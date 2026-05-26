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
from app.agent.parser import parse_opportunity
from app.config import load_settings
from app.copy import templates
from app.flows import claim as claim_flow
from app.flows import outreach as outreach_flow
from app.flows import post_event as post_event_flow
from app.flows._time import VASHON_TZ
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
def _dispatch(*, inbound: InboundMessage) -> None:
    settings = load_settings()
    provider = get_messaging_provider(settings)

    sender = users_repo.get_by_phone(inbound.from_phone)

    # Unknown sender — treat as a JOIN candidate so the coordinator can review.
    if sender is None:
        _handle_unknown_sender(inbound=inbound)
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
            inbound_doc_id=inbound_doc.id or "",
            provider=provider,
        )
        return

    # If the user has an open FLAG, do not auto-reply. The agent stays silent
    # until the admin resolves the flag.
    if sender.id and flags_repo.is_user_flagged(sender.id):
        return

    # Farmer free-form posting?
    if sender.role in (UserRole.FARMER, UserRole.BOTH):
        farm = farms_repo.get_by_owner(sender.id) if sender.id else None
        if farm and _looks_like_posting(inbound.body):
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
def _handle_unknown_sender(*, inbound: InboundMessage) -> None:
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
    provider = get_messaging_provider()
    safe_send(provider, to_phone=inbound.from_phone, body=templates.render_join_ack())


def _handle_hotkey(
    *,
    match: hotkeys.HotkeyMatch,
    sender: UserDoc,
    target_opp: OpportunityDoc | None,
    inbound_doc_id: str,
    provider,
) -> None:
    intent = match.intent

    if intent == IntentLabel.HELP:
        _reply_and_log(
            provider=provider, to=sender, body=templates.HELP_TEXT, opp=target_opp, intent=intent
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
        _reply_and_log(
            provider=provider, to=sender, body=templates.HELP_TEXT, opp=target_opp, intent=intent
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

    if intent == IntentLabel.CLAIM and target_opp is not None:
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


def _handle_farmer_post(
    *,
    sender: UserDoc,
    farm_id: str,
    farm_name: str,
    inbound_text: str,
    inbound_doc_id: str,
    provider,
) -> None:
    """Parse the farmer's free-form posting and create the opportunity."""
    settings = load_settings()
    llm = get_llm_client(settings)
    now_local = datetime.now(VASHON_TZ)

    parsed = parse_opportunity(
        llm=llm,
        farmer_message=inbound_text,
        farm_name=farm_name,
        now_local=now_local,
    )
    if parsed.kind == "other":
        # Not a posting — flag for admin.
        flags_repo.create(
            FlagDoc(
                message_id=inbound_doc_id,
                flagged_by_user_id=sender.id,
                reason=f"Farmer message didn't parse as a posting: {parsed.parse_notes}",
                created_at=datetime.now(UTC),
            )
        )
        provider.send(
            to_phone=sender.phone,
            body="Didn't quite parse that as a shift or pickup. Coordinator will follow up.",
        )
        return

    opp_doc = _opportunity_from_parsed(
        farm_id=farm_id, parsed=parsed, source_message_id=inbound_doc_id
    )
    created = opportunities_repo.create(opp_doc)

    # Send the initial insider tier outreach immediately.
    outreach_flow.send_initial_outreach(opp=created, messaging=provider)

    # Confirm to the farmer (best-effort; failure here doesn't unwind the post).
    summary = _farmer_posting_summary(parsed=parsed)
    safe_send(provider, to_phone=sender.phone, body=f"Got it: {summary}. Insiders pinged.")


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
    if last_outbound is None or opp is None:
        return False
    # Most reliable signal: the opportunity has a checkin-sent flag and the
    # last outbound to this user is the checkin question.
    if not opp.post_event_checkin_sent:
        return False
    body = (last_outbound.body or "").lower()
    return "any issues" in body and "y/n" in body or "any issues" in body and "reply y" in body


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
    """Day-after-the-event checkin time, 9am Vashon local."""
    target = deadline_at if kind == OpportunityKind.PICKUP else starts_at
    if not target:
        return None
    local = target.astimezone(VASHON_TZ)
    next_morning = local.replace(hour=9, minute=0, second=0, microsecond=0)
    # If event is in the afternoon, "next morning" should be the next day.
    if next_morning <= local:
        from datetime import timedelta
        next_morning = next_morning + timedelta(days=1)
    return next_morning.astimezone(UTC)


def _farmer_posting_summary(*, parsed) -> str:
    if parsed.kind == "shift":
        when = parsed.starts_at or "soon"
        activity = ",".join(parsed.activity_tags) if parsed.activity_tags else "shift"
        return f"{activity} {when}, need {parsed.headcount_needed or 1}"
    if parsed.kind == "pickup":
        return f"pickup of {parsed.produce_description or 'surplus'} by {parsed.deadline_at or 'today'}"
    return "posting"
