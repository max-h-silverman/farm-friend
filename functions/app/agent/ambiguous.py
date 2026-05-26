"""Second-pass handler for messages the classifier wasn't confident on.

Uses the stronger model tier (Sonnet on Anthropic). Either decides what to
reply, or escalates to the coordinator.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel

from app.agent.classifier import ClassifiedReply
from app.llm import LLMClient
from app.llm.client import Message
from app.repos.models import OpportunityDoc


PROMPT_PATH = Path(__file__).parent.parent / "prompts" / "ambiguous.md"


class AmbiguousResolution(BaseModel):
    escalate: bool
    reply: str = ""
    reason: str = ""


def resolve_ambiguous(
    *,
    llm: LLMClient,
    inbound_text: str,
    volunteer_name: str,
    recent_outbound_body: str | None,
    opportunity: OpportunityDoc | None,
    prior: ClassifiedReply,
) -> AmbiguousResolution:
    system_prompt = PROMPT_PATH.read_text(encoding="utf-8")
    prior_summary = (
        f"intent={prior.intent} confidence={prior.confidence:.2f} rationale={prior.rationale}"
    )
    opp_summary = _summarize_opp(opportunity) if opportunity else "null"
    user_prompt = (
        f"volunteer_name: {volunteer_name}\n"
        f"recent_outbound: {recent_outbound_body or 'null'}\n"
        f"opportunity: {opp_summary}\n"
        f"prior_classification: {prior_summary}\n"
        f"message: {inbound_text}"
    )
    return llm.chat_json(
        model_tier="strong",
        messages=[
            Message(role="system", content=system_prompt),
            Message(role="user", content=user_prompt),
        ],
        response_model=AmbiguousResolution,
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
    parts.append(f"headcount_needed={opp.headcount_needed} seats_filled={opp.seats_filled}")
    return "; ".join(parts)
