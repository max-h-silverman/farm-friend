"""Phase 2 — candidate-day post creation: parser → executor → fan-out copy.

The agent emits candidate_days; _opportunity_from_parsed translates to a
collecting voting opp; _render_outreach_body produces the voting fan-out.
See docs/preferred-day-voting.md.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime

from app.agent.parser import ParsedOpportunity
from app.flows.message_dispatch import _opportunity_from_parsed
from app.flows.outreach import _render_outreach_body
from app.repos.models import OpportunityDoc, OpportunityKind, OpportunityStatus


_DAYS = [
    "2026-06-07T09:00:00-07:00",  # Sun
    "2026-06-08T09:00:00-07:00",  # Mon
    "2026-06-10T09:00:00-07:00",  # Wed
]


def _parsed(**kw) -> ParsedOpportunity:
    base = dict(
        kind="shift",
        starts_at=_DAYS[0],
        headcount_needed=2,
        activity_detail="Harvest",
    )
    base.update(kw)
    return ParsedOpportunity(**base)


# --- executor translation ----------------------------------------------------
def test_candidate_days_become_a_collecting_opp():
    os.environ["DAY_VOTING_ENABLED"] = "1"
    opp = _opportunity_from_parsed(
        farm_id="f1",
        parsed=_parsed(candidate_days=_DAYS, preferred_day=_DAYS[1]),
        source_message_id="m1",
    )
    assert opp.vote_state == "collecting"
    assert len(opp.candidate_days) == 3
    assert opp.by_date is not None and opp.by_date.date().isoformat() == "2026-06-10"
    assert opp.preferred_day == 0  # Monday
    # Window spans first→last so day-label resolution works.
    assert opp.starts_at.date().isoformat() == "2026-06-07"
    assert opp.window_end_at.date().isoformat() == "2026-06-10"


def test_single_candidate_day_is_not_a_vote():
    # < 2 candidate days = an ordinary single-day post, not voting.
    os.environ["DAY_VOTING_ENABLED"] = "1"
    opp = _opportunity_from_parsed(
        farm_id="f1", parsed=_parsed(candidate_days=[_DAYS[0]]), source_message_id="m1",
    )
    assert opp.vote_state is None
    assert opp.candidate_days == []


def test_no_candidate_days_is_normal_single_day():
    os.environ["DAY_VOTING_ENABLED"] = "1"
    opp = _opportunity_from_parsed(
        farm_id="f1", parsed=_parsed(), source_message_id="m1",
    )
    assert opp.vote_state is None


def test_kill_switch_disables_voting_translation():
    os.environ["DAY_VOTING_ENABLED"] = "0"
    try:
        opp = _opportunity_from_parsed(
            farm_id="f1", parsed=_parsed(candidate_days=_DAYS), source_message_id="m1",
        )
        # With voting off, candidate_days don't create a collecting opp.
        assert opp.vote_state is None
        assert opp.candidate_days == []
    finally:
        os.environ["DAY_VOTING_ENABLED"] = "1"


def test_preferred_day_from_weekday_int():
    os.environ["DAY_VOTING_ENABLED"] = "1"
    opp = _opportunity_from_parsed(
        farm_id="f1",
        parsed=_parsed(candidate_days=_DAYS, preferred_day="2"),  # Wed as int-string
        source_message_id="m1",
    )
    assert opp.preferred_day == 2


def test_pickup_never_votes():
    # Pickups are a single-claim race; candidate_days on a pickup is ignored.
    os.environ["DAY_VOTING_ENABLED"] = "1"
    opp = _opportunity_from_parsed(
        farm_id="f1",
        parsed=_parsed(kind="pickup", candidate_days=_DAYS,
                       produce_description="kale", destination="food bank",
                       deadline_at=_DAYS[0]),
        source_message_id="m1",
    )
    assert opp.vote_state is None


# --- fan-out copy ------------------------------------------------------------
def _voting_opp() -> OpportunityDoc:
    return OpportunityDoc(
        id="o1", farm_id="f1", kind=OpportunityKind.SHIFT, status=OpportunityStatus.OPEN,
        starts_at=datetime(2026, 6, 7, 16, tzinfo=UTC),
        window_end_at=datetime(2026, 6, 10, 16, tzinfo=UTC),
        headcount_needed=2, vote_state="collecting", preferred_day=0,
        candidate_days=[datetime(2026, 6, 7, 16, tzinfo=UTC),
                        datetime(2026, 6, 8, 16, tzinfo=UTC),
                        datetime(2026, 6, 10, 16, tzinfo=UTC)],
        activity_detail="Tomato Harvest", created_at=datetime.now(UTC),
    )


def test_fanout_lists_days_with_dates_and_preference():
    body = _render_outreach_body(opp=_voting_opp(), farm_name="Three Cedars")
    assert "Three Cedars" in body
    assert "Tomato Harvest" in body
    assert "Sun 6/7" in body and "Wed 6/10" in body
    assert "(farmer's pick)" in body  # preferred-day hint
    assert "Reply with a day" in body


def test_fanout_carries_program_name_and_stop():
    # Broadcast outreach must carry program name + STOP (compliance).
    body = _render_outreach_body(opp=_voting_opp(), farm_name="Three Cedars")
    assert body.startswith("Farm Friend Vashon")
    assert "STOP" in body
