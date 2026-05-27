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
# compute_missing_fields
# ---------------------------------------------------------------------------
def test_shift_missing_both_starts_and_headcount():
    parsed = ParsedOpportunity(kind="shift")
    assert sorted(compute_missing_fields(parsed)) == sorted(REQUIRED_SHIFT_FIELDS)


def test_shift_missing_only_headcount():
    parsed = ParsedOpportunity(
        kind="shift",
        starts_at="2026-06-01T09:00:00-07:00",
        activity_tags=["harvest"],
    )
    assert compute_missing_fields(parsed) == ["headcount_needed"]


def test_shift_missing_only_starts():
    parsed = ParsedOpportunity(
        kind="shift", headcount_needed=5, activity_tags=["harvest"],
    )
    assert compute_missing_fields(parsed) == ["starts_at"]


def test_shift_missing_only_activity():
    """activity_tags is required — empty list counts as missing, even though
    the model defaults it to []. The farmer must either name the work or
    explicitly elect `tbd`."""
    parsed = ParsedOpportunity(
        kind="shift",
        starts_at="2026-06-01T09:00:00-07:00",
        headcount_needed=5,
    )
    assert compute_missing_fields(parsed) == ["activity_tags"]


def test_shift_tbd_satisfies_activity_requirement():
    """`tbd` is a canonical farmer-side slug for "work-type intentionally
    open". A shift with activity_tags=['tbd'] is fully specified."""
    parsed = ParsedOpportunity(
        kind="shift",
        starts_at="2026-06-01T09:00:00-07:00",
        headcount_needed=2,
        activity_tags=["tbd"],
    )
    assert compute_missing_fields(parsed) == []


def test_shift_complete_returns_empty():
    parsed = ParsedOpportunity(
        kind="shift",
        starts_at="2026-06-01T09:00:00-07:00",
        headcount_needed=5,
        activity_tags=["harvest"],
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
    )
    assert "headcount_needed" in compute_missing_fields(parsed)


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
