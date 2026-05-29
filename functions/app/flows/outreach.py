"""Tiered outreach + escalation.

Two surfaces:

1. `send_initial_outreach(opp)` — called when a new opportunity opens.
   Picks insiders for that farm, sends them the outreach SMS, schedules a
   future escalation if seats remain.

2. `run_escalation_tick()` — scheduled function. Scans for opportunities
   whose `next_escalation_at` has fired and:
     - if still in insider tier, escalates to broader pool;
     - if already in broader pool and still unfilled, leaves it (the admin
       view will surface it as stalled).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.copy import templates
from app.flows import _time
from app.flows._time import format_day_and_range, format_deadline
from app.messaging import MessagingProvider, get_messaging_provider
from app.messaging._safe_send import safe_send
from app.repos import (
    farms_repo,
    flags_repo,
    messages_repo,
    mutes_repo,
    opportunities_repo,
    users_repo,
)
from app.repos.models import (
    FlagDoc,
    MessageDirection,
    MessageDoc,
    OpportunityDoc,
    OpportunityKind,
    OpportunityStatus,
    OutreachLogDoc,
    OutreachTier,
    UserStatus,
)


STALE_DRAFT_AGE_HOURS = 2


# ---------------------------------------------------------------------------
# Initial outreach when an opportunity is created
# ---------------------------------------------------------------------------
def send_initial_outreach(*, opp: OpportunityDoc, messaging: MessagingProvider | None = None) -> None:
    """Send the insider tier and schedule the escalation tick."""
    assert opp.id is not None
    m = messaging or get_messaging_provider()
    farm = farms_repo.get_by_id(opp.farm_id)
    if not farm:
        return
    # Open the opportunity FIRST, so its status is correct even if every send
    # fails. Outbound delivery is best-effort and must not gate status flips.
    if opp.status == OpportunityStatus.DRAFT:
        opportunities_repo.update_status(opp.id, OpportunityStatus.OPEN)

    # Quiet hours: defer the whole broadcast to 7am. The escalation tick will
    # pick it up — see _has_outreach_at_tier guard in run_escalation_tick.
    if _time.is_quiet_hours():
        opportunities_repo.set_next_escalation(
            opp.id, at=_time.next_quiet_hours_end(), tier=OutreachTier.INSIDER
        )
        return

    recipients = _select_recipients(opp=opp, tier=OutreachTier.INSIDER)
    body = _render_outreach_body(opp=opp, farm_name=farm.name)
    sent_ids = []
    for u in recipients:
        if u.id is None:
            continue
        provider_id = safe_send(m, to_phone=u.phone, body=body)
        if provider_id is None:
            continue  # send failed; skip the message log + recipient record
        messages_repo.create(
            MessageDoc(
                direction=MessageDirection.OUTBOUND,
                provider_msg_id=provider_id,
                user_id=u.id,
                opportunity_id=opp.id,
                body=body,
                created_at=datetime.now(UTC),
            )
        )
        sent_ids.append(u.id)

    opportunities_repo.log_outreach(
        opp_id=opp.id,
        entry=OutreachLogDoc(
            tier=OutreachTier.INSIDER,
            sent_at=datetime.now(UTC),
            recipient_ids=sent_ids,
        ),
    )
    next_at = _next_escalation_time(opp=opp, farm_insider_window_min=_window_minutes(opp, farm))
    opportunities_repo.set_next_escalation(opp.id, at=next_at, tier=OutreachTier.INSIDER)


# ---------------------------------------------------------------------------
# Scheduled escalation tick
# ---------------------------------------------------------------------------
def run_escalation_tick(*, messaging: MessagingProvider | None = None) -> None:
    """Called by `tick_outreach` scheduled function every ~5 minutes."""
    m = messaging or get_messaging_provider()
    now = datetime.now(UTC)
    if _time.is_quiet_hours(now):
        return  # Whole tick is a no-op during quiet hours; we'll catch up at 7am.
    due = opportunities_repo.list_due_for_escalation(now=now)
    for opp in due:
        # Re-check seats — race with claims.
        if opp.seats_filled >= opp.headcount_needed:
            opportunities_repo.set_next_escalation(opp.id, at=None, tier=opp.current_tier)  # type: ignore[arg-type]
            continue
        if opp.current_tier == OutreachTier.INSIDER:
            # Insider tier was either pinged earlier (now time to escalate) or
            # was deferred from quiet hours (still needs the first ping). The
            # outreach log tells us which.
            if _insider_tier_already_pinged(opp.id):  # type: ignore[arg-type]
                _escalate_to_broader(opp=opp, messaging=m)
            else:
                send_initial_outreach(opp=opp, messaging=m)
        else:
            # Already in broader tier — leave it; admin view will surface as stalled.
            opportunities_repo.set_next_escalation(opp.id, at=None, tier=OutreachTier.BROADER)  # type: ignore[arg-type]


def _insider_tier_already_pinged(opp_id: str) -> bool:
    """True if there's at least one insider-tier outreach log entry."""
    return any(
        log.tier == OutreachTier.INSIDER
        for log in opportunities_repo.list_outreach(opp_id)
    )


def _escalate_to_broader(*, opp: OpportunityDoc, messaging: MessagingProvider) -> None:
    assert opp.id is not None
    farm = farms_repo.get_by_id(opp.farm_id)
    if not farm:
        return
    # Notify the farmer once that we're escalating past insiders.
    from app.flows import farmer_ops
    farmer = users_repo.get_by_id(farm.owner_user_id) if farm.owner_user_id else None
    farmer_ops.notify_tier_escalated_if_unsent(
        opp=opp,
        farmer_phone=farmer.phone if farmer else None,
        messaging=messaging,
    )
    recipients = _select_recipients(opp=opp, tier=OutreachTier.BROADER)
    body = _render_outreach_body(opp=opp, farm_name=farm.name)
    sent_ids = []
    for u in recipients:
        if u.id is None:
            continue
        provider_id = safe_send(messaging, to_phone=u.phone, body=body)
        if provider_id is None:
            continue
        messages_repo.create(
            MessageDoc(
                direction=MessageDirection.OUTBOUND,
                provider_msg_id=provider_id,
                user_id=u.id,
                opportunity_id=opp.id,
                body=body,
                created_at=datetime.now(UTC),
            )
        )
        sent_ids.append(u.id)
    opportunities_repo.log_outreach(
        opp_id=opp.id,
        entry=OutreachLogDoc(
            tier=OutreachTier.BROADER,
            sent_at=datetime.now(UTC),
            recipient_ids=sent_ids,
        ),
    )
    opportunities_repo.set_next_escalation(opp.id, at=None, tier=OutreachTier.BROADER)


# ---------------------------------------------------------------------------
# Recipient selection (the heart of "tiered, respecting mutes")
# ---------------------------------------------------------------------------
def _select_recipients(*, opp: OpportunityDoc, tier: OutreachTier):
    assert opp.id is not None
    farm_id = opp.farm_id
    now = datetime.now(UTC)
    # Insider candidates: members of the farm's insider subcollection.
    if tier == OutreachTier.INSIDER:
        insider_ids = {ins.volunteer_user_id for ins in farms_repo.list_insiders(farm_id)}
        candidates = [u for u in (users_repo.get_by_id(i) for i in insider_ids) if u]
    else:
        # Broader: all ACTIVE users who AREN'T already insiders for this farm
        # (insiders were already pinged in the insider tier).
        active = users_repo.list_active()
        insider_ids = {ins.volunteer_user_id for ins in farms_repo.list_insiders(farm_id)}
        candidates = [u for u in active if u.id not in insider_ids]

    # Filter: never re-ping someone who already claimed, was already in this tier's
    # outreach log, or has a matching mute rule.
    already_pinged = set()
    for log in opportunities_repo.list_outreach(opp.id):
        already_pinged.update(log.recipient_ids)
    claims = opportunities_repo.list_all_claims(opp.id)
    claimed_ids = {c.volunteer_user_id for c in claims}

    activity = opp.activity_tags[0] if opp.activity_tags else None
    recipients = []
    for u in candidates:
        if u.status != UserStatus.ACTIVE:
            continue
        if u.id in already_pinged or u.id in claimed_ids:
            continue
        if u.id and mutes_repo.is_muted(
            user_id=u.id,
            activity=activity,
            farm_id=farm_id,
            opportunity_id=opp.id,
            at=now,
        ):
            continue
        recipients.append(u)
    return recipients


# ---------------------------------------------------------------------------
# Rendering + timing
# ---------------------------------------------------------------------------
def _render_outreach_body(*, opp: OpportunityDoc, farm_name: str) -> str:
    if opp.kind == OpportunityKind.PICKUP:
        return templates.render_pickup_outreach(
            farm_name=farm_name,
            produce=opp.produce_description or "surplus produce",
            deadline_human=format_deadline(opp.deadline_at) if opp.deadline_at else "today",
            destination=opp.destination,
            vehicle_needed=opp.vehicle_needed,
        )
    # Window opps get a distinct copy that mentions the day range and
    # instructs the volunteer to reply with a specific day. Outreach pacing
    # is still tier-based; PR 5 doesn't change pacing for windows (the doc
    # flags pacing as a future revisit).
    activity = ", ".join(opp.activity_tags) if opp.activity_tags else "volunteer help"
    # `seats_remaining` for a window opp uses seats_held (PROPOSED + CONFIRMED)
    # so we don't over-advertise capacity while proposals are pending farmer
    # decisions.
    capacity_used = (
        opp.seats_held if opp.window_end_at is not None else opp.seats_filled
    )
    seats_remaining = max(0, opp.headcount_needed - capacity_used)
    if opp.window_end_at is not None and opp.starts_at is not None:
        window_human = _format_window_human(opp)
        return templates.render_window_outreach(
            farm_name=farm_name,
            activity=activity,
            window_human=window_human,
            headcount_open=opp.headcount_open,
            seats_remaining=seats_remaining,
            requirements=opp.requirements_text,
        )
    if opp.starts_at:
        when = format_day_and_range(opp.starts_at, opp.duration_min)
    else:
        when = "soon"
    return templates.render_shift_outreach(
        farm_name=farm_name,
        activity=activity,
        when_human=when,
        headcount=opp.headcount_needed,
        seats_remaining=seats_remaining,
        requirements=opp.requirements_text,
    )

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


def _format_window_human(opp: OpportunityDoc) -> str:
    """Render a window opp's day-range + time as one phrase.

    Examples:
      "any day Mon 6/2 - Fri 6/6, morning"
      "any day Mon 6/2 - Fri 6/6, 9a-12p"
    """
    from app.flows._time import _short_hour, to_local
    assert opp.starts_at is not None
    assert opp.window_end_at is not None
    start_local = to_local(opp.starts_at)
    end_local = to_local(opp.window_end_at)
    day_range = (
        f"{start_local.strftime('%a %-m/%-d')} - "
        f"{end_local.strftime('%a %-m/%-d')}"
    )
    if opp.time_of_day_bucket:
        time_part = _BUCKET_PHRASE.get(opp.time_of_day_bucket, opp.time_of_day_bucket)
    elif opp.duration_min:
        end_t = start_local + timedelta(minutes=opp.duration_min)
        time_part = f"{_short_hour(start_local)}-{_short_hour(end_t)}"
    else:
        time_part = _short_hour(start_local)
    return f"any day {day_range}, {time_part}"


def _window_minutes(opp: OpportunityDoc, farm) -> int:
    if opp.kind == OpportunityKind.PICKUP:
        return farm.pickup_insider_window_minutes
    return farm.insider_window_minutes


def run_stale_draft_tick() -> None:
    """Surface drafts older than STALE_DRAFT_AGE_HOURS that never finished
    clarification. We don't auto-cancel — the farmer might come back. We
    flag for admin so Max can reach out manually.

    Idempotent: each call only flags drafts that don't already have an open
    flag tied to their `created_from_message_id`."""
    cutoff = datetime.now(UTC) - timedelta(hours=STALE_DRAFT_AGE_HOURS)
    stale = opportunities_repo.list_stale_drafts(older_than=cutoff)
    for opp in stale:
        if not opp.id or not opp.created_from_message_id:
            continue
        if flags_repo.has_open_flag_for_message(opp.created_from_message_id):
            continue
        flags_repo.create(
            FlagDoc(
                message_id=opp.created_from_message_id,
                flagged_by_user_id=None,  # raised by the agent
                reason=templates.STALE_DRAFT_FLAG_REASON,
                created_at=datetime.now(UTC),
            )
        )


def _next_escalation_time(*, opp: OpportunityDoc, farm_insider_window_min: int) -> datetime:
    now = datetime.now(UTC)
    candidate = now + timedelta(minutes=farm_insider_window_min)
    # Compress the window if the event is imminent.
    target = opp.deadline_at or opp.starts_at
    if target is not None:
        # Always escalate at least 60 min before the event if seats unfilled.
        cap = target - timedelta(minutes=60)
        if cap < now:
            cap = now + timedelta(minutes=5)
        candidate = min(candidate, cap)
    return candidate
