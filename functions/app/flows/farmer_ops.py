"""Farmer-initiated operations on existing opportunities: STATUS, CANCEL,
EDIT. Also the volunteer-facing change/cancel notification fan-out.

These all assume the sender is the farmer who owns the farm `farm_id`. The
caller (`message_dispatch.py`) is responsible for that authorization.
"""

from __future__ import annotations

from datetime import UTC, datetime

from app.copy import templates
from app.flows._time import format_day_and_range, format_deadline, post_event_time_for
from app.messaging import MessagingProvider
from app.messaging._safe_send import safe_send
from app.repos import opportunities_repo, users_repo
from app.repos.models import (
    ClaimStatus,
    OpportunityDoc,
    OpportunityKind,
    OpportunityStatus,
)


# ---------------------------------------------------------------------------
# Summaries
# ---------------------------------------------------------------------------
def opp_short_summary(opp: OpportunityDoc) -> str:
    """Conversational one-line description of an opportunity. Used in STATUS,
    cancel/change notifications, milestone messages, and clarification options."""
    if opp.kind == OpportunityKind.SHIFT:
        activity = ", ".join(opp.activity_tags) if opp.activity_tags else "shift"
        when = (
            format_day_and_range(opp.starts_at, opp.duration_min)
            if opp.starts_at
            else "soon"
        )
        return f"{activity} {when}"
    produce = opp.produce_description or "surplus"
    when = format_deadline(opp.deadline_at) if opp.deadline_at else "today"
    return f"{produce} pickup {when}"


def _maybe_count(opp_id: str) -> int:
    return sum(
        1
        for c in opportunities_repo.list_all_claims(opp_id)
        if c.status == ClaimStatus.INTERESTED
    )


# ---------------------------------------------------------------------------
# STATUS
# ---------------------------------------------------------------------------
def handle_status(*, farm_id: str) -> str:
    """Render a one-SMS snapshot of all open + filling opps for this farm."""
    opps = opportunities_repo.list_open_for_farm(farm_id)
    if not opps:
        return templates.render_status_empty()
    lines = [templates.render_status_header(count=len(opps))]
    for opp in opps:
        if opp.id is None:
            continue
        lines.append(
            templates.render_status_line(
                summary=opp_short_summary(opp),
                filled=opp.seats_filled,
                headcount=opp.headcount_needed,
                maybes=_maybe_count(opp.id),
            )
        )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CANCEL
# ---------------------------------------------------------------------------
def handle_cancel(
    *,
    farm_id: str,
    farm_name: str,
    messaging: MessagingProvider,
) -> str:
    """Cancel the only open opp for this farm; if there's more than one,
    return a clarification asking which.

    Returns the SMS body to send back to the farmer. Side effect: notifies
    confirmed/interested volunteers of the cancellation.
    """
    opps = opportunities_repo.list_open_for_farm(farm_id)
    if not opps:
        return templates.render_no_open_to_cancel()
    if len(opps) > 1:
        options = [opp_short_summary(o) for o in opps]
        return templates.render_which_opp_question(options=options)
    opp = opps[0]
    assert opp.id is not None
    _do_cancel(opp=opp, farm_name=farm_name, messaging=messaging)
    return templates.render_cancel_confirmed(summary=opp_short_summary(opp))


def _do_cancel(
    *, opp: OpportunityDoc, farm_name: str, messaging: MessagingProvider
) -> None:
    assert opp.id is not None
    opportunities_repo.update_status(opp.id, OpportunityStatus.CANCELLED)
    _notify_claimers_cancelled(opp=opp, farm_name=farm_name, messaging=messaging)


# ---------------------------------------------------------------------------
# EDIT (apply pre-validated field updates)
# ---------------------------------------------------------------------------
class HeadcountTooLow(Exception):
    """Raised when the requested headcount would drop below already-confirmed
    seats. The caller surfaces this to the farmer instead of silently dropping
    volunteers."""

    def __init__(self, currently_filled: int):
        self.currently_filled = currently_filled


def apply_edit(
    *,
    opp: OpportunityDoc,
    field_updates: dict,
    farm_name: str,
    messaging: MessagingProvider,
) -> OpportunityDoc:
    """Apply `field_updates` to `opp`, notify claimers, and return the
    refreshed doc. Raises HeadcountTooLow if the requested headcount would
    drop below the current seats_filled."""
    assert opp.id is not None

    new_headcount = field_updates.get("headcount_needed")
    if new_headcount is not None and new_headcount < opp.seats_filled:
        raise HeadcountTooLow(currently_filled=opp.seats_filled)

    # Reopen the status if headcount increased past the current filled count.
    # The escalation tick will re-fire outreach for the additional seats.
    if new_headcount is not None and new_headcount > opp.seats_filled:
        if opp.status == OpportunityStatus.FULL:
            field_updates["status"] = OpportunityStatus.FILLING.value

    # If the time of the event moved, recompute the post-event checkin time
    # so the day-after-checkin SMS doesn't fire on the old date.
    if "starts_at" in field_updates or "deadline_at" in field_updates:
        new_starts = field_updates.get("starts_at", opp.starts_at)
        new_deadline = field_updates.get("deadline_at", opp.deadline_at)
        new_checkin = post_event_time_for(
            is_pickup=opp.kind == OpportunityKind.PICKUP,
            starts_at=new_starts,
            deadline_at=new_deadline,
        )
        field_updates["post_event_checkin_at"] = new_checkin
        # If the event was bumped to the future, allow the checkin to fire
        # again (the tick is one-shot via post_event_checkin_sent).
        if new_checkin and new_checkin > datetime.now(UTC):
            field_updates["post_event_checkin_sent"] = False

    opportunities_repo.update_fields(opp.id, field_updates)
    refreshed = opportunities_repo.get_by_id(opp.id) or opp.model_copy(update=field_updates)

    what_changed = _summarize_changes(before=opp, after=refreshed)
    if what_changed:
        _notify_claimers_changed(
            opp=refreshed,
            farm_name=farm_name,
            what_changed=what_changed,
            messaging=messaging,
        )
    return refreshed


def _summarize_changes(*, before: OpportunityDoc, after: OpportunityDoc) -> str:
    """Human-readable list of what actually changed. Used in the
    volunteer-facing change notification body."""
    parts = []
    if before.starts_at != after.starts_at or before.duration_min != after.duration_min:
        if after.starts_at:
            parts.append(
                "time is now " + format_day_and_range(after.starts_at, after.duration_min)
            )
    if before.headcount_needed != after.headcount_needed:
        parts.append(f"now needs {after.headcount_needed} people")
    if before.requirements_text != after.requirements_text and after.requirements_text:
        parts.append(f"note: {after.requirements_text}")
    if before.produce_description != after.produce_description and after.produce_description:
        parts.append(f"produce is now {after.produce_description}")
    if before.destination != after.destination and after.destination:
        parts.append(f"drop at {after.destination}")
    return "; ".join(parts)


# ---------------------------------------------------------------------------
# Notification fan-out
# ---------------------------------------------------------------------------
def _active_claimer_ids(opp_id: str) -> list[str]:
    return [
        c.volunteer_user_id
        for c in opportunities_repo.list_all_claims(opp_id)
        if c.status in (ClaimStatus.CONFIRMED, ClaimStatus.INTERESTED)
    ]


def _notify_claimers_cancelled(
    *, opp: OpportunityDoc, farm_name: str, messaging: MessagingProvider
) -> None:
    assert opp.id is not None
    body = templates.render_opportunity_cancelled(
        farm_name=farm_name, summary=opp_short_summary(opp)
    )
    for uid in _active_claimer_ids(opp.id):
        user = users_repo.get_by_id(uid)
        if user is None:
            continue
        safe_send(messaging, to_phone=user.phone, body=body)


def _notify_claimers_changed(
    *,
    opp: OpportunityDoc,
    farm_name: str,
    what_changed: str,
    messaging: MessagingProvider,
) -> None:
    assert opp.id is not None
    body = templates.render_opportunity_changed(
        farm_name=farm_name,
        summary=opp_short_summary(opp),
        what_changed=what_changed,
    )
    for uid in _active_claimer_ids(opp.id):
        user = users_repo.get_by_id(uid)
        if user is None:
            continue
        safe_send(messaging, to_phone=user.phone, body=body)


# ---------------------------------------------------------------------------
# Milestones (server-side, called from claim/outreach/scheduled paths)
# ---------------------------------------------------------------------------
def notify_first_claim_if_unsent(
    *,
    opp: OpportunityDoc,
    volunteer_name: str,
    farmer_phone: str | None,
    messaging: MessagingProvider,
) -> None:
    """Called from claim_flow on every CONFIRMED claim. Fires once per opp."""
    assert opp.id is not None
    if opp.farmer_notified_first_claim or farmer_phone is None:
        return
    new_filled = opp.seats_filled + 1
    body = templates.render_first_claim(
        opp_summary=opp_short_summary(opp),
        volunteer_name=volunteer_name,
        filled=new_filled,
        headcount=opp.headcount_needed,
    )
    safe_send(messaging, to_phone=farmer_phone, body=body)
    opportunities_repo.update_fields(opp.id, {"farmer_notified_first_claim": True})


def notify_tier_escalated_if_unsent(
    *,
    opp: OpportunityDoc,
    farmer_phone: str | None,
    messaging: MessagingProvider,
) -> None:
    """Called from outreach when the tier flips INSIDER → BROADER."""
    assert opp.id is not None
    if opp.farmer_notified_broader or farmer_phone is None:
        return
    body = templates.render_tier_escalated(opp_summary=opp_short_summary(opp))
    safe_send(messaging, to_phone=farmer_phone, body=body)
    opportunities_repo.update_fields(opp.id, {"farmer_notified_broader": True})


def notify_unfilled_at_start(
    *,
    opp: OpportunityDoc,
    farmer_phone: str | None,
    messaging: MessagingProvider,
) -> None:
    """Called from the unfilled-at-start tick. Fires once per opp."""
    assert opp.id is not None
    if opp.farmer_notified_unfilled or farmer_phone is None:
        return
    body = templates.render_unfilled_at_start(
        opp_summary=opp_short_summary(opp),
        filled=opp.seats_filled,
        headcount=opp.headcount_needed,
    )
    safe_send(messaging, to_phone=farmer_phone, body=body)
    opportunities_repo.update_fields(opp.id, {"farmer_notified_unfilled": True})


def run_unfilled_at_start_tick(messaging: MessagingProvider) -> None:
    """Scan for shifts whose start time has passed and that still aren't
    fully filled, and notify each farmer once. Intentionally bounded to
    shifts; pickups have a deadline_at semantic and a different urgency."""
    from app.repos import farms_repo

    now = datetime.now(UTC)
    for opp in opportunities_repo.list_unfilled_started(now=now):
        if opp.seats_filled >= opp.headcount_needed:
            continue  # filled in the gap between query and processing
        farm = farms_repo.get_by_id(opp.farm_id)
        if farm is None:
            continue
        farmer = users_repo.get_by_id(farm.owner_user_id)
        if farmer is None:
            continue
        notify_unfilled_at_start(
            opp=opp,
            farmer_phone=farmer.phone,
            messaging=messaging,
        )
