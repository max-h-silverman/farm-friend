"""Tests for the parser's missing-fields detection and default-fill logic.

These avoid LLM calls entirely — they exercise the deterministic helpers
that wrap the LLM output: `compute_missing_fields` and `_apply_farm_defaults`.
"""

from __future__ import annotations

import pytest

from app.agent.parser import (
    REQUIRED_PICKUP_FIELDS,
    REQUIRED_SHIFT_FIELDS,
    ParsedOpportunity,
    _apply_farm_defaults,
    compute_missing_fields,
)


# ---------------------------------------------------------------------------
# compute_missing_fields — axis-based, NOT schema-field-based
# ---------------------------------------------------------------------------
def test_shift_missing_everything():
    parsed = ParsedOpportunity(kind="shift")
    assert sorted(compute_missing_fields(parsed)) == sorted(REQUIRED_SHIFT_FIELDS)


def test_shift_missing_only_headcount():
    parsed = ParsedOpportunity(
        kind="shift",
        starts_at="2026-06-01T09:00:00-07:00",
        activity_detail="Harvest",
    )
    assert compute_missing_fields(parsed) == ["headcount"]


def test_shift_missing_only_date_and_time():
    parsed = ParsedOpportunity(
        kind="shift", headcount_needed=5, activity_detail="Harvest",
    )
    assert sorted(compute_missing_fields(parsed)) == ["date", "time"]


def test_shift_missing_only_activity():
    """activity is required — empty activity_detail counts as missing."""
    parsed = ParsedOpportunity(
        kind="shift",
        starts_at="2026-06-01T09:00:00-07:00",
        headcount_needed=5,
    )
    assert compute_missing_fields(parsed) == ["activity"]


def test_shift_tbd_satisfies_activity_axis():
    """Free-text "general farm work (TBD)" satisfies the activity axis — any
    non-empty activity_detail is a valid activity now."""
    parsed = ParsedOpportunity(
        kind="shift",
        starts_at="2026-06-01T09:00:00-07:00",
        headcount_needed=2,
        activity_detail="General farm work (TBD)",
    )
    assert compute_missing_fields(parsed) == []


def test_shift_complete_returns_empty():
    parsed = ParsedOpportunity(
        kind="shift",
        starts_at="2026-06-01T09:00:00-07:00",
        headcount_needed=5,
        activity_detail="Harvest",
    )
    assert compute_missing_fields(parsed) == []


def test_shift_bucket_satisfies_time_axis():
    """A time-of-day bucket on its own is enough to satisfy the time axis —
    starts_at can be midnight (date-only placeholder) when a bucket is set."""
    parsed = ParsedOpportunity(
        kind="shift",
        starts_at="2026-06-01T00:00:00-07:00",  # midnight = date-only placeholder
        time_of_day_bucket="morning",
        headcount_needed=2,
        activity_detail="Harvest",
    )
    assert compute_missing_fields(parsed) == []


def test_shift_midnight_without_bucket_is_missing_time():
    """Midnight without a bucket means the agent didn't supply a clock time
    AND didn't supply a bucket — time is missing."""
    parsed = ParsedOpportunity(
        kind="shift",
        starts_at="2026-06-01T00:00:00-07:00",
        headcount_needed=2,
        activity_detail="Harvest",
    )
    assert compute_missing_fields(parsed) == ["time"]


def test_shift_headcount_open_satisfies_headcount_axis():
    """When farmer says "any number of helpers welcome", headcount_open=True
    satisfies the headcount axis even with headcount_needed unset."""
    parsed = ParsedOpportunity(
        kind="shift",
        starts_at="2026-06-01T09:00:00-07:00",
        headcount_open=True,
        activity_detail="Harvest",
    )
    assert compute_missing_fields(parsed) == []


def test_shift_window_post_still_passes_mvd():
    """A multi-day window post has window_end_at set; date+time axes still
    derive from starts_at and time_of_day_bucket as usual."""
    parsed = ParsedOpportunity(
        kind="shift",
        starts_at="2026-06-01T00:00:00-07:00",  # Mon
        window_end_at="2026-06-05T00:00:00-07:00",  # Fri
        time_of_day_bucket="morning",
        headcount_needed=2,
        activity_detail="Weeding",
    )
    assert compute_missing_fields(parsed) == []


def test_pickup_missing_all_required():
    parsed = ParsedOpportunity(kind="pickup")
    assert sorted(compute_missing_fields(parsed)) == sorted(REQUIRED_PICKUP_FIELDS)


def test_pickup_only_destination_missing():
    parsed = ParsedOpportunity(
        kind="pickup",
        deadline_at="2026-06-01T18:00:00-07:00",
        produce_description="20lbs plums",
    )
    assert compute_missing_fields(parsed) == ["destination"]


def test_pickup_complete():
    parsed = ParsedOpportunity(
        kind="pickup",
        deadline_at="2026-06-01T18:00:00-07:00",
        produce_description="20lbs plums",
        destination="Vashon Food Bank",
    )
    assert compute_missing_fields(parsed) == []


def test_other_kind_has_no_required_fields():
    parsed = ParsedOpportunity(kind="other", parse_notes="not a posting")
    assert compute_missing_fields(parsed) == []


def test_zero_headcount_is_treated_as_missing():
    """Defensive: an LLM that returns headcount_needed=0 should not pass the
    completeness check. 0 is never a valid "explicit count from the farmer"."""
    parsed = ParsedOpportunity(
        kind="shift",
        starts_at="2026-06-01T09:00:00-07:00",
        headcount_needed=0,
        activity_detail="Harvest",
    )
    assert "headcount" in compute_missing_fields(parsed)


# ---------------------------------------------------------------------------
# _apply_farm_defaults
# ---------------------------------------------------------------------------
def test_apply_defaults_fills_missing_duration():
    parsed = ParsedOpportunity(kind="shift", starts_at="2026-06-01T09:00:00-07:00", headcount_needed=3)
    out = _apply_farm_defaults(
        parsed=parsed,
        farm_defaults={"typical_shift_duration_min": 180},
    )
    assert out.duration_min == 180


def test_apply_defaults_does_not_overwrite_explicit_duration():
    parsed = ParsedOpportunity(
        kind="shift",
        starts_at="2026-06-01T09:00:00-07:00",
        headcount_needed=3,
        duration_min=120,
    )
    out = _apply_farm_defaults(
        parsed=parsed,
        farm_defaults={"typical_shift_duration_min": 180},
    )
    assert out.duration_min == 120


def test_apply_defaults_noop_on_pickup():
    """Farm defaults are shift-only — pickups have their own time semantics."""
    parsed = ParsedOpportunity(kind="pickup")
    out = _apply_farm_defaults(
        parsed=parsed,
        farm_defaults={"typical_shift_duration_min": 180},
    )
    assert out.duration_min is None


def test_apply_defaults_noop_when_no_defaults():
    parsed = ParsedOpportunity(kind="shift")
    out = _apply_farm_defaults(parsed=parsed, farm_defaults=None)
    assert out == parsed


def test_apply_defaults_never_fills_required_fields():
    """Required fields must come from the farmer's words, never defaults."""
    parsed = ParsedOpportunity(kind="shift")
    out = _apply_farm_defaults(
        parsed=parsed,
        farm_defaults={
            "typical_shift_duration_min": 180,
            "typical_start_hour": 9,  # tempting, but must not fill starts_at
        },
    )
    assert out.starts_at is None
    assert out.headcount_needed is None
