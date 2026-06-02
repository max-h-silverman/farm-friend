"""Candidate-day voting: lock-in, deadline, and expiry resolution.

This is the deterministic resolution half of candidate-day voting
(docs/preferred-day-voting.md). The board-review tick (Phase 4) decides WHEN to
nudge/lock/expire; the functions here DO the resolution. No LLM.

- `lock_day`: farmer chose a day. Promote that day's DAY_VOTEs (plus any voter
  who offered every candidate day) to CONFIRMED up to headcount, waitlist the
  overflow, notify off-day-only voters and offer them the locked day, and
  collapse the opp from a candidate window to a normal single-day shift.
- `choose_lock_day`: greedy "best-supported day, preference breaks ties".
- `expire_unlocked`: by-date passed with no lock → release voters, expire opp.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

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
    OpportunityStatus,
)

# Cadence (docs/preferred-day-voting.md). The board-review tick is the pacer; a
# ~30-min worst-case nudge delay is acceptable, so a frequent tick alone is fine.
# Nudge the farmer when a day is fillable, OR when the by-date is within this
# window (deadline-tightening). Per-opp nudge budget caps farmer SMS volume.
_DEADLINE_NUDGE_WINDOW = timedelta(hours=24)
_PER_OPP_NUDGE_BUDGET = 4


def choose_lock_day(opp: OpportunityDoc) -> datetime | None:
    """The best day to lock: most DAY_VOTEs wins; ties broken by the farmer's
    preferred_day, then by earliest date. Returns the candidate datetime, or
    None if there are no votes yet."""
    tally = opportunities_repo.day_vote_tally(opp.id)  # {local_date_iso: count}
    if not tally:
        return None

    def rank(day: datetime) -> tuple[int, int, float]:
        local = to_local(day)
        count = tally.get(local.date().isoformat(), 0)
        is_pref = 1 if (opp.preferred_day is not None and local.weekday() == opp.preferred_day) else 0
        # Higher count, then preferred, then earlier date (negative ts so earlier wins).
        return (count, is_pref, -local.timestamp())

    best = max(opp.candidate_days, key=rank)
    # Don't lock a day with zero votes.
    if tally.get(to_local(best).date().isoformat(), 0) == 0:
        return None
    return best


def _voter_day_set(votes: list[ClaimDoc]) -> dict[str, set[str]]:
    """volunteer_id -> set of local-date-iso days they voted for."""
    out: dict[str, set[str]] = {}
    for v in votes:
        if v.scheduled_for_at is None:
            continue
        out.setdefault(v.volunteer_user_id, set()).add(
            to_local(v.scheduled_for_at).date().isoformat()
        )
    return out


def lock_day(
    *,
    opportunity: OpportunityDoc,
    locked_day: datetime,
    messaging: MessagingProvider,
    farm_name: str,
) -> None:
    """Resolve a candidate-day opp to a single locked day. Deterministic; called
    when the farmer confirms a lock (or, later, by the deadline path with an
    explicit day). Idempotent-ish: a second call on a non-collecting opp no-ops.
    """
    assert opportunity.id is not None
    if opportunity.vote_state != "collecting":
        return

    locked_key = to_local(locked_day).date().isoformat()
    votes = opportunities_repo.list_day_votes(opportunity.id)
    by_voter = _voter_day_set(votes)
    all_candidate_keys = {to_local(d).date().isoformat() for d in opportunity.candidate_days}

    # Voters for the locked day, OR who offered EVERY candidate day (an ANY vote).
    eligible: list[str] = []
    off_day_only: list[str] = []
    for vol_id, days in by_voter.items():
        if locked_key in days or days >= all_candidate_keys:
            eligible.append(vol_id)
        else:
            off_day_only.append(vol_id)

    headcount = opportunity.headcount_needed
    confirmed = eligible[:headcount]
    waitlisted = eligible[headcount:]

    for vol_id in confirmed:
        opportunities_repo.upsert_claim(
            opp_id=opportunity.id,
            claim=ClaimDoc(
                volunteer_user_id=vol_id,
                status=ClaimStatus.CONFIRMED,
                scheduled_for_at=locked_day,
                claimed_at=datetime.now(UTC),
            ),
        )
    for vol_id in waitlisted:
        opportunities_repo.upsert_claim(
            opp_id=opportunity.id,
            claim=ClaimDoc(
                volunteer_user_id=vol_id,
                status=ClaimStatus.WAITLIST,
                scheduled_for_at=locked_day,
                claimed_at=datetime.now(UTC),
            ),
        )

    # Collapse the candidate window to the single locked day → normal shift.
    new_status = (
        OpportunityStatus.FULL
        if len(confirmed) >= headcount
        else OpportunityStatus.FILLING if confirmed
        else OpportunityStatus.OPEN
    )
    opportunities_repo.update_fields(
        opportunity.id,
        {
            "starts_at": locked_day,
            "window_end_at": None,
            "candidate_days": [],
            "vote_state": "locked",
            "seats_filled": len(confirmed),
            "status": new_status.value,
        },
    )

    when_human = _day_human(locked_day)
    activity = opportunity.activity_detail.strip() or "volunteer help"

    # Tell confirmed volunteers they're in.
    for vol_id in confirmed:
        _notify(messaging, vol_id, templates.render_claim_confirmed(
            farm_name=farm_name, when_human=when_human, activity_or_produce=activity,
        ))
    # Tell waitlisted volunteers.
    for vol_id in waitlisted:
        _notify(messaging, vol_id,
                f"{farm_name} is set for {when_human} and full, but you're on the "
                f"waitlist — we'll text if a spot opens.")
    # Off-day-only voters: offer them the locked day (product call).
    for vol_id in off_day_only:
        _notify(messaging, vol_id,
                f"Farm Friend Vashon: {farm_name}'s {activity} is set for "
                f"{when_human} instead. Still able to make it? Reply YES.")


def expire_unlocked(
    *,
    opportunity: OpportunityDoc,
    messaging: MessagingProvider,
    farm_name: str,
) -> None:
    """By-date passed with no farmer lock → release all voters and expire."""
    assert opportunity.id is not None
    if opportunity.vote_state != "collecting":
        return
    votes = opportunities_repo.list_day_votes(opportunity.id)
    notified: set[str] = set()
    for v in votes:
        if v.volunteer_user_id in notified:
            continue
        notified.add(v.volunteer_user_id)
        _notify(messaging, v.volunteer_user_id,
                f"Thanks for offering to help {farm_name} — this one didn't get "
                f"scheduled. We'll be in touch with the next opportunity.")
    opportunities_repo.update_fields(
        opportunity.id,
        {"vote_state": "expired", "status": OpportunityStatus.EXPIRED.value},
    )


def _notify(messaging: MessagingProvider, user_id: str, body: str) -> None:
    user = users_repo.get_by_id(user_id)
    if user is None:
        return
    safe_send(messaging, to_phone=user.phone, body=body)


def _day_human(when: datetime) -> str:
    return to_local(when).strftime("%a %-m/%-d")


# ---------------------------------------------------------------------------
# Coordinator pass (called by the board-review tick — the standing process)
# ---------------------------------------------------------------------------
def coordinate_collecting_opps(*, messaging: MessagingProvider, now: datetime | None = None) -> None:
    """Deterministic day-vote coordination, run each board-review tick.

    For every collecting opp: expire it if the by-date has passed; otherwise, if
    a day is fillable OR the by-date is near, send the farmer a lock nudge (a
    PENDING_CONFIRMATION for `lock_day_vote` on the best day). The farmer's YES
    runs the exact day shown. Throttled by a per-opp nudge budget.

    This is the day-vote carve-out: it sends farmer nudges DIRECTLY even while
    the general review tick is admin-only — the farmer opted into their own
    multi-day post, so a nudge about it is low-risk. No LLM.
    """
    now = now or datetime.now(UTC)
    for opp in opportunities_repo.list_collecting(now=now):
        if opp.id is None:
            continue
        farm = farms_repo.get_by_id(opp.farm_id)
        farm_name = farm.name if farm else "the farm"

        # Deadline passed with no lock → expire + release.
        if opp.by_date is not None and now >= opp.by_date:
            expire_unlocked(opportunity=opp, messaging=messaging, farm_name=farm_name)
            continue

        # Nothing to decide until at least one day has votes.
        best = choose_lock_day(opp)
        if best is None:
            continue

        tally = opportunities_repo.day_vote_tally(opp.id)
        best_count = tally.get(to_local(best).date().isoformat(), 0)
        fillable = best_count >= opp.headcount_needed
        deadline_near = (
            opp.by_date is not None and (opp.by_date - now) <= _DEADLINE_NUDGE_WINDOW
        )
        if not (fillable or deadline_near):
            continue
        if opp.day_vote_nudges_sent >= _PER_OPP_NUDGE_BUDGET:
            continue
        if _already_nudged_this_pass(opp):
            continue

        _send_lock_nudge(
            opp=opp, locked_day=best, best_count=best_count,
            fillable=fillable, farm=farm, farm_name=farm_name, messaging=messaging,
        )


def _already_nudged_this_pass(opp: OpportunityDoc) -> bool:
    """True if the latest farmer outbound on this opp is already a live lock
    nudge — avoid stacking duplicate pending confirmations on consecutive ticks."""
    if not opp.farm_id:
        return False
    farm = farms_repo.get_by_id(opp.farm_id)
    farmer_id = farm.owner_user_id if farm else None
    if not farmer_id:
        return False
    recent = messages_repo.list_for_user(farmer_id, limit=5)
    for msg in recent:
        if (
            msg.direction == MessageDirection.OUTBOUND
            and msg.opportunity_id == opp.id
            and msg.intent_label == IntentLabel.PENDING_CONFIRMATION
            and (msg.pending_action or {}).get("action") == "lock_day_vote"
        ):
            return True
    return False


def _send_lock_nudge(
    *,
    opp: OpportunityDoc,
    locked_day: datetime,
    best_count: int,
    fillable: bool,
    farm,
    farm_name: str,
    messaging: MessagingProvider,
) -> None:
    """Send the farmer a 'lock this day?' nudge as a PENDING_CONFIRMATION for
    lock_day_vote. Token is YES; the locked day is fixed in the payload so the
    farmer's YES locks exactly the day named."""
    farmer = users_repo.get_by_id(farm.owner_user_id) if farm and farm.owner_user_id else None
    if farmer is None:
        return
    day_human = _day_human(locked_day)
    pref_note = ""
    if opp.preferred_day is not None and to_local(locked_day).weekday() == opp.preferred_day:
        pref_note = " (your pick)"
    if fillable:
        body = (
            f"Farm Friend Vashon: {best_count} want {day_human}{pref_note} for your "
            f"{opp.activity_detail or 'shift'} at {farm_name}. Lock it in? Reply YES, "
            f"or ignore to wait for more."
        )
    else:
        body = (
            f"Farm Friend Vashon: so far {best_count} offered {day_human}{pref_note} "
            f"for your {opp.activity_detail or 'shift'}. Lock it in? Reply YES, or "
            f"ignore to keep waiting."
        )

    provider_id = safe_send(messaging, to_phone=farmer.phone, body=body)
    if provider_id is None:
        return
    pending_payload = {
        "action": "lock_day_vote",
        "token": "YES",
        "payload": {"opp_id": opp.id, "locked_day": locked_day.isoformat()},
        "expires_at": (datetime.now(UTC) + timedelta(hours=12)).isoformat(),
    }
    messages_repo.create(
        MessageDoc(
            direction=MessageDirection.OUTBOUND,
            provider_msg_id=provider_id,
            user_id=farmer.id,
            opportunity_id=opp.id,
            body=body,
            intent_label=IntentLabel.PENDING_CONFIRMATION,
            pending_action=pending_payload,
            created_at=datetime.now(UTC),
        )
    )
    opportunities_repo.increment_day_vote_nudges_sent(opp.id)
