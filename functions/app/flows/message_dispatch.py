"""Inbound message dispatch.

This is the brain that ties everything together. The webhook lands here;
from this point on we never talk to Telnyx directly — we use the messaging
provider abstraction.

Pipeline:
  1. Verify webhook signature (provider-specific).
  2. Parse payload into normalized InboundMessage.
  3. Look up sender. If unknown phone → handle as a JOIN candidate.
  4. Persist inbound message.
  5. Run hotkey parser (deterministic).
  6. If hotkey matched → dispatch to handler.
  7. Otherwise → LLM classifier; if confident → reply; else → ambiguous
     handler → reply or escalate.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from firebase_functions import https_fn

from app.agent import hotkeys
from app.agent.ambiguous import resolve_ambiguous
from app.agent.classifier import classify_reply
from app.agent.parser import (
    classify_farmer_message,
    merge_clarification_into_draft,
    parse_opportunity,
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

    known_activities = tuple()
    known_farms = tuple(f.name for f in farms_repo.list_all())
    match = hotkeys.parse(
        inbound.body,
        expecting_post_event_reply=expecting_post_event,
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

    # Farmer free-form posting (or clarification reply on an in-progress draft)?
    if sender.role in (UserRole.FARMER, UserRole.BOTH):
        farm = farms_repo.get_by_owner(sender.id) if sender.id else None
        if farm:
            # An open draft from this farm within the clarification window
            # short-circuits the "is this a posting?" check: any reply at all
            # within ~2h gets treated as an answer to the pending question.
            draft = _find_recent_draft(farm_id=farm.id or "")
            if draft is not None:
                _handle_clarification_reply(
                    sender=sender,
                    farm_id=farm.id or "",
                    farm_name=farm.name,
                    draft=draft,
                    inbound_text=inbound.body,
                    inbound_doc_id=inbound_doc.id or "",
                    provider=provider,
                )
                return
            # If there are open opps, route through the edit/cancel/new-post
            # triage. Otherwise fall through to the simpler new-post path.
            open_opps = opportunities_repo.list_open_for_farm(farm.id or "")
            if open_opps and len(inbound.body.strip()) > 4:
                _handle_farmer_message_with_open_opps(
                    sender=sender,
                    farm_id=farm.id or "",
                    farm_name=farm.name,
                    open_opps=open_opps,
                    inbound_text=inbound.body,
                    inbound_doc_id=inbound_doc.id or "",
                    provider=provider,
                )
                return
            if _looks_like_posting(inbound.body):
                _handle_farmer_post(
                    sender=sender,
                    farm_id=farm.id or "",
                    farm_name=farm.name,
                    inbound_text=inbound.body,
                    inbound_doc_id=inbound_doc.id or "",
                    provider=provider,
                )
                return

    # Otherwise: LLM classification path.
    _handle_llm_reply(
        sender=sender,
        target_opp=target_opp,
        last_outbound_body=last_outbound.body if last_outbound else None,
        inbound_text=inbound.body,
        inbound_doc_id=inbound_doc.id or "",
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
    safe_send(provider, to_phone=inbound.from_phone, body=templates.render_join_ack())


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


def _handle_farmer_message_with_open_opps(
    *,
    sender: UserDoc,
    farm_id: str,
    farm_name: str,
    open_opps: list[OpportunityDoc],
    inbound_text: str,
    inbound_doc_id: str,
    provider,
) -> None:
    """Triage a farmer message when their farm has at least one open opp.

    The LLM decides edit / cancel / new_post / clarify. On `new_post` we
    fall through to the existing _handle_farmer_post path so nothing else
    changes.
    """
    settings = load_settings()
    llm = get_llm_client(settings)
    now_local = datetime.now(VASHON_TZ)
    opp_dicts = [_opp_for_edit_prompt(o) for o in open_opps]
    decision = classify_farmer_message(
        llm=llm,
        farmer_message=inbound_text,
        open_opps=opp_dicts,
        now_local=now_local,
    )

    if decision.action == "escalate":
        _handle_escalation(
            sender=sender,
            inbound_doc_id=inbound_doc_id,
            provider=provider,
            reason=decision.escalation_reason,
            urgency=decision.escalation_urgency,
            reply_body=None,
        )
        return

    if decision.action == "clarify":
        safe_send(
            provider,
            to_phone=sender.phone,
            body=decision.clarification_question or "Which post are you referring to?",
        )
        return

    if decision.action == "cancel" and decision.opp_id:
        target = next((o for o in open_opps if o.id == decision.opp_id), None)
        if target is None:
            safe_send(provider, to_phone=sender.phone, body="Couldn't find that post.")
            return
        farmer_ops._do_cancel(opp=target, farm_name=farm_name, messaging=provider)
        safe_send(
            provider,
            to_phone=sender.phone,
            body=templates.render_cancel_confirmed(summary=farmer_ops.opp_short_summary(target)),
        )
        return

    if decision.action == "edit" and decision.opp_id:
        target = next((o for o in open_opps if o.id == decision.opp_id), None)
        if target is None:
            safe_send(provider, to_phone=sender.phone, body="Couldn't find that post.")
            return
        field_updates = _normalize_edit_updates(decision.field_updates)
        if not field_updates:
            safe_send(
                provider,
                to_phone=sender.phone,
                body="What should change? (time, headcount, requirements, drop location...)",
            )
            return
        try:
            updated = farmer_ops.apply_edit(
                opp=target,
                field_updates=field_updates,
                farm_name=farm_name,
                messaging=provider,
            )
        except farmer_ops.HeadcountTooLow as e:
            safe_send(
                provider,
                to_phone=sender.phone,
                body=templates.render_edit_headcount_too_low(currently_filled=e.currently_filled),
            )
            return
        safe_send(
            provider,
            to_phone=sender.phone,
            body=templates.render_edit_confirmed(summary=farmer_ops.opp_short_summary(updated)),
        )
        return

    # action == "new_post" — fall through to the existing handler.
    _handle_farmer_post(
        sender=sender,
        farm_id=farm_id,
        farm_name=farm_name,
        inbound_text=inbound_text,
        inbound_doc_id=inbound_doc_id,
        provider=provider,
    )


def _opp_for_edit_prompt(opp: OpportunityDoc) -> dict:
    """Shape an OpportunityDoc for the edit-triage LLM prompt."""
    return {
        "id": opp.id,
        "kind": opp.kind.value,
        "activity_or_produce": (
            ", ".join(opp.activity_tags) if opp.kind == OpportunityKind.SHIFT
            else (opp.produce_description or "surplus")
        ),
        "when_human": farmer_ops.opp_short_summary(opp),
        "headcount_needed": opp.headcount_needed,
        "seats_filled": opp.seats_filled,
    }


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


def _handle_farmer_post(
    *,
    sender: UserDoc,
    farm_id: str,
    farm_name: str,
    inbound_text: str,
    inbound_doc_id: str,
    provider,
) -> None:
    """Parse the farmer's free-form posting and create the opportunity.

    If required fields are missing, the opportunity is saved as a draft and
    a clarification question is sent. Outreach only fires when all required
    fields are present.
    """
    settings = load_settings()
    llm = get_llm_client(settings)
    now_local = datetime.now(VASHON_TZ)
    farm = farms_repo.get_by_id(farm_id)
    farm_defaults = _farm_defaults_dict(farm)

    parsed = parse_opportunity(
        llm=llm,
        farmer_message=inbound_text,
        farm_name=farm_name,
        now_local=now_local,
        farm_defaults=farm_defaults,
    )
    if parsed.kind == "other":
        # Two flavors: the parser thinks this is something the coordinator
        # needs to see (prefixed ESCALATE:), or it's just not a posting.
        notes = (parsed.parse_notes or "").strip()
        if notes.startswith("ESCALATE:"):
            reason = notes[len("ESCALATE:"):].strip()
            _handle_escalation(
                sender=sender,
                inbound_doc_id=inbound_doc_id,
                provider=provider,
                reason=reason,
                urgency="immediate" if _looks_immediate(reason) else "routine",
                reply_body=None,  # use the fallback handoff template
            )
            return
        flags_repo.create(
            FlagDoc(
                message_id=inbound_doc_id,
                flagged_by_user_id=sender.id,
                reason=f"Farmer message didn't parse as a posting: {parsed.parse_notes}",
                created_at=datetime.now(UTC),
            )
        )
        safe_send(
            provider,
            to_phone=sender.phone,
            body="Didn't quite parse that as a shift or pickup. Coordinator will follow up.",
        )
        return

    opp_doc = _opportunity_from_parsed(
        farm_id=farm_id, parsed=parsed, source_message_id=inbound_doc_id
    )

    if parsed.missing_fields:
        # Save as draft and ask the farmer for the missing details. No outreach.
        created = opportunities_repo.create(opp_doc)
        safe_send(
            provider,
            to_phone=sender.phone,
            body=templates.render_clarification(question=parsed.clarification_question),
        )
        return

    created = opportunities_repo.create(opp_doc)
    outreach_flow.send_initial_outreach(opp=created, messaging=provider)
    summary = _farmer_posting_summary(parsed=parsed)
    safe_send(
        provider,
        to_phone=sender.phone,
        body=templates.render_draft_complete(summary=summary),
    )


def _handle_clarification_reply(
    *,
    sender: UserDoc,
    farm_id: str,
    farm_name: str,
    draft: OpportunityDoc,
    inbound_text: str,
    inbound_doc_id: str,
    provider,
) -> None:
    """The farmer is replying to our clarification question for `draft`.

    Run the merge parser, persist the merged fields, and either: (a) re-ask
    if something is still missing, (b) cancel if the farmer bailed, or
    (c) flip to open + fire outreach if we're complete.
    """
    settings = load_settings()
    llm = get_llm_client(settings)
    now_local = datetime.now(VASHON_TZ)
    farm = farms_repo.get_by_id(farm_id)
    farm_defaults = _farm_defaults_dict(farm)
    draft_as_parsed = _parsed_from_opportunity(draft)

    merged = merge_clarification_into_draft(
        llm=llm,
        draft=draft_as_parsed,
        farmer_reply=inbound_text,
        farm_name=farm_name,
        now_local=now_local,
        farm_defaults=farm_defaults,
    )

    if merged.kind == "other":
        notes = (merged.parse_notes or "").strip()
        if notes.startswith("ESCALATE:"):
            reason = notes[len("ESCALATE:"):].strip()
            # Leave the draft as-is; the admin needs to see the full thread
            # and decide what to do with the in-progress opp.
            _handle_escalation(
                sender=sender,
                inbound_doc_id=inbound_doc_id,
                provider=provider,
                reason=reason,
                urgency="immediate" if _looks_immediate(reason) else "routine",
                reply_body=None,
            )
            return
        # Farmer cancelled the post.
        assert draft.id is not None
        opportunities_repo.update_status(draft.id, OpportunityStatus.CANCELLED)
        safe_send(provider, to_phone=sender.phone, body=templates.render_draft_cancelled())
        return

    assert draft.id is not None
    field_updates = _merge_updates_for_opportunity(parsed=merged)
    opportunities_repo.update_fields(draft.id, field_updates)

    if merged.missing_fields:
        safe_send(
            provider,
            to_phone=sender.phone,
            body=templates.render_clarification(question=merged.clarification_question),
        )
        return

    # All required fields are present. Reload the doc with the merged values,
    # flip to open, and send outreach.
    refreshed = opportunities_repo.get_by_id(draft.id)
    if refreshed is None:
        return
    opportunities_repo.update_status(draft.id, OpportunityStatus.OPEN)
    refreshed = refreshed.model_copy(update={"status": OpportunityStatus.OPEN})
    outreach_flow.send_initial_outreach(opp=refreshed, messaging=provider)
    summary = _farmer_posting_summary(parsed=merged)
    safe_send(
        provider,
        to_phone=sender.phone,
        body=templates.render_draft_complete(summary=summary),
    )


def _find_recent_draft(*, farm_id: str) -> OpportunityDoc | None:
    """Look back ~2h for a draft from this farm. We use the most recent.

    Two hours is the same window the stale-draft tick uses to flag abandoned
    drafts, so the boundaries line up: a farmer either finishes the dialog
    within the window, or it gets flagged for admin review.
    """
    from datetime import timedelta
    since = datetime.now(UTC) - timedelta(hours=2)
    drafts = opportunities_repo.list_recent_drafts_for_farm(farm_id=farm_id, since=since)
    return drafts[0] if drafts else None


def _farm_defaults_dict(farm) -> dict | None:
    if farm is None:
        return None
    return {
        "typical_start_hour": farm.typical_start_hour,
        "typical_shift_duration_min": farm.typical_shift_duration_min,
        "usual_days_of_week": farm.usual_days_of_week,
    }


def _parsed_from_opportunity(opp: OpportunityDoc):
    """Re-build a ParsedOpportunity-ish dict from a persisted draft so the merge
    parser sees what we already have. We pass datetimes back as ISO strings
    to match the original parser's wire format."""
    from app.agent.parser import ParsedOpportunity
    return ParsedOpportunity(
        kind="shift" if opp.kind == OpportunityKind.SHIFT else "pickup",
        starts_at=opp.starts_at.isoformat() if opp.starts_at else None,
        duration_min=opp.duration_min,
        headcount_needed=opp.headcount_needed if opp.headcount_needed else None,
        activity_tags=list(opp.activity_tags),
        requirements_text=opp.requirements_text,
        deadline_at=opp.deadline_at.isoformat() if opp.deadline_at else None,
        produce_description=opp.produce_description,
        destination=opp.destination,
        vehicle_needed=opp.vehicle_needed,
    )


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


def _handle_llm_reply(
    *,
    sender: UserDoc,
    target_opp: OpportunityDoc | None,
    last_outbound_body: str | None,
    inbound_text: str,
    inbound_doc_id: str,
    provider,
) -> None:
    settings = load_settings()
    llm = get_llm_client(settings)
    classification = classify_reply(
        llm=llm,
        inbound_text=inbound_text,
        volunteer_name=sender.name,
        recent_outbound_body=last_outbound_body,
        opportunity=target_opp,
    )

    threshold = settings.classifier_confidence_threshold

    # ESCALATE — always act, regardless of confidence. The model's confidence
    # on an escalation reflects "should we escalate" not "should we auto-reply".
    if classification.intent == "ESCALATE":
        _handle_escalation(
            sender=sender,
            inbound_doc_id=inbound_doc_id,
            provider=provider,
            reason=classification.escalation_reason or classification.rationale,
            urgency=classification.escalation_urgency,
            reply_body=classification.draft_reply,
            target_opp=target_opp,
        )
        return

    # High-confidence soft CLAIM — route to claim handler.
    if classification.intent == "CLAIM" and target_opp and classification.confidence >= threshold:
        farm = farms_repo.get_by_id(target_opp.farm_id)
        farmer = users_repo.get_by_id(farm.owner_user_id) if farm else None
        reply = claim_flow.handle_claim(
            messaging=provider,
            opportunity=target_opp,
            volunteer=sender,
            slots=1,
            farm_name=farm.name if farm else "the farm",
            notify_farmer_phone=farmer.phone if farmer else None,
        )
        _reply_and_log(
            provider=provider, to=sender, body=reply, opp=target_opp, intent=IntentLabel.CLAIM
        )
        return

    # High-confidence soft MAYBE — record interest without a seat.
    if classification.intent == "MAYBE" and target_opp and classification.confidence >= threshold:
        farm = farms_repo.get_by_id(target_opp.farm_id)
        reply = claim_flow.handle_maybe(
            opportunity=target_opp,
            volunteer=sender,
            farm_name=farm.name if farm else "the farm",
        )
        _reply_and_log(
            provider=provider, to=sender, body=reply, opp=target_opp, intent=IntentLabel.MAYBE
        )
        return

    # High-confidence non-claim with a draft reply — send it.
    if classification.draft_reply and classification.confidence >= threshold:
        _reply_and_log(
            provider=provider,
            to=sender,
            body=classification.draft_reply,
            opp=target_opp,
            intent=_label_from_intent_string(classification.intent),
            confidence=classification.confidence,
        )
        return

    # Below threshold — second pass with the stronger model.
    resolution = resolve_ambiguous(
        llm=llm,
        inbound_text=inbound_text,
        volunteer_name=sender.name,
        recent_outbound_body=last_outbound_body,
        opportunity=target_opp,
        prior=classification,
    )
    if resolution.escalate or not resolution.reply:
        flags_repo.create(
            FlagDoc(
                message_id=inbound_doc_id,
                flagged_by_user_id=None,
                reason=f"Agent escalated. Prior: {classification.intent} ({classification.confidence:.2f}). {resolution.reason}",
                created_at=datetime.now(UTC),
            )
        )
        _reply_and_log(
            provider=provider,
            to=sender,
            body=templates.render_fallback_ambiguous(),
            opp=target_opp,
            intent=IntentLabel.AMBIGUOUS,
            confidence=classification.confidence,
        )
        return
    _reply_and_log(
        provider=provider,
        to=sender,
        body=resolution.reply,
        opp=target_opp,
        intent=_label_from_intent_string(classification.intent),
        confidence=classification.confidence,
    )


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
    confidence: float | None = None,
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
            confidence=confidence,
            created_at=datetime.now(UTC),
        )
    )


def _label_from_intent_string(s: str) -> IntentLabel:
    try:
        return IntentLabel(s)
    except ValueError:
        return IntentLabel.AMBIGUOUS


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


def _looks_like_posting(text: str) -> bool:
    """Heuristic: does this read like a farmer posting a shift/pickup?
    Loose check; the LLM will classify rigorously."""
    t = text.lower()
    keywords = (
        "need",
        "harvest",
        "pickup",
        "pick up",
        "weed",
        "glean",
        "plant",
        "volunteers",
        "help",
        "surplus",
        "extra",
    )
    return any(k in t for k in keywords) and len(text) > 20


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
