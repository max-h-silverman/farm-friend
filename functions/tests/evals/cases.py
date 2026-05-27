"""Eval cases for the unified agent.

This file is the spec, not a runner. Each `EvalCase` describes:
  - the world before the agent runs (sender, sender state, opps, last message)
  - the inbound text (or, for review-mode cases, the trigger)
  - the expected shape of `AgentOutput` (mode + action shape, not prose)

`runner.py` constructs an `AgentContext` from `world`, calls `run_agent`, and
asserts on the output. For state-changing modes it also asserts the receipt
shape after dispatch executes.

Pass criteria per category:
  - REGRESSION cases (existing flows): exact match required.
  - NEW_INTENT cases: exact match required.
  - ADVERSARIAL cases: behavioral match — correct mode + rough action shape;
    prose latitude allowed.
  - REVIEW cases: deterministic budget filtering checked exactly; proposal
    ranking checked by category only.

The cases below are the spec. The world fixture is intentionally lightweight
so a fresh reader can see the shape at a glance.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

UTC = timezone.utc

# A frozen "now" so cases are deterministic. We use a Wednesday early-evening
# stamp so all the relative date references ("Friday", "tomorrow", "this
# weekend") are unambiguous in the human sense. Datetimes throughout this
# module are best read as Vashon-local clock time — the runner strips the
# UTC tz when building the agent's context so date arithmetic is internally
# consistent: `NOW + timedelta(days=2)` is two calendar days later in the
# same wall-clock frame.
NOW = datetime(2026, 6, 3, 21, 0, tzinfo=UTC)  # Wed Jun 3, 9pm local (treated as naive)


# ---------------------------------------------------------------------------
# World shape (mirrors what AgentContext will be built from)
# ---------------------------------------------------------------------------
@dataclass
class FakeUser:
    id: str
    phone: str
    name: str
    role: Literal["farmer", "volunteer", "both"]
    status: Literal["pending", "active", "suspended", "unsubscribed"] = "active"
    available_days: list[int] = field(default_factory=list)
    available_start_hour: int | None = None
    available_end_hour: int | None = None
    activity_preferences: list[str] = field(default_factory=list)
    mute_dimensions: list[tuple[str, str]] = field(default_factory=list)  # (dim, value)
    last_agent_initiated_outbound_at: datetime | None = None


@dataclass
class FakeFarm:
    id: str
    name: str
    owner_user_id: str
    typical_start_hour: int | None = None
    typical_shift_duration_min: int | None = None
    usual_days_of_week: list[int] = field(default_factory=list)


@dataclass
class FakeOpp:
    id: str
    farm_id: str
    kind: Literal["shift", "pickup"]
    status: Literal["draft", "open", "filling", "full", "completed", "cancelled", "expired"]
    starts_at: datetime | None = None
    deadline_at: datetime | None = None
    duration_min: int | None = None
    headcount_needed: int = 1
    seats_filled: int = 0
    activity_tags: list[str] = field(default_factory=list)
    requirements_text: str = ""
    produce_description: str | None = None
    destination: str | None = None
    agent_nudges_sent: int = 0
    post_event_checkin_sent: bool = False
    post_event_checkin_at: datetime | None = None


@dataclass
class FakeClaim:
    opp_id: str
    volunteer_user_id: str
    slots: int = 1
    status: Literal["confirmed", "interested", "waitlist", "dropped"] = "confirmed"
    confirmation_sent_at: datetime | None = None


@dataclass
class FakeOffer:
    id: str
    volunteer_user_id: str
    activity_tags: list[str]
    earliest_at: datetime | None = None
    latest_at: datetime | None = None
    note: str = ""
    status: Literal["open", "matched", "expired", "cancelled"] = "open"
    created_at: datetime = NOW


@dataclass
class FakeMessage:
    direction: Literal["inbound", "outbound"]
    user_id: str
    body: str
    intent_label: str | None = None
    opportunity_id: str | None = None
    created_at: datetime = NOW
    pending_action: dict | None = None
    executed_action: dict | None = None


@dataclass
class World:
    users: list[FakeUser] = field(default_factory=list)
    farms: list[FakeFarm] = field(default_factory=list)
    opps: list[FakeOpp] = field(default_factory=list)
    claims: list[FakeClaim] = field(default_factory=list)
    offers: list[FakeOffer] = field(default_factory=list)
    messages: list[FakeMessage] = field(default_factory=list)
    flags_open_for_user_ids: list[str] = field(default_factory=list)


@dataclass
class ExpectedOutput:
    mode: Literal["reply", "confirm", "execute", "clarify", "escalate", "review"]
    # For confirm/execute, the action.name we expect.
    action_name: str | None = None
    # For confirm/execute, required keys in action.payload (existence + value match).
    # Set value to `ANY` to assert presence without value.
    payload_must_include: dict[str, Any] = field(default_factory=dict)
    # For confirm, the token must satisfy this predicate. By default: 5-8 char
    # uppercase alphanumeric, no hyphens, not collide with hotkeys.
    token_regex: str = r"^[A-Z][A-Z0-9]{4,7}$"
    token_must_not_equal: tuple[str, ...] = (
        "STOP", "HELP", "JOIN", "FLAG", "YES", "MAYBE", "MUTE", "STATUS",
        "CANCEL", "EDIT", "INSIDER", "UNDO", "PAUSE", "RESUME", "UNSUBSCRIBE", "END", "QUIT", "INFO", "START",
    )
    # For escalate, the urgency.
    escalation_urgency: Literal["routine", "immediate"] | None = None
    # For review, expected proposal categories and counts.
    review_min_proposals: int | None = None
    review_max_proposals: int | None = None
    # For execute mode, what the receipt outbound should look like.
    receipt_must_include_phrase: list[str] = field(default_factory=list)


ANY: Any = object()


@dataclass
class EvalCase:
    id: str
    category: Literal["REGRESSION", "NEW_INTENT", "ADVERSARIAL", "REVIEW"]
    description: str
    world: World
    inbound_text: str
    inbound_from_user_id: str | None = None  # which user is sending
    expected: ExpectedOutput = field(default_factory=lambda: ExpectedOutput(mode="reply"))
    # Review-mode cases don't have an inbound; this trigger names the tick.
    review_trigger: bool = False


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------
FARMER_A = FakeUser(id="u_farmer_a", phone="+12065550001", name="Eli Chen", role="farmer")
FARMER_B = FakeUser(id="u_farmer_b", phone="+12065550002", name="Mara Cole", role="farmer")
VOL_A = FakeUser(id="u_vol_a", phone="+12065550101", name="Alex Park", role="volunteer")
VOL_B = FakeUser(id="u_vol_b", phone="+12065550102", name="Sam Reyes", role="volunteer")
VOL_C = FakeUser(id="u_vol_c", phone="+12065550103", name="Jess Liu", role="volunteer",
                 available_days=[5, 6], available_start_hour=8, available_end_hour=14)

FARM_THREE_CEDARS = FakeFarm(
    id="f_3c", name="Three Cedars", owner_user_id="u_farmer_a",
    typical_start_hour=9, typical_shift_duration_min=180,
)
FARM_PLUM_FOREST = FakeFarm(
    id="f_pf", name="Plum Forest", owner_user_id="u_farmer_b",
)

# A common "Friday morning shift" used across many cases.
# NOW is Wed Jun 3 21:00 (Vashon-local). +1d +12h = Fri Jun 5 09:00 local.
SHIFT_FRI_HARVEST = FakeOpp(
    id="o_fri_harvest", farm_id="f_3c", kind="shift", status="open",
    starts_at=NOW + timedelta(days=1, hours=12),  # Friday Jun 5 9am Vashon
    duration_min=180, headcount_needed=3, seats_filled=1,
    activity_tags=["harvest"],
)
SHIFT_SAT_GLEAN = FakeOpp(
    id="o_sat_glean", farm_id="f_pf", kind="shift", status="open",
    starts_at=NOW + timedelta(days=2, hours=12),  # Saturday Jun 6 9am Vashon
    duration_min=180, headcount_needed=4, seats_filled=0,
    activity_tags=["gleaning"],
)
PICKUP_THU = FakeOpp(
    id="o_thu_pickup", farm_id="f_3c", kind="pickup", status="open",
    deadline_at=NOW + timedelta(hours=23),  # Thu Jun 4 8pm Vashon
    produce_description="50 lbs carrots", destination="Vashon Food Bank",
)


# ---------------------------------------------------------------------------
# CASES
# ---------------------------------------------------------------------------
CASES: list[EvalCase] = []


# === REGRESSION: existing flows that must not break ========================

CASES.append(EvalCase(
    id="reg.claim.free_form_with_opp",
    category="REGRESSION",
    description=(
        "Volunteer received outreach for Friday harvest; replies in free-form "
        "('count me in'). Should draft a claim confirmation."
    ),
    world=World(
        users=[VOL_A, FARMER_A], farms=[FARM_THREE_CEDARS], opps=[SHIFT_FRI_HARVEST],
        messages=[
            FakeMessage(direction="outbound", user_id="u_vol_a",
                        body="Three Cedars needs 3 for harvest Fri 9am-12.",
                        opportunity_id="o_fri_harvest"),
        ],
    ),
    inbound_text="count me in",
    inbound_from_user_id="u_vol_a",
    expected=ExpectedOutput(
        mode="confirm", action_name="claim_opportunity",
        payload_must_include={"opp_id": "o_fri_harvest", "slots": 1},
    ),
))

CASES.append(EvalCase(
    id="reg.claim.token_confirms_claim",
    category="REGRESSION",
    description=(
        "Volunteer was sent a CLAIM confirmation; replies with the token. "
        "Should execute (dispatch path), NOT the agent — but the agent must "
        "still produce a sensible output if dispatch routes it (it shouldn't)."
    ),
    world=World(
        users=[VOL_A, FARMER_A], farms=[FARM_THREE_CEDARS], opps=[SHIFT_FRI_HARVEST],
        messages=[
            FakeMessage(direction="outbound", user_id="u_vol_a",
                        body="Reply CONFIRM to claim Friday 9am harvest at Three Cedars.",
                        opportunity_id="o_fri_harvest",
                        intent_label="PENDING_CONFIRMATION",
                        pending_action={
                            "action": "claim_opportunity",
                            "token": "CONFIRM",
                            "payload": {"opp_id": "o_fri_harvest", "slots": 1},
                            "expires_at": (NOW + timedelta(minutes=30)).isoformat(),
                        }),
        ],
    ),
    inbound_text="CONFIRM",
    inbound_from_user_id="u_vol_a",
    expected=ExpectedOutput(
        mode="execute", action_name="claim_opportunity",
        payload_must_include={"opp_id": "o_fri_harvest", "slots": 1},
        receipt_must_include_phrase=["Three Cedars", "Friday", "UNDO"],
    ),
))

CASES.append(EvalCase(
    id="reg.maybe.soft_yes",
    category="REGRESSION",
    description="Volunteer expresses soft interest. Records MAYBE without seat.",
    world=World(
        users=[VOL_A], opps=[SHIFT_FRI_HARVEST], farms=[FARM_THREE_CEDARS],
        messages=[FakeMessage(direction="outbound", user_id="u_vol_a",
                              body="Three Cedars needs 3 for Fri harvest.",
                              opportunity_id="o_fri_harvest")],
    ),
    inbound_text="maybe — depends on weather",
    inbound_from_user_id="u_vol_a",
    expected=ExpectedOutput(
        mode="confirm", action_name="record_maybe",
        payload_must_include={"opp_id": "o_fri_harvest"},
    ),
))

CASES.append(EvalCase(
    id="reg.decline.busy",
    category="REGRESSION",
    description="Volunteer declines politely; should reply, not draft an action.",
    world=World(
        users=[VOL_A], opps=[SHIFT_FRI_HARVEST], farms=[FARM_THREE_CEDARS],
        messages=[FakeMessage(direction="outbound", user_id="u_vol_a",
                              body="Three Cedars needs 3 for Fri harvest.",
                              opportunity_id="o_fri_harvest")],
    ),
    inbound_text="sorry, can't this Friday",
    inbound_from_user_id="u_vol_a",
    expected=ExpectedOutput(mode="reply"),
))

CASES.append(EvalCase(
    id="reg.farmer.post.shift_well_formed",
    category="REGRESSION",
    description="Farmer posts a well-formed shift; should draft create_opportunity.",
    world=World(users=[FARMER_A], farms=[FARM_THREE_CEDARS]),
    inbound_text="Need 3 for harvest Friday 9am-12, $0, light work",
    inbound_from_user_id="u_farmer_a",
    expected=ExpectedOutput(
        mode="confirm", action_name="create_opportunity",
        payload_must_include={
            "kind": "shift",
            "headcount_needed": 3,
            "duration_min": 180,
            "activity_tags": ["harvest"],
        },
    ),
))

CASES.append(EvalCase(
    id="reg.farmer.post.missing_time",
    category="REGRESSION",
    description=(
        "Farmer posts a shift missing the start time. Should clarify, not "
        "guess. The farm has a typical_start_hour but the parser should NOT "
        "silently fill it for a fresh post — it asks."
    ),
    world=World(users=[FARMER_A], farms=[FARM_THREE_CEDARS]),
    inbound_text="need 2 for weeding tomorrow",
    inbound_from_user_id="u_farmer_a",
    expected=ExpectedOutput(mode="clarify"),
))

CASES.append(EvalCase(
    id="reg.farmer.post.crop_name_no_activity",
    category="REGRESSION",
    description=(
        "Farmer posts with a crop name but no activity word ('need tomatoes "
        "two people Friday 9am'). 'Tomatoes' could mean harvest, weeding, "
        "transplanting, or surplus pickup — the agent must NOT infer 'harvest'. "
        "Should clarify what kind of work."
    ),
    world=World(users=[FARMER_A], farms=[FARM_THREE_CEDARS]),
    inbound_text="need tomatoes two people friday 9am",
    inbound_from_user_id="u_farmer_a",
    expected=ExpectedOutput(mode="clarify"),
))

CASES.append(EvalCase(
    id="reg.farmer.post.tbd_explicit",
    category="REGRESSION",
    description=(
        "Farmer explicitly says they don't know the activity yet ('not sure "
        "what we'll do — just need extra hands'). Should confirm with "
        "activity_tags=['tbd'] rather than clarifying or auto-picking a slug."
    ),
    world=World(users=[FARMER_A], farms=[FARM_THREE_CEDARS]),
    inbound_text="not sure what we'll do monday but need 2 extra hands 9am-12",
    inbound_from_user_id="u_farmer_a",
    expected=ExpectedOutput(
        mode="confirm", action_name="create_opportunity",
        payload_must_include={
            "kind": "shift",
            "headcount_needed": 2,
            "activity_tags": ["tbd"],
        },
    ),
))

CASES.append(EvalCase(
    id="reg.farmer.clarification_completes_draft",
    category="REGRESSION",
    description=(
        "Farmer previously posted a missing-time draft; replies with the time. "
        "Should confirm a create_opportunity with the merged fields."
    ),
    world=World(
        users=[FARMER_A], farms=[FARM_THREE_CEDARS],
        opps=[FakeOpp(
            id="o_draft", farm_id="f_3c", kind="shift", status="draft",
            # Day is settled from the prior post ("tomorrow"); only time was
            # missing. starts_at is at midnight Vashon-local on the target day
            # as a placeholder — the clarification updates the hour.
            starts_at=NOW + timedelta(days=1, hours=7),  # Thu 00:00 Vashon
            headcount_needed=2, activity_tags=["weeding"],
        )],
        messages=[
            FakeMessage(direction="inbound", user_id="u_farmer_a",
                        body="need 2 for weeding tomorrow",
                        created_at=NOW - timedelta(minutes=5)),
            FakeMessage(direction="outbound", user_id="u_farmer_a",
                        body="What time should we start, and how long?",
                        intent_label="CLARIFY",
                        opportunity_id="o_draft",
                        created_at=NOW - timedelta(minutes=4)),
        ],
    ),
    inbound_text="9am for 3 hours",
    inbound_from_user_id="u_farmer_a",
    expected=ExpectedOutput(
        mode="confirm", action_name="update_draft_opportunity",
        payload_must_include={
            "opp_id": "o_draft",
            "duration_min": 180,
        },
    ),
))

CASES.append(EvalCase(
    id="reg.farmer.edit.time_change",
    category="REGRESSION",
    description="Farmer wants to move Friday shift to Saturday.",
    world=World(
        users=[FARMER_A], farms=[FARM_THREE_CEDARS], opps=[SHIFT_FRI_HARVEST],
    ),
    inbound_text="move the Friday shift to Saturday same time",
    inbound_from_user_id="u_farmer_a",
    expected=ExpectedOutput(
        mode="confirm", action_name="edit_opportunity",
        payload_must_include={"opp_id": "o_fri_harvest", "starts_at": ANY},
    ),
))

CASES.append(EvalCase(
    id="reg.farmer.edit.headcount_down_below_filled",
    category="REGRESSION",
    description=(
        "Farmer wants to cut headcount below already-confirmed seats. Should "
        "NOT draft an edit that would invalidate confirmed claims — reply "
        "explaining the constraint."
    ),
    world=World(
        users=[FARMER_A], farms=[FARM_THREE_CEDARS],
        opps=[FakeOpp(id="o_fri_harvest", farm_id="f_3c", kind="shift", status="filling",
                      starts_at=NOW + timedelta(days=1, hours=12),  # Fri 9am
                      duration_min=180, headcount_needed=3, seats_filled=2,
                      activity_tags=["harvest"])],
    ),
    inbound_text="actually only need 1 person Friday",
    inbound_from_user_id="u_farmer_a",
    expected=ExpectedOutput(mode="reply"),
))

CASES.append(EvalCase(
    id="reg.farmer.cancel.unique_match",
    category="REGRESSION",
    description="Farmer says 'cancel Friday' with one open Friday opp. Resolve silently.",
    world=World(users=[FARMER_A], farms=[FARM_THREE_CEDARS], opps=[SHIFT_FRI_HARVEST]),
    inbound_text="cancel Friday",
    inbound_from_user_id="u_farmer_a",
    expected=ExpectedOutput(
        mode="confirm", action_name="cancel_opportunity",
        payload_must_include={"opp_id": "o_fri_harvest"},
    ),
))

CASES.append(EvalCase(
    id="reg.farmer.cancel.ambiguous_match",
    category="REGRESSION",
    description="Two open Friday opps; should clarify which.",
    world=World(
        users=[FARMER_A], farms=[FARM_THREE_CEDARS],
        opps=[
            SHIFT_FRI_HARVEST,
            FakeOpp(id="o_fri_glean", farm_id="f_3c", kind="shift", status="open",
                    starts_at=NOW + timedelta(days=1, hours=18),  # Fri 3pm
                    duration_min=120, headcount_needed=2, activity_tags=["gleaning"]),
        ],
    ),
    inbound_text="cancel Friday",
    inbound_from_user_id="u_farmer_a",
    expected=ExpectedOutput(mode="clarify"),
))

CASES.append(EvalCase(
    id="reg.farmer.status_hotkey_equivalent",
    category="REGRESSION",
    description="Farmer asks in free-form for status; should reply directly with state info.",
    world=World(
        users=[FARMER_A], farms=[FARM_THREE_CEDARS],
        opps=[SHIFT_FRI_HARVEST, PICKUP_THU],
    ),
    inbound_text="how's everything looking?",
    inbound_from_user_id="u_farmer_a",
    expected=ExpectedOutput(mode="reply"),
))

CASES.append(EvalCase(
    id="reg.post_event.farmer_ok",
    category="REGRESSION",
    description="Farmer replies Y to a post-event check-in. Executes acknowledge.",
    world=World(
        users=[FARMER_A], farms=[FARM_THREE_CEDARS],
        opps=[FakeOpp(id="o_done", farm_id="f_3c", kind="shift", status="completed",
                      starts_at=NOW - timedelta(days=1), duration_min=180,
                      headcount_needed=2, seats_filled=2, activity_tags=["harvest"],
                      post_event_checkin_sent=True)],
        messages=[FakeMessage(
            direction="outbound", user_id="u_farmer_a",
            body="Any issues from yesterday's harvest? Y/N",
            intent_label="POST_EVENT_CHECKIN", opportunity_id="o_done",
        )],
    ),
    inbound_text="Y",
    inbound_from_user_id="u_farmer_a",
    expected=ExpectedOutput(
        mode="execute", action_name="acknowledge_post_event",
        payload_must_include={"opp_id": "o_done", "answer": "Y"},
    ),
))

CASES.append(EvalCase(
    id="reg.escalate.injury_immediate",
    category="REGRESSION",
    description="Volunteer reports an injury. Immediate escalation to coordinator.",
    world=World(users=[VOL_A]),
    inbound_text="I cut my hand at Plum Forest, bleeding a lot",
    inbound_from_user_id="u_vol_a",
    expected=ExpectedOutput(mode="escalate", escalation_urgency="immediate"),
))

CASES.append(EvalCase(
    id="reg.escalate.payment_routine",
    category="REGRESSION",
    description="Volunteer asks about payment. Routine escalation.",
    world=World(users=[VOL_A]),
    inbound_text="when do I get paid for last week?",
    inbound_from_user_id="u_vol_a",
    expected=ExpectedOutput(mode="escalate", escalation_urgency="routine"),
))

CASES.append(EvalCase(
    id="reg.flag.silent_when_flagged",
    category="REGRESSION",
    description=(
        "Sender has an open FLAG. Dispatch must NOT call the agent at all. "
        "This case checks dispatch behavior; the agent should never run."
    ),
    world=World(
        users=[VOL_A], opps=[SHIFT_FRI_HARVEST], farms=[FARM_THREE_CEDARS],
        flags_open_for_user_ids=["u_vol_a"],
    ),
    inbound_text="anything happening Friday?",
    inbound_from_user_id="u_vol_a",
    # Special: runner will assert the agent was NOT invoked.
    expected=ExpectedOutput(mode="reply"),  # placeholder; runner checks dispatch
))


# === NEW_INTENT: behaviors the refactor adds ===============================

CASES.append(EvalCase(
    id="new.vol.offer.broadcast",
    category="NEW_INTENT",
    description=(
        "Volunteer proactively offers help with no specific farm. Should "
        "confirm a record_offer (NOT escalate, NOT generic fallback). "
        "This is the motivating bug for the whole refactor."
    ),
    world=World(users=[VOL_A], opps=[SHIFT_SAT_GLEAN], farms=[FARM_PLUM_FOREST]),
    inbound_text="hey does anyone need help with tilling on Friday?",
    inbound_from_user_id="u_vol_a",
    expected=ExpectedOutput(
        mode="confirm", action_name="record_offer",
        payload_must_include={"activity_tags": ANY},
    ),
))

CASES.append(EvalCase(
    id="new.vol.offer.directed",
    category="NEW_INTENT",
    description="Volunteer offers help at a specific farm. record_offer with farm hint.",
    world=World(users=[VOL_A], opps=[SHIFT_SAT_GLEAN], farms=[FARM_PLUM_FOREST]),
    inbound_text="can I help at Plum Forest this week?",
    inbound_from_user_id="u_vol_a",
    expected=ExpectedOutput(
        mode="confirm", action_name="record_offer",
        payload_must_include={"note": ANY},  # farm name lives in the note
    ),
))

CASES.append(EvalCase(
    id="new.vol.offer.matches_existing_opp",
    category="NEW_INTENT",
    description=(
        "Volunteer offers tilling help; there's an OPEN gleaning shift "
        "Saturday. Agent should NOT auto-suggest a claim — gleaning != "
        "tilling. Should still record the offer."
    ),
    world=World(users=[VOL_A], opps=[SHIFT_SAT_GLEAN], farms=[FARM_PLUM_FOREST]),
    inbound_text="can I help with tilling this weekend?",
    inbound_from_user_id="u_vol_a",
    expected=ExpectedOutput(mode="confirm", action_name="record_offer"),
))

CASES.append(EvalCase(
    id="new.vol.offer.flexible_phys_work",
    category="NEW_INTENT",
    description=(
        "Volunteer offers themselves for any activity within a specific window "
        "('i'd love to get in some physical work this weekend, some morning'). "
        "Has day-range + time-window + explicit openness — clears the offer "
        "floor. Should confirm record_offer with activity_tags=['flexible']."
    ),
    world=World(users=[VOL_A], farms=[FARM_THREE_CEDARS]),
    inbound_text="i'd love to get in some physical work this weekend, some morning",
    inbound_from_user_id="u_vol_a",
    expected=ExpectedOutput(
        mode="confirm", action_name="record_offer",
        payload_must_include={"activity_tags": ["flexible"]},
    ),
))

CASES.append(EvalCase(
    id="new.vol.offer.vague_crop_only",
    category="NEW_INTENT",
    description=(
        "Volunteer says 'help with tomatoes this week' — crop name (not an "
        "activity) + week-broad window. Below the offer floor: no specific "
        "day, no time, no real activity signal. Should clarify, not silently "
        "record a useless offer."
    ),
    world=World(users=[VOL_A], farms=[FARM_THREE_CEDARS]),
    inbound_text="help with tomatoes this week",
    inbound_from_user_id="u_vol_a",
    expected=ExpectedOutput(mode="clarify"),
))

CASES.append(EvalCase(
    id="new.vol.availability.add_day",
    category="NEW_INTENT",
    description="Volunteer says 'I'm free Saturdays now'. Confirm set_availability.",
    world=World(users=[VOL_C]),  # VOL_C has [5,6] already; adding sat is no-op
    inbound_text="actually I can do Fridays going forward too",
    inbound_from_user_id="u_vol_c",
    expected=ExpectedOutput(
        mode="confirm", action_name="set_availability",
        payload_must_include={"available_days": ANY},
    ),
))

CASES.append(EvalCase(
    id="new.vol.availability.remove_day",
    category="NEW_INTENT",
    description="Volunteer says 'drop Tuesdays from my schedule'.",
    world=World(users=[FakeUser(
        id="u_vol_c", phone="+12065550103", name="Jess Liu", role="volunteer",
        available_days=[1, 5, 6],
    )]),
    inbound_text="drop Tuesdays from my schedule",
    inbound_from_user_id="u_vol_c",
    expected=ExpectedOutput(
        mode="confirm", action_name="set_availability",
        payload_must_include={"available_days": [5, 6]},
    ),
))

CASES.append(EvalCase(
    id="new.vol.activity_preference",
    category="NEW_INTENT",
    description="Volunteer expresses positive preference for gleaning.",
    world=World(users=[VOL_A]),
    inbound_text="I love gleaning, send me more of those",
    inbound_from_user_id="u_vol_a",
    expected=ExpectedOutput(
        mode="confirm", action_name="set_activity_preferences",
        payload_must_include={"add": ["gleaning"]},
    ),
))

CASES.append(EvalCase(
    id="new.vol.query.whats_open",
    category="NEW_INTENT",
    description="Volunteer asks what's open. Pure reply with current state.",
    world=World(
        users=[VOL_A], farms=[FARM_THREE_CEDARS, FARM_PLUM_FOREST],
        opps=[SHIFT_FRI_HARVEST, SHIFT_SAT_GLEAN, PICKUP_THU],
    ),
    inbound_text="what's open this weekend?",
    inbound_from_user_id="u_vol_a",
    expected=ExpectedOutput(mode="reply"),
))

CASES.append(EvalCase(
    id="new.vol.query.specific_day",
    category="NEW_INTENT",
    description="Volunteer asks about a specific day; should answer specifically.",
    world=World(
        users=[VOL_A], farms=[FARM_THREE_CEDARS, FARM_PLUM_FOREST],
        opps=[SHIFT_FRI_HARVEST, SHIFT_SAT_GLEAN],
    ),
    inbound_text="anything Friday?",
    inbound_from_user_id="u_vol_a",
    expected=ExpectedOutput(mode="reply"),
))

CASES.append(EvalCase(
    id="new.vol.proactive_cancel.unique",
    category="NEW_INTENT",
    description=(
        "Volunteer with one confirmed Friday claim says 'can't make Friday'. "
        "Resolve silently to that claim, draft drop_confirmed_claim."
    ),
    world=World(
        users=[VOL_A, FARMER_A], farms=[FARM_THREE_CEDARS], opps=[SHIFT_FRI_HARVEST],
        claims=[FakeClaim(opp_id="o_fri_harvest", volunteer_user_id="u_vol_a")],
    ),
    inbound_text="can't make Friday after all",
    inbound_from_user_id="u_vol_a",
    expected=ExpectedOutput(
        mode="confirm", action_name="drop_confirmed_claim",
        payload_must_include={"opp_id": "o_fri_harvest"},
    ),
))

CASES.append(EvalCase(
    id="new.vol.proactive_cancel.ambiguous",
    category="NEW_INTENT",
    description="Volunteer has two confirmed claims this week; says 'cancel mine'. Clarify.",
    world=World(
        users=[VOL_A], farms=[FARM_THREE_CEDARS, FARM_PLUM_FOREST],
        opps=[SHIFT_FRI_HARVEST, SHIFT_SAT_GLEAN],
        claims=[
            FakeClaim(opp_id="o_fri_harvest", volunteer_user_id="u_vol_a"),
            FakeClaim(opp_id="o_sat_glean", volunteer_user_id="u_vol_a"),
        ],
    ),
    inbound_text="need to cancel my shift",
    inbound_from_user_id="u_vol_a",
    expected=ExpectedOutput(mode="clarify"),
))

CASES.append(EvalCase(
    id="new.farmer.passthrough_request",
    category="NEW_INTENT",
    description=(
        "Farmer says 'tell Alex thanks'. The system doesn't pass arbitrary "
        "messages between users in v1. Should reply explaining, not escalate."
    ),
    world=World(users=[FARMER_A], farms=[FARM_THREE_CEDARS]),
    inbound_text="can you tell Alex thanks for yesterday?",
    inbound_from_user_id="u_farmer_a",
    expected=ExpectedOutput(mode="reply"),
))

CASES.append(EvalCase(
    id="new.farmer.general_question",
    category="NEW_INTENT",
    description="Farmer asks how the system works; reply, don't escalate.",
    world=World(users=[FARMER_A], farms=[FARM_THREE_CEDARS]),
    inbound_text="how does this whole thing work anyway?",
    inbound_from_user_id="u_farmer_a",
    expected=ExpectedOutput(mode="reply"),
))

CASES.append(EvalCase(
    id="new.undo.recent_action",
    category="NEW_INTENT",
    description=(
        "Volunteer says UNDO right after a claim was executed. Dispatch (not "
        "agent) reverses; this case confirms agent isn't accidentally called."
    ),
    world=World(
        users=[VOL_A], opps=[FakeOpp(
            id="o_fri_harvest", farm_id="f_3c", kind="shift", status="filling",
            starts_at=NOW + timedelta(days=1, hours=12),  # Fri 9am
            duration_min=180, headcount_needed=3, seats_filled=2,
            activity_tags=["harvest"])], farms=[FARM_THREE_CEDARS],
        claims=[FakeClaim(opp_id="o_fri_harvest", volunteer_user_id="u_vol_a")],
        messages=[FakeMessage(
            direction="outbound", user_id="u_vol_a",
            body="You're confirmed for harvest at Three Cedars Friday 9am-12. Reply UNDO within 5 min if that wasn't right.",
            intent_label="ACTION_RECEIPT", opportunity_id="o_fri_harvest",
            created_at=NOW - timedelta(minutes=2),
            executed_action={
                "action": "claim_opportunity",
                "payload": {"opp_id": "o_fri_harvest", "slots": 1},
                "executed_at": (NOW - timedelta(minutes=2)).isoformat(),
                "undo_token": "UNDO",
            },
        )],
    ),
    inbound_text="UNDO",
    inbound_from_user_id="u_vol_a",
    expected=ExpectedOutput(mode="execute", action_name="undo_last"),
))


# === ADVERSARIAL: things the agent has to actively NOT do ==================

CASES.append(EvalCase(
    id="adv.token.too_long",
    category="ADVERSARIAL",
    description=(
        "Stress test: prompt should never produce a token longer than 8 chars. "
        "If it does, schema validation rejects and runner records a hard fail."
    ),
    world=World(
        users=[VOL_A], opps=[SHIFT_FRI_HARVEST], farms=[FARM_THREE_CEDARS],
        messages=[FakeMessage(direction="outbound", user_id="u_vol_a",
                              body="Three Cedars needs 3 for harvest Fri 9am-12.",
                              opportunity_id="o_fri_harvest")],
    ),
    inbound_text="yeah I'll do the Friday thing",
    inbound_from_user_id="u_vol_a",
    expected=ExpectedOutput(
        mode="confirm", action_name="claim_opportunity",
        # Token regex in default ExpectedOutput rejects > 8 chars / hyphens / lowercase.
    ),
))

CASES.append(EvalCase(
    id="adv.token.collides_with_hotkey",
    category="ADVERSARIAL",
    description="Confirm token must NOT equal STOP/HELP/YES/etc.",
    world=World(
        users=[VOL_A], opps=[SHIFT_FRI_HARVEST], farms=[FARM_THREE_CEDARS],
        messages=[FakeMessage(direction="outbound", user_id="u_vol_a",
                              body="Three Cedars needs 3 for harvest Fri 9am-12.",
                              opportunity_id="o_fri_harvest")],
    ),
    inbound_text="alright sign me up",
    inbound_from_user_id="u_vol_a",
    expected=ExpectedOutput(
        mode="confirm", action_name="claim_opportunity",
        # Default `token_must_not_equal` enforces the constraint.
    ),
))

CASES.append(EvalCase(
    id="adv.affirmative_after_pending",
    category="ADVERSARIAL",
    description=(
        "User replies 'yes' after a PENDING_CONFIRMATION. Dispatch (not agent) "
        "treats this as a token match via the affirmative variants list, and "
        "executes. Agent must not see this case; runner asserts dispatch route."
    ),
    world=World(
        users=[VOL_A], opps=[SHIFT_FRI_HARVEST], farms=[FARM_THREE_CEDARS],
        messages=[FakeMessage(
            direction="outbound", user_id="u_vol_a",
            body="Reply CLAIM to grab Friday 9am harvest at Three Cedars.",
            intent_label="PENDING_CONFIRMATION", opportunity_id="o_fri_harvest",
            pending_action={
                "action": "claim_opportunity",
                "token": "CLAIM",
                "payload": {"opp_id": "o_fri_harvest", "slots": 1},
                "expires_at": (NOW + timedelta(minutes=30)).isoformat(),
            },
        )],
    ),
    inbound_text="yes",
    inbound_from_user_id="u_vol_a",
    expected=ExpectedOutput(mode="execute", action_name="claim_opportunity"),
))

CASES.append(EvalCase(
    id="adv.affirmative_after_clarify_does_nothing",
    category="ADVERSARIAL",
    description=(
        "User replies 'yes' after a CLARIFY (no token!). Must NOT execute "
        "anything — there's no pending action. Agent should ask a more "
        "specific follow-up or treat this as a normal inbound."
    ),
    world=World(
        users=[FARMER_A], farms=[FARM_THREE_CEDARS],
        opps=[FakeOpp(id="o_draft", farm_id="f_3c", kind="shift", status="draft",
                      headcount_needed=2, activity_tags=["weeding"])],
        messages=[FakeMessage(direction="outbound", user_id="u_farmer_a",
                              body="What time should we start?",
                              intent_label="CLARIFY", opportunity_id="o_draft")],
    ),
    inbound_text="yes",
    inbound_from_user_id="u_farmer_a",
    expected=ExpectedOutput(mode="clarify"),  # re-ask, more specifically
))

CASES.append(EvalCase(
    id="adv.context_switch_mid_confirmation",
    category="ADVERSARIAL",
    description=(
        "User has a pending CLAIM confirmation; replies with an unrelated "
        "QUERY. Agent should answer the query and EITHER keep the pending "
        "alive or send a new draft. Must NOT silently execute the old one."
    ),
    world=World(
        users=[VOL_A], opps=[SHIFT_FRI_HARVEST, SHIFT_SAT_GLEAN],
        farms=[FARM_THREE_CEDARS, FARM_PLUM_FOREST],
        messages=[FakeMessage(
            direction="outbound", user_id="u_vol_a",
            body="Reply CLAIM to grab Friday 9am harvest at Three Cedars.",
            intent_label="PENDING_CONFIRMATION", opportunity_id="o_fri_harvest",
            pending_action={
                "action": "claim_opportunity", "token": "CLAIM",
                "payload": {"opp_id": "o_fri_harvest", "slots": 1},
                "expires_at": (NOW + timedelta(minutes=30)).isoformat(),
            },
        )],
    ),
    inbound_text="actually what's available Saturday?",
    inbound_from_user_id="u_vol_a",
    expected=ExpectedOutput(mode="reply"),
))

CASES.append(EvalCase(
    id="adv.undo_outside_window",
    category="ADVERSARIAL",
    description=(
        "User says UNDO 8 min after the action. Must not execute. Receipt was "
        "explicit about 5-min window; agent or dispatch replies 'too late'."
    ),
    world=World(
        users=[VOL_A], opps=[SHIFT_FRI_HARVEST], farms=[FARM_THREE_CEDARS],
        claims=[FakeClaim(opp_id="o_fri_harvest", volunteer_user_id="u_vol_a")],
        messages=[FakeMessage(
            direction="outbound", user_id="u_vol_a",
            body="Confirmed for Friday. Reply UNDO within 5 min if wrong.",
            intent_label="ACTION_RECEIPT", opportunity_id="o_fri_harvest",
            created_at=NOW - timedelta(minutes=8),
            executed_action={"action": "claim_opportunity",
                             "payload": {"opp_id": "o_fri_harvest", "slots": 1},
                             "executed_at": (NOW - timedelta(minutes=8)).isoformat(),
                             "undo_token": "UNDO"},
        )],
    ),
    inbound_text="UNDO",
    inbound_from_user_id="u_vol_a",
    expected=ExpectedOutput(mode="reply"),  # dispatch replies "too late"
))

CASES.append(EvalCase(
    id="adv.fabrication.claim_not_held",
    category="ADVERSARIAL",
    description=(
        "Volunteer with NO confirmed claims says 'cancel mine'. Agent must "
        "NOT invent a claim. Should clarify or reply explaining no claims."
    ),
    world=World(users=[VOL_A], opps=[SHIFT_FRI_HARVEST], farms=[FARM_THREE_CEDARS]),
    inbound_text="cancel my shift",
    inbound_from_user_id="u_vol_a",
    expected=ExpectedOutput(mode="reply"),
))

CASES.append(EvalCase(
    id="adv.fabrication.opp_doesnt_exist",
    category="ADVERSARIAL",
    description=(
        "Volunteer asks about 'the Tuesday gleaning at Sweet Tree' which "
        "doesn't exist in any farm context. Must not invent details."
    ),
    world=World(
        users=[VOL_A], farms=[FARM_THREE_CEDARS, FARM_PLUM_FOREST],
        opps=[SHIFT_FRI_HARVEST, SHIFT_SAT_GLEAN],
    ),
    inbound_text="what time's the Tuesday gleaning at Sweet Tree?",
    inbound_from_user_id="u_vol_a",
    expected=ExpectedOutput(mode="reply"),
))

CASES.append(EvalCase(
    id="adv.unknown_activity_slug",
    category="ADVERSARIAL",
    description=(
        "Farmer posts a shift for 'mushroom foraging' — not in canonical list. "
        "Should NOT silently map to an existing slug. Should clarify or flag."
    ),
    world=World(users=[FARMER_A], farms=[FARM_THREE_CEDARS]),
    inbound_text="need 2 people Saturday 10am for mushroom foraging, 2 hours",
    inbound_from_user_id="u_farmer_a",
    expected=ExpectedOutput(mode="clarify"),
))

CASES.append(EvalCase(
    id="adv.clarify_cap.escalates_at_third_round",
    category="ADVERSARIAL",
    description=(
        "Two prior CLARIFY outbounds on this thread. Third inbound still "
        "ambiguous. Dispatch must NOT invoke the agent — straight to routine "
        "escalation. Verified by runner asserting agent was not called."
    ),
    world=World(
        users=[VOL_A], farms=[FARM_THREE_CEDARS], opps=[SHIFT_FRI_HARVEST],
        messages=[
            FakeMessage(direction="outbound", user_id="u_vol_a",
                        body="Which shift did you mean?",
                        intent_label="CLARIFY",
                        created_at=NOW - timedelta(minutes=20)),
            FakeMessage(direction="inbound", user_id="u_vol_a",
                        body="you know, the one",
                        created_at=NOW - timedelta(minutes=18)),
            FakeMessage(direction="outbound", user_id="u_vol_a",
                        body="Could you say the date or the farm name?",
                        intent_label="CLARIFY",
                        created_at=NOW - timedelta(minutes=15)),
        ],
    ),
    inbound_text="the recent one",
    inbound_from_user_id="u_vol_a",
    expected=ExpectedOutput(mode="escalate", escalation_urgency="routine"),
))

CASES.append(EvalCase(
    id="adv.clarify_cap.resets_on_resolution",
    category="ADVERSARIAL",
    description=(
        "A prior CLARIFY was resolved (user's next reply produced an action). "
        "Later, the user sends a different ambiguous message. Counter must "
        "start fresh at 1, NOT escalate immediately."
    ),
    world=World(
        users=[VOL_A], farms=[FARM_THREE_CEDARS],
        opps=[SHIFT_FRI_HARVEST, SHIFT_SAT_GLEAN],
        messages=[
            FakeMessage(direction="outbound", user_id="u_vol_a",
                        body="Which day?",
                        intent_label="CLARIFY",
                        created_at=NOW - timedelta(hours=4)),
            FakeMessage(direction="inbound", user_id="u_vol_a",
                        body="Friday harvest",
                        created_at=NOW - timedelta(hours=4)),
            FakeMessage(direction="outbound", user_id="u_vol_a",
                        body="You're confirmed for Friday harvest at Three Cedars.",
                        intent_label="ACTION_RECEIPT",
                        created_at=NOW - timedelta(hours=4)),
        ],
    ),
    inbound_text="hmm not sure about that one",
    inbound_from_user_id="u_vol_a",
    expected=ExpectedOutput(mode="clarify"),  # NOT escalate; this is round 1
))

CASES.append(EvalCase(
    id="adv.clarify_cap.user_resolves_at_round_2",
    category="ADVERSARIAL",
    description=(
        "One prior CLARIFY. User's reply on round 2 IS understandable. Agent "
        "executes the action; no escalation. Verifies the cap is on consecutive "
        "clarifies, not on any-two-clarifies-in-a-row."
    ),
    world=World(
        users=[VOL_A], farms=[FARM_THREE_CEDARS, FARM_PLUM_FOREST],
        opps=[SHIFT_FRI_HARVEST, SHIFT_SAT_GLEAN],
        # Two confirmed claims — the prior CLARIFY was disambiguating which to drop.
        claims=[
            FakeClaim(opp_id="o_fri_harvest", volunteer_user_id="u_vol_a"),
            FakeClaim(opp_id="o_sat_glean", volunteer_user_id="u_vol_a"),
        ],
        messages=[
            FakeMessage(direction="inbound", user_id="u_vol_a",
                        body="need to cancel my shift",
                        created_at=NOW - timedelta(minutes=3)),
            FakeMessage(direction="outbound", user_id="u_vol_a",
                        body="Which shift did you mean to drop — Friday harvest at Three Cedars or Saturday gleaning at Plum Forest?",
                        intent_label="CLARIFY",
                        created_at=NOW - timedelta(minutes=2)),
        ],
    ),
    inbound_text="Friday harvest",
    inbound_from_user_id="u_vol_a",
    expected=ExpectedOutput(
        mode="confirm", action_name="drop_confirmed_claim",
        payload_must_include={"opp_id": "o_fri_harvest"},
    ),
))

CASES.append(EvalCase(
    id="adv.quiet_hours_does_not_block_inbound",
    category="ADVERSARIAL",
    description=(
        "Inbound at 2am — direct replies are allowed anytime per CLAUDE.md. "
        "Agent runs and responds; quiet hours only gate scheduled outbound."
    ),
    world=World(
        users=[VOL_A], opps=[SHIFT_FRI_HARVEST], farms=[FARM_THREE_CEDARS],
        messages=[FakeMessage(direction="outbound", user_id="u_vol_a",
                              body="Three Cedars needs 3 for Fri harvest.",
                              opportunity_id="o_fri_harvest")],
    ),
    inbound_text="yeah I can do it",
    inbound_from_user_id="u_vol_a",
    expected=ExpectedOutput(mode="confirm", action_name="claim_opportunity"),
))


# === REVIEW: agent-as-coordinator-on-the-board =============================

CASES.append(EvalCase(
    id="review.empty.no_actionable_state",
    category="REVIEW",
    description="Nothing to do. Empty proposal list.",
    world=World(users=[VOL_A, FARMER_A], farms=[FARM_THREE_CEDARS]),
    inbound_text="",
    review_trigger=True,
    expected=ExpectedOutput(mode="review", review_min_proposals=0, review_max_proposals=0),
))

CASES.append(EvalCase(
    id="review.underfilled_shift_t_minus_24h",
    category="REVIEW",
    description=(
        "Shift Friday 9am at 1/3 seats, currently Thursday 9am (T-24h). "
        "Agent should propose nudging the farmer or broadening outreach."
    ),
    world=World(
        users=[FARMER_A, VOL_A, VOL_B, VOL_C], farms=[FARM_THREE_CEDARS],
        opps=[FakeOpp(id="o_fri_harvest", farm_id="f_3c", kind="shift", status="filling",
                      starts_at=NOW + timedelta(days=1, hours=12),
                      duration_min=180, headcount_needed=3, seats_filled=1,
                      activity_tags=["harvest"])],
    ),
    inbound_text="",
    review_trigger=True,
    expected=ExpectedOutput(mode="review", review_min_proposals=1, review_max_proposals=3),
))

CASES.append(EvalCase(
    id="review.aging_offer_no_match",
    category="REVIEW",
    description="Offer 5 days old, no matching opps. Propose flagging to admin.",
    world=World(
        users=[VOL_A], farms=[FARM_THREE_CEDARS],
        offers=[FakeOffer(id="off_1", volunteer_user_id="u_vol_a",
                          activity_tags=["livestock"], created_at=NOW - timedelta(days=5))],
    ),
    inbound_text="",
    review_trigger=True,
    expected=ExpectedOutput(mode="review", review_min_proposals=1, review_max_proposals=1),
))

CASES.append(EvalCase(
    id="review.budget_blocks_user_proposal",
    category="REVIEW",
    description=(
        "Same as underfilled_shift_t_minus_24h, but farmer was already sent an "
        "agent-initiated outbound 6 hours ago. Per-user 48h budget should "
        "drop this proposal (or downgrade it to an admin flag)."
    ),
    world=World(
        users=[FakeUser(id="u_farmer_a", phone="+12065550001", name="Eli Chen",
                        role="farmer",
                        last_agent_initiated_outbound_at=NOW - timedelta(hours=6))],
        farms=[FARM_THREE_CEDARS],
        opps=[FakeOpp(id="o_fri_harvest", farm_id="f_3c", kind="shift", status="filling",
                      starts_at=NOW + timedelta(days=1, hours=12),
                      duration_min=180, headcount_needed=3, seats_filled=1,
                      activity_tags=["harvest"])],
    ),
    inbound_text="",
    review_trigger=True,
    expected=ExpectedOutput(mode="review", review_min_proposals=0, review_max_proposals=1),
))

CASES.append(EvalCase(
    id="review.per_opp_cap_at_max",
    category="REVIEW",
    description=(
        "Underfilled opp has already received 2 agent nudges. Proposal must "
        "be downgraded to admin-flag-only, not sent to user."
    ),
    world=World(
        users=[FARMER_A], farms=[FARM_THREE_CEDARS],
        opps=[FakeOpp(id="o_fri_harvest", farm_id="f_3c", kind="shift", status="filling",
                      starts_at=NOW + timedelta(days=1, hours=12),
                      duration_min=180, headcount_needed=3, seats_filled=1,
                      activity_tags=["harvest"], agent_nudges_sent=2)],
    ),
    inbound_text="",
    review_trigger=True,
    expected=ExpectedOutput(mode="review", review_min_proposals=0, review_max_proposals=1),
))

CASES.append(EvalCase(
    id="review.pause_mute_drops_user_proposal",
    category="REVIEW",
    description=(
        "Volunteer has an active PAUSE mute. A proposal targeting them must "
        "be dropped at dispatch budget-filter time."
    ),
    world=World(
        users=[FakeUser(id="u_vol_a", phone="+12065550101", name="Alex Park",
                        role="volunteer",
                        mute_dimensions=[("agent_nudge", "all")])],
        farms=[FARM_THREE_CEDARS],
        opps=[SHIFT_FRI_HARVEST],
        offers=[FakeOffer(id="off_1", volunteer_user_id="u_vol_a",
                          activity_tags=["harvest"], created_at=NOW - timedelta(days=1))],
    ),
    inbound_text="",
    review_trigger=True,
    expected=ExpectedOutput(mode="review", review_min_proposals=0, review_max_proposals=2),
))

CASES.append(EvalCase(
    id="review.per_tick_global_ceiling",
    category="REVIEW",
    description=(
        "Five different proposals worth sending. Dispatch sends top 3, flags "
        "the other 2 to admin."
    ),
    world=World(
        users=[FARMER_A, FARMER_B, VOL_A, VOL_B],
        farms=[FARM_THREE_CEDARS, FARM_PLUM_FOREST],
        opps=[
            FakeOpp(id="o1", farm_id="f_3c", kind="shift", status="filling",
                    starts_at=NOW + timedelta(days=1, hours=12),
                    duration_min=180, headcount_needed=3, seats_filled=1,
                    activity_tags=["harvest"]),
            FakeOpp(id="o2", farm_id="f_pf", kind="shift", status="open",
                    starts_at=NOW + timedelta(days=1, hours=18),
                    duration_min=120, headcount_needed=2, seats_filled=0,
                    activity_tags=["gleaning"]),
            FakeOpp(id="o3", farm_id="f_3c", kind="pickup", status="open",
                    deadline_at=NOW + timedelta(hours=8),
                    produce_description="20 lbs tomatoes",
                    destination="Vashon Food Bank"),
        ],
        offers=[
            FakeOffer(id="off_1", volunteer_user_id="u_vol_a",
                      activity_tags=["weeding"], created_at=NOW - timedelta(days=4)),
            FakeOffer(id="off_2", volunteer_user_id="u_vol_b",
                      activity_tags=["planting"], created_at=NOW - timedelta(days=6)),
        ],
    ),
    inbound_text="",
    review_trigger=True,
    expected=ExpectedOutput(mode="review", review_min_proposals=3, review_max_proposals=5),
))

CASES.append(EvalCase(
    id="review.failed_send_does_not_increment_counter",
    category="REVIEW",
    description=(
        "Dispatch-side invariant (not agent-side): if safe_send returns None "
        "(delivery failure), agent_nudges_sent must NOT be incremented and "
        "last_agent_initiated_outbound_at must NOT be updated. Verified by "
        "runner asserting state diff after the simulated failure."
    ),
    world=World(
        users=[FARMER_A], farms=[FARM_THREE_CEDARS],
        opps=[FakeOpp(id="o_fri_harvest", farm_id="f_3c", kind="shift", status="filling",
                      starts_at=NOW + timedelta(days=1, hours=12),
                      duration_min=180, headcount_needed=3, seats_filled=1,
                      activity_tags=["harvest"])],
    ),
    inbound_text="",
    review_trigger=True,
    expected=ExpectedOutput(mode="review", review_min_proposals=1, review_max_proposals=1),
))


# ---------------------------------------------------------------------------
# Indices for the runner
# ---------------------------------------------------------------------------
CASES_BY_ID = {c.id: c for c in CASES}
CASES_BY_CATEGORY: dict[str, list[EvalCase]] = {}
for c in CASES:
    CASES_BY_CATEGORY.setdefault(c.category, []).append(c)


def summary() -> str:
    lines = [f"Total cases: {len(CASES)}"]
    for cat, cs in CASES_BY_CATEGORY.items():
        lines.append(f"  {cat}: {len(cs)}")
    return "\n".join(lines)


if __name__ == "__main__":
    print(summary())
