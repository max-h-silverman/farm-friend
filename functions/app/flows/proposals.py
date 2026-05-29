"""Window-opp farmer-approval gate.

When a volunteer claims a specific day inside a window opp, the claim lands
as PROPOSED and the farmer gets an SMS asking ACCEPT/DECLINE. The farmer is
the decider; the volunteer is told they're confirmed only after the farmer
acts (or after the auto-confirm fallback in `tick_proposals` fires).

This module owns:
  - drafting + sending the proposal-to-farmer SMS (with persisted token →
    claim mapping for later lookup)
  - resolving a 4-letter ACCEPT/DECLINE token against the farmer's recent
    outbounds to find the live proposal
  - applying the farmer's decision atomically and sending volunteer-side
    feedback

The auto-confirm fallback tick lives in PR 5 (`flows/proposals_tick.py`).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from app.copy import templates
from app.flows._time import to_local
from app.messaging import MessagingProvider
from app.messaging._safe_send import safe_send
from app.repos import farms_repo, messages_repo, opportunities_repo, users_repo
from app.repos.models import (
    ClaimDoc,
    ClaimStatus,
    IntentLabel,
    MessageDirection,
    MessageDoc,
    OpportunityDoc,
    UserDoc,
)


# Token: 4 uppercase letters. We use the day's three-letter weekday abbrev
# plus a stable per-claim suffix letter so the farmer can tell at a glance
# which day each ACCEPT/DECLINE targets ("ACCEPT WEDA" reads as "accept the
# Wed one"). Collisions within a single opp are rare at pilot scale but the
# suffix gives 26 variants per day per opp.
_WEEKDAY_ABBREV = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]


def proposal_token(*, claim_doc_id: str, scheduled_for_at: datetime) -> str:
    """Generate the stable 4-letter token for a proposal.

    Deterministic: same claim → same token always, so the persisted token in
    the outbound MessageDoc can be reverse-looked-up from an inbound reply.
    Uses sha256 (Python's `hash()` is randomized per process and would shift
    between webhook invocations).
    """
    import hashlib
    local = to_local(scheduled_for_at)
    weekday = _WEEKDAY_ABBREV[local.weekday()]
    digest = hashlib.sha256(claim_doc_id.encode("utf-8")).digest()
    suffix_idx = digest[0] % 26
    suffix = chr(ord("A") + suffix_idx)
    return f"{weekday[:3]}{suffix}"


def send_proposal_to_farmer(
    *,
    opp: OpportunityDoc,
    claim: ClaimDoc,
    claim_doc_id: str,
    volunteer: UserDoc,
    messaging: MessagingProvider,
) -> str | None:
    """Send the ACCEPT/DECLINE prompt to the farmer.

    Returns the token used (the caller may log it). Returns None on send
    failure — the proposal sits in PROPOSED state and the auto-confirm tick
    will pick it up.

    The token + claim_doc_id are persisted on the outbound's pending_action
    so `resolve_proposal_token` can find this proposal from an inbound reply.
    """
    if opp.id is None or claim.scheduled_for_at is None:
        return None
    farm = farms_repo.get_by_id(opp.farm_id)
    if farm is None:
        return None
    farmer = users_repo.get_by_id(farm.owner_user_id)
    if farmer is None or farmer.phone is None:
        return None
    token = proposal_token(
        claim_doc_id=claim_doc_id,
        scheduled_for_at=claim.scheduled_for_at,
    )
    day_human = _format_day_with_time(opp=opp, scheduled_for_at=claim.scheduled_for_at)
    opp_summary = _proposal_opp_summary(opp=opp)
    body = templates.render_proposal_to_farmer(
        volunteer_name=volunteer.name,
        day_human=day_human,
        opp_summary=opp_summary,
        token=token,
    )
    provider_id = safe_send(messaging, to_phone=farmer.phone, body=body)
    if provider_id is None:
        return None
    messages_repo.create(
        MessageDoc(
            direction=MessageDirection.OUTBOUND,
            provider_msg_id=provider_id,
            user_id=farmer.id,
            opportunity_id=opp.id,
            body=body,
            intent_label=IntentLabel.PROPOSAL_NOTIFICATION,
            pending_action={
                "action": "farmer_decide_on_proposal",
                "token": token,
                "payload": {
                    "opp_id": opp.id,
                    "claim_doc_id": claim_doc_id,
                    "volunteer_user_id": claim.volunteer_user_id,
                    "scheduled_for_at": claim.scheduled_for_at.isoformat(),
                },
            },
            created_at=datetime.now(UTC),
        )
    )
    return token


def resolve_proposal_token(
    *, farmer_user_id: str, token: str,
) -> dict | None:
    """Walk the farmer's recent outbounds for a live PROPOSAL_NOTIFICATION with
    a matching token. Returns the pending_action payload, or None.

    "Live" = the PROPOSED claim still exists with PROPOSED status. We confirm
    against the repo rather than just trusting the outbound, so a stale token
    (claim already accepted/declined) returns None.
    """
    token = token.upper()
    for msg in messages_repo.list_for_user(farmer_user_id, limit=50):
        if msg.direction != MessageDirection.OUTBOUND:
            continue
        if msg.intent_label != IntentLabel.PROPOSAL_NOTIFICATION:
            continue
        pending = msg.pending_action or {}
        if pending.get("token", "").upper() != token:
            continue
        payload = pending.get("payload") or {}
        opp_id = payload.get("opp_id")
        claim_doc_id = payload.get("claim_doc_id")
        if not opp_id or not claim_doc_id:
            continue
        # Confirm the claim is still PROPOSED.
        ref_opp = opportunities_repo.get_by_id(opp_id)
        if ref_opp is None:
            continue
        # Look up by claim_doc_id directly using the repo's internal API.
        # The composite-ID helper exposes this implicitly.
        claim_snap = _get_claim_by_doc_id(opp_id=opp_id, claim_doc_id=claim_doc_id)
        if claim_snap is None or claim_snap.status != ClaimStatus.PROPOSED:
            continue
        return payload
    return None


def _get_claim_by_doc_id(*, opp_id: str, claim_doc_id: str) -> ClaimDoc | None:
    """Direct doc-id lookup. Bypasses the (volunteer_user_id, scheduled_for_at)
    composition because we already have the full doc id from the persisted
    pending_action payload."""
    from app.firebase_app import db
    from app.repos._base import snapshot_to_model
    snap = (
        db.collection("opportunities")
        .document(opp_id)
        .collection("claims")
        .document(claim_doc_id)
        .get()
    )
    return snapshot_to_model(snap, ClaimDoc)


def handle_farmer_decision(
    *,
    messaging: MessagingProvider,
    farmer: UserDoc,
    token: str,
    decision: Literal["accept", "decline"],
) -> str:
    """Apply the farmer's ACCEPT/DECLINE. Returns the SMS body for the farmer.

    Side effects:
      - applies the txn (CONFIRMED or DROPPED)
      - sends the volunteer their confirmation or decline SMS (best-effort)
    """
    payload = resolve_proposal_token(farmer_user_id=farmer.id or "", token=token)
    if payload is None:
        # Either token is wrong, or the proposal already got resolved (by the
        # auto-confirm tick, or the volunteer dropping, or a prior decision).
        return (
            "I can't find that proposal — it may have already been accepted, "
            "declined, or the volunteer dropped it."
        )
    opp_id = payload["opp_id"]
    claim_doc_id = payload["claim_doc_id"]
    volunteer_user_id = payload["volunteer_user_id"]
    now = datetime.now(UTC)

    if decision == "accept":
        outcome = opportunities_repo.accept_proposal_in_transaction(
            opp_id=opp_id, claim_doc_id=claim_doc_id, now=now,
        )
    else:
        outcome = opportunities_repo.decline_proposal_in_transaction(
            opp_id=opp_id, claim_doc_id=claim_doc_id, now=now,
        )

    if not outcome.found:
        return "That proposal isn't on file anymore."
    if outcome.was_already_decided:
        return "That proposal was already resolved."

    # Fan-out to the volunteer.
    opp = opportunities_repo.get_by_id(opp_id)
    farm = farms_repo.get_by_id(opp.farm_id) if opp else None
    volunteer = users_repo.get_by_id(volunteer_user_id)
    scheduled_for_at = _parse_iso(payload.get("scheduled_for_at"))
    if opp and farm and volunteer and volunteer.phone:
        day_human = (
            _format_day_with_time(opp=opp, scheduled_for_at=scheduled_for_at)
            if scheduled_for_at else "that day"
        )
        if decision == "accept":
            activity_or_produce = (
                ", ".join(opp.activity_tags) if opp.activity_tags else "a shift"
            )
            vol_body = templates.render_proposal_accepted_to_volunteer(
                farm_name=farm.name,
                day_human=day_human,
                activity_or_produce=activity_or_produce,
            )
            vol_intent = IntentLabel.ACTION_RECEIPT
        else:
            vol_body = templates.render_proposal_declined_to_volunteer(
                farm_name=farm.name, day_human=day_human,
            )
            vol_intent = IntentLabel.PROPOSAL_DECLINED
        provider_id = safe_send(messaging, to_phone=volunteer.phone, body=vol_body)
        if provider_id is not None:
            messages_repo.create(
                MessageDoc(
                    direction=MessageDirection.OUTBOUND,
                    provider_msg_id=provider_id,
                    user_id=volunteer.id,
                    opportunity_id=opp_id,
                    body=vol_body,
                    intent_label=vol_intent,
                    created_at=now,
                )
            )

    if decision == "accept":
        return (
            f"Accepted. {outcome.seats_filled_after}/{outcome.headcount_needed} "
            f"confirmed."
        )
    return "Declined. Volunteer notified."


def _format_day_with_time(
    *, opp: OpportunityDoc, scheduled_for_at: datetime,
) -> str:
    """Render a per-day proposal day with the opp's time-of-day.

    Window opps have a single time-of-day applied to every day, expressed
    either as `time_of_day_bucket` (fuzzy) or as the clock time on
    `opp.starts_at`. The day comes from `scheduled_for_at`.
    """
    local = to_local(scheduled_for_at)
    day = local.strftime("%a %-m/%-d")
    bucket = getattr(opp, "time_of_day_bucket", None)
    if bucket:
        bucket_phrase = _BUCKET_PHRASE.get(bucket, bucket)
        return f"{day} {bucket_phrase}"
    if opp.starts_at:
        starts_local = to_local(opp.starts_at)
        hour = starts_local.strftime("%-I%p").lower()
        return f"{day} {hour}"
    return day


def _proposal_opp_summary(*, opp: OpportunityDoc) -> str:
    """Short label for the opp in proposal copy. "weeding window" reads better
    in an SMS than "Mon Jun 2 - Fri Jun 6 weeding"."""
    activity = ", ".join(opp.activity_tags) if opp.activity_tags else "shift"
    if opp.window_end_at:
        return f"{activity} window"
    return f"{activity} shift"


def _parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


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
