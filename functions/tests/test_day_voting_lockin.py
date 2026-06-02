"""Phase 3 — candidate-day voting lock-in / deadline / expiry (deterministic).

Tests choose_lock_day (greedy + preference tiebreak), lock_day (confirm /
waitlist / off-day split + opp collapse), and expire_unlocked. Repo + messaging
are mocked. See docs/preferred-day-voting.md.
"""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

from app.flows import day_voting
from app.repos.models import (
    ClaimDoc,
    ClaimStatus,
    OpportunityDoc,
    OpportunityKind,
    OpportunityStatus,
    UserDoc,
    UserRole,
    UserStatus,
)

SUN = datetime(2026, 6, 7, 16, tzinfo=UTC)   # Sun 6/7 9am PDT
MON = datetime(2026, 6, 8, 16, tzinfo=UTC)   # Mon 6/8
WED = datetime(2026, 6, 10, 16, tzinfo=UTC)  # Wed 6/10


def _opp(headcount=2, preferred_day=None, vote_state="collecting") -> OpportunityDoc:
    return OpportunityDoc(
        id="o1", farm_id="f1", kind=OpportunityKind.SHIFT, status=OpportunityStatus.OPEN,
        starts_at=SUN, window_end_at=WED, headcount_needed=headcount,
        vote_state=vote_state, preferred_day=preferred_day,
        candidate_days=[SUN, MON, WED], activity_detail="Harvest",
        created_at=datetime.now(UTC),
    )


def _vote(vol, day) -> ClaimDoc:
    return ClaimDoc(volunteer_user_id=vol, status=ClaimStatus.DAY_VOTE,
                    scheduled_for_at=day, claimed_at=datetime.now(UTC))


def _user(uid):
    u = UserDoc(id=uid, phone=f"+1206555{uid[-4:].zfill(4)}", name=uid,
                role=UserRole.VOLUNTEER, status=UserStatus.ACTIVE,
                created_at=datetime.now(UTC))
    return u


# --- choose_lock_day ---------------------------------------------------------
def test_choose_lock_day_most_votes_wins():
    opp = _opp()
    tally = {"2026-06-07": 1, "2026-06-08": 3, "2026-06-10": 2}
    with patch.object(day_voting.opportunities_repo, "day_vote_tally", return_value=tally):
        assert day_voting.choose_lock_day(opp) == MON


def test_choose_lock_day_preference_breaks_tie():
    opp = _opp(preferred_day=2)  # Wed
    tally = {"2026-06-08": 2, "2026-06-10": 2}  # Mon and Wed tied
    with patch.object(day_voting.opportunities_repo, "day_vote_tally", return_value=tally):
        assert day_voting.choose_lock_day(opp) == WED


def test_choose_lock_day_none_when_no_votes():
    opp = _opp()
    with patch.object(day_voting.opportunities_repo, "day_vote_tally", return_value={}):
        assert day_voting.choose_lock_day(opp) is None


# --- lock_day ----------------------------------------------------------------
def _run_lock(opp, votes, locked=MON):
    updates = {}
    claims = []
    prov = MagicMock()
    with patch.object(day_voting.opportunities_repo, "list_day_votes", return_value=votes), \
         patch.object(day_voting.opportunities_repo, "upsert_claim",
                      side_effect=lambda **k: claims.append(k["claim"])), \
         patch.object(day_voting.opportunities_repo, "update_fields",
                      side_effect=lambda oid, f: updates.update(f)), \
         patch.object(day_voting.users_repo, "get_by_id", side_effect=_user), \
         patch.object(day_voting, "safe_send") as send:
        day_voting.lock_day(opportunity=opp, locked_day=locked,
                            messaging=prov, farm_name="Three Cedars")
    return updates, claims, send


def test_lock_day_confirms_chosen_day_voters_up_to_headcount():
    opp = _opp(headcount=2)
    votes = [_vote("u1", MON), _vote("u2", MON), _vote("u3", MON)]  # 3 want Mon, need 2
    updates, claims, send = _run_lock(opp, votes, locked=MON)
    confirmed = [c for c in claims if c.status == ClaimStatus.CONFIRMED]
    waitlist = [c for c in claims if c.status == ClaimStatus.WAITLIST]
    assert len(confirmed) == 2 and len(waitlist) == 1
    assert all(c.scheduled_for_at == MON for c in confirmed)
    # Opp collapses to the locked single day.
    assert updates["vote_state"] == "locked"
    assert updates["window_end_at"] is None
    assert updates["candidate_days"] == []
    assert updates["starts_at"] == MON
    assert updates["seats_filled"] == 2
    assert updates["status"] == OpportunityStatus.FULL.value


def test_lock_day_any_voter_counts_for_the_locked_day():
    opp = _opp(headcount=2)
    # u1 voted all three days (an ANY vote); u2 voted only Mon.
    votes = [_vote("u1", SUN), _vote("u1", MON), _vote("u1", WED), _vote("u2", MON)]
    updates, claims, send = _run_lock(opp, votes, locked=MON)
    confirmed = {c.volunteer_user_id for c in claims if c.status == ClaimStatus.CONFIRMED}
    assert confirmed == {"u1", "u2"}


def test_lock_day_off_day_voters_notified_and_offered():
    opp = _opp(headcount=2)
    votes = [_vote("u1", MON), _vote("u2", SUN)]  # u2 only wants Sun; locked = Mon
    updates, claims, send = _run_lock(opp, votes, locked=MON)
    confirmed = {c.volunteer_user_id for c in claims if c.status == ClaimStatus.CONFIRMED}
    assert confirmed == {"u1"}  # u2 not auto-confirmed
    # u2 got an offer message mentioning the new day + "Reply YES".
    bodies = [c.kwargs.get("body", "") for c in send.call_args_list]
    assert any("set for" in b and "Reply YES" in b for b in bodies)


def test_lock_day_noop_when_not_collecting():
    opp = _opp(vote_state="locked")
    updates, claims, send = _run_lock(opp, [_vote("u1", MON)], locked=MON)
    assert claims == [] and updates == {}


# --- expire_unlocked ---------------------------------------------------------
def test_expire_releases_voters_and_expires_opp():
    opp = _opp()
    votes = [_vote("u1", MON), _vote("u2", SUN), _vote("u1", WED)]  # u1 voted twice
    updates = {}
    prov = MagicMock()
    with patch.object(day_voting.opportunities_repo, "list_day_votes", return_value=votes), \
         patch.object(day_voting.opportunities_repo, "update_fields",
                      side_effect=lambda oid, f: updates.update(f)), \
         patch.object(day_voting.users_repo, "get_by_id", side_effect=_user), \
         patch.object(day_voting, "safe_send") as send:
        day_voting.expire_unlocked(opportunity=opp, messaging=prov, farm_name="Three Cedars")
    assert updates["vote_state"] == "expired"
    assert updates["status"] == OpportunityStatus.EXPIRED.value
    # Each unique voter notified once (u1 deduped).
    assert send.call_count == 2
