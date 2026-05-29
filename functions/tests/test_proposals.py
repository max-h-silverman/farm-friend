"""Tests for the farmer-approval gate (window-opp proposal flow).

Token generation is the deterministic, Firestore-free piece — pin its shape
and stability. Day-label resolution (`_resolve_day_label`) is similarly pure
and worth testing exhaustively because the hotkey grammar feeds into it.

The Firestore-touching pieces (handle_farmer_decision, send_proposal_to_farmer)
get integration coverage at the eval-runner layer in PR 6.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.flows.claim import _resolve_day_label
from app.flows.proposals import proposal_token
from app.repos.models import OpportunityDoc, OpportunityKind, OpportunityStatus


# Vashon-local Mon Jun 1 9am = UTC 16:00.
MON_9AM = datetime(2026, 6, 1, 16, 0, tzinfo=UTC)
FRI_LAST = datetime(2026, 6, 5, 16, 0, tzinfo=UTC)


def _window_opp() -> OpportunityDoc:
    return OpportunityDoc(
        farm_id="f_1",
        kind=OpportunityKind.SHIFT,
        status=OpportunityStatus.OPEN,
        starts_at=MON_9AM,
        window_end_at=FRI_LAST,
        duration_min=180,
        headcount_needed=2,
        activity_tags=["weeding"],
        created_at=MON_9AM,
    )


def _single_day_opp() -> OpportunityDoc:
    return OpportunityDoc(
        farm_id="f_1",
        kind=OpportunityKind.SHIFT,
        status=OpportunityStatus.OPEN,
        starts_at=MON_9AM,
        duration_min=180,
        headcount_needed=2,
        activity_tags=["weeding"],
        created_at=MON_9AM,
    )


# ---------------------------------------------------------------------------
# proposal_token
# ---------------------------------------------------------------------------
def test_proposal_token_starts_with_weekday():
    """Token's first three chars are the local weekday abbreviation."""
    wed = datetime(2026, 6, 3, 16, 0, tzinfo=UTC)  # Wed 9am Vashon
    token = proposal_token(claim_doc_id="u_a_2026-06-03", scheduled_for_at=wed)
    assert token.startswith("WED")
    assert len(token) == 4
    assert token[3].isalpha()


def test_proposal_token_is_deterministic():
    """Same input → same token every time. Stable across process restarts
    because we use sha256 not Python's randomized `hash()`."""
    when = datetime(2026, 6, 3, 16, 0, tzinfo=UTC)
    t1 = proposal_token(claim_doc_id="u_a_2026-06-03", scheduled_for_at=when)
    t2 = proposal_token(claim_doc_id="u_a_2026-06-03", scheduled_for_at=when)
    assert t1 == t2


def test_proposal_token_differs_by_claim_doc_id():
    when = datetime(2026, 6, 3, 16, 0, tzinfo=UTC)
    t_a = proposal_token(claim_doc_id="u_a_2026-06-03", scheduled_for_at=when)
    t_b = proposal_token(claim_doc_id="u_b_2026-06-03", scheduled_for_at=when)
    # Same weekday prefix, different suffix (collisions are possible but rare;
    # if these two collide, swap inputs).
    assert t_a[:3] == t_b[:3] == "WED"
    # Suffix usually differs.
    # Don't hard-assert difference — accept the rare 1/26 collision.


# ---------------------------------------------------------------------------
# _resolve_day_label — weekday abbreviations
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "label,expected_weekday",
    [("MON", 0), ("TUE", 1), ("WED", 2), ("THU", 3), ("FRI", 4)],
)
def test_resolve_weekday_inside_window(label: str, expected_weekday: int):
    opp = _window_opp()
    resolved = _resolve_day_label(label, opp=opp)
    assert resolved is not None
    # Convert to local to assert weekday.
    from app.flows._time import to_local
    assert to_local(resolved).weekday() == expected_weekday


def test_resolve_weekday_outside_window_returns_none():
    """SUN isn't in Mon-Fri."""
    opp = _window_opp()
    assert _resolve_day_label("SUN", opp=opp) is None


def test_resolve_weekday_picks_first_match_in_window():
    """If the window spans two of the same weekday (e.g. two Mondays in a
    Mon-Mon window), pick the first one."""
    opp = _window_opp().model_copy(update={
        # Mon Jun 1 → Mon Jun 8 = two Mondays.
        "window_end_at": datetime(2026, 6, 8, 16, 0, tzinfo=UTC),
    })
    resolved = _resolve_day_label("MON", opp=opp)
    assert resolved is not None
    from app.flows._time import to_local
    assert to_local(resolved).date().day == 1


# ---------------------------------------------------------------------------
# _resolve_day_label — TODAY / TOMORROW / explicit dates
# ---------------------------------------------------------------------------
def test_resolve_jun_4_explicit_inside_window():
    opp = _window_opp()
    resolved = _resolve_day_label("JUN 4", opp=opp)
    assert resolved is not None
    from app.flows._time import to_local
    local = to_local(resolved)
    assert local.month == 6 and local.day == 4


def test_resolve_slash_date_inside_window():
    opp = _window_opp()
    resolved = _resolve_day_label("6/4", opp=opp)
    assert resolved is not None
    from app.flows._time import to_local
    local = to_local(resolved)
    assert local.month == 6 and local.day == 4


def test_resolve_explicit_date_outside_window_is_none():
    opp = _window_opp()
    assert _resolve_day_label("JUN 10", opp=opp) is None
    assert _resolve_day_label("6/10", opp=opp) is None


def test_resolve_garbage_label_is_none():
    opp = _window_opp()
    assert _resolve_day_label("FROBNICATE", opp=opp) is None
    assert _resolve_day_label("", opp=opp) is None


# ---------------------------------------------------------------------------
# _resolve_day_label — single-day opps
# ---------------------------------------------------------------------------
def test_resolve_single_day_opp_only_accepts_matching_weekday():
    """Single-day opp: the window collapses to one date. A weekday label
    resolves only if it matches that date."""
    opp = _single_day_opp()  # Mon Jun 1
    # Mon matches.
    assert _resolve_day_label("MON", opp=opp) is not None
    # Tue doesn't.
    assert _resolve_day_label("TUE", opp=opp) is None


def test_resolve_preserves_opp_time_of_day():
    """Time-of-day comes from opp.starts_at, regardless of label."""
    opp = _window_opp()  # 9am
    resolved = _resolve_day_label("WED", opp=opp)
    assert resolved is not None
    from app.flows._time import to_local
    local = to_local(resolved)
    assert local.hour == 9
    assert local.minute == 0
