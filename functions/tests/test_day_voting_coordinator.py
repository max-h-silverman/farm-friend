"""Phase 4 — board-review tick coordination of collecting opps (deterministic).

coordinate_collecting_opps: expire at by-date, nudge the farmer to lock a
fillable/deadline-near day, respect the per-opp budget + dedup. Repo + messaging
mocked. See docs/preferred-day-voting.md.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

from app.flows import day_voting
from app.repos.models import (
    FarmDoc,
    OpportunityDoc,
    OpportunityKind,
    OpportunityStatus,
    UserDoc,
    UserRole,
    UserStatus,
)

NOW = datetime(2026, 6, 5, 18, tzinfo=UTC)
SUN = datetime(2026, 6, 7, 16, tzinfo=UTC)
MON = datetime(2026, 6, 8, 16, tzinfo=UTC)
WED = datetime(2026, 6, 10, 16, tzinfo=UTC)


def _opp(by_date=WED, nudges=0, headcount=2, preferred_day=None) -> OpportunityDoc:
    return OpportunityDoc(
        id="o1", farm_id="f1", kind=OpportunityKind.SHIFT, status=OpportunityStatus.OPEN,
        starts_at=SUN, window_end_at=WED, headcount_needed=headcount,
        vote_state="collecting", by_date=by_date, preferred_day=preferred_day,
        candidate_days=[SUN, MON, WED], activity_detail="Harvest",
        day_vote_nudges_sent=nudges, created_at=datetime.now(UTC),
    )


def _farm() -> FarmDoc:
    return FarmDoc(id="f1", name="Three Cedars", owner_user_id="farmer1",
                   created_at=datetime.now(UTC))


def _farmer() -> UserDoc:
    return UserDoc(id="farmer1", phone="+12065550001", name="Tom",
                   role=UserRole.FARMER, status=UserStatus.ACTIVE,
                   created_at=datetime.now(UTC))


def _run(opp, tally, *, now=NOW, last_msgs=None):
    created = []
    sent = []
    expired = {"called": False}
    with patch.object(day_voting.opportunities_repo, "list_collecting", return_value=[opp]), \
         patch.object(day_voting.opportunities_repo, "day_vote_tally", return_value=tally), \
         patch.object(day_voting.opportunities_repo, "increment_day_vote_nudges_sent"), \
         patch.object(day_voting.opportunities_repo, "update_fields"), \
         patch.object(day_voting.opportunities_repo, "list_day_votes", return_value=[]), \
         patch.object(day_voting.farms_repo, "get_by_id", return_value=_farm()), \
         patch.object(day_voting.users_repo, "get_by_id", return_value=_farmer()), \
         patch.object(day_voting.messages_repo, "list_for_user", return_value=last_msgs or []), \
         patch.object(day_voting.messages_repo, "create", side_effect=lambda d: created.append(d)), \
         patch.object(day_voting, "safe_send", side_effect=lambda *a, **k: sent.append(k) or "pid"), \
         patch.object(day_voting, "expire_unlocked", side_effect=lambda **k: expired.update(called=True)):
        day_voting.coordinate_collecting_opps(messaging=MagicMock(), now=now)
    return created, sent, expired


# --- expiry ------------------------------------------------------------------
def test_expires_at_by_date():
    opp = _opp(by_date=datetime(2026, 6, 4, tzinfo=UTC))  # by-date already passed
    created, sent, expired = _run(opp, {"2026-06-08": 1})
    assert expired["called"] is True
    assert created == []  # no nudge once expiring


# --- fillable nudge ----------------------------------------------------------
def test_nudges_farmer_when_a_day_is_fillable():
    opp = _opp(headcount=2)
    created, sent, expired = _run(opp, {"2026-06-08": 2})  # Mon fillable
    assert len(created) == 1
    pending = created[0].pending_action
    assert pending["action"] == "lock_day_vote"
    assert pending["payload"]["opp_id"] == "o1"
    # Locked day is Monday (the fillable one).
    assert pending["payload"]["locked_day"].startswith("2026-06-08")
    assert "Lock it in?" in created[0].body


def test_no_nudge_when_not_fillable_and_deadline_far():
    opp = _opp(by_date=WED, headcount=3)  # WED is >24h from NOW (6/5)
    created, sent, expired = _run(opp, {"2026-06-08": 1})  # 1 vote, need 3
    assert created == [] and expired["called"] is False


def test_nudges_when_deadline_near_even_if_not_fillable():
    # by-date within 24h of NOW; a single vote is enough to prompt a decision.
    opp = _opp(by_date=NOW + timedelta(hours=12), headcount=3)
    created, sent, expired = _run(opp, {"2026-06-08": 1})
    assert len(created) == 1
    assert "so far" in created[0].body.lower()


# --- budget + dedup ----------------------------------------------------------
def test_respects_per_opp_nudge_budget():
    opp = _opp(headcount=2, nudges=day_voting._PER_OPP_NUDGE_BUDGET)
    created, sent, expired = _run(opp, {"2026-06-08": 2})
    assert created == []  # budget exhausted


def test_dedups_when_live_lock_nudge_already_sent():
    from app.repos.models import MessageDoc, MessageDirection, IntentLabel
    prior = MessageDoc(
        direction=MessageDirection.OUTBOUND, provider_msg_id="m0", user_id="farmer1",
        opportunity_id="o1", body="Lock it in?", intent_label=IntentLabel.PENDING_CONFIRMATION,
        pending_action={"action": "lock_day_vote"}, created_at=datetime.now(UTC),
    )
    opp = _opp(headcount=2)
    created, sent, expired = _run(opp, {"2026-06-08": 2}, last_msgs=[prior])
    assert created == []  # already nudged, don't stack
