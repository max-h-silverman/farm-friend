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


class OpportunityPurpose(StrEnum):
    """Why the opportunity exists — orthogonal to `kind` (what the volunteer
    does). A gleaning job can be hands-on (shift) or a pickup; same for farm
    help. Used for routing/muting and outreach copy, NOT for the pacing/claim
    behavior that `kind` drives. Defaults to FARM_HELP when unspecified."""
    GLEANING = "gleaning"     # food-access / waste-reduction (often → food bank)
    FARM_HELP = "farm_help"   # general support for a farm's work or logistics


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
    # Window-opp claim awaiting farmer ACCEPT/DECLINE. Counts toward
    # `seats_held` but NOT `seats_filled` — only farmer-confirmed claims
    # gate the opp's FULL transition. See docs/agent-architecture-rethink.md.
    PROPOSED = "proposed"


class MuteDimension(StrEnum):
    PURPOSE = "purpose"  # mute gleaning/food-access or general farm help
    FARM = "farm"
    WINDOW = "window"
    OPPORTUNITY = "opportunity"
    AGENT_NUDGE = "agent_nudge"  # PAUSE/RESUME — silences review-tick nudges only
    # DEPRECATED (activity-model redesign): activity-slug muting replaced by
    # PURPOSE. No new ACTIVITY rules are created; kept so any legacy rule docs
    # still deserialize. Remove post-pilot.
    ACTIVITY = "activity"


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
    STOP_PURPOSE = "STOP_PURPOSE"   # mute gleaning / farm-help opportunities
    STOP_ACTIVITY = "STOP_ACTIVITY"  # DEPRECATED (activity-model redesign); legacy only
    STOP_FARM = "STOP_FARM"
    UNAVAILABLE = "UNAVAILABLE"
    FLAG = "FLAG"
    INSIDER = "INSIDER"
    STATUS = "STATUS"          # farmer-only: snapshot of open opps
    CANCEL = "CANCEL"          # context-sensitive; see CLAUDE.md §SMS compliance
    DROP = "DROP"              # volunteer-only: drop a claim after reminder context
    # --- Refactor-introduced hotkey intents ---
    UNDO = "UNDO"              # reverse the last agent-executed action receipt
    PAUSE = "PAUSE"            # 14-day mute on agent-initiated nudges
    RESUME = "RESUME"          # undo PAUSE
    # --- Farmer-approval gate (window opps) ---
    ACCEPT_PROPOSAL = "ACCEPT_PROPOSAL"   # farmer accepts a PROPOSED claim → CONFIRMED
    DECLINE_PROPOSAL = "DECLINE_PROPOSAL" # farmer declines a PROPOSED claim → DROPPED
    PROPOSAL_NOTIFICATION = "PROPOSAL_NOTIFICATION"  # outbound: "Alex wants Wed..."
    AUTO_CONFIRM_NOTICE = "AUTO_CONFIRM_NOTICE"      # outbound: "auto-accepted ... reply DROP"
    PROPOSAL_DECLINED = "PROPOSAL_DECLINED"          # outbound to volunteer: farmer declined
    # --- Agent reply/escalate intents ---
    # QUESTION labels a plain mode="reply" outbound (answer / acknowledgement /
    # small talk). ESCALATE labels the user-facing handoff line on an escalation.
    QUESTION = "QUESTION"
    ESCALATE = "ESCALATE"
    # Removed with the unified-agent refactor (no remaining producers): the
    # classifier-era labels AMBIGUOUS, DECLINE, OFFER, AVAILABILITY, QUERY. The
    # agent emits mode="clarify"/"reply" and records offers/availability via
    # ACTION_RECEIPT/PENDING_CONFIRMATION outbounds, so these never get written.
    # Kept out of the enum so the model isn't tempted to emit a dead label.
    CLARIFY = "CLARIFY"                   # outbound: agent's clarifying question
    PENDING_CONFIRMATION = "PENDING_CONFIRMATION"  # outbound: drafted action awaiting token reply
    ACTION_RECEIPT = "ACTION_RECEIPT"     # outbound: "here's what I did" after execute
    AGENT_NUDGE = "AGENT_NUDGE"           # outbound: review-tick initiated nudge (budgeted)
    # --- Post-event flow (load-bearing — see CLAUDE.md) ---
    POST_EVENT_OK = "POST_EVENT_OK"
    POST_EVENT_ISSUE = "POST_EVENT_ISSUE"
    POST_EVENT_CHECKIN = "POST_EVENT_CHECKIN"  # outbound: the "any issues? Y/N" we sent
    CONFIRMATION_REMINDER = "CONFIRMATION_REMINDER"  # outbound: pre-event "still good?" reminder


# Canonical time-of-day buckets. Used when the farmer gives a fuzzy time
# ("morning", "weekend mornings") and no clock time. Buckets overlap by design
# — farmer phrasing isn't precise and we'd rather record the bucket than
# force a clock-time choice. Broadcast copy renders the bucket directly
# ("late morning"), not a clock range. See docs/agent-architecture-rethink.md
# §"Canonical time-of-day buckets" for the full rationale.
TIME_OF_DAY_BUCKETS = (
    "early_morning",   # before 8am
    "morning",         # 8am–11am
    "late_morning",    # 10am–noon
    "midday",          # 11am–2pm
    "afternoon",       # 1pm–5pm
    "late_afternoon",  # 3pm–6pm
    "early_evening",   # 5pm–7pm
    "evening",         # 6pm–8pm
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
    seats_filled: int = 0      # CONFIRMED claims only — gates the FULL transition.
    # PROPOSED + CONFIRMED. Used by tick_outreach to decide whether to keep
    # broadcasting. A window opp with 2/3 seats_held and 0/3 seats_filled is
    # still pending farmer decisions; outreach should pause to let those play
    # out rather than pile up more PROPOSED claims.
    seats_held: int = 0
    # Multi-day window post. None = single-day opp (current semantics). When
    # set and > starts_at, the opp accepts claims for any day in
    # [starts_at.date(), window_end_at.date()]. The time-of-day comes from
    # starts_at (and/or time_of_day_bucket) and applies to every day.
    window_end_at: datetime | None = None
    # Fuzzy time-of-day from a canonical bucket (see TIME_OF_DAY_BUCKETS).
    # Mutually substitutable with starts_at's time component — at least one of
    # starts_at-with-time or time_of_day_bucket must be set for a shift to be
    # MVD-complete. If both are set, the clock time wins.
    time_of_day_bucket: str | None = None
    # Farmer signaled "any number of helpers welcome". headcount_needed is
    # still set (used as the practical broadcast cap) but the opp doesn't
    # close to outreach when seats_filled hits it.
    headcount_open: bool = False
    # Why the opp exists (food-access vs general farm help). Routing/mute/copy
    # axis, orthogonal to `kind`. Defaults to FARM_HELP so legacy/unspecified
    # opps remain valid.
    purpose: OpportunityPurpose = OpportunityPurpose.FARM_HELP
    # Free-text, display-cased specifics of the work ("Inoculate Shiitake Logs",
    # "Harvest leftover apples"). Replaces the old closed-list `activity_tags`
    # as the source of truth for "what is the work". The agent captures what the
    # farmer said and returns a cleaned form; never invents one.
    activity_detail: str = ""
    # DEPRECATED (activity-model redesign 2026-05-31): no longer the source of
    # truth and no longer constrained to a canonical list. Retained only so we
    # don't drop a field mid-flight; nothing should read it for behavior. Remove
    # post-pilot. See docs/activity-model-redesign.md.
    activity_tags: list[str] = Field(default_factory=list)
    requirements_text: str = ""
    produce_description: str | None = None
    destination: str | None = None
    vehicle_needed: bool | None = None
    # Public media URLs attached by the farmer, usually MMS photos for pickup
    # location/context. Sent only to volunteers with a confirmed claim.
    media_urls: list[str] = Field(default_factory=list)
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
    """Subcollection under opportunities/{oppId}/claims.

    Doc id:
      - Single-day opp: `{volunteer_user_id}`.
      - Window opp: `{volunteer_user_id}_{scheduled_for_at.date().isoformat()}`.
        Lets one volunteer claim multiple days on the same window opp.
    """
    id: str | None = None
    volunteer_user_id: str
    slots: int = 1
    claimed_at: datetime
    status: ClaimStatus
    # Set when the pre-event confirmation reminder is sent. Used by the
    # confirmation tick to avoid double-pinging and to scope the DROP hotkey
    # window (a recent reminder means DROP targets this claim).
    confirmation_sent_at: datetime | None = None
    # For window opps: the specific day this claim is for, with time-of-day
    # inherited from the opp. None on single-day opps (derive from opp.starts_at).
    scheduled_for_at: datetime | None = None


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
    media_urls: list[str] = Field(default_factory=list)
    intent_label: IntentLabel | None = None
    created_at: datetime
    ttl: datetime | None = None  # Firestore TTL; ~90 days after created_at
    # --- Refactor-introduced fields (unified agent) ---
    # On outbounds with intent_label == PENDING_CONFIRMATION: the action drafted
    # by the agent awaiting user confirmation. Shape:
    #   {"action": "<name>", "token": "YES or <4 uppercase>", "payload": {...},
    #    "expires_at": <iso datetime>}
    pending_action: dict | None = None
    # On CLARIFY/PENDING_CONFIRMATION outbounds during farmer/volunteer intake:
    # the model-maintained draft JSON. Fed back into AgentContext.current_draft
    # on the next inbound so the model can merge answers instead of relying on
    # implicit conversation memory.
    intake_draft: dict | None = None
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
    # On outbounds with intent_label == CLARIFY: which MVD axis (or other
    # ambiguity) the question is about. Used by the clarify-cap streak
    # counter so a clarify about a DIFFERENT axis doesn't extend the streak
    # — only consecutive clarifies on the same axis count. None = legacy
    # outbound or an ambiguity that doesn't map to an axis (e.g. "which opp?").
    # Axis names match `app.agent.parser.REQUIRED_*_FIELDS`:
    #   shift: "date", "time", "headcount", "activity"
    #   pickup: "deadline", "produce", "destination"
    #   other: "opp_selection", "general"
    clarify_axis: str | None = None


class FlagDoc(BaseModel):
    id: str | None = None
    # Inbound MessageDoc this flag is anchored to. Optional because agent-
    # raised flags (review tick, schema-validation failures, missing-fields
    # backstops) aren't tied to a single inbound — they're system-side.
    message_id: str | None = None
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
    # Purpose the volunteer is interested in (food-access vs general help).
    # Optional — None means "no preference stated"; the review-tick matcher
    # treats it as open. Defaults to None rather than FARM_HELP so we don't
    # invent a preference the volunteer didn't express.
    purpose: OpportunityPurpose | None = None
    activity_detail: str = ""            # cleaned free-text the agent captured
    # DEPRECATED (activity-model redesign): use activity_detail + purpose. Kept
    # for legacy deserialization; nothing should read it for behavior.
    activity_tags: list[str] = Field(default_factory=list)
    earliest_at: datetime | None = None  # earliest the volunteer can help
    latest_at: datetime | None = None    # latest the volunteer can help
    note: str = ""                       # raw text the agent captured
    status: Literal["open", "matched", "expired", "cancelled"] = "open"
    matched_opportunity_id: str | None = None
    created_at: datetime
    expires_at: datetime  # default: latest_at or +7 days; set at create time


class AgentDecisionDoc(BaseModel):
    """One audit record per unified-agent inbound call.

    The system's reliability rests on a single open-weight LLM call per inbound
    message. This is the queryable record of what that model actually decided in
    production — mode, action, latency, and the model's own rationale — so the
    coordinator can spot drift (e.g. a spike in `escalate`, or `confirm` on
    crop-name-only posts) without reading raw logs. Written best-effort after
    every successful `run_agent`; a write failure never blocks the reply.

    TTL-purged like messages (it can contain message excerpts); not load-bearing
    for any flow, purely observability.
    """

    id: str | None = None
    user_id: str | None = None
    inbound_message_id: str | None = None
    sender_role: str = ""
    inbound_excerpt: str = ""          # first ~200 chars of the inbound
    mode: str = ""                     # reply | clarify | confirm | execute | escalate
    action_name: str | None = None     # populated for confirm/execute
    escalation_urgency: str | None = None
    rationale: str = ""                # the agent's admin-facing rationale
    elapsed_ms: int | None = None
    model: str = ""                    # which model produced this decision
    created_at: datetime
    ttl: datetime | None = None        # Firestore TTL; ~90 days after created_at


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
