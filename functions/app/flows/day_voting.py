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

from datetime import UTC, datetime

from app.copy import templates
from app.flows._time import to_local
from app.messaging import MessagingProvider
from app.messaging._safe_send import safe_send
from app.repos import opportunities_repo, users_repo
from app.repos.models import (
    ClaimDoc,
    ClaimStatus,
    OpportunityDoc,
    OpportunityStatus,
)


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
