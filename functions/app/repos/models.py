"""Pydantic models for Firestore documents.

These are application-side types. Repository functions translate between
Firestore dicts and these models, so callers never deal with raw dicts.

Naming: `Doc` suffix indicates a stored document; mutable in-app representation.
IDs are stored separately from the body (Firestore convention: doc id is the
path component, not a field). When loading we attach `id` onto the model.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------
class UserRole(StrEnum):
    FARMER = "farmer"
    VOLUNTEER = "volunteer"
    BOTH = "both"


class UserStatus(StrEnum):
    PENDING = "pending"
    ACTIVE = "active"
    SUSPENDED = "suspended"
    UNSUBSCRIBED = "unsubscribed"


class OpportunityKind(StrEnum):
    SHIFT = "shift"
    PICKUP = "pickup"


class OpportunityStatus(StrEnum):
    DRAFT = "draft"
    OPEN = "open"
    FILLING = "filling"
    FULL = "full"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    EXPIRED = "expired"


class OutreachTier(StrEnum):
    INSIDER = "insider"
    BROADER = "broader"


class ClaimStatus(StrEnum):
    CONFIRMED = "confirmed"
    INTERESTED = "interested"  # MAYBE — recorded but does not consume a seat
    WAITLIST = "waitlist"
    DROPPED = "dropped"


class MuteDimension(StrEnum):
    ACTIVITY = "activity"
    FARM = "farm"
    WINDOW = "window"
    OPPORTUNITY = "opportunity"
    AGENT_NUDGE = "agent_nudge"  # PAUSE/RESUME — silences review-tick nudges only


class MessageDirection(StrEnum):
    INBOUND = "inbound"
    OUTBOUND = "outbound"


class IntentLabel(StrEnum):
    # --- Compliance-mandated keyword intents (see docs/sms-compliance-requirements.md) ---
    STOP = "STOP"              # global unsubscribe (also UNSUBSCRIBE, END, QUIT)
    HELP = "HELP"              # canonical help reply (also INFO)
    JOIN = "JOIN"              # opt-in (also START)
    # --- Hotkey intents ---
    CLAIM = "CLAIM"
    MAYBE = "MAYBE"
    MUTE = "MUTE"
    STOP_ACTIVITY = "STOP_ACTIVITY"
    STOP_FARM = "STOP_FARM"
    UNAVAILABLE = "UNAVAILABLE"
    FLAG = "FLAG"
    INSIDER = "INSIDER"
    STATUS = "STATUS"          # farmer-only: snapshot of open opps
    CANCEL = "CANCEL"          # context-sensitive; see CLAUDE.md §SMS compliance
    # --- Refactor-introduced hotkey intents ---
    UNDO = "UNDO"              # reverse the last agent-executed action (5-min window)
    PAUSE = "PAUSE"            # 14-day mute on agent-initiated nudges
    RESUME = "RESUME"          # undo PAUSE
    # --- Volunteer reply intents (formerly classifier output, now agent mode hint) ---
    QUESTION = "QUESTION"
    DECLINE = "DECLINE"
    ESCALATE = "ESCALATE"
    # AMBIGUOUS removed with the unified-agent refactor — the new agent emits
    # mode="clarify" instead.
    # --- Refactor-introduced agent-output intents ---
    OFFER = "OFFER"                       # inbound/outbound: volunteer-initiated offer
    AVAILABILITY = "AVAILABILITY"         # inbound/outbound: standing availability update
    QUERY = "QUERY"                       # inbound/outbound: status-of-things question
    CLARIFY = "CLARIFY"                   # outbound: agent's clarifying question
    PENDING_CONFIRMATION = "PENDING_CONFIRMATION"  # outbound: drafted action awaiting token reply
    ACTION_RECEIPT = "ACTION_RECEIPT"     # outbound: "here's what I did" after execute
    AGENT_NUDGE = "AGENT_NUDGE"           # outbound: review-tick initiated nudge (budgeted)
    # --- Post-event flow (load-bearing — see CLAUDE.md) ---
    POST_EVENT_OK = "POST_EVENT_OK"
    POST_EVENT_ISSUE = "POST_EVENT_ISSUE"
    POST_EVENT_CHECKIN = "POST_EVENT_CHECKIN"  # outbound: the "any issues? Y/N" we sent
    CONFIRMATION_REMINDER = "CONFIRMATION_REMINDER"  # outbound: pre-event "still good?" reminder


CANONICAL_ACTIVITIES = (
    "harvest",
    "gleaning",
    "weeding",
    "planting",
    "transplanting",
    "livestock",
    "infrastructure",
    "processing",
    # Side-asymmetric slugs — used to express "no activity constraint" in two
    # distinct ways. NOT interchangeable: the farmer-side slug describes the
    # opp ("type TBD until day-of"); the volunteer-side slug describes the
    # volunteer's openness ("match me to anything"). The agent prompt enforces
    # which side may use which.
    "tbd",       # farmer-side: posting where work-type is uncertain
    "flexible",  # volunteer-side: offer/preference open to any activity
)


# ---------------------------------------------------------------------------
# Document models
# ---------------------------------------------------------------------------
class UserDoc(BaseModel):
    id: str | None = None
    phone: str  # E.164
    name: str
    role: UserRole
    status: UserStatus
    created_at: datetime
    notes: str = ""
    # Volunteer availability captured at onboarding. Used to weigh outreach so
    # we don't ping people on days/times they've said they're unavailable.
    # Empty values mean "no preference recorded — treat as fully available".
    available_days: list[int] = Field(default_factory=list)  # 0=Mon .. 6=Sun
    available_start_hour: int | None = None                  # 0-23, Vashon local
    available_end_hour: int | None = None                    # 0-23, Vashon local
    max_commit_hours_per_week: int | None = None
    # --- Refactor-introduced fields (unified agent) ---
    # Positive activity preferences (canonical slugs). The negative side lives
    # in mute_rules (STOP {activity}); this captures "I love gleaning" signals
    # the agent learns from inbound messages or onboarding.
    activity_preferences: list[str] = Field(default_factory=list)
    # Timestamp of the most recent AGENT_NUDGE outbound. Used by the per-user
    # 48h budget gate in the review tick. None means "never nudged."
    last_agent_initiated_outbound_at: datetime | None = None


class FarmDoc(BaseModel):
    id: str | None = None
    name: str
    owner_user_id: str
    location: str = ""
    activity_tags: list[str] = Field(default_factory=list)
    insider_window_minutes: int = 180  # default 3h before broader pool
    pickup_insider_window_minutes: int = 30  # pickup default 30m
    created_at: datetime
    # Onboarding-captured defaults. Used by the parser to fill gaps the farmer
    # left out (e.g. duration when only a start time was given). All optional;
    # absent values mean "no default known, leave the field empty".
    typical_start_hour: int | None = None             # 0-23, Vashon local
    typical_shift_duration_min: int | None = None     # minutes
    usual_days_of_week: list[int] = Field(default_factory=list)  # 0=Mon .. 6=Sun


class InsiderDoc(BaseModel):
    """Subcollection under farms/{farmId}/insiders."""
    id: str | None = None  # equal to volunteer user id
    volunteer_user_id: str
    added_at: datetime


class OpportunityDoc(BaseModel):
    id: str | None = None
    farm_id: str
    kind: OpportunityKind
    status: OpportunityStatus
    starts_at: datetime | None = None
    deadline_at: datetime | None = None
    duration_min: int | None = None
    headcount_needed: int = 1
    seats_filled: int = 0
    activity_tags: list[str] = Field(default_factory=list)
    requirements_text: str = ""
    produce_description: str | None = None
    destination: str | None = None
    vehicle_needed: bool | None = None
    created_from_message_id: str | None = None
    created_at: datetime
    # Bumped on every update_fields write. The stale-draft tick uses this
    # (not created_at) as the staleness clock so a live clarification dialog
    # crossing the 2h boundary doesn't get flagged while the farmer is still
    # responding.
    last_updated_at: datetime | None = None
    next_escalation_at: datetime | None = None
    current_tier: OutreachTier = OutreachTier.INSIDER
    post_event_checkin_at: datetime | None = None
    post_event_checkin_sent: bool = False
    # Once-per-opportunity farmer notifications. Tracked here (not via a
    # separate collection) so the existing admin/observability surface sees
    # the state without joins.
    farmer_notified_first_claim: bool = False
    farmer_notified_broader: bool = False
    farmer_notified_unfilled: bool = False
    # --- Refactor-introduced fields (unified agent review tick) ---
    # Lifetime count of agent-initiated nudges drafted for this opp (after
    # successful safe_send). Per-opp cap is 2; beyond that the review agent
    # can only flag to admin, not message users about this opp.
    agent_nudges_sent: int = 0


class OutreachLogDoc(BaseModel):
    """Subcollection under opportunities/{oppId}/outreach."""
    id: str | None = None
    tier: OutreachTier
    sent_at: datetime
    recipient_ids: list[str]


class ClaimDoc(BaseModel):
    """Subcollection under opportunities/{oppId}/claims. Doc id = volunteer_user_id."""
    id: str | None = None
    volunteer_user_id: str
    slots: int = 1
    claimed_at: datetime
    status: ClaimStatus
    # Set when the pre-event confirmation reminder is sent. Used by the
    # confirmation tick to avoid double-pinging and to scope the CANCEL
    # hotkey window (a recent reminder means CANCEL targets this claim).
    confirmation_sent_at: datetime | None = None


class MuteRuleDoc(BaseModel):
    id: str | None = None
    user_id: str
    dimension: MuteDimension
    value: str  # activity slug, farm id, ISO window range, or opportunity id
    created_at: datetime
    expires_at: datetime | None = None


class MessageDoc(BaseModel):
    id: str | None = None
    direction: MessageDirection
    provider_msg_id: str
    user_id: str | None = None
    opportunity_id: str | None = None
    body: str
    intent_label: IntentLabel | None = None
    created_at: datetime
    ttl: datetime | None = None  # Firestore TTL; ~90 days after created_at
    # --- Refactor-introduced fields (unified agent) ---
    # On outbounds with intent_label == PENDING_CONFIRMATION: the action drafted
    # by the agent awaiting user confirmation. Shape:
    #   {"action": "<name>", "token": "<5–8 uppercase>", "payload": {...},
    #    "expires_at": <iso datetime>}
    pending_action: dict | None = None
    # On outbounds with intent_label == ACTION_RECEIPT: the action that was
    # just executed, with enough payload to reverse it via UNDO. Shape:
    #   {"action": "<name>", "payload": {...},
    #    "executed_at": <iso datetime>, "undo_token": "UNDO"}
    executed_action: dict | None = None
    # On outbounds with intent_label == CLARIFY: which round this is in the
    # current clarification streak. Used to enforce the 2-round cap before
    # auto-escalating to admin. Counter resets when the user's reply produces
    # a mode other than clarify.
    clarification_round: int = 0


class FlagDoc(BaseModel):
    id: str | None = None
    message_id: str
    flagged_by_user_id: str | None = None  # None when raised by the agent
    reason: str = ""
    resolved_at: datetime | None = None
    created_at: datetime


class OfferDoc(BaseModel):
    """Volunteer-initiated offer of help, decoupled from any specific opportunity.

    Captured when a volunteer texts in something like "anyone need tilling
    Friday?". Lives until matched to an opp, expired, or cancelled by the
    volunteer. Used by the review tick to suggest matches when an opp opens
    up that fits an outstanding offer.
    """
    id: str | None = None
    volunteer_user_id: str
    activity_tags: list[str] = Field(default_factory=list)  # canonical slugs
    earliest_at: datetime | None = None  # earliest the volunteer can help
    latest_at: datetime | None = None    # latest the volunteer can help
    note: str = ""                       # raw text the agent captured
    status: Literal["open", "matched", "expired", "cancelled"] = "open"
    matched_opportunity_id: str | None = None
    created_at: datetime
    expires_at: datetime  # default: latest_at or +7 days; set at create time


class PendingUserDoc(BaseModel):
    """Awaiting admin approval. Created from JOIN texts and farmer INSIDER nominations."""
    id: str | None = None
    phone: str
    name: str = ""
    source: Literal["join", "insider_nomination", "manual"] = "join"
    suggested_role: UserRole = UserRole.VOLUNTEER
    nominated_by_farm_id: str | None = None
    status: Literal["pending", "approved", "rejected"] = "pending"
    created_at: datetime
