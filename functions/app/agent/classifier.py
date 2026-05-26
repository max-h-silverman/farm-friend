"""Reply classifier — interpret messages that didn't match a hotkey.

Output includes a confidence score; the caller decides whether to auto-reply
(above threshold) or escalate to admin (below).
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from app.llm import LLMClient
from app.llm.client import Message
from app.repos.models import OpportunityDoc


PROMPT_PATH = Path(__file__).parent.parent / "prompts" / "classifier.md"


class ClassifiedReply(BaseModel):
    intent: Literal["CLAIM", "DECLINE", "QUESTION", "AMBIGUOUS", "MUTE", "ESCALATE"]
    confidence: float = Field(ge=0.0, le=1.0)
    draft_reply: str = ""
    # When intent is MUTE, what should be muted (free-text; coordinator confirms).
    mute_value: str = ""
    rationale: str = ""
    # Only populated when intent=="ESCALATE". "routine" = flag for the admin's
    # next dashboard review; "immediate" = also text the coordinator now.
    escalation_urgency: Literal["routine", "immediate"] = "routine"
    escalation_reason: str = ""


def classify_reply(
    *,
    llm: LLMClient,
    inbound_text: str,
    volunteer_name: str,
    recent_outbound_body: str | None,
    opportunity: OpportunityDoc | None,
) -> ClassifiedReply:
    system_prompt = PROMPT_PATH.read_text(encoding="utf-8")
    opp_summary = _summarize_opp(opportunity) if opportunity else "null"
    recent = recent_outbound_body or "null"
    user_prompt = (
        f"volunteer_name: {volunteer_name}\n"
        f"recent_outbound: {recent}\n"
        f"opportunity: {opp_summary}\n"
        f"message: {inbound_text}"
    )
    return llm.chat_json(
        model_tier="fast",
        messages=[
            Message(role="system", content=system_prompt),
            Message(role="user", content=user_prompt),
        ],
        response_model=ClassifiedReply,
        cache_system_prompt=True,
        max_tokens=400,
    )


def _summarize_opp(opp: OpportunityDoc) -> str:
    parts = [f"kind={opp.kind.value}"]
    if opp.starts_at:
        parts.append(f"starts_at={opp.starts_at.isoformat()}")
    if opp.deadline_at:
        parts.append(f"deadline_at={opp.deadline_at.isoformat()}")
    if opp.activity_tags:
        parts.append(f"activity={','.join(opp.activity_tags)}")
    if opp.produce_description:
        parts.append(f"produce={opp.produce_description}")
    if opp.destination:
        parts.append(f"destination={opp.destination}")
    if opp.requirements_text:
        parts.append(f"requirements={opp.requirements_text}")
    parts.append(f"headcount_needed={opp.headcount_needed} seats_filled={opp.seats_filled}")
    return "; ".join(parts)
