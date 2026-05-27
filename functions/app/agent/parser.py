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


# Required-field rules. The unified agent prompt also lists these, but
# dispatch re-checks here — never trust the agent to set missing_fields
# correctly.
REQUIRED_SHIFT_FIELDS = ("starts_at", "headcount_needed")
REQUIRED_PICKUP_FIELDS = ("deadline_at", "produce_description", "destination")


class ParsedOpportunity(BaseModel):
    """Structured shape of a parsed shift or pickup.

    Used inside `ActionSpec.create_opportunity.parsed` and
    `ActionSpec.update_draft_opportunity.parsed`. The unified agent fills
    this in; dispatch validates and persists.
    """

    kind: Literal["shift", "pickup", "other"]
    parse_notes: str = ""
    unknown_activity: bool = False

    # Shift fields (populated when kind=="shift")
    starts_at: str | None = None  # ISO 8601 with offset
    duration_min: int | None = None
    headcount_needed: int | None = None
    activity_tags: list[str] = Field(default_factory=list)
    requirements_text: str = ""

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
    """Authoritative server-side check of which required fields are still empty.

    The agent also populates `missing_fields` but we recompute here so dispatch
    has a deterministic source of truth — the agent should never be able to
    push an opp to OPEN with missing required fields.
    """
    if parsed.kind == "shift":
        return [f for f in REQUIRED_SHIFT_FIELDS if getattr(parsed, f) in (None, "", 0)]
    if parsed.kind == "pickup":
        return [f for f in REQUIRED_PICKUP_FIELDS if getattr(parsed, f) in (None, "")]
    return []


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
