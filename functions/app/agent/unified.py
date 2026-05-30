"""Unified agent — the single LLM-driven coordinator for inbound *and* review.

Replaces the v1 trio (classifier + ambiguous + parser-triage). One prompt
(`app/prompts/agent.md`), one structured JSON output schema, one dispatch
contract: the agent *drafts*, the dispatch layer *executes*. The agent has
zero direct write authority.

See `docs/refactor-unified-agent.md` for the full design rationale.

This module defines:
  - AgentContext       : the input payload the dispatch layer assembles
  - AgentOutput        : the discriminated-union output schema (5 modes)
  - ActionSpec         : the discriminated union of state-changing actions
  - EscalationSpec     : escalation reason + urgency
  - run_agent          : the inbound-message entrypoint (one LLM call)
  - AgentReviewOutput  : the proactive-review output schema (list of proposals)
  - ReviewProposal     : one proposed action from a review tick
  - run_review_agent   : the review-tick entrypoint (one LLM call)
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from app.agent.parser import ParsedOpportunity
from app.llm import LLMClient
from app.llm.client import Message
from app.repos.models import (
    ClaimDoc,
    FarmDoc,
    MessageDoc,
    MuteRuleDoc,
    OfferDoc,
    OpportunityDoc,
    OpportunityKind,
    UserDoc,
    UserRole,
)


PROMPT_PATH = Path(__file__).parent.parent / "prompts" / "agent.md"


# ---------------------------------------------------------------------------
# Context (what dispatch hands to the agent)
# ---------------------------------------------------------------------------
class ClaimSummary(BaseModel):
    """Compact view of one of the sender's own claims, for the context payload."""

    opp_id: str
    opp_kind: Literal["shift", "pickup"]
    farm_name: str
    activity_or_produce: str
    when_human: str  # e.g. "Friday May 29 9am–12"
    status: Literal["confirmed", "interested", "waitlist", "dropped"]


class OppSummary(BaseModel):
    """Compact view of an opportunity, for the context payload."""

    opp_id: str
    farm_name: str
    kind: Literal["shift", "pickup"]
    status: str
    when_human: str
    activity_or_produce: str
    headcount_needed: int | None = None
    seats_filled: int | None = None
    requirements_text: str = ""


class OfferSummary(BaseModel):
    """Compact view of an open offer, used by the review-tick context."""

    offer_id: str
    volunteer_name: str
    activity_tags: list[str]
    when_human: str
    age_days: int


class MessageExcerpt(BaseModel):
    """Last-N messages on a thread, for short-term memory."""

    direction: Literal["inbound", "outbound"]
    body: str
    intent_label: str | None = None
    created_at_iso: str


class AgentContext(BaseModel):
    """Everything the inbound agent sees when classifying one message.

    Built fresh by dispatch on every inbound. The agent re-derives judgment
    each turn from this payload — no stored agent state, no tool-use callbacks.
    """

    now_local_iso: str
    sender_role: Literal["farmer", "volunteer", "both"]
    sender_name: str
    sender_phone: str
    sender_availability: dict  # days/hours/max_hours from UserDoc
    sender_activity_preferences: list[str]
    sender_mute_summary: list[str]  # rendered "activity:weeding", "farm:Plum Forest", etc.
    sender_open_claims: list[ClaimSummary]
    sender_farm: OppSummary | None = None  # placeholder until we add a FarmSummary; not used yet
    sender_farm_id: str | None = None  # if sender is farmer/both, the farm they own
    sender_farm_name: str | None = None
    sender_farm_defaults: dict | None = None  # typical_start_hour, typical_shift_duration_min, usual_days
    sender_farm_open_opps: list[OppSummary] = Field(default_factory=list)
    last_outbound_body: str | None = None
    last_outbound_intent: str | None = None
    last_outbound_clarification_round: int = 0
    last_outbound_opp_summary: OppSummary | None = None
    current_draft: dict | None = None
    pending_action: dict | None = None  # alive PENDING_CONFIRMATION payload, if any
    executed_action: dict | None = None  # alive ACTION_RECEIPT payload (within UNDO window), if any
    cross_cutting_opps: list[OppSummary] = Field(default_factory=list)
    known_farms: list[dict] = Field(default_factory=list)  # {id, name}
    canonical_activities: list[str] = Field(default_factory=list)
    opp_message_excerpt: list[MessageExcerpt] = Field(default_factory=list)
    user_recent_excerpt: list[MessageExcerpt] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Output — actions
# ---------------------------------------------------------------------------
# Token regex: exactly 4 uppercase letters. No digits, no hyphens — must read
# as a real word or a clear abbreviation. Hotkey-collision check is enforced
# by dispatch (centralized list there).
TOKEN_REGEX = r"^[A-Z]{4}$"


class ClaimOpportunityPayload(BaseModel):
    opp_id: str
    slots: int = 1
    # For window opps: which specific day(s) the volunteer is claiming. Each
    # entry is ISO-8601 (date-only or full datetime). Empty list = single-day
    # opp; the opp's own starts_at is the implicit day. When non-empty, each
    # day creates one PROPOSED claim awaiting farmer ACCEPT.
    days: list[str] = Field(default_factory=list)


class RecordMaybePayload(BaseModel):
    opp_id: str


class DropConfirmedClaimPayload(BaseModel):
    opp_id: str


class CancelOpportunityPayload(BaseModel):
    opp_id: str


class EditOpportunityPayload(BaseModel):
    opp_id: str
    # Only fields the farmer is changing. Allowed keys: starts_at (iso),
    # duration_min, headcount_needed, requirements_text, produce_description,
    # destination. Validation lives in dispatch (farmer_ops._normalize_edit_updates).
    field_updates: dict


class CreateOpportunityPayload(BaseModel):
    parsed: ParsedOpportunity


class UpdateDraftOpportunityPayload(BaseModel):
    opp_id: str
    parsed: ParsedOpportunity


class AcknowledgePostEventPayload(BaseModel):
    opp_id: str
    answer: Literal["Y", "N"]


class AddMuteRulePayload(BaseModel):
    dimension: Literal["activity", "farm", "window", "opportunity", "agent_nudge"]
    value: str


class SetAvailabilityPayload(BaseModel):
    available_days: list[int] = Field(default_factory=list)
    available_start_hour: int | None = None
    available_end_hour: int | None = None
    max_commit_hours_per_week: int | None = None


class SetActivityPreferencesPayload(BaseModel):
    # Discriminated by the verbs the dispatch layer applies to the user's
    # current list. The agent must pick one; both empty means no-op (dispatch
    # rejects).
    add: list[str] = Field(default_factory=list)
    remove: list[str] = Field(default_factory=list)


class RecordOfferPayload(BaseModel):
    activity_tags: list[str] = Field(default_factory=list)
    earliest_at: str | None = None  # ISO 8601
    latest_at: str | None = None
    note: str = ""  # short verbatim of what the volunteer said


class UndoLastPayload(BaseModel):
    # Dispatch resolves to the most recent ACTION_RECEIPT for the user; no
    # payload is needed from the agent. Kept as a model for shape consistency.
    pass


class FarmerDecideOnProposalPayload(BaseModel):
    """Farmer accepts or declines a PROPOSED claim on one of their window opps.

    The 4-letter `token` identifies which proposal. Dispatch resolves the
    token against the farmer's recent PROPOSAL_NOTIFICATION outbounds.
    """
    token: str  # 4-letter ACCEPT/DECLINE target
    decision: Literal["accept", "decline"]


class ActionSpec(BaseModel):
    """Discriminated union — one variant per action the agent is allowed to draft.

    Dispatch pattern-matches on `name` to call the existing flow function.
    Exactly one of the *_payload fields will be populated for each name.
    """

    name: Literal[
        "claim_opportunity",
        "record_maybe",
        "drop_confirmed_claim",
        "cancel_opportunity",
        "edit_opportunity",
        "create_opportunity",
        "update_draft_opportunity",
        "acknowledge_post_event",
        "add_mute_rule",
        "set_availability",
        "set_activity_preferences",
        "record_offer",
        "undo_last",
        "farmer_decide_on_proposal",
    ]
    claim_opportunity: ClaimOpportunityPayload | None = None
    record_maybe: RecordMaybePayload | None = None
    drop_confirmed_claim: DropConfirmedClaimPayload | None = None
    cancel_opportunity: CancelOpportunityPayload | None = None
    edit_opportunity: EditOpportunityPayload | None = None
    create_opportunity: CreateOpportunityPayload | None = None
    update_draft_opportunity: UpdateDraftOpportunityPayload | None = None
    acknowledge_post_event: AcknowledgePostEventPayload | None = None
    add_mute_rule: AddMuteRulePayload | None = None
    set_availability: SetAvailabilityPayload | None = None
    set_activity_preferences: SetActivityPreferencesPayload | None = None
    record_offer: RecordOfferPayload | None = None
    undo_last: UndoLastPayload | None = None
    farmer_decide_on_proposal: FarmerDecideOnProposalPayload | None = None


class EscalationSpec(BaseModel):
    reason: str
    urgency: Literal["routine", "immediate"] = "routine"


class AgentOutput(BaseModel):
    """Discriminated union of the five inbound-handling modes.

    Exactly which sub-fields are populated depends on `mode`:
      - reply     : reply_text only
      - clarify   : reply_text only
      - confirm   : reply_text + confirmation_token + action
      - execute   : action only (dispatch composes the receipt copy itself);
                    NOTE: the agent rarely emits this — token-match execution
                    is handled deterministically by dispatch *before* the agent
                    is called. The agent emits "execute" only for `undo_last`
                    when the user's intent to undo is clear enough that we
                    don't need a confirmation round (rare).
      - escalate  : reply_text (the user-facing handoff line) + escalation
    """

    mode: Literal["reply", "confirm", "execute", "clarify", "escalate"]
    reply_text: str = ""
    confirmation_token: str | None = None
    action: ActionSpec | None = None
    escalation: EscalationSpec | None = None
    intake_draft: dict | None = None
    rationale: str = ""  # admin-facing; not sent to the user


# ---------------------------------------------------------------------------
# Output — review mode
# ---------------------------------------------------------------------------
class ReviewProposal(BaseModel):
    """One thing the review agent thinks should happen.

    Dispatch processes the list in priority order, applying budget filters:
      - drop if target=user and user has active PAUSE mute
      - drop if target=user and user is over the 48h nudge budget
      - downgrade to admin flag if opp-related and agent_nudges_sent >= cap
      - send the top N (per-tick ceiling); flag the rest to admin
    """

    priority: Literal["high", "medium", "low"]
    target: Literal["user", "admin"]
    target_user_id: str | None = None  # required when target=="user"
    target_opp_id: str | None = None  # if the proposal is about a specific opp
    reason: str  # admin-facing rationale
    # When target=="user" and the proposal would change state, action+token+reply
    # describe the PENDING_CONFIRMATION outbound to draft. When target=="admin",
    # leave these unset.
    action: ActionSpec | None = None
    confirmation_token: str | None = None
    reply_text: str = ""


class AgentReviewOutput(BaseModel):
    proposals: list[ReviewProposal] = Field(default_factory=list)
    rationale: str = ""  # admin-facing


# ---------------------------------------------------------------------------
# Board state (review-tick context)
# ---------------------------------------------------------------------------
class BoardState(BaseModel):
    """What the review agent sees. Built by `flows/board_review.build_board_context`."""

    now_local_iso: str
    open_opps: list[OppSummary]
    open_offers: list[OfferSummary]
    upcoming_confirmations: list[ClaimSummary]  # claims with confirmation_sent_at in last 24h
    stalled_threads: list[dict]  # {user_id, last_inbound_iso, last_outbound_intent}
    # Budgets remaining. Agent uses these to prioritize, not as authority.
    per_tick_send_budget: int
    canonical_activities: list[str]


# ---------------------------------------------------------------------------
# Entrypoints
# ---------------------------------------------------------------------------
def run_agent(
    *,
    llm: LLMClient,
    context: AgentContext,
    inbound_text: str,
) -> AgentOutput:
    """Run the unified agent for one inbound message.

    One LLM call. JSON output validated against `AgentOutput`. Caller (dispatch)
    interprets the output and executes any state changes deterministically.
    """
    system_prompt = PROMPT_PATH.read_text(encoding="utf-8")
    user_prompt = (
        "MODE: inbound\n"
        f"CONTEXT:\n{context.model_dump_json(exclude_none=True)}\n\n"
        f"INBOUND_TEXT:\n{inbound_text}"
    )
    return llm.chat_json(
        model_tier="strong",
        messages=[
            Message(role="system", content=system_prompt),
            Message(role="user", content=user_prompt),
        ],
        response_model=AgentOutput,
        cache_system_prompt=True,
        max_tokens=1024,
    )


def run_review_agent(
    *,
    llm: LLMClient,
    board: BoardState,
) -> AgentReviewOutput:
    """Run the unified agent in review mode for one scheduled tick.

    Same prompt, same model, different user-message header. Returns a ranked
    list of proposals; dispatch applies budget filters and decides which to
    actually send vs. flag to admin.
    """
    system_prompt = PROMPT_PATH.read_text(encoding="utf-8")
    user_prompt = (
        "MODE: review\n"
        f"BOARD_STATE:\n{board.model_dump_json(exclude_none=True)}"
    )
    return llm.chat_json(
        model_tier="strong",
        messages=[
            Message(role="system", content=system_prompt),
            Message(role="user", content=user_prompt),
        ],
        response_model=AgentReviewOutput,
        cache_system_prompt=True,
        max_tokens=2048,  # multiple proposals, leave headroom
    )
