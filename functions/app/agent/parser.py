"""Opportunity parser — farmer free-form SMS -> structured shift OR pickup.

Calls the LLM (fast tier) with a cached system prompt. Output is validated
against `ParsedOpportunity`. On validation failure or `kind=other`, the
caller flags for admin rather than auto-creating an opportunity.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from app.llm import LLMClient
from app.llm.client import Message


PROMPT_PATH = Path(__file__).parent.parent / "prompts" / "parser.md"


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


def parse_opportunity(
    *,
    llm: LLMClient,
    farmer_message: str,
    farm_name: str,
    now_local: datetime,
) -> ParsedOpportunity:
    system_prompt = PROMPT_PATH.read_text(encoding="utf-8")
    user_prompt = (
        f"farm: {farm_name}\n"
        f"now: {now_local.isoformat()}\n"
        f"message:\n{farmer_message}"
    )
    return llm.chat_json(
        model_tier="fast",
        messages=[
            Message(role="system", content=system_prompt),
            Message(role="user", content=user_prompt),
        ],
        response_model=ParsedOpportunity,
        cache_system_prompt=True,
        max_tokens=512,
    )
