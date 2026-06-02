"""Claim resolution for YES replies.

Rules:
- Shifts: first-N-wins where N = headcount_needed. Late repliers get a waitlist
  message and a `waitlist` claim record. Cancellations can promote a waitlist
  claim.
- Pickups: single-claim race. First YES wins; later YESes get "already claimed".
  If headcount_needed > 1 on a pickup (big haul), behaves like a shift.
- Window opps: YES <day> creates a PROPOSED claim per day; farmer accepts via
  the proposal flow before the volunteer is told they're confirmed.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.copy import templates
from app.flows._time import VASHON_TZ, format_deadline, format_when, to_local
from app.messaging import MessagingProvider
from app.messaging._safe_send import safe_send
from app.repos import opportunities_repo
from app.repos.models import (
    ClaimDoc,
    ClaimStatus,
    OpportunityDoc,
    OpportunityKind,
    OpportunityStatus,
    UserDoc,
)

# ClaimDoc / ClaimStatus stay imported for handle_maybe below.


def handle_claim(
    *,
    messaging: MessagingProvider,
    opportunity: OpportunityDoc,
    volunteer: UserDoc,
    slots: int,
    farm_name: str,
    notify_farmer_phone: str | None,
) -> str:
    """Apply a YES claim; return the SMS body that should be sent back to the volunteer.

    Seat resolution runs inside a Firestore transaction so concurrent YES
    messages can't overshoot `headcount_needed`. The transaction returns a
    ClaimOutcome describing what happened; SMS side-effects (volunteer reply,
    farmer milestones) fire here, outside the transaction.
    """
    assert opportunity.id is not None
    assert volunteer.id is not None

    if opportunity.status in (OpportunityStatus.COMPLETED, OpportunityStatus.CANCELLED, OpportunityStatus.EXPIRED):
        return _stale_opportunity_body(opportunity, farm_name)

    outcome = opportunities_repo.try_claim_in_transaction(
        opp_id=opportunity.id,
        volunteer_user_id=volunteer.id,
        requested_slots=slots,
        now=datetime.now(UTC),
    )

    if outcome.is_stale:
        return _stale_opportunity_body(opportunity, farm_name)

    if outcome.is_waitlist:
        if outcome.kind == OpportunityKind.PICKUP:
            return templates.render_pickup_already_claimed(farm_name=farm_name)
        return templates.render_shift_full(farm_name=farm_name)

    # Re-load with the post-transaction state so milestone helpers see the
    # updated seats_filled / status when deciding whether to fire.
    refreshed = opportunities_repo.get_by_id(opportunity.id) or opportunity

    from app.flows import farmer_ops
    farmer_ops.notify_first_claim_if_unsent(
        opp=refreshed,
        volunteer_name=volunteer.name,
        farmer_phone=notify_farmer_phone,
        messaging=messaging,
    )

    if outcome.just_filled and notify_farmer_phone:
        safe_send(
            messaging,
            to_phone=notify_farmer_phone,
            body=f"{farm_name} is fully claimed for {farmer_ops.opp_short_summary(refreshed)}.",
        )

    return _confirmation_body(refreshed, farm_name)


def handle_volunteer_drop(
    *,
    messaging: MessagingProvider,
    opportunity: OpportunityDoc,
    volunteer: UserDoc,
) -> str:
    """Volunteer is dropping a confirmed claim (typically in reply to a
    confirmation reminder). Decrements seats_filled atomically, flips status
    back to FILLING if it was FULL, resets next_escalation_at so the existing
    outreach tick re-fires, and notifies the farmer of the drop.

    Returns the SMS body to send back to the volunteer. If their claim wasn't
    actually CONFIRMED (already dropped, never confirmed, opp gone), returns
    a neutral ack rather than erroring.
    """
    assert opportunity.id is not None
    assert volunteer.id is not None
    outcome = opportunities_repo.drop_confirmed_claim_in_transaction(
        opp_id=opportunity.id,
        volunteer_user_id=volunteer.id,
        now=datetime.now(UTC),
    )
    if not outcome.dropped:
        # Either never confirmed, or already dropped. Acknowledge harmlessly.
        return templates.render_volunteer_drop_ack()

    # Re-fire outreach. The existing escalation tick re-pings the broader pool
    # (or insiders, if we're somehow still in insider tier) and skips anyone
    # already pinged, claimed, or muted — so this is safe even if the opp was
    # already saturated with outreach attempts.
    opportunities_repo.set_next_escalation(
        opportunity.id, at=datetime.now(UTC), tier=opportunity.current_tier
    )

    # Notify the farmer. Direct one-to-one, sends even in quiet hours because
    # the farmer needs to know in real time.
    from app.flows import farmer_ops
    refreshed = opportunities_repo.get_by_id(opportunity.id) or opportunity
    farm = None
    try:
        from app.repos import farms_repo as _farms_repo
        from app.repos import users_repo as _users_repo
        farm = _farms_repo.get_by_id(refreshed.farm_id)
        farmer = _users_repo.get_by_id(farm.owner_user_id) if farm else None
        if farmer and farmer.phone:
            body = templates.render_volunteer_dropped_to_farmer(
                opp_summary=farmer_ops.opp_short_summary(refreshed),
                volunteer_name=volunteer.name,
                filled=outcome.seats_filled_after,
                headcount=outcome.headcount_needed,
            )
            safe_send(messaging, to_phone=farmer.phone, body=body)
    except Exception:  # noqa: BLE001 — farmer notification is best-effort
        pass

    return templates.render_volunteer_drop_ack()


def handle_maybe(
    *,
    opportunity: OpportunityDoc,
    volunteer: UserDoc,
    farm_name: str,
) -> str:
    """Record soft interest on the opportunity without consuming a seat.

    Returned body is the volunteer ack. The interest is visible to admins
    via the claims subcollection (status=INTERESTED).
    """
    assert opportunity.id is not None
    assert volunteer.id is not None
    if opportunity.status in (
        OpportunityStatus.COMPLETED,
        OpportunityStatus.CANCELLED,
        OpportunityStatus.EXPIRED,
        OpportunityStatus.FULL,
    ):
        return _stale_opportunity_body(opportunity, farm_name)
    opportunities_repo.upsert_claim(
        opp_id=opportunity.id,
        claim=ClaimDoc(
            volunteer_user_id=volunteer.id,
            slots=0,
            claimed_at=datetime.now(UTC),
            status=ClaimStatus.INTERESTED,
        ),
    )
    return templates.render_maybe_ack(farm_name=farm_name)


def _confirmation_body(opp: OpportunityDoc, farm_name: str) -> str:
    if opp.kind == OpportunityKind.PICKUP:
        deadline_text = (
            format_deadline(opp.deadline_at) if opp.deadline_at else "today"
        )
        what = opp.produce_description or "the surplus pickup"
        return templates.render_claim_confirmed(
            farm_name=farm_name, when_human=deadline_text, activity_or_produce=what
        )
    when_text = format_when(opp.starts_at) if opp.starts_at else "soon"
    what = ", ".join(opp.activity_tags) if opp.activity_tags else "volunteer shift"
    return templates.render_claim_confirmed(
        farm_name=farm_name, when_human=when_text, activity_or_produce=what
    )


def _stale_opportunity_body(opp: OpportunityDoc, farm_name: str) -> str:
    if opp.kind == OpportunityKind.PICKUP:
        return templates.render_pickup_already_claimed(farm_name=farm_name)
    return templates.render_shift_full(farm_name=farm_name)


# ---------------------------------------------------------------------------
# Window-opp claims (PROPOSED state, farmer-approval gate)
# ---------------------------------------------------------------------------
def handle_window_claim(
    *,
    messaging: MessagingProvider,
    opportunity: OpportunityDoc,
    volunteer: UserDoc,
    day_labels: list[str],
    farm_name: str,
) -> str:
    """Apply a window-opp YES <day-list>.

    For each day label, resolves it against the opp's window to a concrete
    datetime, creates a PROPOSED claim, and triggers the farmer-approval SMS.
    Returns a single SMS reply describing the outcome to the volunteer.

    Days that don't resolve (label outside the window, or unrecognized) are
    listed in the reply so the volunteer knows what was skipped.
    """
    assert opportunity.id is not None
    assert volunteer.id is not None
    if opportunity.status in (
        OpportunityStatus.COMPLETED,
        OpportunityStatus.CANCELLED,
        OpportunityStatus.EXPIRED,
        OpportunityStatus.FULL,
    ):
        return _stale_opportunity_body(opportunity, farm_name)

    resolved: list[tuple[str, datetime]] = []
    unresolved: list[str] = []
    for label in day_labels:
        when = _resolve_day_label(label, opp=opportunity)
        if when is None:
            unresolved.append(label)
        else:
            resolved.append((label, when))

    if not resolved:
        return (
            f"Couldn't match those days to {farm_name}'s window — try "
            f"specific weekdays like YES WED."
        )

    # Import inside the function to avoid a circular import at module load.
    from app.flows import proposals as proposals_flow
    from app.repos import opportunities_repo as _opp_repo

    accepted_labels: list[str] = []
    full_labels: list[str] = []
    for label, when in resolved:
        outcome = _opp_repo.try_claim_in_transaction(
            opp_id=opportunity.id,
            volunteer_user_id=volunteer.id,
            requested_slots=1,
            now=datetime.now(UTC),
            scheduled_for_at=when,
            target_status=ClaimStatus.PROPOSED,
        )
        if outcome.is_stale:
            return _stale_opportunity_body(opportunity, farm_name)
        if outcome.is_waitlist:
            full_labels.append(label)
            continue
        accepted_labels.append(label)
        # Look up the just-written claim to pass to the proposal sender.
        claim_doc_id = _opp_repo._claim_doc_id(
            volunteer_user_id=volunteer.id, scheduled_for_at=when,
        )
        claim = _opp_repo.get_claim(
            opp_id=opportunity.id,
            volunteer_user_id=volunteer.id,
            scheduled_for_at=when,
        )
        if claim is not None:
            proposals_flow.send_proposal_to_farmer(
                opp=opportunity,
                claim=claim,
                claim_doc_id=claim_doc_id,
                volunteer=volunteer,
                messaging=messaging,
            )

    parts: list[str] = []
    if accepted_labels:
        days_str = ", ".join(accepted_labels)
        parts.append(
            f"Got it — proposed {days_str} for {farm_name}. The farmer "
            f"will confirm shortly."
        )
    if full_labels:
        parts.append(f"({', '.join(full_labels)} already at headcount.)")
    if unresolved:
        parts.append(f"(Couldn't match: {', '.join(unresolved)}.)")
    return " ".join(parts)


def handle_day_vote(
    *,
    opportunity: OpportunityDoc,
    volunteer: UserDoc,
    day_labels: list[str],
    any_day: bool = False,
    farm_name: str,
) -> str:
    """Record soft DAY_VOTEs for a candidate-day (COLLECTING) opp and ack.

    This is the dispatch *reflex* half of candidate-day voting: it only writes
    votes and acknowledges the volunteer. It never claims a seat, never messages
    the farmer, and never decides anything — the board-review tick owns the
    farmer nudge / convergence / lock-in (docs/preferred-day-voting.md).

    `any_day` expands to every candidate day. Day labels that don't resolve to a
    candidate day are reported back so the volunteer knows what was skipped.
    """
    assert opportunity.id is not None
    assert volunteer.id is not None
    if opportunity.vote_state != "collecting":
        # Defensive: caller already checks, but never vote on a locked/expired opp.
        return _stale_opportunity_body(opportunity, farm_name)

    if any_day:
        resolved = [(_label_for_date(d), d) for d in _candidate_datetimes(opportunity)]
        unresolved: list[str] = []
    else:
        resolved = []
        unresolved = []
        for label in day_labels:
            when = _resolve_day_label(label, opp=opportunity)
            if when is None or not _is_candidate_day(opportunity, when):
                unresolved.append(label)
            else:
                resolved.append((label, when))

    if not resolved:
        return (
            f"Couldn't match those days to {farm_name}'s request — the options "
            f"are {_candidate_days_human(opportunity)}."
        )

    for _label, when in resolved:
        opportunities_repo.add_day_vote(
            opp_id=opportunity.id,
            volunteer_user_id=volunteer.id,
            scheduled_for_at=when,
        )

    days_human = ", ".join(_label_human(when) for _, when in resolved)
    ack = (
        f"Got it — you're down for {days_human} at {farm_name} if it's picked. "
        f"The farmer will confirm the day soon."
    )
    if unresolved:
        ack += f" (Couldn't match: {', '.join(unresolved)}.)"
    return ack


def _candidate_datetimes(opp: OpportunityDoc) -> list[datetime]:
    """The opp's candidate days as concrete datetimes (time-of-day from
    starts_at). Prefers the explicit `candidate_days`; falls back to the
    contiguous window span if only window_end_at is set."""
    if opp.candidate_days:
        return list(opp.candidate_days)
    if opp.starts_at is None:
        return []
    start_local = to_local(opp.starts_at)
    end_local = to_local(opp.window_end_at) if opp.window_end_at else start_local
    out: list[datetime] = []
    cursor = start_local
    while cursor.date() <= end_local.date():
        out.append(cursor.astimezone(UTC))
        cursor = cursor + timedelta(days=1)
    return out


def _is_candidate_day(opp: OpportunityDoc, when: datetime) -> bool:
    target = to_local(when).date()
    return any(to_local(d).date() == target for d in _candidate_datetimes(opp))


def _label_for_date(when: datetime) -> str:
    return to_local(when).strftime("%a").upper()[:3]


def _label_human(when: datetime) -> str:
    local = to_local(when)
    return local.strftime("%a %-m/%-d")


def _candidate_days_human(opp: OpportunityDoc) -> str:
    days = _candidate_datetimes(opp)
    return ", ".join(_label_human(d) for d in days) if days else "the listed days"


_WEEKDAY_INDEX = {
    "MON": 0, "MONDAY": 0,
    "TUE": 1, "TUES": 1, "TUESDAY": 1,
    "WED": 2, "WEDNESDAY": 2,
    "THU": 3, "THUR": 3, "THURS": 3, "THURSDAY": 3,
    "FRI": 4, "FRIDAY": 4,
    "SAT": 5, "SATURDAY": 5,
    "SUN": 6, "SUNDAY": 6,
}

_MONTH_INDEX = {
    "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
    "JUL": 7, "AUG": 8, "SEP": 9, "SEPT": 9, "OCT": 10, "NOV": 11, "DEC": 12,
}


def _resolve_day_label(
    label: str, *, opp: OpportunityDoc,
) -> datetime | None:
    """Resolve a YES-<day> label to a concrete datetime inside the opp's window.

    Time-of-day is inherited from `opp.starts_at`. Date must fall inside
    `[opp.starts_at.date(), opp.window_end_at.date()]`. Returns None if the
    label can't be resolved or falls outside the window.

    Single-day opps (no window_end_at): label must match opp.starts_at's day.
    """
    if opp.starts_at is None:
        return None
    start_local = to_local(opp.starts_at)
    end_local = to_local(opp.window_end_at) if opp.window_end_at else start_local
    label_clean = label.strip().upper()

    candidate_date = None
    if label_clean in _WEEKDAY_INDEX:
        target_wd = _WEEKDAY_INDEX[label_clean]
        # Walk the window day-by-day looking for the matching weekday.
        cursor = start_local.date()
        while cursor <= end_local.date():
            if cursor.weekday() == target_wd:
                candidate_date = cursor
                break
            cursor = cursor + timedelta(days=1)
    elif label_clean == "TODAY":
        now_local = datetime.now(VASHON_TZ)
        candidate_date = now_local.date()
    elif label_clean == "TOMORROW":
        now_local = datetime.now(VASHON_TZ)
        candidate_date = (now_local + timedelta(days=1)).date()
    elif "/" in label_clean:
        # "6/4" → month 6, day 4. Year inferred from the window.
        parts = label_clean.split("/")
        try:
            month, day = int(parts[0]), int(parts[1])
        except (ValueError, IndexError):
            return None
        year = start_local.year
        try:
            candidate_date = datetime(year, month, day).date()
        except ValueError:
            return None
    else:
        # "JUN 4" or "JUN4"
        compact = label_clean.replace(" ", "")
        for mname, mnum in _MONTH_INDEX.items():
            if compact.startswith(mname):
                tail = compact[len(mname):]
                try:
                    day = int(tail)
                except ValueError:
                    return None
                year = start_local.year
                try:
                    candidate_date = datetime(year, mnum, day).date()
                except ValueError:
                    return None
                break

    if candidate_date is None:
        return None
    if candidate_date < start_local.date() or candidate_date > end_local.date():
        return None

    # Combine with the opp's time-of-day, in Vashon-local terms, then convert
    # back to UTC for persistence.
    combined_local = start_local.replace(
        year=candidate_date.year,
        month=candidate_date.month,
        day=candidate_date.day,
    )
    return combined_local.astimezone(UTC)
