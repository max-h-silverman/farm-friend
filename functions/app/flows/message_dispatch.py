"""Inbound message dispatch.

This is the brain that ties everything together. The webhook lands here;
from this point on we never talk to Telnyx directly — we use the messaging
provider abstraction.

Pipeline:
  1. Verify webhook signature (provider-specific).
  2. Parse payload into normalized InboundMessage.
  3. Idempotency check on provider_msg_id.
  4. Look up sender. If unknown phone → handle as a JOIN candidate.
  5. Persist inbound message.
  6. Pending-confirmation precedence: if the last outbound was a live
     PENDING_CONFIRMATION and this inbound matches the token (or an
     affirmative variant), execute the persisted action. This runs
     BEFORE the hotkey parser so a "YES" reply to a confirm prompt is
     read as confirmation, not as a claim hotkey.
  7. Run hotkey parser (deterministic). If hotkey matched → dispatch.
  8. FLAG-pauses-thread invariant: silent if sender has an open flag.
  9. Pre-agent: UNDO (free-form UNDO inside a longer message).
 10. Otherwise → unified agent (one LLM call, one JSON output). Route on
     the output's `mode` (reply/clarify/confirm/execute/escalate).
 11. Post-agent rails: if the agent's mode is `clarify`, enforce the
     consecutive-streak cap and 24h soft cap BEFORE sending. The cap
     fires only when the agent — having seen the user's reply — still
     wants to clarify; never on the inbound that answers a clarify.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import UTC, datetime
from time import monotonic
from typing import Any

from firebase_functions import https_fn

from app.agent import hotkeys
from app.agent.parser import (
    ParsedOpportunity,
    _apply_farm_defaults,
    compute_missing_fields,
)
from app.agent.unified import (
    ActionSpec,
    AgentOutput,
    RecordOfferPayload,
    run_agent,
)
from app.config import load_settings
from app.copy import templates
from app.flows import claim as claim_flow
from app.flows import farmer_ops
from app.flows.agent_context import build_agent_context, farm_defaults_dict
from app.flows import outreach as outreach_flow
from app.flows import post_event as post_event_flow
from app.flows._time import (
    VASHON_TZ,
    format_day_and_range,
    format_deadline,
    post_event_time_for,
)
from app.llm import get_llm_client
from app.messaging import InboundMessage, get_messaging_provider
from app.messaging._safe_send import safe_send
from app.messaging.media_store import persist_media_urls
from app.repos import (
    agent_decisions_repo,
    farms_repo,
    flags_repo,
    messages_repo,
    mutes_repo,
    opportunities_repo,
    pending_users_repo,
    users_repo,
)
from app.repos.models import (
    AgentDecisionDoc,
    ClaimStatus,
    FlagDoc,
    IntentLabel,
    InsiderDoc,
    MessageDirection,
    MessageDoc,
    MuteDimension,
    MuteRuleDoc,
    OpportunityDoc,
    OpportunityKind,
    OpportunityPurpose,
    OpportunityStatus,
    PendingUserDoc,
    UserDoc,
    UserRole,
    UserStatus,
)

log = logging.getLogger(__name__)


def _log_value(value: Any) -> str:
    """Render enum-like values and plain strings without risking log failures."""
    return str(getattr(value, "value", value))


# Exception class names that mean "the model didn't answer in time / couldn't
# be reached" across the providers we use (OpenAI SDK over DeepInfra, the
# Anthropic adapter, and bare stdlib socket timeouts). Matched by name rather
# than by `isinstance` so we don't have to import provider SDKs here and stay
# resilient to SDK version drift. The offer-fallback path keys off this so a
# slow/unreachable model doesn't drop a volunteer's in-flight message.
_LLM_TIMEOUT_ERROR_NAMES = frozenset({
    "APITimeoutError",
    "APIConnectionError",
    "APIConnectionTimeoutError",
    "Timeout",
    "TimeoutError",
    "ConnectTimeout",
    "ReadTimeout",
    "ConnectionError",
})


def _is_llm_timeout(error: Exception) -> bool:
    """True if `error` looks like an LLM timeout / connectivity failure.

    Checks the error's own class name and its base classes so a provider
    subclass (e.g. an SDK-specific timeout deriving from a generic Timeout)
    still matches.
    """
    for klass in type(error).__mro__:
        if klass.__name__ in _LLM_TIMEOUT_ERROR_NAMES:
            return True
    return False


# ---------------------------------------------------------------------------
# Webhook entry point
# ---------------------------------------------------------------------------
def handle_inbound_webhook(req: https_fn.Request) -> https_fn.Response:
    provider = get_messaging_provider()
    raw_body = req.get_data() or b""

    # Smoke-test bypass: if the request carries the smoke-test token AND it
    # matches the value bound as a secret, skip Telnyx signature verification.
    # The token is set by scripts/fire_inbound_sms.py for local end-to-end
    # tests; absent in normal Telnyx traffic.
    import os
    smoke_token_env = os.environ.get("SMOKE_TEST_TOKEN", "")
    smoke_header = req.headers.get("X-Smoke-Test-Token", "")
    is_smoke = bool(smoke_token_env) and smoke_header == smoke_token_env

    if not is_smoke:
        signature = req.headers.get("Telnyx-Signature-Ed25519", "")
        timestamp = req.headers.get("Telnyx-Timestamp", "")
        validation = provider.verify_webhook(
            body=raw_body, signature=signature, timestamp=timestamp
        )
        if not validation.valid:
            return https_fn.Response(
                f"webhook verification failed: {validation.error}", status=403
            )

    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except json.JSONDecodeError:
        return https_fn.Response("bad json", status=400)

    # Telnyx sends both inbound messages and outbound delivery receipts to the
    # same webhook. Only act on inbound.
    event_type = payload.get("data", {}).get("event_type", "")
    if event_type != "message.received":
        return https_fn.Response("ignored", status=200)

    inbound = provider.parse_inbound(payload=payload)
    if inbound.media_urls:
        inbound = InboundMessage(
            from_phone=inbound.from_phone,
            to_phone=inbound.to_phone,
            body=inbound.body,
            provider_msg_id=inbound.provider_msg_id,
            received_at=inbound.received_at,
            media_urls=persist_media_urls(list(inbound.media_urls)),
        )
    # Last-resort backstop. _dispatch degrades known failure modes internally
    # (agent/context failure → flag+fallback). Anything that still escapes —
    # e.g. a repo read failing in a pre-agent step — must not become a 500:
    # Telnyx retries 5xx, and idempotency means the retry re-hits the same
    # crash forever, never reaching the user or the admin. We log it and return
    # 200 so the retry storm stops; the inbound was already persisted for audit.
    try:
        _dispatch(inbound=inbound)
    except Exception:  # noqa: BLE001 — webhook must not 500 on a processing bug
        # Correlate by provider_msg_id only — never log the raw phone (PII).
        log.exception(
            "dispatch_unhandled_failure provider_msg_id=%s",
            inbound.provider_msg_id,
        )
    return https_fn.Response("ok", status=200)


# ---------------------------------------------------------------------------
# Dispatch core (also called by tests with a fake provider)
# ---------------------------------------------------------------------------
def _dispatch(*, inbound: InboundMessage, messaging: "MessagingProvider | None" = None) -> None:
    settings = load_settings()
    provider = messaging or get_messaging_provider(settings)

    # Idempotency: Telnyx occasionally retries webhook delivery for the same
    # SMS. If we've already processed this provider_msg_id, drop silently —
    # processing again would double-create claims, opportunities, etc.
    if inbound.provider_msg_id and messages_repo.exists_by_provider_msg_id(
        inbound.provider_msg_id
    ):
        return

    sender = users_repo.get_by_phone(inbound.from_phone)

    # Unknown sender — treat as a JOIN candidate so the coordinator can review.
    if sender is None:
        _handle_unknown_sender(inbound=inbound, provider=provider)
        return

    if sender.status == UserStatus.UNSUBSCRIBED:
        # They previously sent STOP. We must not send anything back.
        # We still persist the inbound for audit but don't reply.
        messages_repo.create(
            MessageDoc(
                direction=MessageDirection.INBOUND,
                provider_msg_id=inbound.provider_msg_id,
                user_id=sender.id,
                body=inbound.body,
                media_urls=list(inbound.media_urls or []),
                created_at=inbound.received_at,
            )
        )
        return

    # Most recent outbound — used as the "what is this in reply to?" anchor.
    last_outbound = messages_repo.latest_outbound_for_user(sender.id) if sender.id else None
    target_opp = (
        opportunities_repo.get_by_id(last_outbound.opportunity_id)
        if last_outbound and last_outbound.opportunity_id
        else None
    )

    expecting_post_event = _is_post_event_question(last_outbound, target_opp)

    # Persist the inbound message — intent will be filled in below.
    inbound_doc = messages_repo.create(
        MessageDoc(
            direction=MessageDirection.INBOUND,
            provider_msg_id=inbound.provider_msg_id,
            user_id=sender.id,
            opportunity_id=target_opp.id if target_opp else None,
            body=inbound.body,
            media_urls=list(inbound.media_urls or []),
            created_at=inbound.received_at,
        )
    )

    # PENDING-CONFIRMATION precedence: if the user's last outbound is a live
    # PENDING_CONFIRMATION and this inbound matches its token or one of the
    # affirmative variants (YES/OK/SURE/...), execute the persisted action.
    # This MUST run before the hotkey parser, otherwise a YES reply to a
    # CONFIRM would route to the YES-claim hotkey (which assumes the prior
    # outbound was an outreach, not a confirmation prompt).
    #
    # The affirmative set is narrow (YES/OK/OKAY/SURE/CONFIRM/GO/GO AHEAD/
    # YEP/YEAH) — compliance keywords (STOP/FLAG/HELP/JOIN) never match it,
    # so this check doesn't shadow them.
    if _is_live_pending_confirmation(last_outbound) and last_outbound.pending_action:
        if hotkeys.match_pending_token(body=inbound.body, pending=last_outbound.pending_action):
            _execute_pending_action(
                sender=sender,
                pending=last_outbound.pending_action,
                last_outbound=last_outbound,
                provider=provider,
            )
            return
        if _handle_media_for_pending_opportunity(
            sender=sender,
            inbound=inbound,
            inbound_doc=inbound_doc,
            pending=last_outbound.pending_action,
            last_outbound=last_outbound,
            provider=provider,
        ):
            return

    if _handle_media_for_existing_opportunity(
        sender=sender,
        inbound=inbound,
        target_opp=target_opp,
        provider=provider,
    ):
        return

    known_farms = tuple(f.name for f in farms_repo.list_all())
    last_was_clarify = (
        last_outbound is not None
        and last_outbound.intent_label == IntentLabel.CLARIFY
    )
    match = hotkeys.parse(
        inbound.body,
        expecting_post_event_reply=expecting_post_event,
        last_outbound_was_clarify=last_was_clarify,
        known_farm_names=known_farms,
    )

    if match is not None:
        _handle_hotkey(
            match=match,
            sender=sender,
            target_opp=target_opp,
            last_outbound=last_outbound,
            inbound_doc_id=inbound_doc.id or "",
            provider=provider,
        )
        return

    # If the user has an open FLAG, do not auto-reply. The agent stays silent
    # until the admin resolves the flag.
    if sender.id and flags_repo.is_user_flagged(sender.id):
        return

    # --- Unified-agent path ------------------------------------------------
    #
    # The four-branch fan-out (farmer-with-open-opps / clarification-reply /
    # farmer-post / volunteer-llm-reply) has been replaced by a single agent
    # call. See docs/refactor-unified-agent.md.
    #
    # Pre-agent dispatch steps (UNDO) are deterministic and fire
    # BEFORE the agent runs — those paths never cost an LLM call.

    # PRE-AGENT: UNDO after an executed action.
    # UNDO as a bare hotkey is already handled by `_handle_hotkey` above;
    # this branch is reached if the user texts UNDO as part of a longer
    # message that didn't match the hotkey regex. Same semantics.
    if _looks_like_undo(inbound.body) and _is_executed_action_receipt(last_outbound):
        _undo_last_executed_action(
            sender=sender,
            last_outbound=last_outbound,
            provider=provider,
        )
        return

    # Compute the current clarification streak so the agent's CONTEXT can
    # reflect it (we still send it into the agent) and so the post-agent
    # clarify cap check has the right baseline. The cap itself is enforced
    # AFTER the agent runs — see _route_agent_output's clarify branch.
    # Enforcing it before the agent would block the inbound that *answers*
    # the cap-hitting clarify, which is exactly when the user is doing what
    # we asked.
    clarify_streak = _consecutive_clarify_count(
        user_id=sender.id, since=last_outbound,
    )

    # Call the unified agent.
    pending_action = (
        last_outbound.pending_action
        if _is_live_pending_confirmation(last_outbound) and last_outbound
        else None
    )
    executed_action = None
    if _is_executed_action_receipt(last_outbound):
        executed_action = last_outbound.executed_action if last_outbound else None
    try:
        # Context assembly is AI prep — a failure here (a malformed read model,
        # a repo read error, a Pydantic validation error) must degrade to the
        # same flag+fallback as an agent-call failure, NOT escape as an
        # unhandled webhook 500. It lives inside this try for that reason.
        context = build_agent_context(
            sender=sender,
            last_outbound=last_outbound,
            target_opp=target_opp,
            pending_action=pending_action,
            executed_action=executed_action,
        )
        llm = get_llm_client(settings)
        llm_started = monotonic()
        log.info(
            "unified_agent_start user_id=%s role=%s inbound_doc_id=%s provider_msg_id=%s",
            sender.id,
            _log_value(sender.role),
            inbound_doc.id,
            inbound.provider_msg_id,
        )
        output = run_agent(llm=llm, context=context, inbound_text=inbound.body)
        elapsed_ms = int((monotonic() - llm_started) * 1000)
        log.info(
            "unified_agent_success user_id=%s mode=%s elapsed_ms=%d",
            sender.id,
            _log_value(output.mode),
            elapsed_ms,
        )
        _record_agent_decision(
            sender=sender,
            inbound=inbound,
            inbound_doc_id=inbound_doc.id,
            output=output,
            elapsed_ms=elapsed_ms,
            model=settings.llm_model_strong,
        )
    except Exception as e:  # LLMProviderError or anything else
        elapsed_ms = int((monotonic() - llm_started) * 1000) if "llm_started" in locals() else -1
        log.exception(
            "unified_agent_failure user_id=%s elapsed_ms=%d error_type=%s",
            sender.id,
            elapsed_ms,
            type(e).__name__,
        )
        if _is_llm_timeout(e) and _handle_timeout_offer_fallback(
            sender=sender,
            inbound_text=inbound.body,
            inbound_doc_id=inbound_doc.id or "",
            target_opp=target_opp,
            provider=provider,
        ):
            return
        # Agent failure is a flag-for-admin, NOT a silent drop. Better the
        # user gets the fallback than nothing.
        flags_repo.create(
            FlagDoc(
                message_id=inbound_doc.id or "",
                flagged_by_user_id=sender.id,
                reason=f"Unified agent call failed: {type(e).__name__}: {e}",
                created_at=datetime.now(UTC),
            )
        )
        _reply_and_log(
            provider=provider, to=sender,
            body=templates.render_stuck_handoff(),
            opp=target_opp, intent=IntentLabel.ESCALATE,
        )
        return

    _route_agent_output(
        output=output,
        sender=sender,
        target_opp=target_opp,
        clarify_streak=clarify_streak,
        last_outbound=last_outbound,
        inbound_doc_id=inbound_doc.id or "",
        inbound_text=inbound.body,
        provider=provider,
        known_farm_names=known_farms,
    )


# ---------------------------------------------------------------------------
# Branches
# ---------------------------------------------------------------------------
def _handle_unknown_sender(*, inbound: InboundMessage, provider) -> None:
    """Persist the message, create a pending_user record for admin review."""
    # If a pending_user already exists for this phone, don't duplicate.
    existing = pending_users_repo.get_by_phone(inbound.from_phone)
    if existing is None:
        pending_users_repo.create(
            PendingUserDoc(
                phone=inbound.from_phone,
                source="join",
                created_at=datetime.now(UTC),
            )
        )

    messages_repo.create(
        MessageDoc(
            direction=MessageDirection.INBOUND,
            provider_msg_id=inbound.provider_msg_id,
            user_id=None,
            body=inbound.body,
            media_urls=list(inbound.media_urls or []),
            created_at=inbound.received_at,
        )
    )
    ack_body = templates.render_join_ack()
    provider_id = safe_send(provider, to_phone=inbound.from_phone, body=ack_body)
    if provider_id is not None:
        # Audit trail: log the outbound even though we don't have a user_id yet.
        # Admin approval will link the eventual UserDoc back via phone if needed.
        messages_repo.create(
            MessageDoc(
                direction=MessageDirection.OUTBOUND,
                provider_msg_id=provider_id,
                user_id=None,
                body=ack_body,
                intent_label=IntentLabel.JOIN,
                created_at=datetime.now(UTC),
            )
        )


def _handle_hotkey(
    *,
    match: hotkeys.HotkeyMatch,
    sender: UserDoc,
    target_opp: OpportunityDoc | None,
    last_outbound: MessageDoc | None,
    inbound_doc_id: str,
    provider,
) -> None:
    intent = match.intent

    if intent == IntentLabel.HELP:
        is_farmer = sender.role == UserRole.FARMER
        _reply_and_log(
            provider=provider,
            to=sender,
            body=templates.render_help(is_farmer=is_farmer),
            opp=target_opp,
            intent=intent,
        )
        return

    if intent == IntentLabel.STOP:
        if sender.id:
            users_repo.set_status(sender.id, UserStatus.UNSUBSCRIBED)
        _reply_and_log(
            provider=provider, to=sender, body=templates.render_stop_ack(), opp=target_opp, intent=intent
        )
        return

    if intent == IntentLabel.FLAG:
        flags_repo.create(
            FlagDoc(
                message_id=inbound_doc_id,
                flagged_by_user_id=sender.id,
                reason=str(match.payload.get("reason", "")),
                created_at=datetime.now(UTC),
            )
        )
        _reply_and_log(
            provider=provider, to=sender, body=templates.render_flag_ack(), opp=target_opp, intent=intent
        )
        return

    if intent == IntentLabel.JOIN:
        # Already an active user — JOIN is a no-op; reply with HELP.
        is_farmer = sender.role == UserRole.FARMER
        _reply_and_log(
            provider=provider,
            to=sender,
            body=templates.render_help(is_farmer=is_farmer),
            opp=target_opp,
            intent=intent,
        )
        return

    if intent == IntentLabel.MUTE:
        if target_opp and sender.id and target_opp.id:
            mutes_repo.add(
                MuteRuleDoc(
                    user_id=sender.id,
                    dimension=MuteDimension.OPPORTUNITY,
                    value=target_opp.id,
                    created_at=datetime.now(UTC),
                )
            )
            _reply_and_log(
                provider=provider,
                to=sender,
                body=templates.render_mute_ack(what="this one"),
                opp=target_opp,
                intent=intent,
            )
        return

    if intent == IntentLabel.STOP_PURPOSE:
        purpose = str(match.payload.get("purpose", ""))
        if sender.id and purpose:
            mutes_repo.add(
                MuteRuleDoc(
                    user_id=sender.id,
                    dimension=MuteDimension.PURPOSE,
                    value=purpose,
                    created_at=datetime.now(UTC),
                )
            )
            _reply_and_log(
                provider=provider,
                to=sender,
                body=templates.render_mute_ack(what=_purpose_label(purpose)),
                opp=target_opp,
                intent=intent,
            )
        return

    if intent == IntentLabel.STOP_FARM:
        farm_name = str(match.payload.get("farm_name", ""))
        if sender.id and farm_name:
            # Look up farm id by name.
            for f in farms_repo.list_all():
                if f.name.lower() == farm_name.lower() and f.id:
                    mutes_repo.add(
                        MuteRuleDoc(
                            user_id=sender.id,
                            dimension=MuteDimension.FARM,
                            value=f.id,
                            created_at=datetime.now(UTC),
                        )
                    )
                    break
            _reply_and_log(
                provider=provider,
                to=sender,
                body=templates.render_mute_ack(what=farm_name),
                opp=target_opp,
                intent=intent,
            )
        return

    if intent == IntentLabel.UNAVAILABLE:
        # Window parsing is non-trivial — flag for the coordinator rather than
        # guess wrong. The coordinator can pick a sensible range.
        flags_repo.create(
            FlagDoc(
                message_id=inbound_doc_id,
                flagged_by_user_id=sender.id,
                reason=f"UNAVAILABLE window needs setup: {match.payload.get('raw_window', '')}",
                created_at=datetime.now(UTC),
            )
        )
        _reply_and_log(
            provider=provider,
            to=sender,
            body="Got it — coordinator will confirm your availability window shortly.",
            opp=target_opp,
            intent=intent,
        )
        return

    if intent == IntentLabel.INSIDER and sender.role in (UserRole.FARMER, UserRole.BOTH):
        # Farmer is nominating a volunteer by phone. We add as pending_user
        # rather than auto-creating — admin must approve. (Manual gate.)
        phone = str(match.payload.get("phone", ""))
        name = str(match.payload.get("name", ""))
        farm = farms_repo.get_by_owner(sender.id) if sender.id else None
        if phone and farm and farm.id:
            existing = users_repo.get_by_phone(phone)
            if existing and existing.id:
                # Already in system — add as insider directly.
                farms_repo.add_insider(farm_id=farm.id, volunteer_user_id=existing.id)
                _reply_and_log(
                    provider=provider,
                    to=sender,
                    body=f"Added {existing.name} as an insider for {farm.name}.",
                    opp=target_opp,
                    intent=intent,
                )
            else:
                pending_users_repo.create(
                    PendingUserDoc(
                        phone=phone,
                        name=name,
                        source="insider_nomination",
                        suggested_role=UserRole.VOLUNTEER,
                        nominated_by_farm_id=farm.id,
                        created_at=datetime.now(UTC),
                    )
                )
                _reply_and_log(
                    provider=provider,
                    to=sender,
                    body=f"Got it — coordinator will admit {name or phone} and add them as an insider for {farm.name}.",
                    opp=target_opp,
                    intent=intent,
                )
        return

    if intent == IntentLabel.STATUS:
        if sender.role not in (UserRole.FARMER, UserRole.BOTH):
            _reply_and_log(
                provider=provider,
                to=sender,
                body="STATUS is for farmers. Reply HELP for volunteer commands.",
                opp=target_opp,
                intent=intent,
            )
            return
        farm = farms_repo.get_by_owner(sender.id) if sender.id else None
        if farm is None or farm.id is None:
            _reply_and_log(
                provider=provider,
                to=sender,
                body="No farm on file for you yet — the Farm Friend team can set that up.",
                opp=target_opp,
                intent=intent,
            )
            return
        body = farmer_ops.handle_status(farm_id=farm.id)
        _reply_and_log(provider=provider, to=sender, body=body, opp=None, intent=intent)
        return

    if intent in (IntentLabel.CANCEL, IntentLabel.DROP):
        # Volunteer-on-reminder path: DROP (and legacy CANCEL) after a
        # confirmation reminder drops the volunteer's claim on that opp. The
        # reminder anchors target_opp via opportunity_id on the outbound
        # MessageDoc.
        is_volunteer_drop = (
            sender.role in (UserRole.VOLUNTEER, UserRole.BOTH)
            and target_opp is not None
            and last_outbound is not None
            and last_outbound.intent_label == IntentLabel.CONFIRMATION_REMINDER
        )
        if is_volunteer_drop:
            reply = claim_flow.handle_volunteer_drop(
                messaging=provider,
                opportunity=target_opp,
                volunteer=sender,
            )
            _reply_and_log(
                provider=provider, to=sender, body=reply, opp=target_opp, intent=intent
            )
            return
        if intent == IntentLabel.DROP:
            _reply_and_log(
                provider=provider,
                to=sender,
                body="DROP is for replying to a shift reminder. Reply CANCEL or STOP to unsubscribe.",
                opp=target_opp,
                intent=intent,
            )
            return
        if sender.role not in (UserRole.FARMER, UserRole.BOTH):
            if sender.id:
                users_repo.set_status(sender.id, UserStatus.UNSUBSCRIBED)
            _reply_and_log(
                provider=provider,
                to=sender,
                body=templates.render_stop_ack(),
                opp=target_opp,
                intent=IntentLabel.STOP,
            )
            return
        farm = farms_repo.get_by_owner(sender.id) if sender.id else None
        if farm is None or farm.id is None:
            if sender.id:
                users_repo.set_status(sender.id, UserStatus.UNSUBSCRIBED)
            _reply_and_log(
                provider=provider,
                to=sender,
                body=templates.render_stop_ack(),
                opp=target_opp,
                intent=IntentLabel.STOP,
            )
            return
        if not opportunities_repo.list_open_for_farm(farm.id):
            if sender.id:
                users_repo.set_status(sender.id, UserStatus.UNSUBSCRIBED)
            _reply_and_log(
                provider=provider,
                to=sender,
                body=templates.render_stop_ack(),
                opp=target_opp,
                intent=IntentLabel.STOP,
            )
            return
        body = farmer_ops.handle_cancel(
            farm_id=farm.id, farm_name=farm.name, messaging=provider
        )
        _reply_and_log(provider=provider, to=sender, body=body, opp=None, intent=intent)
        return

    if intent == IntentLabel.CLAIM:
        if target_opp is None:
            _handle_orphan_claim_or_maybe(
                sender=sender,
                inbound_doc_id=inbound_doc_id,
                provider=provider,
                intent=intent,
            )
            return
        farm = farms_repo.get_by_id(target_opp.farm_id)
        farmer = users_repo.get_by_id(farm.owner_user_id) if farm else None
        days = list(match.payload.get("days", []) or [])
        # Window-opp claim path: when the inbound carried day tokens AND the
        # target opp has a window, route to handle_window_claim (PROPOSED
        # claims, farmer-approval gate). A bare YES on a window opp falls
        # through to the agent so it can ask which day.
        if days and target_opp.window_end_at is not None:
            reply = claim_flow.handle_window_claim(
                messaging=provider,
                opportunity=target_opp,
                volunteer=sender,
                day_labels=days,
                farm_name=farm.name if farm else "the farm",
            )
            _reply_and_log(provider=provider, to=sender, body=reply, opp=target_opp, intent=intent)
            return
        slots = int(match.payload.get("slots", 1) or 1)
        reply = claim_flow.handle_claim(
            messaging=provider,
            opportunity=target_opp,
            volunteer=sender,
            slots=slots,
            farm_name=farm.name if farm else "the farm",
            notify_farmer_phone=farmer.phone if farmer else None,
        )
        _reply_and_log(
            provider=provider,
            to=sender,
            body=reply,
            opp=target_opp,
            intent=intent,
            media_urls=_confirmed_pickup_media_urls(target_opp, reply),
        )
        return

    if intent == IntentLabel.MAYBE:
        if target_opp is None:
            _handle_orphan_claim_or_maybe(
                sender=sender,
                inbound_doc_id=inbound_doc_id,
                provider=provider,
                intent=intent,
            )
            return
        farm = farms_repo.get_by_id(target_opp.farm_id)
        reply = claim_flow.handle_maybe(
            opportunity=target_opp,
            volunteer=sender,
            farm_name=farm.name if farm else "the farm",
        )
        _reply_and_log(provider=provider, to=sender, body=reply, opp=target_opp, intent=intent)
        return

    if intent in (IntentLabel.POST_EVENT_OK, IntentLabel.POST_EVENT_ISSUE) and target_opp is not None:
        answer = "Y" if intent == IntentLabel.POST_EVENT_OK else "N"
        reply = post_event_flow.handle_post_event_reply(
            messaging=provider,
            opportunity=target_opp,
            farmer_phone=sender.phone,
            answer=answer,
        )
        if intent == IntentLabel.POST_EVENT_ISSUE:
            # Flag for the admin so they see the followup detail when it arrives.
            flags_repo.create(
                FlagDoc(
                    message_id=inbound_doc_id,
                    flagged_by_user_id=sender.id,
                    reason="Post-event issue reported (N). Awaiting farmer detail.",
                    created_at=datetime.now(UTC),
                )
            )
        _reply_and_log(provider=provider, to=sender, body=reply, opp=target_opp, intent=intent)
        return

    if intent == IntentLabel.UNDO:
        # Reverse the most recent agent-executed action receipt.
        if _is_executed_action_receipt(last_outbound):
            _undo_last_executed_action(
                sender=sender, last_outbound=last_outbound, provider=provider,
            )
        else:
            _reply_and_log(
                provider=provider, to=sender,
                body="Nothing recent to undo. Reply with what you'd like to change.",
                opp=target_opp, intent=intent,
            )
        return

    if intent == IntentLabel.PAUSE:
        # 14-day mute on agent-initiated nudges. Does NOT affect scheduled
        # flows the user consented to (confirmation reminders, post-event
        # check-ins) or direct replies to user-initiated messages.
        from datetime import timedelta as _td
        if sender.id:
            mutes_repo.add(
                MuteRuleDoc(
                    user_id=sender.id,
                    dimension=MuteDimension.AGENT_NUDGE,
                    value="all",
                    created_at=datetime.now(UTC),
                    expires_at=datetime.now(UTC) + _td(days=14),
                )
            )
        _reply_and_log(
            provider=provider, to=sender,
            body="Farm Friend Vashon: Paused proactive nudges for 14 days. "
                 "You'll still get messages for shifts you've committed to. "
                 "Reply RESUME to unpause, or STOP to unsubscribe entirely.",
            opp=target_opp, intent=intent,
        )
        return

    if intent == IntentLabel.RESUME:
        # Remove agent_nudge mutes (we set them with expires_at, but explicit
        # RESUME zeros them out now). Lookup-by-dimension is cheap at pilot scale.
        if sender.id:
            for rule in mutes_repo.list_for_user(sender.id):
                if rule.dimension == MuteDimension.AGENT_NUDGE and rule.id:
                    mutes_repo.delete(rule.id)
        _reply_and_log(
            provider=provider, to=sender,
            body="Farm Friend Vashon: Proactive nudges resumed.",
            opp=target_opp, intent=intent,
        )
        return

    if intent in (IntentLabel.ACCEPT_PROPOSAL, IntentLabel.DECLINE_PROPOSAL):
        # Only farmers can accept/decline proposals — volunteers seeing this
        # hotkey get a generic "not for you" reply.
        if sender.role not in (UserRole.FARMER, UserRole.BOTH):
            _reply_and_log(
                provider=provider, to=sender,
                body="ACCEPT/DECLINE are for farmers responding to a volunteer proposal.",
                opp=target_opp, intent=intent,
            )
            return
        from app.flows import proposals as proposals_flow
        token = str(match.payload.get("token", "")).upper()
        decision = "accept" if intent == IntentLabel.ACCEPT_PROPOSAL else "decline"
        reply = proposals_flow.handle_farmer_decision(
            messaging=provider, farmer=sender, token=token, decision=decision,
        )
        _reply_and_log(provider=provider, to=sender, body=reply, opp=target_opp, intent=intent)
        return


_PHOTO_ATTACHMENT_WORDS = (
    "photo", "pic", "picture", "image", "where", "location", "here",
)


def _handle_media_for_existing_opportunity(
    *,
    sender: UserDoc,
    inbound: InboundMessage,
    target_opp: OpportunityDoc | None,
    provider,
) -> bool:
    """Attach a farmer's follow-up MMS to the opportunity they are discussing.

    This handles the natural flow where the farmer posts a pickup, gets the
    receipt, then sends a photo of the pickup location/items. If the caption
    looks like a real edit/request, leave it for the normal hotkey/agent path.
    """
    media_urls = list(inbound.media_urls or [])
    if not media_urls or target_opp is None or target_opp.id is None:
        return False
    if target_opp.kind != OpportunityKind.PICKUP:
        return False
    if sender.role not in (UserRole.FARMER, UserRole.BOTH) or sender.id is None:
        return False
    farm = farms_repo.get_by_owner(sender.id)
    if farm is None or farm.id != target_opp.farm_id:
        return False
    caption = (inbound.body or "").strip().lower()
    if caption and not any(word in caption for word in _PHOTO_ATTACHMENT_WORDS):
        return False

    newly_added = opportunities_repo.append_media_urls(target_opp.id, media_urls)
    if newly_added:
        _send_pickup_media_to_confirmed_volunteers(
            provider=provider, opp=target_opp, media_urls=newly_added,
        )
    _reply_and_log(
        provider=provider,
        to=sender,
        body=(
            "Got the photo — I'll send it only to volunteers who confirm that pickup."
        ),
        opp=target_opp,
        intent=IntentLabel.ACTION_RECEIPT,
    )
    return True


def _send_pickup_media_to_confirmed_volunteers(
    *,
    provider,
    opp: OpportunityDoc,
    media_urls: list[str],
) -> None:
    if opp.id is None or opp.kind != OpportunityKind.PICKUP or not media_urls:
        return
    for claim in opportunities_repo.list_confirmed_claims(opp.id):
        volunteer = users_repo.get_by_id(claim.volunteer_user_id)
        if volunteer is None or volunteer.id is None:
            continue
        body = "Farm Friend Vashon: photo from the farm for your confirmed pickup."
        provider_id = safe_send(
            provider, to_phone=volunteer.phone, body=body, media_urls=media_urls,
        )
        if provider_id is None:
            continue
        messages_repo.create(
            MessageDoc(
                direction=MessageDirection.OUTBOUND,
                provider_msg_id=provider_id,
                user_id=volunteer.id,
                opportunity_id=opp.id,
                body=body,
                media_urls=list(media_urls),
                intent_label=IntentLabel.ACTION_RECEIPT,
                created_at=datetime.now(UTC),
            )
        )


def _handle_media_for_pending_opportunity(
    *,
    sender: UserDoc,
    inbound: InboundMessage,
    inbound_doc: MessageDoc,
    pending: dict,
    last_outbound: MessageDoc,
    provider,
) -> bool:
    """Let a farmer add an MMS photo while a posting confirmation is pending."""
    media_urls = list(inbound.media_urls or [])
    if not media_urls or sender.role not in (UserRole.FARMER, UserRole.BOTH):
        return False
    if pending.get("action") not in ("create_opportunity", "update_draft_opportunity"):
        return False
    caption = (inbound.body or "").strip().lower()
    if caption and not any(word in caption for word in _PHOTO_ATTACHMENT_WORDS):
        return False

    updated_pending = dict(pending)
    updated_pending["media_urls"] = _merge_unique_urls(
        list(pending.get("media_urls") or []),
        media_urls,
    )
    updated_pending["source_message_id"] = (
        pending.get("source_message_id") or inbound_doc.id
    )
    action_word = (
        "post with it"
        if pending.get("action") == "create_opportunity"
        else "save that update with it"
    )
    body = f"Got the photo — reply {pending.get('token', 'YES')} to {action_word}."
    provider_id = safe_send(provider, to_phone=sender.phone, body=body)
    if provider_id is None:
        return True
    messages_repo.create(
        MessageDoc(
            direction=MessageDirection.OUTBOUND,
            provider_msg_id=provider_id,
            user_id=sender.id,
            opportunity_id=last_outbound.opportunity_id,
            body=body,
            intent_label=IntentLabel.PENDING_CONFIRMATION,
            pending_action=updated_pending,
            created_at=datetime.now(UTC),
        )
    )
    return True


_EDITABLE_FIELDS = {
    "starts_at",
    "duration_min",
    "headcount_needed",
    "requirements_text",
    "produce_description",
    "destination",
}


def _normalize_edit_updates(raw: dict) -> dict:
    """Reject unknown fields, parse ISO datetimes, coerce numeric strings."""
    out: dict = {}
    for k, v in (raw or {}).items():
        if k not in _EDITABLE_FIELDS or v is None or v == "":
            continue
        if k == "starts_at":
            dt = _parse_iso(v) if isinstance(v, str) else None
            if dt is not None:
                out[k] = dt
        elif k in ("duration_min", "headcount_needed"):
            try:
                out[k] = int(v)
            except (ValueError, TypeError):
                continue
        else:
            out[k] = str(v)
    return out


def _merge_updates_for_opportunity(*, parsed) -> dict:
    """Translate a merged ParsedOpportunity into the dict of OpportunityDoc
    field updates to persist. Only includes fields that have a value, so we
    never blank a previously-set field."""
    updates: dict = {}
    if parsed.kind == "shift":
        starts = _parse_iso(parsed.starts_at) if parsed.starts_at else None
        window_end = (
            _parse_iso(parsed.window_end_at)
            if getattr(parsed, "window_end_at", None) else None
        )
        if starts:
            updates["starts_at"] = starts
        if window_end:
            updates["window_end_at"] = window_end
        # Post-event timer is anchored to the last day of the window (or
        # starts_at for single-day). Only stamp when we have new info.
        post_event_basis = window_end or starts
        if post_event_basis:
            updates["post_event_checkin_at"] = _post_event_time_for(
                kind=OpportunityKind.SHIFT,
                starts_at=post_event_basis,
                deadline_at=None,
            )
        if getattr(parsed, "time_of_day_bucket", None):
            updates["time_of_day_bucket"] = parsed.time_of_day_bucket
        if getattr(parsed, "headcount_open", False):
            updates["headcount_open"] = True
        if parsed.headcount_needed:
            updates["headcount_needed"] = parsed.headcount_needed
        if parsed.duration_min:
            updates["duration_min"] = parsed.duration_min
        if getattr(parsed, "purpose", None):
            updates["purpose"] = OpportunityPurpose(parsed.purpose)
        if (getattr(parsed, "activity_detail", "") or "").strip():
            updates["activity_detail"] = parsed.activity_detail.strip()
        if parsed.activity_tags:
            updates["activity_tags"] = list(parsed.activity_tags)
        if parsed.requirements_text:
            updates["requirements_text"] = parsed.requirements_text
    elif parsed.kind == "pickup":
        if parsed.deadline_at:
            deadline = _parse_iso(parsed.deadline_at)
            if deadline:
                updates["deadline_at"] = deadline
                updates["post_event_checkin_at"] = _post_event_time_for(
                    kind=OpportunityKind.PICKUP, starts_at=None, deadline_at=deadline
                )
        if parsed.produce_description:
            updates["produce_description"] = parsed.produce_description
        if parsed.destination:
            updates["destination"] = parsed.destination
        if parsed.vehicle_needed is not None:
            updates["vehicle_needed"] = parsed.vehicle_needed
    return updates


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _handle_escalation(
    *,
    sender: UserDoc,
    inbound_doc_id: str,
    provider,
    reason: str,
    urgency: str,
    reply_body: str | None,
    target_opp: OpportunityDoc | None = None,
) -> None:
    """Common ESCALATE side effects: flag (which auto-mutes the thread),
    send the contextual handoff reply to the user, and optionally text the
    coordinator immediately for urgent cases.
    """
    settings = load_settings()
    flags_repo.create(
        FlagDoc(
            message_id=inbound_doc_id,
            flagged_by_user_id=sender.id,
            reason=f"ESCALATE ({urgency}): {reason or 'no reason given'}",
            created_at=datetime.now(UTC),
        )
    )
    body = reply_body or templates.render_fallback_ambiguous()
    _reply_and_log(
        provider=provider,
        to=sender,
        body=body,
        opp=target_opp,
        intent=IntentLabel.ESCALATE,
    )
    if urgency == "immediate":
        if not settings.coordinator_phone:
            # The coordinator phone is the only channel an injury/safety report
            # reaches the coordinator in real time. If it's unset the escalation silently
            # rots in the flag queue until the next dashboard glance — for an
            # "immediate" trigger that is a safety failure, not a minor gap.
            # Log loudly so it surfaces in alerting; the flag above is still
            # written so nothing is lost outright.
            log.error(
                "IMMEDIATE escalation could not reach coordinator: COORDINATOR_PHONE "
                "is unset. reason=%r sender=%s. Flag written; no SMS sent.",
                reason,
                sender.id,
            )
            return
        sender_label = sender.name or sender.phone
        admin_body = (
            f"[Farm Friend ESCALATE] {sender_label} ({sender.phone}): {reason}"
        )
        sent = safe_send(provider, to_phone=settings.coordinator_phone, body=admin_body)
        if sent is None:
            log.error(
                "IMMEDIATE escalation SMS to coordinator failed to send. "
                "reason=%r sender=%s. Flag written.",
                reason,
                sender.id,
            )


def _handle_orphan_claim_or_maybe(
    *,
    sender: UserDoc,
    inbound_doc_id: str,
    provider,
    intent: IntentLabel,
) -> None:
    """A YES/MAYBE arrived but we can't tie it to an opportunity.

    Common cause: the volunteer's last outbound was a non-opp message (HELP,
    STOP ack, intro), or outreach delivery failed so no MessageDoc was logged.
    Reply with a helpful note and flag for admin so the YES isn't silently lost.
    """
    flags_repo.create(
        FlagDoc(
            message_id=inbound_doc_id,
            flagged_by_user_id=sender.id,
            reason=f"{intent.value} with no opportunity anchor — last outbound to this user has no opportunity_id.",
            created_at=datetime.now(UTC),
        )
    )
    _reply_and_log(
        provider=provider,
        to=sender,
        body=templates.render_orphan_yes(),
        opp=None,
        intent=intent,
    )


def _record_agent_decision(
    *,
    sender: UserDoc,
    inbound: InboundMessage,
    inbound_doc_id: str | None,
    output: AgentOutput,
    elapsed_ms: int,
    model: str,
) -> None:
    """Best-effort audit write of one agent decision. Never raises into the
    dispatch path — observability must not break the reply. See
    agent_decisions_repo for why this exists (auditing the frozen model)."""
    try:
        agent_decisions_repo.create(
            AgentDecisionDoc(
                user_id=sender.id,
                inbound_message_id=inbound_doc_id,
                sender_role=_log_value(sender.role),
                inbound_excerpt=(inbound.body or "")[:200],
                mode=output.mode,
                action_name=output.action.name if output.action else None,
                escalation_urgency=(
                    output.escalation.urgency if output.escalation else None
                ),
                rationale=(output.rationale or "")[:500],
                elapsed_ms=elapsed_ms,
                model=model,
                created_at=datetime.now(UTC),
            )
        )
    except Exception:  # noqa: BLE001 — audit logging is strictly best-effort
        log.warning("agent_decision audit write failed", exc_info=True)


def _reply_and_log(
    *,
    provider,
    to: UserDoc,
    body: str,
    opp: OpportunityDoc | None,
    intent: IntentLabel,
    media_urls: list[str] | None = None,
) -> None:
    media = list(media_urls or [])
    provider_id = safe_send(provider, to_phone=to.phone, body=body, media_urls=media)
    if provider_id is None:
        # Delivery failed — don't pretend we sent something. Skip the message
        # log entry to avoid stats/cost double-counting.
        return
    messages_repo.create(
        MessageDoc(
            direction=MessageDirection.OUTBOUND,
            provider_msg_id=provider_id,
            user_id=to.id,
            opportunity_id=opp.id if opp else None,
            body=body,
            media_urls=media,
            intent_label=intent,
            created_at=datetime.now(UTC),
        )
    )


def _is_post_event_question(last_outbound: MessageDoc | None, opp: OpportunityDoc | None) -> bool:
    """True iff the user's last outbound was the post-event checkin SMS.

    Signal is the persisted `intent_label` on the outbound message — reliable
    even if the copy is reworded. We also verify `post_event_checkin_sent` so
    a label that somehow lingered from a prior cycle doesn't fool us."""
    if last_outbound is None or opp is None:
        return False
    if not opp.post_event_checkin_sent:
        return False
    return last_outbound.intent_label == IntentLabel.POST_EVENT_CHECKIN


_IMMEDIATE_KEYWORDS = (
    "injur", "hurt", "bleed", "cut ", "fell", "fall", "accident", "911",
    "emergency", "ambulance", "hospital", "unsafe", "threat", "harass",
    "crisis", "urgent",
)


def _looks_immediate(text: str) -> bool:
    """Heuristic: does this escalation reason warrant texting the coordinator
    immediately vs. waiting for their next dashboard review? Used when the
    upstream classifier didn't emit an explicit urgency."""
    t = (text or "").lower()
    return any(k in t for k in _IMMEDIATE_KEYWORDS)


def _opportunity_from_parsed(
    *, farm_id: str, parsed, source_message_id: str, media_urls: list[str] | None = None,
) -> OpportunityDoc:
    """Translate the LLM-parsed shape into a persistable OpportunityDoc."""
    starts_at = _parse_iso(parsed.starts_at) if parsed.starts_at else None
    deadline_at = _parse_iso(parsed.deadline_at) if parsed.deadline_at else None
    window_end_at = (
        _parse_iso(parsed.window_end_at) if getattr(parsed, "window_end_at", None) else None
    )
    kind = OpportunityKind.SHIFT if parsed.kind == "shift" else OpportunityKind.PICKUP
    # For a window opp, the legacy single-day post-event timer is computed
    # from window_end_at (last day of work) rather than starts_at (first day).
    # PR 5 replaces this with a per-day sidecar collection; until then this
    # is the right one-shot fallback so a window opp still triggers a
    # check-in eventually.
    post_event_basis = window_end_at or starts_at
    post_event_at = _post_event_time_for(
        kind=kind, starts_at=post_event_basis, deadline_at=deadline_at,
    )
    return OpportunityDoc(
        farm_id=farm_id,
        kind=kind,
        status=OpportunityStatus.DRAFT,
        starts_at=starts_at,
        deadline_at=deadline_at,
        duration_min=parsed.duration_min,
        headcount_needed=parsed.headcount_needed or 1,
        seats_filled=0,
        seats_held=0,
        window_end_at=window_end_at,
        time_of_day_bucket=getattr(parsed, "time_of_day_bucket", None),
        headcount_open=getattr(parsed, "headcount_open", False) or False,
        purpose=OpportunityPurpose(getattr(parsed, "purpose", None) or "farm_help"),
        activity_detail=(getattr(parsed, "activity_detail", "") or "").strip(),
        activity_tags=parsed.activity_tags or [],
        requirements_text=parsed.requirements_text or "",
        produce_description=parsed.produce_description,
        destination=parsed.destination,
        vehicle_needed=parsed.vehicle_needed,
        media_urls=list(media_urls or []),
        created_from_message_id=source_message_id,
        created_at=datetime.now(UTC),
        post_event_checkin_at=post_event_at,
    )


def _media_urls_from_message(message_id: str | None) -> list[str]:
    if not message_id:
        return []
    msg = messages_repo.get_by_id(message_id)
    if msg is None:
        return []
    return list(msg.media_urls or [])


def _merge_unique_urls(existing: list[str], incoming: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for url in [*existing, *incoming]:
        if not url or url in seen:
            continue
        seen.add(url)
        out.append(url)
    return out


def _parse_iso(s: str) -> datetime | None:
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def _post_event_time_for(
    *, kind: OpportunityKind, starts_at: datetime | None, deadline_at: datetime | None
) -> datetime | None:
    return post_event_time_for(
        is_pickup=kind == OpportunityKind.PICKUP,
        starts_at=starts_at,
        deadline_at=deadline_at,
    )


def _farmer_posting_summary(*, parsed) -> str:
    """Conversational readback of a parsed posting, used to confirm with the
    farmer after we've successfully filled in all required fields. Reads back
    every field we resolved (including ones the farmer didn't supply but
    defaults filled), so a missing detail is the farmer's cue to correct us."""
    if parsed.kind == "shift":
        if getattr(parsed, "headcount_open", False):
            people = "any number of helpers"
        else:
            headcount = parsed.headcount_needed or 1
            people = "1 person" if headcount == 1 else f"{headcount} people"
        activity = (getattr(parsed, "activity_detail", "") or "").strip() or "a shift"
        when_str = _format_shift_when(parsed)
        return f"{people} to help with {activity} {when_str}"
    if parsed.kind == "pickup":
        produce = parsed.produce_description or "surplus produce"
        deadline_dt = _parse_iso(parsed.deadline_at) if parsed.deadline_at else None
        when_str = format_deadline(deadline_dt) if deadline_dt else "today"
        dest = f", drop at {parsed.destination}" if parsed.destination else ""
        return f"pickup of {produce} {when_str}{dest}"
    return "posting"


# Bucket → human-readable phrase. Used in readback prose when the farmer gave
# only a fuzzy time. Keep tight — these go into a single-paragraph SMS.
_BUCKET_PHRASE = {
    "early_morning": "early morning",
    "morning": "morning",
    "late_morning": "late morning",
    "midday": "midday",
    "afternoon": "afternoon",
    "late_afternoon": "late afternoon",
    "early_evening": "early evening",
    "evening": "evening",
}


def _format_shift_when(parsed) -> str:
    """Render the date/time portion of a shift readback.

    Four shapes:
      - single-day + clock time:   "tomorrow (Fri 6/5) from 9a-12p"
      - single-day + bucket:       "tomorrow (Fri 6/5) morning"
      - window + clock time:       "Mon 6/2 - Fri 6/5, 9a-12p"
      - window + bucket:           "Mon 6/2 - Fri 6/5, morning"
    """
    starts_dt = _parse_iso(parsed.starts_at) if parsed.starts_at else None
    window_end_dt = (
        _parse_iso(parsed.window_end_at)
        if getattr(parsed, "window_end_at", None) else None
    )
    bucket = getattr(parsed, "time_of_day_bucket", None)
    if starts_dt is None:
        return "soon"

    is_window = window_end_dt is not None and window_end_dt.date() > starts_dt.date()
    if is_window:
        from app.flows._time import to_local
        start_local = to_local(starts_dt)
        end_local = to_local(window_end_dt)
        day_part = (
            f"{start_local.strftime('%a %-m/%-d')} - "
            f"{end_local.strftime('%a %-m/%-d')}"
        )
        if bucket:
            return f"{day_part}, {_BUCKET_PHRASE.get(bucket, bucket)}"
        # Within-day time range for a window opp. Render from the time on
        # starts_at + duration.
        time_part = _format_time_range(starts_dt, parsed.duration_min)
        return f"{day_part}, {time_part}"

    if bucket:
        from app.flows._time import to_local
        local = to_local(starts_dt)
        # Day-only phrase, no time. Same shape as format_day_and_range but
        # without the time tail.
        from datetime import datetime as _dt
        now_local = _dt.now(VASHON_TZ)
        delta_days = (local.date() - now_local.date()).days
        if delta_days == 0:
            day_phrase = "today"
        elif delta_days == 1:
            day_phrase = f"tomorrow ({local.strftime('%a %-m/%-d')})"
        else:
            day_phrase = local.strftime("%a %-m/%-d")
        return f"{day_phrase} {_BUCKET_PHRASE.get(bucket, bucket)}"
    return format_day_and_range(starts_dt, parsed.duration_min)


def _format_time_range(starts_dt: datetime, duration_min: int | None) -> str:
    """Just the within-day time portion: "9a-12p" or "9a"."""
    from app.flows._time import _short_hour, to_local
    local = to_local(starts_dt)
    start_str = _short_hour(local)
    if duration_min and duration_min > 0:
        from datetime import timedelta as _td
        end_local = local + _td(minutes=duration_min)
        return f"{start_str}-{_short_hour(end_local)}"
    return start_str


# ===========================================================================
# Unified-agent dispatch helpers
# ===========================================================================
# Everything below is for the unified-agent path. The pre-agent functions
# (`_is_live_pending_confirmation`, `_is_executed_action_receipt`, etc.) run
# BEFORE the agent is invoked. The post-agent function (`_route_agent_output`)
# turns the agent's structured output into Firestore writes + SMS sends.
#
# The single invariant: the agent never writes to Firestore. All state changes
# happen here, in functions called by `_route_agent_output` after the user
# has confirmed via a token reply.


def _is_live_pending_confirmation(last_outbound: MessageDoc | None) -> bool:
    """True if the user's last outbound is a PENDING_CONFIRMATION whose
    `expires_at` (if set) hasn't passed. The agent prompt also enforces token
    freshness via the context payload, but dispatch is the source of truth."""
    if last_outbound is None:
        return False
    if last_outbound.intent_label != IntentLabel.PENDING_CONFIRMATION:
        return False
    pending = last_outbound.pending_action or {}
    expires_at_iso = pending.get("expires_at")
    if expires_at_iso:
        try:
            expires_at = datetime.fromisoformat(expires_at_iso.replace("Z", "+00:00"))
            if datetime.now(UTC) > expires_at:
                return False
        except (ValueError, AttributeError):
            pass
    return True


def _is_executed_action_receipt(last_outbound: MessageDoc | None) -> bool:
    """True if `last_outbound` is an ACTION_RECEIPT with undo metadata."""
    if last_outbound is None:
        return False
    if last_outbound.intent_label != IntentLabel.ACTION_RECEIPT:
        return False
    executed = last_outbound.executed_action or {}
    return bool(executed.get("action"))


def _looks_like_undo(text: str) -> bool:
    """Loose check for free-form undo phrasing that didn't match the UNDO hotkey.
    Conservative — when in doubt, let the agent decide."""
    t = text.lower().strip()
    return t in {"undo", "undo!", "undo.", "undo that", "nevermind", "never mind"}


def _consecutive_clarify_count(
    *, user_id: str | None, since: MessageDoc | None,
) -> int:
    """Count of consecutive CLARIFY outbounds on the SAME axis as `since`.

    Walks the user's recent outbounds in reverse. The streak counts how many
    times in a row the agent asked about the same thing — not how many
    clarifies in total. A clarify about a *different* axis (e.g. activity then
    time) breaks the streak: the user effectively answered the prior question,
    and the agent is now moving on. Only the same-axis-asked-twice case
    signals "user can't answer this; escalate."

    The axis is read from `MessageDoc.clarify_axis`. Legacy outbounds without
    that field (`clarify_axis is None`) count as "general" — same as any
    other None, so they group together.

    Why this matters: the prior implementation counted every consecutive
    CLARIFY blindly, so a thread like
        "what activity?" → "weeding" → "what time?" → "9am" → "how many?"
    falsely hit the 2-round cap on the third clarify even though every
    prior clarify was answered. Per-axis counting fires the cap only when
    the user genuinely can't answer the same question twice.
    """
    if not user_id or since is None:
        return 0
    if since.intent_label != IntentLabel.CLARIFY:
        return 0
    target_axis = since.clarify_axis  # the axis we care about
    streak = 0
    for msg in messages_repo.list_for_user(user_id, limit=20):
        if msg.direction != MessageDirection.OUTBOUND:
            continue
        if msg.intent_label != IntentLabel.CLARIFY:
            break
        if msg.clarify_axis != target_axis:
            # Different axis = user moved on; streak ends.
            break
        streak += 1
    return streak


def _enforce_clarify_caps(
    *,
    sender: UserDoc,
    clarify_streak: int,
    inbound_doc_id: str,
    provider,
) -> bool:
    """Run the consecutive-streak and 24h soft caps before sending a CLARIFY.

    Returns True if a cap fired (escalation already sent — caller should
    return without sending its own clarify). Returns False if the clarify
    is safe to send.
    """
    settings = load_settings()
    if clarify_streak >= settings.clarify_round_max:
        _escalate_clarify_cap(
            sender=sender,
            inbound_doc_id=inbound_doc_id,
            streak=clarify_streak,
            provider=provider,
        )
        return True
    if sender.id:
        from datetime import timedelta as _td
        clarify_24h = messages_repo.count_clarifications_for_user_in_window(
            sender.id, since=datetime.now(UTC) - _td(hours=24),
        )
        if clarify_24h >= settings.clarify_user_24h_max:
            _escalate_clarify_cap(
                sender=sender,
                inbound_doc_id=inbound_doc_id,
                streak=clarify_24h,
                provider=provider,
                reason_override=f"User received {clarify_24h} clarification questions in 24h",
            )
            return True
    return False


def _escalate_clarify_cap(
    *,
    sender: UserDoc,
    inbound_doc_id: str,
    streak: int,
    provider,
    reason_override: str | None = None,
) -> None:
    """Auto-escalate after the clarification cap is reached. Creates a FLAG
    (which pauses further auto-replies on this thread per the existing
    FLAG-pauses-thread invariant) and sends the fallback reply."""
    reason = reason_override or (
        f"Auto-escalation: {streak} consecutive clarification rounds did not "
        f"resolve the user's message."
    )
    flags_repo.create(
        FlagDoc(
            message_id=inbound_doc_id,
            flagged_by_user_id=sender.id,
            reason=reason,
            created_at=datetime.now(UTC),
        )
    )
    _reply_and_log(
        provider=provider, to=sender,
        body=templates.render_stuck_handoff(),
        opp=None, intent=IntentLabel.ESCALATE,
    )


def _handle_timeout_offer_fallback(
    *,
    sender: UserDoc,
    inbound_text: str,
    inbound_doc_id: str,
    target_opp: OpportunityDoc | None,
    provider,
) -> bool:
    """Timeout-only rescue for obvious volunteer offers.

    The LLM remains the normal coordinator. This path only prevents a slow
    provider from losing high-confidence "I'm available to help <when>" texts.
    """
    if sender.role not in (UserRole.VOLUNTEER, UserRole.BOTH):
        return False
    payload = _timeout_offer_payload(inbound_text)
    if payload is None:
        return False

    scope = _timeout_offer_scope(inbound_text)
    output = AgentOutput(
        mode="confirm",
        reply_text=f"Great, recording your offer to help {scope}. Reply YES to confirm.",
        confirmation_token="YES",
        action=ActionSpec(
            name="record_offer",
            record_offer=RecordOfferPayload(**payload),
        ),
        rationale="LLM timeout fallback for high-confidence volunteer offer.",
    )
    _send_pending_confirmation(
        sender=sender,
        output=output,
        target_opp=target_opp,
        source_message_id=inbound_doc_id,
        provider=provider,
        intake_draft={"kind": "offer", **payload, "missing_fields": []},
    )
    return True


def _timeout_offer_payload(text: str) -> dict | None:
    lower = text.lower()
    if re.search(r"\b(?:can't|cannot|won't|not free|unavailable)\b", lower):
        return None
    if not re.search(
        r"\b(?:free|available|around|can help|able to help|want to help|"
        r"would like to help|happy to help|open to help|volunteer)\b",
        lower,
    ):
        return None

    window = _timeout_offer_window(lower)
    if window is None:
        return None
    return {
        # LLM-timeout deterministic fallback: capture the verbatim text in
        # `note` and leave activity_detail empty (open to anything). The
        # coordinator/review tick does the matching — no slug guessing needed.
        "activity_detail": "",
        "earliest_at": window[0].isoformat(),
        "latest_at": window[1].isoformat(),
        "note": text.strip()[:240],
    }


def _timeout_offer_window(lower: str) -> tuple[datetime, datetime] | None:
    from datetime import timedelta as _td

    now = datetime.now(VASHON_TZ)
    date_start = date_end = None
    if "this weekend" in lower or re.search(r"\bweekend\b", lower):
        days_until_sat = (5 - now.weekday()) % 7
        start_date = (now + _td(days=days_until_sat)).date()
        if now.weekday() == 6:
            start_date = now.date()
        date_start = start_date
        date_end = start_date + _td(days=1) if start_date.weekday() == 5 else start_date
    elif re.search(r"\btoday\b", lower):
        date_start = date_end = now.date()
    elif re.search(r"\btomorrow\b", lower):
        date_start = date_end = (now + _td(days=1)).date()
    else:
        weekdays = {
            "monday": 0,
            "tuesday": 1,
            "wednesday": 2,
            "thursday": 3,
            "friday": 4,
            "saturday": 5,
            "sunday": 6,
        }
        for name, weekday in weekdays.items():
            if re.search(rf"\b(?:{name}|{name[:3]})\b", lower):
                days = (weekday - now.weekday()) % 7
                date_start = date_end = (now + _td(days=days)).date()
                break
    if date_start is None or date_end is None:
        return None

    start_hour, end_hour = _timeout_offer_hours(lower)
    start = datetime.combine(date_start, datetime.min.time(), tzinfo=VASHON_TZ).replace(
        hour=start_hour
    )
    end = datetime.combine(date_end, datetime.min.time(), tzinfo=VASHON_TZ).replace(
        hour=end_hour
    )
    if start < now:
        start = now.replace(second=0, microsecond=0)
    if end <= start:
        end = start + _td(hours=3)
    return start, end


def _timeout_offer_hours(lower: str) -> tuple[int, int]:
    if re.search(r"\bmorn(?:ing)?\b", lower):
        return 8, 12
    if re.search(r"\bafternoon\b", lower):
        return 12, 17
    if re.search(r"\bevening\b", lower):
        return 17, 20
    if re.search(r"\b(?:during the day|daytime|day time|day)\b", lower):
        return 9, 17
    return 9, 17



def _timeout_offer_scope(text: str) -> str:
    lower = text.lower()
    if "weekend" in lower:
        return "this weekend"
    for phrase in (
        "today",
        "tomorrow",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
    ):
        if phrase in lower:
            return phrase
    return "then"


# ---------------------------------------------------------------------------
# Routing the agent's output
# ---------------------------------------------------------------------------
def _route_agent_output(
    *,
    output: AgentOutput,
    sender: UserDoc,
    target_opp: OpportunityDoc | None,
    clarify_streak: int,
    last_outbound: MessageDoc | None = None,
    inbound_doc_id: str,
    inbound_text: str,
    provider,
    known_farm_names: tuple[str, ...] = (),
) -> None:
    """Switch on `output.mode` and dispatch accordingly."""
    if output.mode == "reply":
        _reply_and_log(
            provider=provider, to=sender, body=output.reply_text,
            opp=target_opp, intent=IntentLabel.QUESTION,
        )
        return

    if output.mode == "clarify":
        effective_draft = _effective_intake_draft(
            output_draft=output.intake_draft,
            last_outbound=last_outbound,
            inbound_text=inbound_text,
            sender=sender,
        )
        # The clarify-cap rails fire only when we're about to SEND the
        # (cap+1)th consecutive CLARIFY about the SAME axis — never on the
        # inbound that answers the cap-hitting one, and never when the
        # agent moves on to ask about something different (which means the
        # prior question was effectively answered).
        reply_text = _sanitize_clarify_reply(
            body=output.reply_text,
            sender=sender,
            axis=_infer_clarify_axis(output.reply_text),
        )
        new_axis = _infer_clarify_axis(reply_text)
        replacement_axis = _next_unanswered_axis_if_already_answered(
            axis=new_axis,
            draft=effective_draft,
        )
        if replacement_axis is not None:
            reply_text = _question_for_axis(replacement_axis)
            new_axis = replacement_axis
        elif _draft_axis_answered(axis=new_axis, draft=effective_draft) and _draft_is_complete_post(effective_draft):
            if _send_complete_draft_confirmation(
                sender=sender,
                draft=effective_draft,
                target_opp=target_opp,
                source_message_id=inbound_doc_id,
                provider=provider,
            ):
                return
        prior_axis = getattr(last_outbound, "clarify_axis", None) if last_outbound else None
        effective_streak = clarify_streak if new_axis == prior_axis else 0
        if _enforce_clarify_caps(
            sender=sender, clarify_streak=effective_streak,
            inbound_doc_id=inbound_doc_id, provider=provider,
        ):
            return
        _send_clarify(
            sender=sender, body=reply_text,
            previous_streak=effective_streak, target_opp=target_opp, provider=provider,
            axis=new_axis,
            intake_draft=effective_draft,
        )
        return

    if output.mode == "confirm":
        # Pilot safety: window posts are deferred from the agent. If the flag is
        # off and the model still emitted a window_end_at, strip it here — before
        # the confirm prose and the executor see it — so the post collapses to a
        # single day. Deterministic backstop; the prompt also stops describing
        # windows, but a small model drifts, so the code is authoritative.
        _strip_window_if_disabled(output)
        effective_draft = _effective_intake_draft(
            output_draft=output.intake_draft,
            last_outbound=last_outbound,
            inbound_text=inbound_text,
            sender=sender,
        )
        # Server-side backstop: catch agent over-confirms on create_opportunity
        # where the agent has filled a required field from defaults rather than
        # the farmer's words. The prompt forbids this but smaller models drift —
        # detection signals are (1) parse_notes self-report containing "default"
        # or "inferred", and (2) inbound text lacking a time/activity marker
        # while parsed shows one. On detection we downgrade to clarify rather
        # than send the bad confirmation prose.
        reject_reason = _agent_overconfirm_reason(
            output=output, inbound_text=inbound_text, last_outbound=last_outbound,
            known_farm_names=known_farm_names,
            recent_inbound_texts=tuple(_recent_inbound_texts(sender)),
        )
        if reject_reason is not None:
            # Only flag for signals that indicate genuine model misbehavior
            # (filling required fields from no inbound signal, or self-
            # incriminating parse_notes). Signal 3 ("required fields still
            # missing") is the system working as designed — the user just
            # sees one more clarify turn, no admin attention needed.
            if _is_admin_worth_flagging(reject_reason):
                flags_repo.create(
                    FlagDoc(
                        message_id=inbound_doc_id,
                        flagged_by_user_id=sender.id,
                        reason=f"Agent over-confirmed (downgraded to clarify): {reject_reason}",
                        created_at=datetime.now(UTC),
                    )
                )
            # The downgrade emits a CLARIFY; apply the same caps as a
            # native agent-emitted clarify. The axis comes from the
            # backstop's reason string — it's structured enough to parse.
            downgrade_axis = _axis_from_overconfirm_reason(reject_reason)
            # Re-compute the streak against the inferred axis. The
            # `clarify_streak` we already have was computed against
            # `last_outbound.clarify_axis`; if the new axis differs the
            # streak is effectively 0 (we're asking about something new).
            effective_streak = (
                clarify_streak
                if last_outbound is not None
                and getattr(last_outbound, "clarify_axis", None) == downgrade_axis
                else 0
            )
            if _enforce_clarify_caps(
                sender=sender, clarify_streak=effective_streak,
                inbound_doc_id=inbound_doc_id, provider=provider,
            ):
                return
            _send_clarify(
                sender=sender,
                body=_clarify_for_overconfirm(reason=reject_reason),
                previous_streak=effective_streak, target_opp=target_opp, provider=provider,
                axis=downgrade_axis,
                intake_draft=effective_draft,
            )
            return

        # Pre-confirm validator for edit_opportunity: a headcount edit that
        # would drop below the seats already confirmed is a HARD BLOCK. The
        # prompt forbids it, and the executor (farmer_ops.apply_edit) raises
        # HeadcountTooLow — but catching it only at execute time means the
        # farmer is asked to confirm, replies YES, and only THEN is told no.
        # Catch it here so we never send the confirm prompt for an edit we
        # already know we'll refuse. Mirrors the create over-confirm backstop.
        edit_block = _edit_headcount_block_reply(output)
        if edit_block is not None:
            _reply_and_log(
                provider=provider, to=sender, body=edit_block,
                opp=target_opp, intent=IntentLabel.QUESTION,
            )
            return

        _send_pending_confirmation(
            sender=sender,
            output=output,
            target_opp=target_opp,
            source_message_id=inbound_doc_id,
            provider=provider,
            intake_draft=effective_draft,
        )
        return

    if output.mode == "execute":
        # The agent emitted execute directly (rare — mainly acknowledge_post_event).
        _execute_action(
            sender=sender, action_payload=_extract_action_payload(output),
            action_name=output.action.name if output.action else "",
            target_opp=target_opp, provider=provider,
        )
        return

    if output.mode == "escalate":
        urgency = output.escalation.urgency if output.escalation else "routine"
        reason = output.escalation.reason if output.escalation else "agent escalated"
        _handle_escalation(
            sender=sender, inbound_doc_id=inbound_doc_id, provider=provider,
            reason=reason, urgency=urgency,
            reply_body=output.reply_text or None,
            target_opp=target_opp,
        )
        return

    # Unknown mode — flag and fallback. Shouldn't happen given JSON schema validation.
    flags_repo.create(
        FlagDoc(
            message_id=inbound_doc_id,
            flagged_by_user_id=sender.id,
            reason=f"Agent emitted unknown mode={output.mode!r}",
            created_at=datetime.now(UTC),
        )
    )
    _reply_and_log(
        provider=provider, to=sender,
        body=templates.render_stuck_handoff(),
        opp=target_opp, intent=IntentLabel.ESCALATE,
    )


def _send_clarify(
    *,
    sender: UserDoc,
    body: str,
    previous_streak: int,
    target_opp: OpportunityDoc | None,
    provider,
    axis: str | None = None,
    intake_draft: dict | None = None,
) -> None:
    """Send a CLARIFY outbound, stamping the clarification_round counter and
    the axis being asked about (for per-axis streak counting)."""
    next_round = previous_streak + 1
    if axis is None:
        # Native agent clarify — infer the axis from the reply text.
        axis = _infer_clarify_axis(body)
    provider_id = safe_send(provider, to_phone=sender.phone, body=body)
    if provider_id is None:
        return
    messages_repo.create(
        MessageDoc(
            direction=MessageDirection.OUTBOUND,
            provider_msg_id=provider_id,
            user_id=sender.id,
            opportunity_id=target_opp.id if target_opp else None,
            body=body,
            intent_label=IntentLabel.CLARIFY,
            intake_draft=intake_draft,
            clarification_round=next_round,
            clarify_axis=axis,
            created_at=datetime.now(UTC),
        )
    )


# Keyword vocabularies for axis inference. Used when we don't have an
# explicit axis (native agent clarifies). The keywords below are designed to
# match phrasings the prompt's worked examples and clarify-tone guide
# produce — they're not a guarantee, but they're right most of the time at
# pilot scale, and a miss just lands the clarify in a fresh streak rather
# than causing an incorrect cap fire.
_AXIS_KEYWORDS: dict[str, tuple[str, ...]] = {
    "time": ("what time", "morning, afternoon", "what time of day", "start time", "how long"),
    "date": ("which day", "which date", "what day", "any specific day", "which one — mon"),
    "headcount": ("how many", "how many people", "how many helpers", "number of"),
    "activity": (
        "what kind of work", "what kind of help", "which activity",
        "harvest, weeding", "harvest, gleaning", "what activity",
        "what are all the activity",
    ),
    "deadline": ("by when", "when does it need", "what time should it be picked"),
    "produce": ("what's the produce", "what produce", "what surplus"),
    "destination": ("where should it go", "where to drop", "destination"),
    "opp_selection": (
        "which shift", "which post", "which opp", "which one", "which farm",
        "which day's",
    ),
}


def _is_admin_worth_flagging(reason: str) -> bool:
    """True iff the backstop's reason indicates genuine model misbehavior
    that warrants admin attention.

    Worth flagging:
      - signal 1: parse_notes self-report ("default", "inferred", etc.)
        — the agent literally narrated filling fields from defaults.
      - signal 2a: inbound has no clock-time signal
      - signal 2b: inbound has no activity word
      - signal 6: draft finalized with a default-filled time the farmer never
        gave. Like 2a, this is the model fabricating a required value and
        trying to post it — exactly the misbehavior the flag exists to surface.
        (It fires at most once per shift post, only when NO turn gave a time,
        so it is not noisy in the common case where the farmer states a time.)

    NOT worth flagging:
      - signal 3: required fields still missing after defaults
        This fires whenever the agent emits `create_opportunity` without
        every MVD axis filled — but that's also what happens during a
        normal multi-turn dialog where the agent has partial info and is
        moving toward completeness. The user sees one more clarify; that's
        the system working. Flagging here creates noise (3+ flags per
        farmer posting in the typical case).
      - signal 4: vague non-bucket time word after a time clarify
      - signal 5: crop-only offer below the floor
        Both are ordinary "one more clarify" refinement turns — the user
        gave a vague answer and gets re-asked. No admin attention needed.
    """
    if "required fields still missing" in reason:
        return False
    if "vague non-bucket time word" in reason or "below the offer" in reason:
        return False
    return True


def _axis_from_overconfirm_reason(reason: str) -> str:
    """Pull the axis name out of an `_agent_overconfirm_reason` return string.

    Reason strings look like:
      "parsed.starts_at filled but inbound text has no clock-time signal"
        → time
      "parsed.activity_tags=['weeding'] but inbound text has no activity word..."
        → activity
      "required fields still missing after defaults: ['date', 'time']"
        → return the FIRST missing axis (the streak counter handles one
          axis at a time; a multi-axis clarify gets the first one as its
          identity, which matches the user's experience of "I just got
          asked about date again")
      "parse_notes contains 'default'..."
        → "general" (no specific axis implied)
    """
    if (
        "no clock-time signal" in reason
        or "vague non-bucket time word" in reason
        or "default-filled on draft finalize" in reason
    ):
        return "time"
    if "no activity word" in reason or "below the offer" in reason:
        return "activity"
    if "required fields still missing" in reason:
        # Match in priority order. Date and time are the most common gaps.
        for axis in ("date", "time", "headcount", "activity",
                     "deadline", "produce", "destination"):
            if f"'{axis}'" in reason:
                return axis
    return "general"


# "you have two friday posts", "the morning harvest or the afternoon
# gleaning" — distinguishing-between-opps phrasings that the unstructured
# keyword scan can't reliably match.
_OPP_SELECTION_PATTERN = re.compile(
    r"\b("
    r"(?:two|three|four)\s+(?:mon|tue|wed|thu|fri|sat|sun)"
    r"|the\s+morning\s+(?:harvest|gleaning|weeding|planting|shift)"
    r"|the\s+afternoon\s+(?:harvest|gleaning|weeding|planting|shift)"
    r")\b",
    re.IGNORECASE,
)


def _infer_clarify_axis(body: str) -> str:
    """Infer the MVD axis the agent is asking about. Returns "general" if no
    confident match — that bucket groups truly-unclear clarifies together,
    which is the correct default for the streak counter."""
    lower = body.lower()
    if _OPP_SELECTION_PATTERN.search(lower):
        return "opp_selection"
    for axis, keywords in _AXIS_KEYWORDS.items():
        for kw in keywords:
            if kw in lower:
                return axis
    return "general"


_DATE_CLARIFY_DETAIL_PATTERN = re.compile(
    r"^(?P<prefix>\s*(?:what|which)\s+day\b.*?\bworks\s+best)"
    r"\s+for\s+.+\?\s*$",
    re.IGNORECASE,
)


def _sanitize_clarify_reply(*, body: str, sender: UserDoc, axis: str) -> str:
    """Trim accidental readback details from farmer MVD clarifications.

    Prompt rules forbid mini-readbacks in clarify mode; details belong in
    the later confirmation. This guard covers the common drift pattern without
    touching opp-selection clarifies, where labels are required to disambiguate.
    """
    if sender.role not in (UserRole.FARMER, UserRole.BOTH):
        return body
    if axis == "opp_selection":
        return body
    if axis != "date":
        return body

    match = _DATE_CLARIFY_DETAIL_PATTERN.match(body)
    if match:
        return f"{match.group('prefix').strip()}?"
    return body


def _recent_inbound_texts(sender: UserDoc, *, limit: int = 8) -> list[str]:
    """The sender's recent inbound message bodies (newest-first), used to check
    whether a value (e.g. a clock time) was ever actually stated by the user
    across a multi-turn draft — vs. invented from a farm default on the turn it
    appears in the draft."""
    texts: list[str] = []
    if sender.id:
        for msg in messages_repo.list_for_user(sender.id, limit=limit):
            if msg.direction == MessageDirection.INBOUND:
                texts.append(msg.body)
    return texts


def _effective_intake_draft(
    *,
    output_draft: dict | None,
    last_outbound: MessageDoc | None,
    inbound_text: str,
    sender: UserDoc,
) -> dict | None:
    """Merge model draft output with prior persisted draft without erasing
    already-known intake fields.

    The agent owns semantic interpretation, but persisted draft fields are
    turn memory. A later output must not drop a field the farmer already gave
    and then ask for it again.
    """
    previous = (
        last_outbound.intake_draft
        if last_outbound is not None and isinstance(last_outbound.intake_draft, dict)
        else None
    )
    recent_inbound_texts = _recent_inbound_texts(sender)
    return _merge_intake_draft_for_turn(
        output_draft=output_draft,
        previous_draft=previous,
        inbound_text=inbound_text,
        recent_inbound_texts=recent_inbound_texts,
        sender_role=sender.role,
    )


def _merge_intake_draft_for_turn(
    *,
    output_draft: dict | None,
    previous_draft: dict | None,
    inbound_text: str,
    recent_inbound_texts: list[str],
    sender_role: UserRole,
) -> dict | None:
    """Pure helper for intake draft repair; tested directly."""
    if not output_draft and not previous_draft:
        return None

    draft: dict = dict(previous_draft or {})
    for key, value in (output_draft or {}).items():
        if key == "missing_fields":
            continue
        previous_value = draft.get(key)
        if _draft_value_empty(value) and not _draft_value_empty(previous_value):
            continue
        draft[key] = value

    if sender_role in (UserRole.FARMER, UserRole.BOTH):
        _enrich_farmer_shift_draft(
            draft=draft,
            inbound_text=inbound_text,
            recent_inbound_texts=recent_inbound_texts,
        )

    missing = _missing_axes_for_draft(draft)
    if missing is not None:
        draft["missing_fields"] = missing
    elif output_draft and "missing_fields" in output_draft:
        draft["missing_fields"] = list(output_draft.get("missing_fields") or [])
    elif previous_draft and "missing_fields" in previous_draft:
        draft["missing_fields"] = list(previous_draft.get("missing_fields") or [])
    return draft


def _draft_value_empty(value: Any) -> bool:
    return value is None or value == "" or value == [] or value == {}


def _enrich_farmer_shift_draft(
    *, draft: dict, inbound_text: str, recent_inbound_texts: list[str],
) -> None:
    # Activity-model redesign: activity is free text, so there is no canonical
    # slug to deterministically backfill. The agent now captures activity_detail
    # directly; this enrichment is intentionally a no-op for the activity axis.
    # Kept as a seam in case a future deterministic shift-field repair is needed.
    return


def _missing_axes_for_draft(draft: dict | None) -> list[str] | None:
    if not draft:
        return None
    kind = draft.get("kind")
    if kind == "shift":
        missing: list[str] = []
        if not draft.get("starts_at") and not draft.get("window_end_at"):
            missing.append("date")
        if not draft.get("time_of_day_bucket") and not _draft_starts_at_has_clock(draft.get("starts_at")):
            missing.append("time")
        if not draft.get("headcount_open") and not draft.get("headcount_needed"):
            missing.append("headcount")
        if not (draft.get("activity_detail") or "").strip():
            missing.append("activity")
        return missing
    if kind == "pickup":
        missing = []
        if not draft.get("deadline_at"):
            missing.append("deadline")
        if not draft.get("produce_description"):
            missing.append("produce")
        if not draft.get("destination"):
            missing.append("destination")
        return missing
    if kind == "offer":
        return list(draft.get("missing_fields") or [])
    return None


def _draft_starts_at_has_clock(value: Any) -> bool:
    if not value:
        return False
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return False
    return dt.hour != 0 or dt.minute != 0 or dt.second != 0


def _next_unanswered_axis_if_already_answered(
    *, axis: str, draft: dict | None,
) -> str | None:
    if not draft or axis in ("general", "opp_selection"):
        return None
    missing = _missing_axes_for_draft(draft)
    if missing is None:
        return None
    if axis in missing:
        return None
    return missing[0] if missing else None


def _draft_axis_answered(*, axis: str, draft: dict | None) -> bool:
    if not draft or axis in ("general", "opp_selection"):
        return False
    missing = _missing_axes_for_draft(draft)
    return missing is not None and axis not in missing


def _draft_is_complete_post(draft: dict | None) -> bool:
    if not draft or draft.get("kind") not in ("shift", "pickup"):
        return False
    missing = _missing_axes_for_draft(draft)
    return missing == []


def _question_for_axis(axis: str) -> str:
    if axis == "activity":
        return "What kind of work is it?"
    question = _FIELD_QUESTIONS.get(axis, "what detail is still missing")
    return f"Almost there — {question}?"


def _send_complete_draft_confirmation(
    *,
    sender: UserDoc,
    draft: dict | None,
    target_opp: OpportunityDoc | None,
    source_message_id: str,
    provider,
) -> bool:
    """Send a confirmation when the repaired intake draft is complete but the
    model tried to clarify an already-answered axis."""
    if not draft or sender.role not in (UserRole.FARMER, UserRole.BOTH):
        return False
    try:
        parsed = ParsedOpportunity.model_validate(draft)
    except Exception:
        return False
    if _missing_required_reason(parsed=parsed) is not None:
        return False

    if target_opp is not None and target_opp.status == OpportunityStatus.DRAFT and target_opp.id:
        action_name = "update_draft_opportunity"
        payload = {"opp_id": target_opp.id, "parsed": parsed.model_dump(mode="json")}
    else:
        action_name = "create_opportunity"
        payload = {"parsed": parsed.model_dump(mode="json")}

    from datetime import timedelta as _td
    token = "YES"
    pending_payload = {
        "action": action_name,
        "token": token,
        "payload": payload,
        "source_message_id": source_message_id,
        "media_urls": _media_urls_from_message(source_message_id),
        "expires_at": (datetime.now(UTC) + _td(minutes=30)).isoformat(),
    }
    reply_text = f"Post {_farmer_posting_summary(parsed=parsed)}? Reply {token} to post."
    provider_id = safe_send(provider, to_phone=sender.phone, body=reply_text)
    if provider_id is None:
        return True
    messages_repo.create(
        MessageDoc(
            direction=MessageDirection.OUTBOUND,
            provider_msg_id=provider_id,
            user_id=sender.id,
            opportunity_id=target_opp.id if target_opp else None,
            body=reply_text,
            intent_label=IntentLabel.PENDING_CONFIRMATION,
            pending_action=pending_payload,
            intake_draft=draft,
            created_at=datetime.now(UTC),
        )
    )
    return True


def _send_pending_confirmation(
    *,
    sender: UserDoc,
    output: AgentOutput,
    target_opp: OpportunityDoc | None,
    source_message_id: str,
    provider,
    intake_draft: dict | None = None,
) -> None:
    """Send a PENDING_CONFIRMATION outbound, persisting the action payload
    so dispatch can execute it deterministically when the user replies with
    the token (or an affirmative variant).

    Guardrails enforced here, NOT trusted to the prompt:
      - The confirmation token is *derived deterministically* from the action
        (`_token_for_action`), not taken from the model. Any token the agent
        emitted is ignored. This makes invalid/colliding tokens impossible.
      - The action and its payload must round-trip through the discriminated
        union (handled by pydantic validation on AgentOutput).
    """
    settings = load_settings()
    if output.action is None:
        # Shouldn't happen — schema requires action for confirm mode.
        return
    token = _token_for_action(output.action.name)

    from datetime import timedelta as _td
    pending_payload = {
        "action": output.action.name,
        "token": token,
        "payload": _extract_action_payload(output),
        "source_message_id": source_message_id,
        "media_urls": _media_urls_from_message(source_message_id),
        "expires_at": (datetime.now(UTC) + _td(minutes=30)).isoformat(),
    }
    provider_id = safe_send(provider, to_phone=sender.phone, body=output.reply_text)
    if provider_id is None:
        return
    messages_repo.create(
        MessageDoc(
            direction=MessageDirection.OUTBOUND,
            provider_msg_id=provider_id,
            user_id=sender.id,
            opportunity_id=target_opp.id if target_opp else None,
            body=output.reply_text,
            intent_label=IntentLabel.PENDING_CONFIRMATION,
            pending_action=pending_payload,
            intake_draft=intake_draft,
            created_at=datetime.now(UTC),
        )
    )


def _strip_window_if_disabled(output: AgentOutput) -> None:
    """Pilot safety: when window posts are disabled, null out any window_end_at
    the agent emitted on a create/update-draft action, in place.

    This defers the entire multi-day-window subsystem from the agent's
    responsibilities for the pilot (farmers post one day at a time) — it shrinks
    the prompt surface a small model must get right without deleting the
    window code, which stays for post-pilot. No-op when the flag is on, when
    there's no action, or when the action isn't an opportunity create/update.
    """
    if load_settings().agent_window_posts_enabled:
        return
    if output.action is None:
        return
    if output.action.name not in ("create_opportunity", "update_draft_opportunity"):
        return
    payload = getattr(output.action, output.action.name, None)
    parsed = getattr(payload, "parsed", None) if payload is not None else None
    if parsed is not None and getattr(parsed, "window_end_at", None):
        parsed.window_end_at = None


def _agent_overconfirm_reason(
    *,
    output: AgentOutput,
    inbound_text: str,
    last_outbound: MessageDoc | None = None,
    known_farm_names: tuple[str, ...] = (),
    recent_inbound_texts: tuple[str, ...] = (),
) -> str | None:
    """Detect agent over-confirms — cases where a small model jumps to a
    confirm on input that gives it nothing to act on, where the right move is
    one more clarify. The backstop is the in-architecture answer to a weaker
    model's intermittent judgment lapses (it makes the adversarial behavior
    model-independent); it is deliberately narrow so it never second-guesses a
    valid confirm and turns the agent into a phone tree.

    Signals on **`create_opportunity`** (any one downgrades to clarify):

    1. **`parse_notes` self-report.** The agent prompt explicitly forbids
       filling required fields from defaults; despite that, smaller models
       sometimes do it AND write a self-incriminating note like "Start time
       from farm default". Scan for that phrase shape.
    2. **Inbound text doesn't justify a clock time.** If `starts_at` is set
       with a clock time but the farmer's inbound has no clock-time signal
       (digit, "am", "pm", "noon", "morning", etc.) AND no `time_of_day_bucket`
       was supplied, the agent inferred a time from nothing. A bucket-only
       resolution ("any day next week, morning") is a valid fuzzy shape and
       doesn't fire. (Activity is no longer policed here — it's free text now;
       see the removed Signal 2b note below.)
    3. **Required axes still missing after defaults are applied.** Mirrors
       the executor's `compute_missing_fields` axis check. If the agent
       emitted `create_opportunity` without a required axis (e.g.
       `headcount`), catch it here instead of letting the executor reject
       after the user has already confirmed with a token.

    Signals on **other actions** (checked first, before the create-only guard):

    4. **Vague-time answer accepted after a "what time?" clarify.** If the
       prior outbound was a CLARIFY about the time axis and the inbound is a
       vague non-bucket word ("anytime", "whenever", "flexible"), the model
       treated a non-answer as a value. Re-ask as a bucket choice. Fires on
       `create_opportunity` AND `update_draft_opportunity` — the draft case is
       the common one (the farmer's first message set the draft, the clarify
       asked the time), and is exactly why this is keyed on the clarify axis
       rather than on "no time signal in the draft" (which would wrongly fire
       on legitimate carry-forward draft updates).
    5. **Crop-only volunteer offer below the floor.** A `record_offer` whose
       inbound names a crop but carries no time signal is too vague to be a
       useful offer ("help with tomatoes this week"). Clarify instead of
       recording a useless offer. A real offer with a time window ("physical
       work this weekend, some morning") has a time signal and passes.
    6. **Draft-update finalizing a shift with a default-filled time.** An
       `update_draft_opportunity` that confirms a shift whose clock-time
       `starts_at` was never stated by the farmer in ANY turn (invented from
       the farm's typical_start_hour default) → re-ask the time. This is
       signal 2a generalized across the multi-turn draft: it checks every
       recent inbound, not just the current one (`recent_inbound_texts`), so a
       time legitimately given on an earlier turn still passes.

    `update_draft_opportunity` is otherwise NOT policed (signals 1-3): it
    legitimately carries fields forward from the existing draft, so the current
    inbound need not restate activity / time markers, and its executor handles
    missing-fields via the draft merge. Signals 4 and 6 are the two narrow
    exceptions — both catch a VALUE the farmer never gave being treated as real.

    Returns None if no issue, or a short reason string for the flag.
    """
    if output.action is None:
        return None

    text_lower_pre = inbound_text.lower()
    prior_axis = getattr(last_outbound, "clarify_axis", None) if last_outbound else None
    prior_was_clarify = (
        last_outbound is not None
        and getattr(last_outbound, "intent_label", None) == IntentLabel.CLARIFY
    )

    # Signal 4: a non-answer to a "what time?" clarify, accepted as a value.
    # Two shapes, both gated on the prior outbound being a time CLARIFY (so a
    # legitimate affirmative to a PENDING_CONFIRMATION — handled deterministically
    # before the agent runs — is never in scope here):
    #   (a) a vague non-bucket time word ("anytime", "whenever", "flexible"), or
    #   (b) a bare affirmative ("yes", "ok") that answers nothing.
    # In both cases a small model sometimes invents a clock time from a default.
    # Applies to create and draft-update (the draft case is the common one).
    if (
        output.action.name in ("create_opportunity", "update_draft_opportunity")
        and prior_was_clarify
        and prior_axis == "time"
        and (
            _inbound_is_vague_time(text_lower_pre)
            or _inbound_is_bare_affirmative(text_lower_pre)
        )
    ):
        return (
            "inbound is a vague non-bucket time word after a time CLARIFY "
            "(not a valid time-of-day bucket); re-ask as morning/afternoon/evening"
        )

    # Signal 5: crop-only volunteer offer with no time window — below the
    # offer floor. ("help with tomatoes this week" → clarify; an offer with a
    # real time window like "this weekend, some morning" passes.)
    #
    # A NAMED FARM clears the offer floor on its own (the prompt's rule), so an
    # offer that mentions a known farm is recordable even with vague timing —
    # do NOT fire. This also guards the false positive where a farm NAME
    # contains a crop word ("Plum Forest" → "plum"): the farm-name check runs
    # first, so a directed offer is never mistaken for a bare-crop offer.
    if (
        output.action.name == "record_offer"
        and _inbound_has_crop_word(text_lower_pre)
        and not _inbound_has_time_signal(text_lower_pre)
        and not _inbound_names_known_farm(text_lower_pre, known_farm_names)
    ):
        return (
            "record_offer names a crop with no time window — below the offer "
            "floor (too vague to record a useful offer)"
        )

    # Signal 6: a draft-update that FINALIZES a shift with a clock-time
    # `starts_at` that the farmer never stated — i.e. invented from the farm's
    # typical_start_hour default on this turn. Signals 1-2a catch this on
    # `create_opportunity` by checking the inbound for a time signal, but they
    # skip `update_draft_opportunity` because a draft legitimately carries
    # values forward from earlier turns. The fix: check ALL recent inbound turns
    # of this draft, not just the current one. If no inbound across the whole
    # conversation has a time signal AND there is no fuzzy bucket, a clock time
    # in the draft can only have come from a default → re-ask the time.
    if output.action.name == "update_draft_opportunity":
        du_payload = getattr(output.action, "update_draft_opportunity", None)
        du_parsed = getattr(du_payload, "parsed", None) if du_payload else None
        if (
            du_parsed is not None
            and du_parsed.kind == "shift"
            and _draft_starts_at_has_clock(du_parsed.starts_at)
            and not getattr(du_parsed, "time_of_day_bucket", None)
            and not any(
                _inbound_has_time_signal(t.lower())
                for t in (inbound_text, *recent_inbound_texts)
            )
        ):
            return (
                "parsed.starts_at has a clock time but no inbound turn stated a "
                "time (default-filled on draft finalize); re-ask the time"
            )

    if output.action.name != "create_opportunity":
        return None
    payload = getattr(output.action, output.action.name, None)
    if payload is None:
        return None
    parsed = getattr(payload, "parsed", None)
    if parsed is None:
        return None

    text_lower = inbound_text.lower()

    # Signal 1: parse_notes self-report. The agent prompt forbids filling
    # required fields from defaults, but smaller models sometimes do it and
    # then helpfully self-incriminate in parse_notes.
    notes = (getattr(parsed, "parse_notes", "") or "").lower()
    smell_phrases = ("default", "inferred", "typical", "assumed", "guessing")
    for phrase in smell_phrases:
        if phrase in notes:
            return f"parse_notes contains '{phrase}': {notes[:120]!r}"

    # Signal 2a: starts_at set but no time marker in inbound AND no fuzzy
    # time-of-day bucket was supplied. With Stage 1 of the rethink, fuzzy
    # time is a first-class shape (time_of_day_bucket); the only failure
    # mode is "agent inferred a clock time from nothing." A bucket on its
    # own is a valid resolution, so don't fire on bucket-only posts.
    if (
        parsed.kind == "shift"
        and parsed.starts_at
        and not getattr(parsed, "time_of_day_bucket", None)
        and not _inbound_has_time_signal(text_lower)
    ):
        return "parsed.starts_at filled but inbound text has no clock-time signal"

    # Signal 2c removed (PR 3): date-range phrasings ("any day Mon-Fri",
    # "next week", "weekend") are now a *trigger* for the agent to set
    # window_end_at rather than a backstop rejection. The agent is expected
    # to recognize the phrasing and emit a window post; only single-day
    # collapses without a time signal still fire (signal 2a above).

    # Signal 2b (crop-only inference). Activity is free text now, so we no
    # longer police *which* slug — but a bare crop name still isn't an activity
    # ("tomatoes" could be harvest, weeding, or transplanting). If the agent
    # filled `activity_detail` while the inbound names a crop and contains NO
    # work word, it inferred the work from the crop. Downgrade to clarify so the
    # farmer says what the work actually is. (Product decision 2026-05-31: keep
    # clarifying on crops even under the free-text model.)
    if (
        parsed.kind == "shift"
        and (getattr(parsed, "activity_detail", "") or "").strip()
        and _inbound_has_crop_word(text_lower)
        and not _inbound_has_work_word(text_lower)
    ):
        return (
            "activity_detail set but inbound names only a crop, no work word "
            "(possible crop->activity inference)"
        )

    # Signal 3: required fields still missing after farm defaults are applied.
    # Mirrors the executor — catches the case where the agent emits confirm
    # without (e.g.) headcount_needed, the user says YES, then the executor
    # rejects with a raw-field-name error.
    return _missing_required_reason(parsed=parsed)


def _edit_headcount_block_reply(output: AgentOutput) -> str | None:
    """If the agent drafted an `edit_opportunity` that would drop
    `headcount_needed` below the opp's current `seats_filled`, return the
    user-facing reply explaining the block. Otherwise return None.

    Looks up the opp by the action payload's own `opp_id` (authoritative)
    rather than `target_opp` (which is anchored to the last outbound and may
    differ). Read-only — no state change here; this is a pre-confirm gate.
    """
    if output.action is None or output.action.name != "edit_opportunity":
        return None
    payload = getattr(output.action, "edit_opportunity", None)
    if payload is None:
        return None
    new_headcount = (payload.field_updates or {}).get("headcount_needed")
    if new_headcount is None:
        return None
    try:
        new_headcount = int(new_headcount)
    except (TypeError, ValueError):
        return None
    opp = opportunities_repo.get_by_id(payload.opp_id)
    if opp is None:
        return None
    if new_headcount < opp.seats_filled:
        return templates.render_edit_headcount_too_low(
            currently_filled=opp.seats_filled
        )
    return None


def _missing_required_reason(*, parsed) -> str | None:
    """Apply farm defaults and run compute_missing_fields; return a reason
    string if anything is still missing, else None. Mirrors the executor.

    Imported lazily to avoid a circular import with app.agent.parser at
    module load time (parser doesn't import dispatch, but keeping the import
    local keeps the call site obvious)."""
    from app.agent.parser import _apply_farm_defaults, compute_missing_fields
    # We don't have the sender's farm at this point in the call site; the
    # missing-fields check is on hard-required fields (starts_at,
    # headcount_needed, activity_tags) — none of which are defaulted. So
    # passing an empty defaults dict is sound for the check: the executor's
    # later _apply_farm_defaults can only fill optional fields like
    # duration_min, which never appear in REQUIRED_SHIFT_FIELDS.
    parsed_defaulted = _apply_farm_defaults(parsed=parsed, farm_defaults={})
    missing = compute_missing_fields(parsed_defaulted)
    if not missing:
        return None
    return f"required fields still missing after defaults: {missing}"


_TIME_SIGNAL_PATTERN = re.compile(
    r"("
    # 9am / 9 am / 9:30 / 9:30am / 9 a.m. / 9 p.m.
    r"\b\d{1,2}\s*(am|pm|a\.m\.|p\.m\.|:\d{2})"
    # 9a / 9p / 9 a / 9 p — common shorthand. Anchored on a leading word
    # boundary; trailing must end the run (whitespace, punctuation, EOL).
    r"|\b\d{1,2}\s*[ap](?:\b|[^a-zA-Z])"
    # Bare hour in a TIME-GIVING context: a time preposition before the number
    # ("at 9", "around 10", "by 8", "about 7", "~10"), OR "10ish" / "10 o'clock".
    # Requires the context so a bare headcount/duration/date number ("need 2",
    # "for 3 hours", "the 5th") does NOT register as a time. Excludes a trailing
    # unit word (people/ppl/person/hour/hr/min/day/week) to be safe.
    r"|(?:\b(?:at|around|about|by|near)|~)\s*\d{1,2}(?!\s*(?:am|pm|:|"
    r"\s*(?:people|ppl|persons?|folks?|volunteers?|helpers?|hands?|"
    r"hours?|hrs?|mins?|minutes?|days?|weeks?)))\b"
    r"|\b\d{1,2}\s*ish\b"
    r"|\bnoon\b|\bmidnight\b"
    r"|\b(early\s+|late\s+)?(morning|afternoon|evening|night|midday)\b"
    r"|\bdawn\b|\bdusk\b"
    r"|o'?clock"
    r")",
    re.IGNORECASE,
)


def _inbound_has_time_signal(text_lower: str) -> bool:
    """True if the inbound text has any clock-time signal the agent could
    reasonably resolve into `starts_at`. Lenient — we'd rather pass through
    a marginal case than block a valid post."""
    return bool(_TIME_SIGNAL_PATTERN.search(text_lower))


# Common Vashon-farm crops. A bare crop name is NOT an activity — it could be
# harvest, weeding, transplanting, or a surplus pickup. Used by the over-confirm
# backstop to catch "tomatoes Friday 9am" being posted as work.
#
# This list is INTENTIONALLY NOT comprehensive, and should not be made so. It's
# a best-effort backstop, not a crop registry. A crop that's absent just means
# that one post isn't caught here — the agent's prompt-level "clarify on a bare
# crop" rule is the first line of defense, and the confirm readback + UNDO rail
# catch a wrong guess regardless. Chasing completeness would re-create the
# closed-vocabulary problem the activity-model redesign removed. Add an obvious
# local crop if it comes up in practice; don't try to enumerate every plant.
_CROP_WORDS = (
    "tomato", "tomatoes", "lettuce", "kale", "chard", "spinach", "greens",
    "potato", "potatoes", "carrot", "carrots", "beet", "beets", "squash",
    "zucchini", "cucumber", "cucumbers", "pepper", "peppers", "bean", "beans",
    "pea", "peas", "corn", "garlic", "onion", "onions", "berry", "berries",
    "strawberr", "blueberr", "raspberr", "apple", "apples", "pear", "pears",
    "grape", "grapes", "plum", "plums", "cherr", "pumpkin", "pumpkins",
    "herb", "herbs", "flower", "flowers",
)

# Words that signal the WORK itself (not the crop). If any is present, the
# activity is grounded in something the farmer actually said about the task.
_WORK_WORDS = (
    "harvest", "harvesting", "pick", "picking", "pull", "pulling",
    "weed", "weeding", "plant", "planting", "transplant", "transplanting",
    "seed", "seeding", "prune", "pruning", "till", "tilling", "dig", "digging",
    "wash", "washing", "pack", "packing", "process", "processing", "sort",
    "sorting", "build", "fix", "repair", "fence", "fencing", "feed", "feeding",
    "muck", "haul", "hauling", "load", "loading", "clear", "clearing",
    "prep", "spread", "mulch", "water", "watering", "forage", "foraging",
    "glean", "gleaning", "work", "help", "hands",
)


def _inbound_has_crop_word(text_lower: str) -> bool:
    return any(re.search(rf"\b{re.escape(w)}", text_lower) for w in _CROP_WORDS)


def _inbound_has_work_word(text_lower: str) -> bool:
    return any(re.search(rf"\b{re.escape(w)}", text_lower) for w in _WORK_WORDS)


def _inbound_names_known_farm(text_lower: str, known_farm_names: tuple[str, ...]) -> bool:
    """True if the inbound mentions a known farm by name. A named farm clears
    the volunteer-offer floor, so the crop-only backstop (signal 5) must not
    fire on a directed offer ("can I help at Plum Forest this week?"). Also
    prevents a crop word inside a farm name (Plum Forest → "plum") from being
    mistaken for a bare-crop offer."""
    return any(name and name.lower() in text_lower for name in known_farm_names)


# Vague non-answers to a "what time?" clarify. These are NOT valid time-of-day
# buckets (the prompt is explicit: "'anytime' / 'whenever' is NOT a valid
# bucket"). A small model sometimes accepts one as if it resolved the time and
# jumps to a confirm; the backstop catches that and re-asks as a bucket choice.
# Real buckets ("morning", "afternoon", "evening") are matched by
# _TIME_SIGNAL_PATTERN and never reach this list.
_VAGUE_TIME_WORDS = (
    "anytime", "any time", "whenever", "whenevs", "no preference",
    "doesn't matter", "doesnt matter", "don't care", "dont care",
    "you pick", "you choose", "up to you", "flexible", "open",
)


def _inbound_is_vague_time(text_lower: str) -> bool:
    """True if the inbound is a vague non-answer to a time question (and has no
    real clock-time/bucket signal). 'anytime', 'whenever', 'flexible' — words
    that look like an answer but give the scheduler nothing to act on."""
    if _inbound_has_time_signal(text_lower):
        return False
    stripped = text_lower.strip().strip(".!?")
    return any(
        stripped == w or re.search(rf"\b{re.escape(w)}\b", stripped)
        for w in _VAGUE_TIME_WORDS
    )


# Bare affirmatives. After a content question ("what time?"), one of these
# answers nothing — a small model sometimes treats it as assent and fills the
# missing value from a default. Mirrors hotkeys._AFFIRMATIVE.
_BARE_AFFIRMATIVES = frozenset(
    {"yes", "ok", "okay", "sure", "confirm", "go", "go ahead", "yep", "yeah", "yup", "y"}
)


def _inbound_is_bare_affirmative(text_lower: str) -> bool:
    """True if the inbound is ONLY a bare affirmative (no other content). A bare
    'yes' to a 'what time?' clarify answers nothing; the model must re-ask, not
    invent a time. (This is distinct from a 'yes' confirming a PENDING_CONFIRMATION
    — that path is handled deterministically before the agent ever runs.)"""
    return text_lower.strip().strip(".!?") in _BARE_AFFIRMATIVES


_PURPOSE_LABELS = {
    "gleaning": "gleaning / food-access opportunities",
    "farm_help": "general farm help",
}


def _purpose_label(purpose: str) -> str:
    """User-facing label for a purpose value, used in mute acks."""
    return _PURPOSE_LABELS.get(purpose, purpose)


# Axis name → farmer-facing question fragment. Keys match the axis names
# returned by app.agent.parser.compute_missing_fields; values are designed
# to compose naturally inside "Almost there — <question>?".
_FIELD_QUESTIONS = {
    "date": "which day",
    "time": "what time should it start",
    "headcount": "how many people do you need",
    "activity": "what kind of work",
    "deadline": "when does it need to be picked up by",
    "produce": "what's the produce",
    "destination": "where should it go",
}


def _clarify_for_overconfirm(*, reason: str) -> str:
    """User-facing clarify body for the agent-over-confirm backstop.

    Translates the backstop's internal reason string into a friendly question
    the farmer can answer. Never leaks raw schema field names."""
    # Signal 3 path: required axes still missing. Reason looks like
    # "required fields still missing after defaults: ['time', 'headcount']".
    if "required fields still missing" in reason:
        # Cheap parse — pull axis names that match our known set.
        missing = [name for name in _FIELD_QUESTIONS if name in reason]
        if missing:
            questions = [_FIELD_QUESTIONS[n] for n in missing]
            if len(questions) == 1:
                return f"Almost there — {questions[0]}?"
            joined = ", ".join(questions[:-1]) + f", and {questions[-1]}"
            return f"Almost there — {joined}?"

    # Signal 4: vague non-answer to a time clarify — re-ask as a bucket choice.
    if "vague non-bucket time word" in reason:
        return "Got it — roughly when? Morning, afternoon, or evening?"
    # Signal 5: crop-only offer below the floor — ask for the work + a day.
    if "below the offer" in reason:
        return "Happy to help line that up — what kind of work, and which day works?"
    # Signal 6: draft finalized with a default-filled time — ask the real time.
    if "default-filled on draft finalize" in reason:
        return "What time should it start?"
    # Signal 2a: starts_at inferred from no time signal.
    if "time" in reason:
        return "What time should it start, and how long?"
    # Signal 2b: activity_tags inferred from crop name.
    if "activity" in reason:
        return "What kind of work — harvest, weeding, transplanting, or something else?"
    # Signal 1 (parse_notes self-report) or anything unrecognized.
    return "A few details are still missing — what time should it start, and what kind of work?"


# Deterministic confirmation token per action. Token *selection* is no longer
# trusted to the model: only the latest outbound's PENDING_CONFIRMATION is ever
# live, and the inbound matcher accepts any affirmative variant (YES/OK/SURE/…)
# in addition to the stored token, so a distinct per-action token is never
# functionally required. Picking it here removes a whole class of small-model
# failures (invalid 4-letter strings, collisions with reserved hotkeys, prose
# that says "Reply YES" while the stored token is something else). `YES` is the
# universal default; `undo_last` keeps `UNDO` because that is itself a
# deterministic hotkey the user is told to send.
def _token_for_action(action_name: str | None) -> str:
    """Return the deterministic confirmation token for an action name."""
    if action_name == "undo_last":
        return "UNDO"
    return "YES"


def _extract_action_payload(output: AgentOutput) -> dict:
    """Pull the populated payload sub-model into a plain dict for persistence."""
    if output.action is None:
        return {}
    payload_obj = getattr(output.action, output.action.name, None)
    if payload_obj is None:
        return {}
    return payload_obj.model_dump(exclude_none=False, mode="json")


# ---------------------------------------------------------------------------
# Executing the persisted action (called when user confirms via token)
# ---------------------------------------------------------------------------
def _execute_pending_action(
    *,
    sender: UserDoc,
    pending: dict,
    last_outbound: MessageDoc,
    provider,
) -> None:
    """The user confirmed a pending action via token. Execute the persisted
    payload deterministically — no LLM call here."""
    target_opp = (
        opportunities_repo.get_by_id(last_outbound.opportunity_id)
        if last_outbound.opportunity_id else None
    )
    action_payload = dict(pending.get("payload") or {})
    if pending.get("source_message_id"):
        action_payload["_source_message_id"] = pending["source_message_id"]
    if pending.get("media_urls"):
        action_payload["_media_urls"] = list(pending.get("media_urls") or [])
    _execute_action(
        sender=sender,
        action_payload=action_payload,
        action_name=pending.get("action") or "",
        target_opp=target_opp,
        provider=provider,
    )


def _execute_action(
    *,
    sender: UserDoc,
    action_payload: dict,
    action_name: str,
    target_opp: OpportunityDoc | None,
    provider,
) -> None:
    """Run the named action and send a receipt SMS.

    Each action maps to an existing flow function (or a small new one for
    the refactor-introduced actions: set_availability, set_activity_preferences,
    record_offer, undo_last). After the action runs, an ACTION_RECEIPT outbound
    is sent so the user sees what happened and can UNDO it.
    """
    receipt_body: str | None = None
    receipt_opp_id: str | None = None
    executed_payload = {
        "action": action_name,
        "payload": action_payload,
        "executed_at": datetime.now(UTC).isoformat(),
        "undo_token": "UNDO",
    }

    if action_name == "claim_opportunity":
        receipt_body, receipt_opp_id = _execute_claim_opportunity(
            sender=sender, payload=action_payload, provider=provider,
        )
    elif action_name == "record_maybe":
        receipt_body, receipt_opp_id = _execute_record_maybe(
            sender=sender, payload=action_payload,
        )
    elif action_name == "drop_confirmed_claim":
        receipt_body, receipt_opp_id = _execute_drop_confirmed_claim(
            sender=sender, payload=action_payload, provider=provider,
        )
    elif action_name == "cancel_opportunity":
        receipt_body, receipt_opp_id = _execute_cancel_opportunity(
            sender=sender, payload=action_payload, provider=provider,
        )
    elif action_name == "edit_opportunity":
        receipt_body, receipt_opp_id = _execute_edit_opportunity(
            sender=sender, payload=action_payload, provider=provider,
        )
    elif action_name == "create_opportunity":
        receipt_body, receipt_opp_id = _execute_create_opportunity(
            sender=sender, payload=action_payload, provider=provider,
        )
    elif action_name == "update_draft_opportunity":
        receipt_body, receipt_opp_id = _execute_update_draft_opportunity(
            sender=sender, payload=action_payload, provider=provider,
        )
    elif action_name == "acknowledge_post_event":
        receipt_body, receipt_opp_id = _execute_acknowledge_post_event(
            sender=sender, payload=action_payload, provider=provider,
        )
    elif action_name == "add_mute_rule":
        receipt_body, receipt_opp_id = _execute_add_mute_rule(
            sender=sender, payload=action_payload,
        )
    elif action_name == "set_availability":
        receipt_body, receipt_opp_id = _execute_set_availability(
            sender=sender, payload=action_payload,
        )
    elif action_name == "set_activity_preferences":
        receipt_body, receipt_opp_id = _execute_set_activity_preferences(
            sender=sender, payload=action_payload,
        )
    elif action_name == "record_offer":
        receipt_body, receipt_opp_id = _execute_record_offer(
            sender=sender, payload=action_payload,
        )
    elif action_name == "farmer_decide_on_proposal":
        receipt_body, receipt_opp_id = _execute_farmer_decide_on_proposal(
            sender=sender, payload=action_payload, provider=provider,
        )
    else:
        # Unknown action — flag and bail. Schema validation should have caught this.
        flags_repo.create(
            FlagDoc(
                message_id=None,
                flagged_by_user_id=sender.id,
                reason=f"Unknown action_name in execute: {action_name!r}",
                created_at=datetime.now(UTC),
            )
        )
        return

    if receipt_body is None:
        # Execution failed (e.g. opp not found) — receipt_body=None means
        # something went wrong and the action-specific helper already replied
        # with a contextual error. No ACTION_RECEIPT in that case.
        return

    # Send the receipt SMS. Stamping it as ACTION_RECEIPT enables UNDO for
    # the next inbound from this user.
    receipt_media_urls = _action_receipt_media_urls(
        action_name=action_name,
        receipt_opp_id=receipt_opp_id,
        receipt_body=receipt_body,
    )
    provider_id = safe_send(
        provider, to_phone=sender.phone, body=receipt_body,
        media_urls=receipt_media_urls,
    )
    if provider_id is None:
        return
    messages_repo.create(
        MessageDoc(
            direction=MessageDirection.OUTBOUND,
            provider_msg_id=provider_id,
            user_id=sender.id,
            opportunity_id=receipt_opp_id,
            body=receipt_body,
            media_urls=receipt_media_urls,
            intent_label=IntentLabel.ACTION_RECEIPT,
            executed_action=executed_payload,
            created_at=datetime.now(UTC),
        )
    )


def _action_receipt_media_urls(
    *, action_name: str, receipt_opp_id: str | None, receipt_body: str,
) -> list[str]:
    if action_name != "claim_opportunity" or not receipt_opp_id:
        return []
    opp = opportunities_repo.get_by_id(receipt_opp_id)
    if opp is None:
        return []
    return _confirmed_pickup_media_urls(opp, receipt_body)


def _confirmed_pickup_media_urls(opp: OpportunityDoc, body: str) -> list[str]:
    if opp.kind != OpportunityKind.PICKUP:
        return []
    if not body.startswith("Confirmed:"):
        return []
    return list(opp.media_urls or [])


# ---------------------------------------------------------------------------
# Per-action executors
# Each returns (receipt_body, receipt_opp_id_or_None). receipt_body=None on
# failure (the executor already replied with an error message).
# ---------------------------------------------------------------------------
def _execute_claim_opportunity(*, sender: UserDoc, payload: dict, provider) -> tuple[str | None, str | None]:
    opp_id = payload.get("opp_id")
    slots = int(payload.get("slots", 1) or 1)
    if not opp_id:
        return None, None
    opp = opportunities_repo.get_by_id(opp_id)
    if opp is None:
        safe_send(provider, to_phone=sender.phone,
                  body="That post is no longer available.")
        return None, None
    farm = farms_repo.get_by_id(opp.farm_id)
    farmer = users_repo.get_by_id(farm.owner_user_id) if farm else None
    reply = claim_flow.handle_claim(
        messaging=provider,
        opportunity=opp,
        volunteer=sender,
        slots=slots,
        farm_name=farm.name if farm else "the farm",
        notify_farmer_phone=farmer.phone if farmer else None,
    )
    # `handle_claim` already returns the user-facing ack text; we use that
    # plus a one-line UNDO hint as the receipt.
    receipt = f"{reply} Reply UNDO if that wasn't right."
    return receipt, opp_id


def _execute_record_maybe(*, sender: UserDoc, payload: dict) -> tuple[str | None, str | None]:
    opp_id = payload.get("opp_id")
    if not opp_id:
        return None, None
    opp = opportunities_repo.get_by_id(opp_id)
    if opp is None:
        return None, None
    farm = farms_repo.get_by_id(opp.farm_id)
    reply = claim_flow.handle_maybe(
        opportunity=opp,
        volunteer=sender,
        farm_name=farm.name if farm else "the farm",
    )
    receipt = f"{reply} Reply UNDO if that wasn't right."
    return receipt, opp_id


def _execute_drop_confirmed_claim(*, sender: UserDoc, payload: dict, provider) -> tuple[str | None, str | None]:
    opp_id = payload.get("opp_id")
    if not opp_id:
        return None, None
    opp = opportunities_repo.get_by_id(opp_id)
    if opp is None:
        return None, None
    reply = claim_flow.handle_volunteer_drop(
        messaging=provider, opportunity=opp, volunteer=sender,
    )
    receipt = f"{reply} Reply UNDO if that wasn't right."
    return receipt, opp_id


def _execute_cancel_opportunity(*, sender: UserDoc, payload: dict, provider) -> tuple[str | None, str | None]:
    opp_id = payload.get("opp_id")
    if not opp_id:
        return None, None
    opp = opportunities_repo.get_by_id(opp_id)
    if opp is None:
        return None, None
    farm = farms_repo.get_by_id(opp.farm_id)
    farm_name = farm.name if farm else "the farm"
    farmer_ops._do_cancel(opp=opp, farm_name=farm_name, messaging=provider)
    summary = farmer_ops.opp_short_summary(opp)
    receipt = (
        f"Farm Friend Vashon: cancelled {summary}. Confirmed volunteers "
        f"notified. Reply UNDO if wrong."
    )
    return receipt, opp_id


def _execute_edit_opportunity(*, sender: UserDoc, payload: dict, provider) -> tuple[str | None, str | None]:
    opp_id = payload.get("opp_id")
    raw_updates = payload.get("field_updates") or {}
    if not opp_id or not raw_updates:
        return None, None
    opp = opportunities_repo.get_by_id(opp_id)
    if opp is None:
        return None, None
    farm = farms_repo.get_by_id(opp.farm_id)
    farm_name = farm.name if farm else "the farm"
    field_updates = _normalize_edit_updates(raw_updates)
    try:
        updated = farmer_ops.apply_edit(
            opp=opp, field_updates=field_updates, farm_name=farm_name, messaging=provider,
        )
    except farmer_ops.HeadcountTooLow as e:
        safe_send(
            provider, to_phone=sender.phone,
            body=templates.render_edit_headcount_too_low(currently_filled=e.currently_filled),
        )
        return None, None
    summary = farmer_ops.opp_short_summary(updated)
    receipt = (
        f"Farm Friend Vashon: updated {summary}. Confirmed volunteers notified. "
        f"Reply UNDO if wrong."
    )
    return receipt, opp_id


def _execute_create_opportunity(*, sender: UserDoc, payload: dict, provider) -> tuple[str | None, str | None]:
    parsed_raw = payload.get("parsed") or {}
    source_message_id = payload.get("_source_message_id") or ""
    source_media_urls = list(payload.get("_media_urls") or [])
    parsed = ParsedOpportunity.model_validate(parsed_raw)
    # Apply farm defaults to optional fields the farmer didn't specify (the
    # agent prompt also describes this, but dispatch is the deterministic
    # backstop). Required fields are NEVER defaulted — they must come from
    # the farmer's words. See _apply_farm_defaults docstring.
    farm = farms_repo.get_by_owner(sender.id) if sender.id else None
    parsed = _apply_farm_defaults(parsed=parsed, farm_defaults=farm_defaults_dict(farm))
    # Server-authoritative missing-fields check — never trust the agent. The
    # over-confirm backstop in _route_agent_output should have caught this
    # before the user confirmed; if we reach here it means the backstop missed
    # something. Recover with a friendly clarify (no schema field names).
    missing = compute_missing_fields(parsed)
    if missing:
        flags_repo.create(
            FlagDoc(
                message_id=None,
                flagged_by_user_id=sender.id,
                reason=(
                    "Executor caught missing required fields the backstop should "
                    f"have rejected pre-confirm: {missing}"
                ),
                created_at=datetime.now(UTC),
            )
        )
        safe_send(
            provider, to_phone=sender.phone,
            body=_clarify_for_overconfirm(
                reason=f"required fields still missing after defaults: {missing}"
            ),
        )
        return None, None
    if farm is None or farm.id is None:
        return None, None
    opp_doc = _opportunity_from_parsed(
        farm_id=farm.id,
        parsed=parsed,
        source_message_id=source_message_id,
        media_urls=source_media_urls,
    )
    # Posts go live immediately on a successful create_opportunity execute —
    # the user has just confirmed via token, so no DRAFT bounce.
    opp_doc = opp_doc.model_copy(update={"status": OpportunityStatus.OPEN})
    created = opportunities_repo.create(opp_doc)
    outreach_flow.send_initial_outreach(opp=created, messaging=provider)
    summary = _farmer_posting_summary(parsed=parsed)
    receipt = (
        f"Farm Friend Vashon: posted {summary}. Pinging insiders now. "
        f"Reply UNDO if wrong."
    )
    return receipt, created.id


def _execute_update_draft_opportunity(*, sender: UserDoc, payload: dict, provider) -> tuple[str | None, str | None]:
    opp_id = payload.get("opp_id")
    parsed_raw = payload.get("parsed") or {}
    source_message_id = payload.get("_source_message_id") or ""
    source_media_urls = list(payload.get("_media_urls") or [])
    if not opp_id:
        return None, None
    parsed = ParsedOpportunity.model_validate(parsed_raw)
    # Apply farm defaults to optional fields before checking completeness.
    farm = farms_repo.get_by_owner(sender.id) if sender.id else None
    parsed = _apply_farm_defaults(parsed=parsed, farm_defaults=farm_defaults_dict(farm))
    missing = compute_missing_fields(parsed)
    if missing:
        safe_send(
            provider, to_phone=sender.phone,
            body=_clarify_for_overconfirm(
                reason=f"required fields still missing after defaults: {missing}"
            ),
        )
        return None, None
    # _merge_updates_for_opportunity recomputes post_event_checkin_at from the
    # new starts_at/deadline_at — important: an update_draft path that lands the
    # event time for the first time would otherwise leave checkin_at=None and
    # the post-event tick would never fire for the opp.
    field_updates = _merge_updates_for_opportunity(parsed=parsed)
    if source_media_urls:
        current = opportunities_repo.get_by_id(opp_id)
        if current is not None:
            field_updates["media_urls"] = _merge_unique_urls(
                current.media_urls, source_media_urls,
            )
    opportunities_repo.update_fields(opp_id, field_updates)
    opportunities_repo.update_status(opp_id, OpportunityStatus.OPEN)
    refreshed = opportunities_repo.get_by_id(opp_id)
    if refreshed is None:
        return None, None
    refreshed = refreshed.model_copy(update={"status": OpportunityStatus.OPEN})
    outreach_flow.send_initial_outreach(opp=refreshed, messaging=provider)
    summary = _farmer_posting_summary(parsed=parsed)
    receipt = (
        f"Farm Friend Vashon: posted {summary}. Pinging insiders now. "
        f"Reply UNDO if wrong."
    )
    return receipt, opp_id


def _execute_acknowledge_post_event(*, sender: UserDoc, payload: dict, provider) -> tuple[str | None, str | None]:
    opp_id = payload.get("opp_id")
    answer = (payload.get("answer") or "Y").upper()
    if not opp_id:
        return None, None
    opp = opportunities_repo.get_by_id(opp_id)
    if opp is None:
        return None, None
    reply = post_event_flow.handle_post_event_reply(
        messaging=provider,
        opportunity=opp,
        farmer_phone=sender.phone,
        answer=answer,
    )
    if answer == "N":
        flags_repo.create(
            FlagDoc(
                message_id=None,
                flagged_by_user_id=sender.id,
                reason="Post-event issue reported (N). Awaiting farmer detail.",
                created_at=datetime.now(UTC),
            )
        )
    # Post-event ACK doesn't need an UNDO offer — answering Y/N isn't reversible
    # in any meaningful way. We still send a receipt to acknowledge.
    return reply, opp_id


def _execute_add_mute_rule(*, sender: UserDoc, payload: dict) -> tuple[str | None, str | None]:
    if not sender.id:
        return None, None
    dim = payload.get("dimension")
    value = payload.get("value")
    if not dim or not value:
        return None, None
    try:
        dimension = MuteDimension(dim)
    except ValueError:
        return None, None
    mutes_repo.add(
        MuteRuleDoc(
            user_id=sender.id,
            dimension=dimension,
            value=value,
            created_at=datetime.now(UTC),
        )
    )
    receipt = (
        f"Farm Friend Vashon: muted {dim}={value}. Reply UNDO "
        f"if that wasn't right."
    )
    return receipt, None


def _execute_set_availability(*, sender: UserDoc, payload: dict) -> tuple[str | None, str | None]:
    if not sender.id:
        return None, None
    users_repo.update_availability(
        sender.id,
        available_days=payload.get("available_days") or [],
        available_start_hour=payload.get("available_start_hour"),
        available_end_hour=payload.get("available_end_hour"),
        max_commit_hours_per_week=payload.get("max_commit_hours_per_week"),
    )
    days = payload.get("available_days") or []
    days_str = ", ".join(_day_name(d) for d in days) if days else "no days set"
    receipt = (
        f"Farm Friend Vashon: availability set to {days_str}. Reply UNDO "
        f"if wrong."
    )
    return receipt, None


def _execute_set_activity_preferences(*, sender: UserDoc, payload: dict) -> tuple[str | None, str | None]:
    if not sender.id:
        return None, None
    add = payload.get("add") or []
    remove = payload.get("remove") or []
    if not add and not remove:
        return None, None
    current = set(sender.activity_preferences or [])
    current.update(add)
    current.difference_update(remove)
    new_prefs = sorted(current)
    users_repo.update_activity_preferences(sender.id, new_prefs)
    parts = []
    if add:
        parts.append(f"added {', '.join(add)}")
    if remove:
        parts.append(f"removed {', '.join(remove)}")
    receipt = (
        f"Farm Friend Vashon: preferences updated ({'; '.join(parts)}). "
        f"Reply UNDO if wrong."
    )
    return receipt, None


def _execute_farmer_decide_on_proposal(
    *, sender: UserDoc, payload: dict, provider,
) -> tuple[str | None, str | None]:
    """Farmer accepts or declines a PROPOSED claim via the unified agent's
    natural-language path. Mirrors the deterministic ACCEPT/DECLINE hotkey
    handler — same proposals_flow entrypoint."""
    from app.flows import proposals as proposals_flow
    token = str(payload.get("token", "")).upper()
    decision = payload.get("decision")
    if not token or decision not in ("accept", "decline"):
        return None, None
    if sender.role not in (UserRole.FARMER, UserRole.BOTH):
        safe_send(
            provider, to_phone=sender.phone,
            body="ACCEPT/DECLINE are for farmers.",
        )
        return None, None
    reply = proposals_flow.handle_farmer_decision(
        messaging=provider, farmer=sender, token=token, decision=decision,
    )
    # Don't tack on the UNDO suffix here — auto-confirm and farmer-decline
    # both have explicit forward exits (DROP or text another day). UNDO
    # is fine if needed but the receipt copy stays clean.
    return reply, None


# Vague-openness phrases that mean "open to anything," not a concrete task.
# On an offer, these are normalized to an empty activity_detail so the matcher
# treats the volunteer as flexible (product decision 2026-05-31). The model is
# told this in the prompt too, but small models sometimes capture the phrase
# literally ("Physical work"); this is the deterministic backstop.
_VAGUE_OPENNESS = (
    "physical work", "any physical", "some work", "any work", "anything",
    "whatever", "wherever needed", "help out", "helping out", "pitch in",
    "lend a hand", "general help", "general farm work", "open to anything",
    "whatever's needed", "whatever is needed", "be useful", "help where",
)


def _normalize_offer_activity_detail(raw: str) -> str:
    """Collapse vague-openness phrasings to empty; keep concrete tasks as-is."""
    s = raw.strip()
    if not s:
        return ""
    low = s.lower()
    if any(phrase in low for phrase in _VAGUE_OPENNESS):
        return ""
    return s


def _execute_record_offer(*, sender: UserDoc, payload: dict) -> tuple[str | None, str | None]:
    if not sender.id:
        return None, None
    from app.repos import offers_repo
    from app.repos.models import OfferDoc
    from datetime import timedelta as _td

    settings = load_settings()
    activity_detail = _normalize_offer_activity_detail(payload.get("activity_detail") or "")
    purpose_raw = payload.get("purpose")
    purpose = OpportunityPurpose(purpose_raw) if purpose_raw else None
    earliest_at = _parse_iso(payload["earliest_at"]) if payload.get("earliest_at") else None
    latest_at = _parse_iso(payload["latest_at"]) if payload.get("latest_at") else None
    note = payload.get("note") or ""
    now = datetime.now(UTC)
    expires_at = latest_at or (now + _td(days=settings.offer_default_ttl_days))
    offer = OfferDoc(
        volunteer_user_id=sender.id,
        purpose=purpose,
        activity_detail=activity_detail,
        earliest_at=earliest_at,
        latest_at=latest_at,
        note=note,
        status="open",
        created_at=now,
        expires_at=expires_at,
    )
    offers_repo.create(offer)
    # Short, passive, no first-person. The UNDO hint stays because every
    # ACTION_RECEIPT carries it (uniform UNDO rail across actions). See style
    # rules in prompts/agent.md.
    receipt = (
        "Farm Friend Vashon: Your offer has been recorded. "
        "Reply UNDO if wrong."
    )
    return receipt, None


def _undo_last_executed_action(
    *,
    sender: UserDoc,
    last_outbound: MessageDoc,
    provider,
) -> None:
    """Reverse the action recorded on the last ACTION_RECEIPT.

    Each reversible action's inverse is inlined here. The receipt that was
    sent on execute persisted the full payload, so we have everything we need.
    The undo itself sends a confirmation SMS but does NOT stamp another
    ACTION_RECEIPT (UNDO-of-UNDO would be a confusing rabbit hole).
    """
    executed = last_outbound.executed_action or {}
    action_name = executed.get("action") or ""
    payload = executed.get("payload") or {}

    undid_what: str = ""

    if action_name == "claim_opportunity":
        opp_id = payload.get("opp_id")
        if opp_id:
            opp = opportunities_repo.get_by_id(opp_id)
            if opp:
                claim_flow.handle_volunteer_drop(
                    messaging=provider, opportunity=opp, volunteer=sender,
                )
                undid_what = "your claim"
    elif action_name == "drop_confirmed_claim":
        # Re-claiming after a drop is best-effort — the seat may have been
        # taken. We try; if it fails the user sees the failure message.
        opp_id = payload.get("opp_id")
        if opp_id:
            opp = opportunities_repo.get_by_id(opp_id)
            if opp:
                farm = farms_repo.get_by_id(opp.farm_id)
                claim_flow.handle_claim(
                    messaging=provider, opportunity=opp, volunteer=sender,
                    slots=1, farm_name=farm.name if farm else "the farm",
                    notify_farmer_phone=None,  # don't double-notify on undo
                )
                undid_what = "your drop (re-claimed if seat still open)"
    elif action_name == "set_availability":
        # We don't store the prior availability anywhere, so we can't truly
        # undo. Surface that honestly.
        safe_send(
            provider, to_phone=sender.phone,
            body=(
                "Can't auto-undo an availability change since I don't track "
                "the previous values. Reply with the days you want set."
            ),
        )
        return
    elif action_name == "set_activity_preferences":
        # Reverse the add/remove.
        if sender.id:
            add_orig = payload.get("add") or []
            remove_orig = payload.get("remove") or []
            current = set(sender.activity_preferences or [])
            current.difference_update(add_orig)  # un-add
            current.update(remove_orig)          # un-remove
            users_repo.update_activity_preferences(sender.id, sorted(current))
            undid_what = "your preference change"
    elif action_name == "record_offer":
        # Best-effort: find the most recent open offer for this user and cancel it.
        from app.repos import offers_repo
        if sender.id:
            offers = offers_repo.list_open_for_volunteer(sender.id)
            if offers:
                # Most recent first.
                offers.sort(key=lambda o: o.created_at, reverse=True)
                if offers[0].id:
                    offers_repo.set_status(offers[0].id, status="cancelled")
                    undid_what = "your offer"
    elif action_name == "add_mute_rule":
        # We could find-and-delete by (user_id, dimension, value), but the
        # mutes_repo doesn't have that query. Honest about the limitation:
        safe_send(
            provider, to_phone=sender.phone,
            body=(
                "Can't auto-undo that mute. Text MUTE again or reply here if "
                "you need it removed sooner."
            ),
        )
        return
    elif action_name == "farmer_decide_on_proposal":
        # The volunteer has already been notified about the decision.
        # An UNDO would require finding the now-CONFIRMED/DROPPED claim and
        # flipping it back without confusing the volunteer about their
        # status. Don't try — surface honestly and offer a forward action.
        safe_send(
            provider, to_phone=sender.phone,
            body=(
                "Can't auto-undo a proposal decision — the volunteer has "
                "been notified. Reply here if you need to reverse it."
            ),
        )
        return
    elif action_name == "create_opportunity":
        opp_id = last_outbound.opportunity_id
        if opp_id:
            opp = opportunities_repo.get_by_id(opp_id)
            if opp and opp.id:
                farm = farms_repo.get_by_id(opp.farm_id)
                farm_name = farm.name if farm else "the farm"
                opportunities_repo.update_status(opp.id, OpportunityStatus.CANCELLED)
                _notify_opportunity_rescinded(
                    opp=opp,
                    farm_name=farm_name,
                    provider=provider,
                )
                undid_what = "your post; notified anyone already pinged or signed up"
    elif action_name in ("cancel_opportunity", "edit_opportunity"):
        # These fan out without storing the prior opportunity snapshot, so we
        # avoid pretending we can reconstruct the old state.
        safe_send(
            provider, to_phone=sender.phone,
            body=(
                "That change was already sent to volunteers. Reply with the "
                "correction and I'll notify affected volunteers."
            ),
        )
        return
    elif action_name == "acknowledge_post_event":
        # No real-world side effect to undo; allow re-answering.
        undid_what = "your check-in answer"
    else:
        undid_what = "the last action"

    body = f"Farm Friend Vashon: undone — {undid_what}."
    provider_id = safe_send(provider, to_phone=sender.phone, body=body)
    if provider_id is None:
        return
    messages_repo.create(
        MessageDoc(
            direction=MessageDirection.OUTBOUND,
            provider_msg_id=provider_id,
            user_id=sender.id,
            opportunity_id=last_outbound.opportunity_id,
            body=body,
            intent_label=IntentLabel.UNDO,
            created_at=datetime.now(UTC),
        )
    )


def _notify_opportunity_rescinded(
    *, opp: OpportunityDoc, farm_name: str, provider,
) -> None:
    """Notify volunteers who saw or acted on a post that the farmer rescinded."""
    if not opp.id:
        return
    recipient_ids: set[str] = set()
    for entry in opportunities_repo.list_outreach(opp.id):
        recipient_ids.update(entry.recipient_ids or [])
    for claim in opportunities_repo.list_all_claims(opp.id):
        if claim.status != ClaimStatus.DROPPED:
            recipient_ids.add(claim.volunteer_user_id)
    if not recipient_ids:
        return
    body = templates.render_opportunity_cancelled(
        farm_name=farm_name,
        summary=farmer_ops.opp_short_summary(opp),
    )
    for uid in recipient_ids:
        user = users_repo.get_by_id(uid)
        if user is None:
            continue
        safe_send(provider, to_phone=user.phone, body=body)


def _day_name(d: int) -> str:
    return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][d % 7]
