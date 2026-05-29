"""Tests for the per-axis clarify-streak fix.

The cap used to count every consecutive CLARIFY outbound, so a thread that
clarified across multiple axes (activity → time → headcount) would falsely
escalate even though the user answered each question. Per-axis tracking
fires the cap only when the agent re-asks about the SAME axis.

These tests pin:
  - axis inference from agent reply text (the keyword match)
  - axis extraction from backstop reason strings
  - the streak counter resets across different axes
"""

from __future__ import annotations

from app.flows.message_dispatch import (
    _axis_from_overconfirm_reason,
    _infer_clarify_axis,
)


# ---------------------------------------------------------------------------
# _infer_clarify_axis — from agent reply text
# ---------------------------------------------------------------------------
def test_axis_inference_activity():
    assert _infer_clarify_axis(
        "What kind of work — harvest, weeding, or something else?"
    ) == "activity"


def test_axis_inference_activity_meta_question():
    """Tom's exchange: agent answered a meta-question 'what are all the
    activity types?' — we want this categorized as activity-axis so it
    groups with prior activity clarifies, NOT counted as a fresh axis."""
    assert _infer_clarify_axis(
        "Farm Friend Vashon: Our activity types are harvest, gleaning, weeding, planting, transplanting, livestock, infrastructure, and processing. You'd mentioned needing help with tomatoes this weekend — which of these applies?"
    ) == "activity"


def test_axis_inference_time():
    assert _infer_clarify_axis("What time should it start, and how long?") == "time"


def test_axis_inference_time_bucket():
    """Bucket-multiple-choice phrasing → time axis."""
    assert _infer_clarify_axis(
        "Morning, afternoon, or evening?"
    ) == "time"


def test_axis_inference_date():
    assert _infer_clarify_axis("Any specific day work better, or want me to post for one day?") == "date"


def test_axis_inference_headcount():
    assert _infer_clarify_axis("How many people do you need?") == "headcount"


def test_axis_inference_pickup_axes():
    assert _infer_clarify_axis("By when does it need to be picked up?") == "deadline"
    assert _infer_clarify_axis("Where should it go?") == "destination"


def test_axis_inference_opp_selection():
    assert _infer_clarify_axis(
        "You have two Friday posts — the morning harvest or the afternoon gleaning?"
    ) == "opp_selection"


def test_axis_inference_unknown_returns_general():
    """Falls through to 'general' on no keyword match. Groups truly-unclear
    clarifies together for streak counting."""
    assert _infer_clarify_axis("Sorry, could you tell me more?") == "general"


# ---------------------------------------------------------------------------
# _axis_from_overconfirm_reason — from backstop reason strings
# ---------------------------------------------------------------------------
def test_axis_from_reason_time_signal():
    assert _axis_from_overconfirm_reason(
        "parsed.starts_at filled but inbound text has no clock-time signal"
    ) == "time"


def test_axis_from_reason_activity_word():
    assert _axis_from_overconfirm_reason(
        "parsed.activity_tags=['weeding'] but inbound text has no activity word "
        "(possible crop-name-only inference)"
    ) == "activity"


def test_axis_from_reason_missing_fields_picks_first():
    """When multiple axes are missing, pick the first in priority order.
    Matches the user's experience: a 'date, time, headcount missing' clarify
    is most-naturally identified by the first one mentioned."""
    assert _axis_from_overconfirm_reason(
        "required fields still missing after defaults: ['date', 'time', 'headcount']"
    ) == "date"


def test_axis_from_reason_missing_only_headcount():
    assert _axis_from_overconfirm_reason(
        "required fields still missing after defaults: ['headcount']"
    ) == "headcount"


def test_axis_from_reason_parse_notes_general():
    """parse_notes self-report doesn't pin a specific axis."""
    assert _axis_from_overconfirm_reason(
        "parse_notes contains 'default': 'starts time from default'"
    ) == "general"


# ---------------------------------------------------------------------------
# _is_admin_worth_flagging — only signals that imply real model misbehavior
# ---------------------------------------------------------------------------
from app.flows.message_dispatch import _is_admin_worth_flagging


def test_signal_3_missing_fields_does_not_flag():
    """Required-field-missing downgrades are the system working as designed.
    Don't flag — the user just sees one more clarify."""
    assert _is_admin_worth_flagging(
        "required fields still missing after defaults: ['headcount']"
    ) is False
    assert _is_admin_worth_flagging(
        "required fields still missing after defaults: ['date', 'time', 'headcount']"
    ) is False


def test_signal_1_parse_notes_flags():
    """parse_notes self-report DOES flag — the agent just narrated bad behavior."""
    assert _is_admin_worth_flagging(
        "parse_notes contains 'default': 'starts time from default'"
    ) is True
    assert _is_admin_worth_flagging(
        "parse_notes contains 'inferred': 'inferred 9am from farm default'"
    ) is True


def test_signal_2a_no_time_signal_flags():
    """Agent filled starts_at when nothing in the inbound justified it.
    Real model misbehavior — flag."""
    assert _is_admin_worth_flagging(
        "parsed.starts_at filled but inbound text has no clock-time signal"
    ) is True


def test_signal_2b_no_activity_word_flags():
    """Agent inferred an activity from a crop name. Real misbehavior — flag."""
    assert _is_admin_worth_flagging(
        "parsed.activity_tags=['weeding'] but inbound text has no activity word "
        "(possible crop-name-only inference)"
    ) is True


# ---------------------------------------------------------------------------
# _consecutive_clarify_count — per-axis streak counting
# ---------------------------------------------------------------------------
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

from app.flows.message_dispatch import _consecutive_clarify_count
from app.repos.models import (
    IntentLabel,
    MessageDirection,
    MessageDoc,
)


def _clarify(axis: str | None, *, age_minutes: int) -> MessageDoc:
    return MessageDoc(
        direction=MessageDirection.OUTBOUND,
        provider_msg_id=f"p_{age_minutes}",
        user_id="u_a",
        body=f"clarify about {axis}",
        intent_label=IntentLabel.CLARIFY,
        clarify_axis=axis,
        created_at=datetime.now(UTC) - timedelta(minutes=age_minutes),
    )


def _not_clarify(*, age_minutes: int) -> MessageDoc:
    return MessageDoc(
        direction=MessageDirection.OUTBOUND,
        provider_msg_id=f"p_{age_minutes}",
        user_id="u_a",
        body="some other outbound",
        intent_label=IntentLabel.ACTION_RECEIPT,
        created_at=datetime.now(UTC) - timedelta(minutes=age_minutes),
    )


def test_tom_exchange_streak_counts_one_after_three_different_axis_clarifies():
    """Tom's exchange end-to-end through the streak counter.

    Outbound stream (newest → oldest):
      headcount clarify (most recent) ← `since`
      time clarify
      activity clarify

    Streak should be 1 — only the headcount clarify is on the headcount axis;
    walking back hits time (different axis) → streak ends.
    """
    most_recent = _clarify("headcount", age_minutes=1)
    stream = [
        most_recent,                       # headcount
        _clarify("time", age_minutes=5),   # time
        _clarify("activity", age_minutes=10),  # activity
    ]
    with patch("app.flows.message_dispatch.messages_repo.list_for_user", return_value=stream):
        streak = _consecutive_clarify_count(user_id="u_a", since=most_recent)
    assert streak == 1, "Different axes must break the streak"


def test_streak_counts_two_when_same_axis_asked_twice():
    """The real failure case: the user can't answer 'what time?' twice in a row."""
    most_recent = _clarify("time", age_minutes=1)
    stream = [
        most_recent,                      # time (2nd time)
        _clarify("time", age_minutes=5),  # time (1st time)
    ]
    with patch("app.flows.message_dispatch.messages_repo.list_for_user", return_value=stream):
        streak = _consecutive_clarify_count(user_id="u_a", since=most_recent)
    assert streak == 2, "Same axis twice IS a streak — cap should fire"


def test_streak_resets_when_non_clarify_in_between():
    """A non-CLARIFY outbound (an action receipt, a milestone) breaks the
    streak even if the next-back outbound is the same axis."""
    most_recent = _clarify("time", age_minutes=1)
    stream = [
        most_recent,                            # time (now)
        _not_clarify(age_minutes=3),            # ACTION_RECEIPT in between
        _clarify("time", age_minutes=10),       # time (much earlier)
    ]
    with patch("app.flows.message_dispatch.messages_repo.list_for_user", return_value=stream):
        streak = _consecutive_clarify_count(user_id="u_a", since=most_recent)
    assert streak == 1


def test_legacy_outbounds_without_axis_count_as_general():
    """Outbounds written before the clarify_axis field existed have
    `clarify_axis=None`. They group as 'general' for streak purposes —
    a streak of None ≠ time, so they don't extend a typed-axis streak."""
    most_recent = _clarify("time", age_minutes=1)
    stream = [
        most_recent,
        _clarify(None, age_minutes=5),  # legacy
    ]
    with patch("app.flows.message_dispatch.messages_repo.list_for_user", return_value=stream):
        streak = _consecutive_clarify_count(user_id="u_a", since=most_recent)
    assert streak == 1


def test_streak_zero_when_since_is_not_clarify():
    """Defensive: if the most recent outbound is anything but CLARIFY, streak is 0."""
    most_recent = _not_clarify(age_minutes=1)
    with patch("app.flows.message_dispatch.messages_repo.list_for_user", return_value=[most_recent]):
        streak = _consecutive_clarify_count(user_id="u_a", since=most_recent)
    assert streak == 0
