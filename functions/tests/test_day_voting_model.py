"""Phase 0 — candidate-day voting data model + repo helpers.

Covers the new DAY_VOTE claim status, the OpportunityDoc voting fields, and the
add_day_vote / list_day_votes / day_vote_tally repo helpers. Firestore is mocked
(matching the other repo tests); the point is the shapes + tally aggregation,
not a live emulator round-trip. See docs/preferred-day-voting.md.
"""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

from app.repos import opportunities_repo
from app.repos.models import (
    ClaimDoc,
    ClaimStatus,
    OpportunityDoc,
    OpportunityKind,
    OpportunityStatus,
)


def _opp(**kw) -> OpportunityDoc:
    base = dict(
        farm_id="f1",
        kind=OpportunityKind.SHIFT,
        status=OpportunityStatus.OPEN,
        created_at=datetime.now(UTC),
    )
    base.update(kw)
    return OpportunityDoc(**base)


# --- status + model fields ---------------------------------------------------
def test_day_vote_status_is_distinct() -> None:
    assert ClaimStatus.DAY_VOTE.value == "day_vote"
    # Distinct from the soft/holding statuses it must not be confused with.
    assert ClaimStatus.DAY_VOTE not in (
        ClaimStatus.INTERESTED,
        ClaimStatus.PROPOSED,
        ClaimStatus.CONFIRMED,
    )


def test_opportunity_voting_fields_default_off() -> None:
    o = _opp()
    assert o.candidate_days == []
    assert o.by_date is None
    assert o.preferred_day is None
    assert o.vote_state is None
    assert o.day_vote_nudges_sent == 0


def test_opportunity_voting_fields_roundtrip() -> None:
    days = [datetime(2026, 6, 7, tzinfo=UTC), datetime(2026, 6, 8, tzinfo=UTC)]
    o = _opp(
        candidate_days=days,
        by_date=datetime(2026, 6, 8, tzinfo=UTC),
        preferred_day=0,  # Monday
        vote_state="collecting",
    )
    assert o.vote_state == "collecting"
    assert o.preferred_day == 0
    assert len(o.candidate_days) == 2


# --- repo helpers ------------------------------------------------------------
def test_add_day_vote_writes_a_day_vote_claim() -> None:
    captured: dict = {}
    fake_ref = MagicMock()
    fake_ref.set.side_effect = lambda d: captured.update(d)
    fake_collection = MagicMock()
    fake_collection.document.return_value = fake_ref
    # opp doc -> claims subcollection -> claim doc
    fake_opp_doc = MagicMock()
    fake_opp_doc.collection.return_value = fake_collection
    fake_root = MagicMock()
    fake_root.document.return_value = fake_opp_doc
    fake_db = MagicMock()
    fake_db.collection.return_value = fake_root

    with patch.object(opportunities_repo, "db", fake_db), patch.object(
        opportunities_repo, "_parent_exists", return_value=True
    ):
        opportunities_repo.add_day_vote(
            opp_id="o1",
            volunteer_user_id="u1",
            scheduled_for_at=datetime(2026, 6, 7, 17, 0, tzinfo=UTC),  # 10am PDT
        )

    assert captured["status"] == ClaimStatus.DAY_VOTE.value
    assert captured["volunteer_user_id"] == "u1"
    # Holds no seat: a day-vote claim never carries confirmation markers.
    assert captured.get("scheduled_for_at") is not None


def test_day_vote_tally_aggregates_by_local_date() -> None:
    # Three votes: two for 6/7 (one of which is a different volunteer), one 6/8.
    # Times chosen so the LOCAL (Vashon) date is unambiguous.
    votes = [
        ClaimDoc(volunteer_user_id="u1", status=ClaimStatus.DAY_VOTE,
                 scheduled_for_at=datetime(2026, 6, 7, 17, 0, tzinfo=UTC),
                 claimed_at=datetime.now(UTC)),
        ClaimDoc(volunteer_user_id="u2", status=ClaimStatus.DAY_VOTE,
                 scheduled_for_at=datetime(2026, 6, 7, 18, 0, tzinfo=UTC),
                 claimed_at=datetime.now(UTC)),
        ClaimDoc(volunteer_user_id="u3", status=ClaimStatus.DAY_VOTE,
                 scheduled_for_at=datetime(2026, 6, 8, 17, 0, tzinfo=UTC),
                 claimed_at=datetime.now(UTC)),
    ]
    with patch.object(opportunities_repo, "list_day_votes", return_value=votes):
        tally = opportunities_repo.day_vote_tally("o1")
    assert tally == {"2026-06-07": 2, "2026-06-08": 1}


def test_day_vote_tally_empty() -> None:
    with patch.object(opportunities_repo, "list_day_votes", return_value=[]):
        assert opportunities_repo.day_vote_tally("o1") == {}


# --- config flag -------------------------------------------------------------
def test_day_voting_flag_defaults_on() -> None:
    import os
    from app.config import load_settings
    # Ensure no override is forcing it off.
    prev = os.environ.pop("DAY_VOTING_ENABLED", None)
    try:
        assert load_settings().day_voting_enabled is True
    finally:
        if prev is not None:
            os.environ["DAY_VOTING_ENABLED"] = prev


def test_day_voting_flag_kill_switch() -> None:
    import os
    from app.config import load_settings
    prev = os.environ.get("DAY_VOTING_ENABLED")
    os.environ["DAY_VOTING_ENABLED"] = "0"
    try:
        assert load_settings().day_voting_enabled is False
    finally:
        if prev is None:
            os.environ.pop("DAY_VOTING_ENABLED", None)
        else:
            os.environ["DAY_VOTING_ENABLED"] = prev
