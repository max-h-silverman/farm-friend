"""Phase 1 — volunteer day-vote intake (dispatch reflex).

Two layers: the hotkey grammar (bare day-lists / ANY-BOTH -> CLAIM with days),
and claim_flow.handle_day_vote (records DAY_VOTEs + deterministic ack, no seat,
no farmer outreach). Firestore is mocked. See docs/preferred-day-voting.md.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import patch

from app.agent import hotkeys
from app.flows import claim as claim_flow
from app.repos.models import (
    IntentLabel,
    OpportunityDoc,
    OpportunityKind,
    OpportunityStatus,
    UserDoc,
    UserRole,
    UserStatus,
)


# --- hotkey grammar ----------------------------------------------------------
def _parse(text, clarify=False):
    m = hotkeys.parse(text, last_outbound_was_clarify=clarify)
    return None if m is None else (m.intent, m.payload)


def test_bare_day_list_parses_to_claim_with_days():
    intent, payload = _parse("MON, WED")
    assert intent == IntentLabel.CLAIM
    assert payload["days"] == ["MON", "WED"]


def test_single_bare_day():
    intent, payload = _parse("SUN")
    assert intent == IntentLabel.CLAIM and payload["days"] == ["SUN"]


def test_any_both_set_any_day_flag():
    for tok in ("ANY", "both", "all"):
        intent, payload = _parse(tok)
        assert intent == IntentLabel.CLAIM and payload.get("any_day") is True


def test_free_form_with_day_word_falls_through_to_agent():
    # A sentence containing a day word must NOT be a hotkey — the agent handles it.
    assert _parse("can i do sunday maybe?") is None
    assert _parse("sunday works but i'm flexible") is None


def test_bare_day_suppressed_right_after_clarify():
    assert _parse("SUN", clarify=True) is None


def test_leading_yes_day_still_wins():
    intent, payload = _parse("YES SUN")
    assert intent == IntentLabel.CLAIM and payload["days"] == ["SUN"]


# --- handle_day_vote ---------------------------------------------------------
def _voting_opp(**kw) -> OpportunityDoc:
    # Window Sun 6/7 .. Wed 6/10 (9am PDT). Candidate days Sun/Mon/Wed.
    start = datetime(2026, 6, 7, 16, 0, tzinfo=UTC)  # 9am PDT
    base = dict(
        id="o1",
        farm_id="f1",
        kind=OpportunityKind.SHIFT,
        status=OpportunityStatus.OPEN,
        starts_at=start,
        window_end_at=datetime(2026, 6, 10, 16, 0, tzinfo=UTC),
        headcount_needed=2,
        vote_state="collecting",
        candidate_days=[
            datetime(2026, 6, 7, 16, 0, tzinfo=UTC),
            datetime(2026, 6, 8, 16, 0, tzinfo=UTC),
            datetime(2026, 6, 10, 16, 0, tzinfo=UTC),
        ],
        created_at=datetime.now(UTC),
    )
    base.update(kw)
    return OpportunityDoc(**base)


def _vol() -> UserDoc:
    return UserDoc(id="u1", phone="+12065550101", name="Alex", role=UserRole.VOLUNTEER,
                   status=UserStatus.ACTIVE, created_at=datetime.now(UTC))


def test_handle_day_vote_records_votes_and_acks():
    opp, vol = _voting_opp(), _vol()
    calls = []
    with patch.object(claim_flow.opportunities_repo, "add_day_vote",
                      side_effect=lambda **k: calls.append(k)):
        reply = claim_flow.handle_day_vote(
            opportunity=opp, volunteer=vol, day_labels=["SUN", "MON"],
            farm_name="Three Cedars",
        )
    assert len(calls) == 2  # two days recorded
    assert all(c["opp_id"] == "o1" and c["volunteer_user_id"] == "u1" for c in calls)
    assert "Three Cedars" in reply and "farmer will confirm" in reply.lower()


def test_handle_day_vote_any_expands_to_all_candidate_days():
    opp, vol = _voting_opp(), _vol()
    calls = []
    with patch.object(claim_flow.opportunities_repo, "add_day_vote",
                      side_effect=lambda **k: calls.append(k)):
        reply = claim_flow.handle_day_vote(
            opportunity=opp, volunteer=vol, day_labels=[], any_day=True,
            farm_name="Three Cedars",
        )
    assert len(calls) == 3  # all three candidate days
    assert reply  # non-empty ack


def test_handle_day_vote_rejects_non_candidate_day():
    # Tuesday (6/9) is inside the window span but NOT a candidate day.
    opp, vol = _voting_opp(), _vol()
    calls = []
    with patch.object(claim_flow.opportunities_repo, "add_day_vote",
                      side_effect=lambda **k: calls.append(k)):
        reply = claim_flow.handle_day_vote(
            opportunity=opp, volunteer=vol, day_labels=["TUE"],
            farm_name="Three Cedars",
        )
    assert len(calls) == 0
    assert "couldn't match" in reply.lower()


def test_handle_day_vote_partial_match_reports_unresolved():
    opp, vol = _voting_opp(), _vol()
    calls = []
    with patch.object(claim_flow.opportunities_repo, "add_day_vote",
                      side_effect=lambda **k: calls.append(k)):
        reply = claim_flow.handle_day_vote(
            opportunity=opp, volunteer=vol, day_labels=["SUN", "TUE"],
            farm_name="Three Cedars",
        )
    assert len(calls) == 1  # only SUN resolved
    assert "TUE" in reply  # unresolved reported
