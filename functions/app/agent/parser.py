"""ParsedOpportunity schema + required-field rules.

This file used to host three LLM-calling functions (`parse_opportunity`,
`merge_clarification_into_draft`, `classify_farmer_message`) plus three
prompts. All of that was retired in the unified-agent refactor — see
`docs/refactor-unified-agent.md`. The unified agent now emits a `parsed`
sub-payload inside its `create_opportunity` / `update_draft_opportunity`
actions, dispatch validates it against `ParsedOpportunity`, and
`compute_missing_fields` is the server-authoritative check.

What stays here:
  - `ParsedOpportunity` — the structured shape for a parsed shift / pickup.
  - `compute_missing_fields` — authoritative server-side check.
  - `REQUIRED_SHIFT_FIELDS` / `REQUIRED_PICKUP_FIELDS` — the truth about
    which fields must be present before an opp can go live.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.repos.models import TIME_OF_DAY_BUCKETS


# Required-field rules. Expressed as **axes** rather than schema field names
# because a single axis can be satisfied by multiple fields (e.g. "time" can
# come from `starts_at`'s clock component OR from `time_of_day_bucket`).
# Axis names are also what dispatch uses to render farmer-friendly clarify
# copy via `_FIELD_QUESTIONS` — they read as questions, not as schema fields.
#
# Shift axes (each must be satisfied):
#   - "date":      starts_at has a date component
#   - "time":      starts_at has a clock time OR time_of_day_bucket is set
#   - "headcount": headcount_needed > 0 OR headcount_open=True
#   - "activity":  activity_detail is non-empty (any free text the farmer gave)
#
# Pickup axes (each must be satisfied):
#   - "deadline":   deadline_at is set
#   - "produce":    produce_description is set
#   - "destination": destination is set
REQUIRED_SHIFT_FIELDS = ("date", "time", "headcount", "activity")
REQUIRED_PICKUP_FIELDS = ("deadline", "produce", "destination")


class ParsedOpportunity(BaseModel):
    """Structured shape of a parsed shift or pickup.

    Used inside `ActionSpec.create_opportunity.parsed` and
    `ActionSpec.update_draft_opportunity.parsed`. The unified agent fills
    this in; dispatch validates and persists.
    """

    kind: Literal["shift", "pickup", "other"]
    parse_notes: str = ""

    # Shift fields (populated when kind=="shift")
    starts_at: str | None = None  # ISO 8601 with offset
    duration_min: int | None = None
    headcount_needed: int | None = None
    # Why the opp exists. "gleaning" (food-access) or "farm_help" (default).
    purpose: Literal["gleaning", "farm_help"] = "farm_help"
    # Free-text, display-cased specifics of the work ("Inoculate Shiitake
    # Logs"). The agent captures what the farmer said; this is the activity
    # axis's source of truth. Replaces the old closed-list activity_tags.
    activity_detail: str = ""
    # DEPRECATED (activity-model redesign): retained for round-trip back-compat;
    # no longer the activity axis. Don't read it for behavior.
    activity_tags: list[str] = Field(default_factory=list)
    requirements_text: str = ""
    # Multi-day window post: end of the window (inclusive). None for
    # single-day posts. ISO 8601 with offset. See rethink doc §"Multi-day
    # window posts" and OpportunityDoc.window_end_at.
    window_end_at: str | None = None
    # Fuzzy time-of-day bucket. One of TIME_OF_DAY_BUCKETS. Mutually
    # substitutable with starts_at's clock time — see compute_missing_fields.
    time_of_day_bucket: str | None = None
    # Farmer said "any number of helpers welcome". headcount_needed is still
    # set (used as a practical broadcast cap) but doesn't gate close.
    headcount_open: bool = False

    # Pickup fields (populated when kind=="pickup")
    deadline_at: str | None = None
    produce_description: str | None = None
    destination: str | None = None
    vehicle_needed: bool | None = None

    # Clarification handshake (mostly cosmetic now — the agent emits
    # `mode="clarify"` rather than setting these, but keeping the fields
    # avoids breaking ParsedOpportunity round-trips).
    missing_fields: list[str] = Field(default_factory=list)
    clarification_question: str = ""


def compute_missing_fields(parsed: ParsedOpportunity) -> list[str]:
    """Authoritative server-side check of which required AXES are still empty.

    Returns axis names (e.g. "time", "headcount") — NOT schema field names.
    Dispatch's `_FIELD_QUESTIONS` map keys on these axis names to produce
    farmer-friendly clarify copy.

    Shift axes:
      - "date":      starts_at is set (carries the day, even when the clock
                     time is fuzzy and lives in time_of_day_bucket).
      - "time":      starts_at has a non-midnight clock time OR
                     time_of_day_bucket is set.
      - "headcount": headcount_needed > 0 OR headcount_open is True.
      - "activity":  activity_detail is non-empty (any free text satisfies it).

    Pickup axes:
      - "deadline":    deadline_at is set.
      - "produce":     produce_description is non-empty.
      - "destination": destination is non-empty.

    The agent also populates `missing_fields` on the ParsedOpportunity but
    we recompute here so dispatch has a deterministic source of truth — the
    agent should never be able to push an opp to OPEN with missing fields.
    """
    if parsed.kind == "shift":
        missing: list[str] = []
        if not parsed.starts_at:
            missing.append("date")
        time_satisfied = (
            bool(parsed.time_of_day_bucket)
            or _starts_at_has_clock_time(parsed.starts_at)
        )
        if not time_satisfied:
            missing.append("time")
        if not parsed.headcount_open and not (parsed.headcount_needed and parsed.headcount_needed > 0):
            missing.append("headcount")
        if not parsed.activity_detail.strip():
            missing.append("activity")
        return missing
    if parsed.kind == "pickup":
        missing_p: list[str] = []
        if not parsed.deadline_at:
            missing_p.append("deadline")
        if not parsed.produce_description:
            missing_p.append("produce")
        if not parsed.destination:
            missing_p.append("destination")
        return missing_p
    return []


def _starts_at_has_clock_time(starts_at: str | None) -> bool:
    """True if `starts_at` carries a non-midnight clock time.

    The convention: when the agent has only a fuzzy time, it sets
    `time_of_day_bucket` and uses midnight (T00:00:00) on `starts_at` as a
    date-only placeholder. A non-midnight clock time means the farmer gave
    an explicit time.

    This is intentionally lenient — `T00:00:00` is genuinely ambiguous
    (could be midnight farm work or a bucket placeholder), but no farm shift
    actually starts at midnight, so treating it as "no clock time" is the
    right default.
    """
    if not starts_at:
        return False
    from datetime import datetime as _dt
    try:
        dt = _dt.fromisoformat(starts_at.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return False
    return not (dt.hour == 0 and dt.minute == 0 and dt.second == 0)


def _apply_farm_defaults(
    *,
    parsed: ParsedOpportunity,
    farm_defaults: dict | None,
) -> ParsedOpportunity:
    """Fill optional fields the farmer didn't specify using farm-level defaults.

    Required fields (starts_at, headcount_needed, etc.) are NEVER defaulted —
    those must come from the farmer's words. Only fills truly optional fields
    like `duration_min`.

    Dispatch calls this defensively after the unified agent emits a
    `create_opportunity` action: the prompt also describes the rule, but
    this is the deterministic backstop.
    """
    if not farm_defaults or parsed.kind != "shift":
        return parsed
    updates: dict = {}
    if parsed.duration_min is None and farm_defaults.get("typical_shift_duration_min"):
        updates["duration_min"] = farm_defaults["typical_shift_duration_min"]
    return parsed.model_copy(update=updates) if updates else parsed
