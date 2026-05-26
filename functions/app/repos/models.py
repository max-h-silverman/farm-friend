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


class MessageDirection(StrEnum):
    INBOUND = "inbound"
    OUTBOUND = "outbound"


class IntentLabel(StrEnum):
    CLAIM = "CLAIM"
    MAYBE = "MAYBE"
    MUTE = "MUTE"
    STOP = "STOP"
    STOP_ACTIVITY = "STOP_ACTIVITY"
    STOP_FARM = "STOP_FARM"
    UNAVAILABLE = "UNAVAILABLE"
    FLAG = "FLAG"
    JOIN = "JOIN"
    HELP = "HELP"
    INSIDER = "INSIDER"
    QUESTION = "QUESTION"
    DECLINE = "DECLINE"
    AMBIGUOUS = "AMBIGUOUS"
    STATUS = "STATUS"          # farmer-only: snapshot of open opps
    CANCEL = "CANCEL"          # farmer-only: cancel an open opp
    EDIT = "EDIT"              # farmer-only: edit fields on an open opp
    POST_EVENT_OK = "POST_EVENT_OK"
    POST_EVENT_ISSUE = "POST_EVENT_ISSUE"


CANONICAL_ACTIVITIES = (
    "harvest",
    "gleaning",
    "weeding",
    "planting",
    "transplanting",
    "livestock",
    "infrastructure",
    "processing",
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
    confidence: float | None = None
    created_at: datetime
    ttl: datetime | None = None  # Firestore TTL; ~90 days after created_at


class FlagDoc(BaseModel):
    id: str | None = None
    message_id: str
    flagged_by_user_id: str | None = None  # None when raised by the agent
    reason: str = ""
    resolved_at: datetime | None = None
    created_at: datetime


class DestinationDoc(BaseModel):
    id: str | None = None
    name: str
    address: str | None = None
    notes: str = ""


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
