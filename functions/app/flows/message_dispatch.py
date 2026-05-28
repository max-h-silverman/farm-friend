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
  9. Pre-agent: UNDO window (free-form UNDO inside a longer message).
 10. Otherwise → unified agent (one LLM call, one JSON output). Route on
     the output's `mode` (reply/clarify/confirm/execute/escalate).
 11. Post-agent rails: if the agent's mode is `clarify`, enforce the
     consecutive-streak cap and 24h soft cap BEFORE sending. The cap
     fires only when the agent — having seen the user's reply — still
     wants to clarify; never on the inbound that answers a clarify.
"""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from typing import Any

from firebase_functions import https_fn

from app.agent import hotkeys
from app.agent.parser import (
    ParsedOpportunity,
    _apply_farm_defaults,
    compute_missing_fields,
)
from app.agent.unified import (
    AgentContext,
    AgentOutput,
    ClaimSummary,
    MessageExcerpt,
    OppSummary,
    run_agent,
)
from app.config import load_settings
from app.copy import templates
from app.flows import claim as claim_flow
from app.flows import farmer_ops
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
from app.repos import (
    farms_repo,
    flags_repo,
    messages_repo,
    mutes_repo,
    opportunities_repo,
    pending_users_repo,
    users_repo,
)
from app.repos.models import (
    CANONICAL_ACTIVITIES,
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
    OpportunityStatus,
    PendingUserDoc,
    UserDoc,
    UserRole,
    UserStatus,
)


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
    _dispatch(inbound=inbound)
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

    known_activities = tuple()
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
    # Pre-agent dispatch steps (UNDO window) are deterministic and fire
    # BEFORE the agent runs — those paths never cost an LLM call.

    # PRE-AGENT: UNDO within the 5-minute window after an executed action.
    # UNDO as a bare hotkey is already handled by `_handle_hotkey` above;
    # this branch is reached if the user texts UNDO as part of a longer
    # message that didn't match the hotkey regex. Same semantics, same
    # window.
    if _looks_like_undo(inbound.body) and _is_recent_executed_action(
        last_outbound, window_min=settings.undo_window_min,
    ):
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
    context = _build_agent_context(
        sender=sender,
        last_outbound=last_outbound,
        target_opp=target_opp,
    )
    try:
        llm = get_llm_client(settings)
        output = run_agent(llm=llm, context=context, inbound_text=inbound.body)
    except Exception as e:  # LLMProviderError or anything else
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
            body=templates.render_fallback_ambiguous(),
            opp=target_opp, intent=IntentLabel.CLARIFY,
        )
        return

    _route_agent_output(
        output=output,
        sender=sender,
        target_opp=target_opp,
        clarify_streak=clarify_streak,
        inbound_doc_id=inbound_doc.id or "",
        inbound_text=inbound.body,
        provider=provider,
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

    if intent == IntentLabel.STOP_ACTIVITY:
        activity = str(match.payload.get("activity", ""))
        if sender.id and activity:
            mutes_repo.add(
                MuteRuleDoc(
                    user_id=sender.id,
                    dimension=MuteDimension.ACTIVITY,
                    value=activity,
                    created_at=datetime.now(UTC),
                )
            )
            _reply_and_log(
                provider=provider,
                to=sender,
                body=templates.render_mute_ack(what=activity),
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
                body="No farm on file for you yet — Max can set that up.",
                opp=target_opp,
                intent=intent,
            )
            return
        body = farmer_ops.handle_status(farm_id=farm.id)
        _reply_and_log(provider=provider, to=sender, body=body, opp=None, intent=intent)
        return

    if intent == IntentLabel.CANCEL:
        # Volunteer-on-reminder path: CANCEL after a confirmation reminder drops
        # the volunteer's claim on that opp. The reminder anchors target_opp
        # via opportunity_id on the outbound MessageDoc.
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
        if sender.role not in (UserRole.FARMER, UserRole.BOTH):
            _reply_and_log(
                provider=provider,
                to=sender,
                body="CANCEL is for farmers, or for volunteers replying to a shift reminder. Reply STOP to unsubscribe, MUTE to silence this thread.",
                opp=target_opp,
                intent=intent,
            )
            return
        farm = farms_repo.get_by_owner(sender.id) if sender.id else None
        if farm is None or farm.id is None:
            _reply_and_log(
                provider=provider,
                to=sender,
                body="No farm on file for you yet — Max can set that up.",
                opp=target_opp,
                intent=intent,
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
        slots = int(match.payload.get("slots", 1) or 1)
        reply = claim_flow.handle_claim(
            messaging=provider,
            opportunity=target_opp,
            volunteer=sender,
            slots=slots,
            farm_name=farm.name if farm else "the farm",
            notify_farmer_phone=farmer.phone if farmer else None,
        )
        _reply_and_log(provider=provider, to=sender, body=reply, opp=target_opp, intent=intent)
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
        # Reverse the most recent agent-executed action if within window.
        settings = load_settings()
        if _is_recent_executed_action(last_outbound, window_min=settings.undo_window_min):
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


def _farm_defaults_dict(farm) -> dict | None:
    if farm is None:
        return None
    return {
        "typical_start_hour": farm.typical_start_hour,
        "typical_shift_duration_min": farm.typical_shift_duration_min,
        "usual_days_of_week": farm.usual_days_of_week,
    }


def _merge_updates_for_opportunity(*, parsed) -> dict:
    """Translate a merged ParsedOpportunity into the dict of OpportunityDoc
    field updates to persist. Only includes fields that have a value, so we
    never blank a previously-set field."""
    updates: dict = {}
    if parsed.kind == "shift":
        if parsed.starts_at:
            starts = _parse_iso(parsed.starts_at)
            if starts:
                updates["starts_at"] = starts
                updates["post_event_checkin_at"] = _post_event_time_for(
                    kind=OpportunityKind.SHIFT, starts_at=starts, deadline_at=None
                )
        if parsed.headcount_needed:
            updates["headcount_needed"] = parsed.headcount_needed
        if parsed.duration_min:
            updates["duration_min"] = parsed.duration_min
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
    if urgency == "immediate" and settings.coordinator_phone:
        sender_label = sender.name or sender.phone
        admin_body = (
            f"[Farm Friend ESCALATE] {sender_label} ({sender.phone}): {reason}"
        )
        safe_send(provider, to_phone=settings.coordinator_phone, body=admin_body)


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


def _reply_and_log(
    *,
    provider,
    to: UserDoc,
    body: str,
    opp: OpportunityDoc | None,
    intent: IntentLabel,
) -> None:
    provider_id = safe_send(provider, to_phone=to.phone, body=body)
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


def _opportunity_from_parsed(*, farm_id: str, parsed, source_message_id: str) -> OpportunityDoc:
    """Translate the LLM-parsed shape into a persistable OpportunityDoc."""
    starts_at = _parse_iso(parsed.starts_at) if parsed.starts_at else None
    deadline_at = _parse_iso(parsed.deadline_at) if parsed.deadline_at else None
    kind = OpportunityKind.SHIFT if parsed.kind == "shift" else OpportunityKind.PICKUP
    post_event_at = _post_event_time_for(kind=kind, starts_at=starts_at, deadline_at=deadline_at)
    return OpportunityDoc(
        farm_id=farm_id,
        kind=kind,
        status=OpportunityStatus.DRAFT,
        starts_at=starts_at,
        deadline_at=deadline_at,
        duration_min=parsed.duration_min,
        headcount_needed=parsed.headcount_needed or 1,
        seats_filled=0,
        activity_tags=parsed.activity_tags or [],
        requirements_text=parsed.requirements_text or "",
        produce_description=parsed.produce_description,
        destination=parsed.destination,
        vehicle_needed=parsed.vehicle_needed,
        created_from_message_id=source_message_id,
        created_at=datetime.now(UTC),
        post_event_checkin_at=post_event_at,
    )


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
        headcount = parsed.headcount_needed or 1
        people = "1 person" if headcount == 1 else f"{headcount} people"
        activity = ", ".join(parsed.activity_tags) if parsed.activity_tags else "a shift"
        when_str: str
        starts_dt = _parse_iso(parsed.starts_at) if parsed.starts_at else None
        if starts_dt:
            when_str = format_day_and_range(starts_dt, parsed.duration_min)
        else:
            when_str = "soon"
        return f"{people} to help with {activity} {when_str}"
    if parsed.kind == "pickup":
        produce = parsed.produce_description or "surplus produce"
        deadline_dt = _parse_iso(parsed.deadline_at) if parsed.deadline_at else None
        when_str = format_deadline(deadline_dt) if deadline_dt else "today"
        dest = f", drop at {parsed.destination}" if parsed.destination else ""
        return f"pickup of {produce} {when_str}{dest}"
    return "posting"


# ===========================================================================
# Unified-agent dispatch helpers
# ===========================================================================
# Everything below is for the unified-agent path. The pre-agent functions
# (`_is_live_pending_confirmation`, `_is_recent_executed_action`, etc.) run
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


def _is_recent_executed_action(
    last_outbound: MessageDoc | None, *, window_min: int,
) -> bool:
    """True if `last_outbound` is an ACTION_RECEIPT executed within the UNDO
    window. Used both by the pre-agent UNDO branch and the hotkey UNDO branch."""
    if last_outbound is None:
        return False
    if last_outbound.intent_label != IntentLabel.ACTION_RECEIPT:
        return False
    executed = last_outbound.executed_action or {}
    executed_at_iso = executed.get("executed_at")
    if not executed_at_iso:
        return False
    try:
        executed_at = datetime.fromisoformat(executed_at_iso.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return False
    from datetime import timedelta as _td
    return datetime.now(UTC) - executed_at <= _td(minutes=window_min)


def _looks_like_undo(text: str) -> bool:
    """Loose check for free-form undo phrasing that didn't match the UNDO hotkey.
    Conservative — when in doubt, let the agent decide."""
    t = text.lower().strip()
    return t in {"undo", "undo!", "undo.", "undo that", "nevermind", "never mind"}


def _consecutive_clarify_count(
    *, user_id: str | None, since: MessageDoc | None,
) -> int:
    """Count of CLARIFY outbounds at the tail of this user's outbound stream.

    Walks the user's recent outbounds in reverse and counts consecutive
    CLARIFYs. The streak terminates at the first non-CLARIFY outbound, even
    if a `clarification_round` field on the latest CLARIFY would suggest a
    longer streak — what matters is the *user's* most recent experience.

    Why walk rather than read `clarification_round`: a non-CLARIFY outbound
    (an unrelated fan-out, a milestone, an ACTION_RECEIPT for a different
    opp) can sit between two CLARIFYs and falsely reset the in-stamped
    counter. Walking the actual stream is cheap at pilot scale and accurate.
    """
    if not user_id or since is None:
        return 0
    if since.intent_label != IntentLabel.CLARIFY:
        return 0
    # Walk back through this user's outbound stream until a non-CLARIFY appears.
    streak = 0
    for msg in messages_repo.list_for_user(user_id, limit=20):
        if msg.direction != MessageDirection.OUTBOUND:
            continue
        if msg.intent_label == IntentLabel.CLARIFY:
            streak += 1
        else:
            break
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
        body=templates.render_fallback_ambiguous(),
        opp=None, intent=IntentLabel.ESCALATE,
    )


# ---------------------------------------------------------------------------
# Building the agent context
# ---------------------------------------------------------------------------
def _build_agent_context(
    *,
    sender: UserDoc,
    last_outbound: MessageDoc | None,
    target_opp: OpportunityDoc | None,
) -> AgentContext:
    """Assemble the AgentContext payload the unified agent sees.

    Includes: sender state, recent message excerpts, the live pending action
    (if any), the live executed action (if within UNDO window), the sender's
    open claims (volunteer side), the sender's farm + open opps (farmer side),
    cross-cutting open opps across all farms (for queries / matching).
    """
    now_local = datetime.now(VASHON_TZ)

    # Sender's own confirmed/interested claims, lifted to ClaimSummary shape.
    sender_claims: list[ClaimSummary] = []
    if sender.id:
        # Walk the sender's recent messages to find opps they have claims on.
        # Cheaper than scanning every claim subcollection across all opps.
        recent_msgs = messages_repo.list_for_user(sender.id, limit=50)
        seen_opp_ids: set[str] = set()
        for msg in recent_msgs:
            if not msg.opportunity_id or msg.opportunity_id in seen_opp_ids:
                continue
            seen_opp_ids.add(msg.opportunity_id)
            claim = opportunities_repo.get_claim(
                opp_id=msg.opportunity_id, volunteer_user_id=sender.id,
            )
            if claim is None or claim.status == ClaimStatus.DROPPED:
                continue
            opp = opportunities_repo.get_by_id(msg.opportunity_id)
            if opp is None or opp.status in (
                OpportunityStatus.COMPLETED, OpportunityStatus.CANCELLED, OpportunityStatus.EXPIRED,
            ):
                continue
            farm = farms_repo.get_by_id(opp.farm_id)
            sender_claims.append(_claim_summary_from(opp=opp, claim=claim, farm=farm))

    # Farmer-side: own farm + open opps + defaults.
    sender_farm_id: str | None = None
    sender_farm_name: str | None = None
    sender_farm_defaults: dict | None = None
    sender_farm_open_opps: list[OppSummary] = []
    if sender.id and sender.role in (UserRole.FARMER, UserRole.BOTH):
        farm = farms_repo.get_by_owner(sender.id)
        if farm and farm.id:
            sender_farm_id = farm.id
            sender_farm_name = farm.name
            sender_farm_defaults = _farm_defaults_dict(farm)
            for opp in opportunities_repo.list_open_for_farm(farm.id):
                sender_farm_open_opps.append(_opp_summary_from(opp=opp, farm=farm))

    # Cross-cutting: all OPEN/FILLING opps system-wide. At pilot scale this
    # is small (2-3 farms × maybe 5 opps each). Revisit caps if it grows.
    cross_cutting: list[OppSummary] = []
    all_farms = {f.id: f for f in farms_repo.list_all() if f.id}
    for farm_id, farm in all_farms.items():
        if farm_id == sender_farm_id:
            continue  # already in sender_farm_open_opps
        for opp in opportunities_repo.list_open_for_farm(farm_id):
            cross_cutting.append(_opp_summary_from(opp=opp, farm=farm))

    # Live pending action and executed action, if alive.
    pending_action = None
    executed_action = None
    last_outbound_opp_summary: OppSummary | None = None
    if last_outbound is not None:
        if _is_live_pending_confirmation(last_outbound):
            pending_action = last_outbound.pending_action
        # Executed action freshness uses the configured UNDO window.
        settings = load_settings()
        if _is_recent_executed_action(last_outbound, window_min=settings.undo_window_min):
            executed_action = last_outbound.executed_action
        # Summarize the opp last_outbound was about, if any.
        if target_opp:
            farm = farms_repo.get_by_id(target_opp.farm_id)
            last_outbound_opp_summary = _opp_summary_from(opp=target_opp, farm=farm)

    # Per-opportunity message excerpt (last 5 on the targeted opp).
    opp_excerpt: list[MessageExcerpt] = []
    if target_opp and target_opp.id:
        for msg in messages_repo.list_for_opportunity(target_opp.id, limit=5):
            opp_excerpt.append(_excerpt_from(msg))

    # Per-user message excerpt: messages in the last 24h with a hard cap of
    # 20. Time-bounded so a multi-turn SMS dialog (clarify → answer → confirm)
    # stays coherent in context, but unrelated conversations from earlier in
    # the week don't bleed in. Hard cap protects against pathological bursts.
    user_excerpt: list[MessageExcerpt] = []
    if sender.id:
        from datetime import timedelta as _td
        since = datetime.now(UTC) - _td(hours=24)
        for msg in messages_repo.list_for_user_since(sender.id, since=since, hard_cap=20):
            user_excerpt.append(_excerpt_from(msg))

    # Mute summary — render as a list of "dim:value" strings for the prompt.
    mute_summary: list[str] = []
    if sender.id:
        for rule in mutes_repo.list_for_user(sender.id):
            mute_summary.append(f"{rule.dimension.value}:{rule.value}")

    return AgentContext(
        now_local_iso=now_local.isoformat(),
        sender_role=sender.role.value,
        sender_name=sender.name,
        sender_phone=sender.phone,
        sender_availability={
            "available_days": sender.available_days,
            "available_start_hour": sender.available_start_hour,
            "available_end_hour": sender.available_end_hour,
            "max_commit_hours_per_week": sender.max_commit_hours_per_week,
        },
        sender_activity_preferences=sender.activity_preferences,
        sender_mute_summary=mute_summary,
        sender_open_claims=sender_claims,
        sender_farm_id=sender_farm_id,
        sender_farm_name=sender_farm_name,
        sender_farm_defaults=sender_farm_defaults,
        sender_farm_open_opps=sender_farm_open_opps,
        last_outbound_body=last_outbound.body if last_outbound else None,
        last_outbound_intent=(
            last_outbound.intent_label.value if last_outbound and last_outbound.intent_label else None
        ),
        last_outbound_clarification_round=(
            last_outbound.clarification_round if last_outbound else 0
        ),
        last_outbound_opp_summary=last_outbound_opp_summary,
        pending_action=pending_action,
        executed_action=executed_action,
        cross_cutting_opps=cross_cutting,
        known_farms=[{"id": fid, "name": f.name} for fid, f in all_farms.items()],
        canonical_activities=list(CANONICAL_ACTIVITIES),
        opp_message_excerpt=opp_excerpt,
        user_recent_excerpt=user_excerpt,
    )


def _opp_summary_from(*, opp: OpportunityDoc, farm) -> OppSummary:
    activity_or_produce = (
        ", ".join(opp.activity_tags) if opp.kind == OpportunityKind.SHIFT
        else (opp.produce_description or "surplus")
    )
    return OppSummary(
        opp_id=opp.id or "",
        farm_name=farm.name if farm else "unknown farm",
        kind=opp.kind.value,
        status=opp.status.value,
        when_human=farmer_ops.opp_short_summary(opp),
        activity_or_produce=activity_or_produce,
        headcount_needed=opp.headcount_needed,
        seats_filled=opp.seats_filled,
        requirements_text=opp.requirements_text or "",
    )


def _claim_summary_from(*, opp: OpportunityDoc, claim, farm) -> ClaimSummary:
    activity_or_produce = (
        ", ".join(opp.activity_tags) if opp.kind == OpportunityKind.SHIFT
        else (opp.produce_description or "surplus")
    )
    return ClaimSummary(
        opp_id=opp.id or "",
        opp_kind=opp.kind.value,
        farm_name=farm.name if farm else "unknown farm",
        activity_or_produce=activity_or_produce,
        when_human=farmer_ops.opp_short_summary(opp),
        status=claim.status.value,
    )


def _excerpt_from(msg: MessageDoc) -> MessageExcerpt:
    return MessageExcerpt(
        direction=msg.direction.value,
        body=msg.body[:200],  # truncate long bodies
        intent_label=msg.intent_label.value if msg.intent_label else None,
        created_at_iso=msg.created_at.isoformat(),
    )


# ---------------------------------------------------------------------------
# Routing the agent's output
# ---------------------------------------------------------------------------
def _route_agent_output(
    *,
    output: AgentOutput,
    sender: UserDoc,
    target_opp: OpportunityDoc | None,
    clarify_streak: int,
    inbound_doc_id: str,
    inbound_text: str,
    provider,
) -> None:
    """Switch on `output.mode` and dispatch accordingly."""
    if output.mode == "reply":
        _reply_and_log(
            provider=provider, to=sender, body=output.reply_text,
            opp=target_opp, intent=IntentLabel.QUESTION,
        )
        return

    if output.mode == "clarify":
        # The clarify-cap rails fire only when we're about to SEND the
        # (cap+1)th consecutive CLARIFY — never on the inbound that
        # answers the cap-hitting one. The agent saw the answer and still
        # chose clarify, which is the signal that further asking won't
        # help and Max should take over.
        if _enforce_clarify_caps(
            sender=sender, clarify_streak=clarify_streak,
            inbound_doc_id=inbound_doc_id, provider=provider,
        ):
            return
        _send_clarify(
            sender=sender, body=output.reply_text,
            previous_streak=clarify_streak, target_opp=target_opp, provider=provider,
        )
        return

    if output.mode == "confirm":
        # Server-side backstop: catch agent over-confirms on create_opportunity
        # where the agent has filled a required field from defaults rather than
        # the farmer's words. The prompt forbids this but smaller models drift —
        # detection signals are (1) parse_notes self-report containing "default"
        # or "inferred", and (2) inbound text lacking a time/activity marker
        # while parsed shows one. On detection we downgrade to clarify rather
        # than send the bad confirmation prose.
        reject_reason = _agent_overconfirm_reason(output=output, inbound_text=inbound_text)
        if reject_reason is not None:
            flags_repo.create(
                FlagDoc(
                    message_id=inbound_doc_id,
                    flagged_by_user_id=sender.id,
                    reason=f"Agent over-confirmed (downgraded to clarify): {reject_reason}",
                    created_at=datetime.now(UTC),
                )
            )
            # The downgrade emits a CLARIFY; apply the same caps as a
            # native agent-emitted clarify.
            if _enforce_clarify_caps(
                sender=sender, clarify_streak=clarify_streak,
                inbound_doc_id=inbound_doc_id, provider=provider,
            ):
                return
            _send_clarify(
                sender=sender,
                body=_clarify_for_overconfirm(reason=reject_reason),
                previous_streak=clarify_streak, target_opp=target_opp, provider=provider,
            )
            return
        _send_pending_confirmation(
            sender=sender, output=output, target_opp=target_opp, provider=provider,
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
        body=templates.render_fallback_ambiguous(),
        opp=target_opp, intent=IntentLabel.CLARIFY,
    )


def _send_clarify(
    *,
    sender: UserDoc,
    body: str,
    previous_streak: int,
    target_opp: OpportunityDoc | None,
    provider,
) -> None:
    """Send a CLARIFY outbound, stamping the clarification_round counter."""
    next_round = previous_streak + 1
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
            clarification_round=next_round,
            created_at=datetime.now(UTC),
        )
    )


def _send_pending_confirmation(
    *,
    sender: UserDoc,
    output: AgentOutput,
    target_opp: OpportunityDoc | None,
    provider,
) -> None:
    """Send a PENDING_CONFIRMATION outbound, persisting the action payload
    so dispatch can execute it deterministically when the user replies with
    the token (or an affirmative variant).

    Guardrails enforced here, NOT trusted to the prompt:
      - Token must match the regex AND not collide with a reserved hotkey.
        If either check fails, we flag and reply with a generic clarify.
      - The action and its payload must round-trip through the discriminated
        union (handled by pydantic validation on AgentOutput).
    """
    settings = load_settings()
    token = (output.confirmation_token or "").upper()
    if not _is_valid_token(token):
        flags_repo.create(
            FlagDoc(
                message_id=None,  # not tied to a single inbound
                flagged_by_user_id=sender.id,
                reason=f"Agent proposed invalid confirmation token: {token!r}",
                created_at=datetime.now(UTC),
            )
        )
        _reply_and_log(
            provider=provider, to=sender,
            body=templates.render_fallback_ambiguous(),
            opp=target_opp, intent=IntentLabel.CLARIFY,
        )
        return

    if output.action is None:
        # Shouldn't happen — schema requires action for confirm mode.
        return

    from datetime import timedelta as _td
    pending_payload = {
        "action": output.action.name,
        "token": token,
        "payload": _extract_action_payload(output),
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
            created_at=datetime.now(UTC),
        )
    )


def _agent_overconfirm_reason(*, output: AgentOutput, inbound_text: str) -> str | None:
    """Detect agent over-confirms on create_opportunity.

    Three signals (any one is sufficient to downgrade to clarify):

    1. **`parse_notes` self-report.** The agent prompt explicitly forbids
       filling required fields from defaults; despite that, smaller models
       sometimes do it AND write a self-incriminating note like "Start time
       from farm default". Scan for that phrase shape.
    2. **Inbound text doesn't justify required-field values.** If `starts_at`
       is set but the farmer's inbound has no clock-time signal (digit, "am",
       "pm", "noon", "morning", etc.), the agent inferred. Same for
       `activity_tags` populated when the inbound has no activity word —
       only a crop name. Catches the "tomatoes 9am" case.
    3. **Required fields still missing after defaults are applied.** Mirrors
       the executor's `compute_missing_fields` check. If the agent emitted
       `create_opportunity` without a required field (e.g. `headcount_needed`),
       catch it here instead of letting the executor reject after the user
       has already confirmed with a token.

    Only checks `create_opportunity`. `update_draft_opportunity` legitimately
    carries fields forward from the existing draft (the prior turn established
    them), so the current inbound need not restate activity / time markers,
    and its own executor handles missing-fields via the draft merge.

    Returns None if no issue, or a short reason string for the flag.
    """
    if output.action is None:
        return None
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

    # Signal 2a: starts_at set but no time marker in inbound.
    if parsed.kind == "shift" and parsed.starts_at and not _inbound_has_time_signal(text_lower):
        return "parsed.starts_at filled but inbound text has no clock-time signal"

    # Signal 2c: inbound expresses date-flexibility ("any day", "monday to
    # friday", "next week", "whenever") but agent silently picked a single
    # starts_at. v1 only supports single-day shifts; until multi-day windows
    # land, the agent must clarify which specific day rather than guess.
    if (
        parsed.kind == "shift"
        and parsed.starts_at
        and _inbound_has_date_range_signal(text_lower)
    ):
        return (
            "parsed.starts_at filled from a date-range phrasing "
            "(any day / mon-fri / next week) — must clarify which day"
        )

    # Signal 2b: activity_tags populated with a canonical work-type slug, but
    # the inbound has no activity word — only a crop name. The "tomatoes 9am"
    # case. `tbd`/`flexible` are explicit choices and don't trigger this.
    if (
        parsed.kind == "shift"
        and parsed.activity_tags
        and not any(t in ("tbd", "flexible") for t in parsed.activity_tags)
        and not _inbound_has_activity_signal(text_lower)
    ):
        return (
            f"parsed.activity_tags={parsed.activity_tags!r} but inbound text has "
            "no activity word (possible crop-name-only inference)"
        )

    # Signal 3: required fields still missing after farm defaults are applied.
    # Mirrors the executor — catches the case where the agent emits confirm
    # without (e.g.) headcount_needed, the user says YES, then the executor
    # rejects with a raw-field-name error.
    return _missing_required_reason(parsed=parsed)


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
    r"\b("
    r"\d{1,2}\s*(am|pm|a\.m\.|p\.m\.|:\d{2})"  # 9am, 9:30, 9 pm
    r"|noon|midnight|morning|afternoon|evening|night|dawn|dusk"
    r"|early|late"
    r"|o'?clock"
    r")\b",
    re.IGNORECASE,
)


def _inbound_has_time_signal(text_lower: str) -> bool:
    """True if the inbound text has any clock-time signal the agent could
    reasonably resolve into `starts_at`. Lenient — we'd rather pass through
    a marginal case than block a valid post."""
    return bool(_TIME_SIGNAL_PATTERN.search(text_lower))


# Canonical activities + close-enough synonyms the agent prompt accepts. Keep
# in sync with the activity decision tree in prompts/agent.md.
_ACTIVITY_WORDS = (
    "harvest", "harvesting", "pick", "picking", "picked",
    "glean", "gleaning",
    "weed", "weeding", "weeds",
    "plant", "planting", "seed", "seeding",
    "transplant", "transplanting",
    "livestock", "animal", "animals", "chickens", "goats", "sheep",
    "infrastructure", "fence", "fencing", "repair", "build", "fix",
    "process", "processing",
    "tbd", "general", "anything", "whatever",
)


def _inbound_has_activity_signal(text_lower: str) -> bool:
    """True if the inbound contains any canonical activity word or close synonym."""
    for word in _ACTIVITY_WORDS:
        if re.search(rf"\b{re.escape(word)}\b", text_lower):
            return True
    return False


# Phrases that imply the farmer is offering a window of days, not picking one.
# v1 only supports single-day shifts (starts_at is a single datetime), so the
# agent must clarify to a specific day before confirming. This pattern is
# intentionally conservative — false positives just trigger an extra clarify.
_DATE_RANGE_PATTERN = re.compile(
    r"\b("
    r"any\s+day"
    r"|some\s+day"
    r"|whenever"
    r"|any\s*time\s+this"
    r"|any\s*time\s+next"
    r"|this\s+week"
    r"|next\s+week"
    r"|this\s+weekend"
    r"|next\s+weekend"
    r"|mon(day)?\s*(through|to|-|–|—)\s*fri(day)?"
    r"|mon(day)?\s*(through|to|-|–|—)\s*sun(day)?"
    r"|all\s+week"
    r"|every\s+day"
    r"|several\s+days"
    r"|a\s+few\s+days"
    r")\b",
    re.IGNORECASE,
)


def _inbound_has_date_range_signal(text_lower: str) -> bool:
    """True if the inbound expresses date-flexibility (a window of days)
    rather than a specific day. v1 can't honor a window with a single
    `starts_at`; the agent must clarify which day."""
    return bool(_DATE_RANGE_PATTERN.search(text_lower))


_FIELD_QUESTIONS = {
    "starts_at": "what time should it start",
    "deadline_at": "when does it need to be picked up by",
    "headcount_needed": "how many people do you need",
    "activity_tags": "what kind of work",
    "produce_description": "what's the produce",
    "destination": "where should it go",
}


def _clarify_for_overconfirm(*, reason: str) -> str:
    """User-facing clarify body for the agent-over-confirm backstop.

    Translates the backstop's internal reason string into a friendly question
    the farmer can answer. Never leaks raw schema field names."""
    # Signal 3 path: required fields still missing. Reason looks like
    # "required fields still missing after defaults: ['starts_at', 'headcount_needed']".
    if "required fields still missing" in reason:
        # Cheap parse — pull names that match our known field set.
        missing = [name for name in _FIELD_QUESTIONS if name in reason]
        if missing:
            questions = [_FIELD_QUESTIONS[n] for n in missing]
            if len(questions) == 1:
                return f"Almost there — {questions[0]}?"
            joined = ", ".join(questions[:-1]) + f", and {questions[-1]}"
            return f"Almost there — {joined}?"

    # Signal 2c: date-range phrasing collapsed to one day.
    if "date-range" in reason:
        return (
            "Got it — which specific day works best? I can post one shift "
            "now and you can text again to add more."
        )
    # Signal 2a: starts_at inferred from no time signal.
    if "time" in reason:
        return "What time should it start, and how long?"
    # Signal 2b: activity_tags inferred from crop name.
    if "activity_tags" in reason:
        return "What kind of work — harvest, weeding, transplanting, or something else?"
    # Signal 1 (parse_notes self-report) or anything unrecognized.
    return "A few details are still missing — what time should it start, and what kind of work?"


def _is_valid_token(token: str) -> bool:
    """Token must be exactly 4 uppercase letters and not collide with a hotkey.

    Two exceptions:
      - `YES` is the default/preferred confirmation token. The pending-token
        check runs BEFORE the hotkey parser when a live PENDING_CONFIRMATION
        is on the user's last outbound, so `YES` is unambiguously routed to
        confirmation in that context (and only falls through to claim-hotkey
        when no pending confirm exists).
      - `UNDO` may be used for the `undo_last` action — UNDO is itself a
        deterministic hotkey and the semantics line up.

    All other reserved hotkey words remain off-limits as tokens.
    """
    if token in ("YES", "UNDO"):
        return True
    if not re.match(r"^[A-Z]{4}$", token):
        return False
    return token not in hotkeys.RESERVED_HOTKEY_TOKENS


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
    _execute_action(
        sender=sender,
        action_payload=pending.get("payload") or {},
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
    is sent so the user sees what happened and can UNDO within the window.
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

    # Send the receipt SMS. Stamping it as ACTION_RECEIPT enables the UNDO
    # window for the next inbound from this user.
    provider_id = safe_send(provider, to_phone=sender.phone, body=receipt_body)
    if provider_id is None:
        return
    messages_repo.create(
        MessageDoc(
            direction=MessageDirection.OUTBOUND,
            provider_msg_id=provider_id,
            user_id=sender.id,
            opportunity_id=receipt_opp_id,
            body=receipt_body,
            intent_label=IntentLabel.ACTION_RECEIPT,
            executed_action=executed_payload,
            created_at=datetime.now(UTC),
        )
    )


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
    receipt = f"{reply} Reply UNDO within 5 min if that wasn't right."
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
    receipt = f"{reply} Reply UNDO within 5 min if that wasn't right."
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
    receipt = f"{reply} Reply UNDO within 5 min if that wasn't right."
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
        f"notified. Reply UNDO within 5 min if wrong."
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
        f"Reply UNDO within 5 min if wrong."
    )
    return receipt, opp_id


def _execute_create_opportunity(*, sender: UserDoc, payload: dict, provider) -> tuple[str | None, str | None]:
    parsed_raw = payload.get("parsed") or {}
    parsed = ParsedOpportunity.model_validate(parsed_raw)
    # Apply farm defaults to optional fields the farmer didn't specify (the
    # agent prompt also describes this, but dispatch is the deterministic
    # backstop). Required fields are NEVER defaulted — they must come from
    # the farmer's words. See _apply_farm_defaults docstring.
    farm = farms_repo.get_by_owner(sender.id) if sender.id else None
    parsed = _apply_farm_defaults(parsed=parsed, farm_defaults=_farm_defaults_dict(farm))
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
        farm_id=farm.id, parsed=parsed, source_message_id="",
    )
    # Posts go live immediately on a successful create_opportunity execute —
    # the user has just confirmed via token, so no DRAFT bounce.
    opp_doc = opp_doc.model_copy(update={"status": OpportunityStatus.OPEN})
    created = opportunities_repo.create(opp_doc)
    outreach_flow.send_initial_outreach(opp=created, messaging=provider)
    summary = _farmer_posting_summary(parsed=parsed)
    receipt = (
        f"Farm Friend Vashon: posted {summary}. Pinging insiders now. "
        f"Reply UNDO within 5 min if wrong."
    )
    return receipt, created.id


def _execute_update_draft_opportunity(*, sender: UserDoc, payload: dict, provider) -> tuple[str | None, str | None]:
    opp_id = payload.get("opp_id")
    parsed_raw = payload.get("parsed") or {}
    if not opp_id:
        return None, None
    parsed = ParsedOpportunity.model_validate(parsed_raw)
    # Apply farm defaults to optional fields before checking completeness.
    farm = farms_repo.get_by_owner(sender.id) if sender.id else None
    parsed = _apply_farm_defaults(parsed=parsed, farm_defaults=_farm_defaults_dict(farm))
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
        f"Reply UNDO within 5 min if wrong."
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
        f"Farm Friend Vashon: muted {dim}={value}. Reply UNDO within 5 min "
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
        f"within 5 min if wrong."
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
        f"Reply UNDO within 5 min if wrong."
    )
    return receipt, None


def _execute_record_offer(*, sender: UserDoc, payload: dict) -> tuple[str | None, str | None]:
    if not sender.id:
        return None, None
    from app.repos import offers_repo
    from app.repos.models import OfferDoc
    from datetime import timedelta as _td

    settings = load_settings()
    activity_tags = payload.get("activity_tags") or []
    earliest_at = _parse_iso(payload["earliest_at"]) if payload.get("earliest_at") else None
    latest_at = _parse_iso(payload["latest_at"]) if payload.get("latest_at") else None
    note = payload.get("note") or ""
    now = datetime.now(UTC)
    expires_at = latest_at or (now + _td(days=settings.offer_default_ttl_days))
    offer = OfferDoc(
        volunteer_user_id=sender.id,
        activity_tags=activity_tags,
        earliest_at=earliest_at,
        latest_at=latest_at,
        note=note,
        status="open",
        created_at=now,
        expires_at=expires_at,
    )
    offers_repo.create(offer)
    activity_str = ", ".join(activity_tags) if activity_tags else "helping out"
    receipt = (
        f"Farm Friend Vashon: recorded your offer ({activity_str}). I'll "
        f"reach out if something matches. Reply UNDO within 5 min if wrong."
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
                "Can't auto-undo that mute. Text MUTE again or contact Max if "
                "you need it removed sooner."
            ),
        )
        return
    elif action_name in ("cancel_opportunity", "create_opportunity", "edit_opportunity"):
        # Farmer actions — these have already fanned out to volunteers. We
        # don't auto-undo them in v1; reply explaining.
        safe_send(
            provider, to_phone=sender.phone,
            body=(
                "That change has already been sent to volunteers — can't "
                "auto-undo. Text Max if you need to reverse it."
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


def _day_name(d: int) -> str:
    return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][d % 7]
