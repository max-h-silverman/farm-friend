"""Pre-event confirmation reminders.

Scheduled function `tick_confirmations` runs every 15 minutes. For each
opportunity whose event is approaching (shifts: within 24h; pickups: within
3h), iterates the CONFIRMED claims and sends each volunteer a reminder with
a DROP escape hatch. One reminder per claim, tracked via
`ClaimDoc.confirmation_sent_at`.

Volunteer DROP handling lives in `message_dispatch` so it sits next to the
other hotkey branches.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.copy import templates
from app.flows import _time
from app.flows._time import format_day_and_range, format_deadline
from app.messaging import MessagingProvider, get_messaging_provider
from app.messaging._safe_send import safe_send
from app.repos import farms_repo, messages_repo, opportunities_repo, users_repo
from app.repos.models import (
    ClaimStatus,
    IntentLabel,
    MessageDirection,
    MessageDoc,
    OpportunityDoc,
    OpportunityKind,
)


SHIFT_LEAD_TIME = timedelta(hours=24)
PICKUP_LEAD_TIME = timedelta(hours=3)


def run_confirmation_tick(*, messaging: MessagingProvider | None = None) -> None:
    """Send a one-time pre-event reminder to each confirmed volunteer."""
    m = messaging or get_messaging_provider()
    now = datetime.now(UTC)
    if _time.is_quiet_hours(now):
        return
    due_opps = opportunities_repo.list_opps_due_for_confirmation(
        now=now,
        shift_lead_time=SHIFT_LEAD_TIME,
        pickup_lead_time=PICKUP_LEAD_TIME,
    )
    for opp in due_opps:
        _process_opp(opp=opp, messaging=m, now=now)


def _process_opp(
    *, opp: OpportunityDoc, messaging: MessagingProvider, now: datetime
) -> None:
    if opp.id is None:
        return
    farm = farms_repo.get_by_id(opp.farm_id)
    if farm is None:
        return
    for claim in opportunities_repo.list_all_claims(opp.id):
        # CONFIRMED claims get reminded. PROPOSED claims are still awaiting
        # the farmer's accept/decline and shouldn't get a "you're scheduled"
        # reminder yet — the proposal flow / auto-confirm tick may still
        # turn this into either CONFIRMED or DROPPED.
        if claim.status != ClaimStatus.CONFIRMED:
            continue
        if claim.confirmation_sent_at is not None:
            continue
        # Lead-time anchor: the volunteer's specific day for window claims,
        # otherwise the opp's single start time.
        anchor = claim.scheduled_for_at or opp.starts_at
        if anchor is None and opp.kind == OpportunityKind.SHIFT:
            continue
        if opp.kind == OpportunityKind.SHIFT:
            assert anchor is not None
            if not (now <= anchor <= now + SHIFT_LEAD_TIME):
                continue
        # Pickups have no per-claim scheduled_for_at; the opp's deadline_at
        # is the anchor and the calling `list_opps_due_for_confirmation`
        # already gated on it.
        volunteer = users_repo.get_by_id(claim.volunteer_user_id)
        if volunteer is None:
            continue
        body = _render_reminder(
            opp=opp, farm_name=farm.name, anchor=anchor,
        )
        provider_id = safe_send(messaging, to_phone=volunteer.phone, body=body)
        if provider_id is None:
            continue  # send failed; leave confirmation_sent_at null so we retry
        messages_repo.create(
            MessageDoc(
                direction=MessageDirection.OUTBOUND,
                provider_msg_id=provider_id,
                user_id=volunteer.id,
                opportunity_id=opp.id,
                body=body,
                intent_label=IntentLabel.CONFIRMATION_REMINDER,
                created_at=now,
            )
        )
        opportunities_repo.mark_confirmation_sent(
            opp_id=opp.id,
            volunteer_user_id=claim.volunteer_user_id,
            at=now,
            scheduled_for_at=claim.scheduled_for_at,
        )


def _render_reminder(
    *, opp: OpportunityDoc, farm_name: str, anchor: datetime | None = None,
) -> str:
    if opp.kind == OpportunityKind.SHIFT:
        activity = ", ".join(opp.activity_tags) if opp.activity_tags else "a shift"
        when_dt = anchor or opp.starts_at
        when = (
            format_day_and_range(when_dt, opp.duration_min)
            if when_dt else "soon"
        )
        return templates.render_confirmation_reminder_shift(
            farm_name=farm_name, activity=activity, when_human=when
        )
    produce = opp.produce_description or "the surplus pickup"
    when = format_deadline(opp.deadline_at) if opp.deadline_at else "today"
    return templates.render_confirmation_reminder_pickup(
        farm_name=farm_name, produce=produce, deadline_human=when
    )
