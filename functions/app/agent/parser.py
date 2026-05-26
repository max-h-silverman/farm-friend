"""Opportunity parser — farmer free-form SMS -> structured shift OR pickup.

Calls the LLM (fast tier) with a cached system prompt. Output is validated
against `ParsedOpportunity`. On validation failure or `kind=other`, the
caller flags for admin rather than auto-creating an opportunity.

If required fields are missing, the parser populates `missing_fields` and a
human-friendly `clarification_question`. Dispatch saves the opportunity as a
draft, asks the farmer the question, and merges the reply via
`merge_clarification_into_draft`.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from app.llm import LLMClient
from app.llm.client import Message


PROMPT_PATH = Path(__file__).parent.parent / "prompts" / "parser.md"
MERGE_PROMPT_PATH = Path(__file__).parent.parent / "prompts" / "parser_merge.md"


# Required-field rules. Kept in code (not just the prompt) so dispatch can
# re-check after a merge — we don't trust the LLM to set missing_fields
# correctly every time.
REQUIRED_SHIFT_FIELDS = ("starts_at", "headcount_needed")
REQUIRED_PICKUP_FIELDS = ("deadline_at", "produce_description", "destination")


class ParsedOpportunity(BaseModel):
    """LLM output schema."""

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

    # Clarification handshake.
    missing_fields: list[str] = Field(default_factory=list)
    clarification_question: str = ""


def compute_missing_fields(parsed: ParsedOpportunity) -> list[str]:
    """Authoritative server-side check of which required fields are still empty.

    The LLM also populates `missing_fields` but we recompute here so dispatch
    can rely on a deterministic source of truth (esp. after a merge, where the
    LLM might forget to clear the list).
    """
    if parsed.kind == "shift":
        return [f for f in REQUIRED_SHIFT_FIELDS if getattr(parsed, f) in (None, "", 0)]
    if parsed.kind == "pickup":
        return [f for f in REQUIRED_PICKUP_FIELDS if getattr(parsed, f) in (None, "")]
    return []


def parse_opportunity(
    *,
    llm: LLMClient,
    farmer_message: str,
    farm_name: str,
    now_local: datetime,
    farm_defaults: dict | None = None,
) -> ParsedOpportunity:
    """Parse a fresh farmer message into a (possibly partial) opportunity.

    `farm_defaults` (optional): a dict with `typical_shift_duration_min`,
    `typical_start_hour` from FarmDoc. Used to fill omitted fields so the
    farmer doesn't have to specify every detail.
    """
    system_prompt = PROMPT_PATH.read_text(encoding="utf-8")
    user_prompt = _format_user_prompt(
        farm_name=farm_name,
        now_local=now_local,
        farm_defaults=farm_defaults,
        farmer_message=farmer_message,
    )
    parsed = llm.chat_json(
        model_tier="fast",
        messages=[
            Message(role="system", content=system_prompt),
            Message(role="user", content=user_prompt),
        ],
        response_model=ParsedOpportunity,
        cache_system_prompt=True,
        max_tokens=512,
    )
    # Apply farm defaults the prompt may have skipped (cheap belt-and-suspenders).
    parsed = _apply_farm_defaults(parsed=parsed, farm_defaults=farm_defaults)
    # Server-authoritative missing-field check overrides whatever the LLM said.
    parsed = parsed.model_copy(update={"missing_fields": compute_missing_fields(parsed)})
    return parsed


def merge_clarification_into_draft(
    *,
    llm: LLMClient,
    draft: ParsedOpportunity,
    farmer_reply: str,
    farm_name: str,
    now_local: datetime,
    farm_defaults: dict | None = None,
) -> ParsedOpportunity:
    """Merge a farmer's clarification reply into an existing draft.

    The merge prompt is told what the draft currently looks like, what fields
    are still missing, and the farmer's new message. It returns the same
    schema with the additional fields filled in (and the question rewritten
    if some required fields are still missing).
    """
    system_prompt = MERGE_PROMPT_PATH.read_text(encoding="utf-8")
    user_prompt = (
        f"farm: {farm_name}\n"
        f"now: {now_local.isoformat()}\n"
        f"draft_so_far:\n{draft.model_dump_json(exclude={'parse_notes'})}\n\n"
        f"farmer_reply:\n{farmer_reply}"
    )
    merged = llm.chat_json(
        model_tier="fast",
        messages=[
            Message(role="system", content=system_prompt),
            Message(role="user", content=user_prompt),
        ],
        response_model=ParsedOpportunity,
        cache_system_prompt=True,
        max_tokens=512,
    )
    merged = _apply_farm_defaults(parsed=merged, farm_defaults=farm_defaults)
    merged = merged.model_copy(update={"missing_fields": compute_missing_fields(merged)})
    return merged


def _format_user_prompt(
    *,
    farm_name: str,
    now_local: datetime,
    farm_defaults: dict | None,
    farmer_message: str,
) -> str:
    parts = [f"farm: {farm_name}", f"now: {now_local.isoformat()}"]
    if farm_defaults:
        # Only include keys that are actually set, so the LLM can rely on them.
        hints = {k: v for k, v in farm_defaults.items() if v not in (None, [], "")}
        if hints:
            parts.append(f"farm_defaults: {hints}")
    parts.append(f"message:\n{farmer_message}")
    return "\n".join(parts)


def _apply_farm_defaults(
    *,
    parsed: ParsedOpportunity,
    farm_defaults: dict | None,
) -> ParsedOpportunity:
    """Fill optional fields the farmer didn't specify using farm-level defaults.

    Required fields (starts_at, headcount_needed, etc.) are NOT defaulted —
    those must trigger a clarification question. This only fills truly
    optional fields like duration_min.
    """
    if not farm_defaults or parsed.kind != "shift":
        return parsed
    updates: dict = {}
    if parsed.duration_min is None and farm_defaults.get("typical_shift_duration_min"):
        updates["duration_min"] = farm_defaults["typical_shift_duration_min"]
    return parsed.model_copy(update=updates) if updates else parsed
