"""Tests for `_farmer_posting_summary` and `_format_shift_when` — the readback
prose the farmer sees when confirming a `create_opportunity` action.

PR 3 added window + bucket + headcount_open shapes. These tests pin the four
combinations so a refactor to the underlying time helpers doesn't silently
break the SMS the farmer sees.
"""

from __future__ import annotations

from datetime import UTC, datetime

from app.agent.parser import ParsedOpportunity
from app.flows.message_dispatch import (
    _farmer_posting_summary,
    _format_shift_when,
)


# Tue Jun 2 2026 9am Vashon = 16:00 UTC. Friday Jun 5 = +3d.
TUE_9AM = "2026-06-02T09:00:00-07:00"
TUE_MIDNIGHT = "2026-06-02T00:00:00-07:00"
FRI_MIDNIGHT = "2026-06-05T00:00:00-07:00"


def test_single_day_with_clock_time():
    parsed = ParsedOpportunity(
        kind="shift",
        starts_at=TUE_9AM,
        duration_min=180,
        headcount_needed=3,
        activity_detail="Harvest",
    )
    out = _farmer_posting_summary(parsed=parsed)
    assert "3 people" in out
    assert "Harvest" in out
    # Time helper renders the clock time + day; pin the time portion.
    assert "9a" in out


def test_single_day_with_bucket_only():
    parsed = ParsedOpportunity(
        kind="shift",
        starts_at=TUE_MIDNIGHT,  # date placeholder
        time_of_day_bucket="morning",
        headcount_needed=2,
        activity_detail="Weeding",
    )
    out = _farmer_posting_summary(parsed=parsed)
    assert "2 people" in out
    assert "Weeding" in out
    assert "morning" in out
    # Must NOT contain a clock time like "9a" or "12a" — bucket is fuzzy.
    assert "9a" not in out
    assert "12a" not in out


def test_window_with_bucket():
    parsed = ParsedOpportunity(
        kind="shift",
        starts_at=TUE_MIDNIGHT,
        window_end_at=FRI_MIDNIGHT,
        time_of_day_bucket="morning",
        headcount_needed=2,
        activity_detail="General farm work (TBD)",
        requirements_text="prep work",
    )
    out = _farmer_posting_summary(parsed=parsed)
    assert "2 people" in out
    # Window must be rendered with both days, not just one.
    assert "Tue" in out
    assert "Fri" in out
    assert "morning" in out


def test_window_with_clock_time():
    parsed = ParsedOpportunity(
        kind="shift",
        starts_at=TUE_9AM,
        window_end_at=FRI_MIDNIGHT,
        duration_min=180,
        headcount_needed=2,
        activity_detail="Weeding",
    )
    out = _format_shift_when(parsed)
    # Both ends of the window appear.
    assert "Tue" in out
    assert "Fri" in out
    # Time range too.
    assert "9a" in out


def test_headcount_open_renders_as_any_number():
    parsed = ParsedOpportunity(
        kind="shift",
        starts_at=TUE_9AM,
        duration_min=180,
        headcount_needed=1,
        headcount_open=True,
        activity_detail="Harvest",
    )
    out = _farmer_posting_summary(parsed=parsed)
    assert "any number" in out.lower()
    # The literal headcount number shouldn't appear when headcount_open=True.
    assert "1 person" not in out
