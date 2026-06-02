"""Eval runner — assert that the unified agent does the right thing on each case.

Two modes:

  - stub mode (default): a deterministic fake LLM returns canned outputs keyed
    by case_id. Used to verify the harness mechanic itself, the AgentContext
    builder, the dispatch glue, and the budget filters. Cheap, fast, runs in
    CI.
  - live mode (--live): calls real Anthropic. Used as the cutover gate before
    the unified agent ships. Slower, costs real money (~50 cases × Sonnet
    pricing per run ≈ pennies).

Usage:
  python -m tests.evals.runner                    # stub mode, all cases
  python -m tests.evals.runner --live             # live mode against real LLM
  python -m tests.evals.runner --category REVIEW  # one category
  python -m tests.evals.runner --case new.vol.offer.broadcast
  python -m tests.evals.runner --verbose          # show passing cases too

This runner does NOT touch Firestore. It constructs an AgentContext from the
case's `World` directly and calls `run_agent(llm=…, context=…, inbound=…)`.
The dispatch layer's deterministic branches (token-match, UNDO,
clarification cap, hotkey routing, budget filters) are simulated in-runner —
this keeps the eval focused on the agent's behavior and the dispatch logic in
isolation, not on Firestore round-trips.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

# Allow running as `python -m tests.evals.runner` from functions/ directory.
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from tests.evals.cases import (  # noqa: E402
    ANY,
    CASES,
    CASES_BY_ID,
    NOW,
    EvalCase,
    ExpectedOutput,
    FakeClaim,
    FakeFarm,
    FakeMessage,
    FakeOffer,
    FakeOpp,
    FakeUser,
    World,
)

UTC = timezone.utc


# ---------------------------------------------------------------------------
# Stub LLM — returns canned outputs per case_id
# ---------------------------------------------------------------------------
# Each entry: case_id → callable that takes (case) and returns a dict matching
# the AgentOutput JSON schema. Built lazily because some agent-module imports
# (which transitively touch Firebase) fail outside a Firebase env.
StubFn = Callable[[EvalCase], dict]
_STUB_REGISTRY: dict[str, StubFn] = {}


def stub_for(case_id: str) -> Callable[[StubFn], StubFn]:
    """Decorator: register a stub output for one case_id."""
    def _wrap(fn: StubFn) -> StubFn:
        _STUB_REGISTRY[case_id] = fn
        return fn
    return _wrap


# ---------------------------------------------------------------------------
# Deterministic stub LLM client (avoids importing app.llm)
# ---------------------------------------------------------------------------
class StubLLM:
    """Mimics LLMClient.chat_json without touching a real provider.

    For each call, peeks at the user-message MODE header and the case_id we
    threaded in via a synthetic CASE_ID line, looks up a stub, and returns
    the canned output. Validates against the response_model so we still catch
    schema mistakes in the stubs themselves.
    """

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def chat_json(self, *, model_tier, messages, response_model, **_kwargs):
        # Find CASE_ID and MODE in the user message.
        user_msg = next((m.content for m in messages if m.role == "user"), "")
        case_id_match = re.search(r"CASE_ID:\s*(\S+)", user_msg)
        case_id = case_id_match.group(1) if case_id_match else None
        mode_match = re.search(r"MODE:\s*(\S+)", user_msg)
        mode = mode_match.group(1) if mode_match else "inbound"
        self.calls.append({"case_id": case_id, "mode": mode})

        if case_id is None or case_id not in _STUB_REGISTRY:
            raise RuntimeError(f"no stub registered for case_id={case_id!r}")
        case = CASES_BY_ID[case_id]
        raw = _STUB_REGISTRY[case_id](case)
        return response_model.model_validate(raw)


# ---------------------------------------------------------------------------
# Pre-agent dispatch simulation (mirrors the rewritten _dispatch entry steps)
# ---------------------------------------------------------------------------
@dataclass
class DispatchResult:
    """What the runner observed after simulating dispatch + agent."""

    agent_was_called: bool = False
    mode: str | None = None
    action_name: str | None = None
    payload: dict = field(default_factory=dict)
    confirmation_token: str | None = None
    escalation_urgency: str | None = None
    reply_text: str = ""
    receipt_text: str = ""           # for execute-mode receipts
    review_proposals: list[dict] = field(default_factory=list)
    # Why dispatch routed somewhere without calling the agent (e.g. flagged
    # user, token-match, undo, clarify-cap). Useful for assertion messages.
    dispatch_reason: str = ""


def simulate_dispatch(
    case: EvalCase,
    llm,
    *,
    live: bool = False,
) -> DispatchResult:
    """Run the case through a simplified version of the dispatch pipeline.

    Mirrors the order of the rewritten `_dispatch` (see docs/refactor-unified-agent.md
    §"Dispatch rewrite"). The real Firestore-backed dispatch will use repo
    queries; this runner uses the in-memory `World`.

    Review-mode cases take a different path: they build a `BoardState` from the
    World and call `run_review_agent` once; budget filters run against the
    resulting proposal list and the surviving proposals are surfaced as
    `review_proposals` on the DispatchResult.
    """
    if case.review_trigger:
        return simulate_review_tick(case, llm, live=live)

    world = case.world
    sender = _find_user(world, case.inbound_from_user_id)
    last_outbound = _latest_outbound(world)

    # Step 1: idempotency — irrelevant for the runner (no Firestore).
    # Step 2: sender lookup — handled by case.inbound_from_user_id.
    # Step 3: UNSUBSCRIBED check — none of the cases test this here.

    # Step 6: FLAG-pauses-thread invariant. Dispatch returns silently.
    if sender and sender.id in world.flags_open_for_user_ids:
        return DispatchResult(
            agent_was_called=False,
            dispatch_reason="sender has open FLAG; agent not invoked",
        )

    # Step 5 (hotkey parse) is bypassed in the runner — hotkey cases are
    # exercised in tests/test_hotkeys.py. The runner focuses on the agent.

    # Step 7: PRE-AGENT — if last outbound is PENDING_CONFIRMATION and the
    # inbound matches its token, execute deterministically (no LLM call).
    if (
        last_outbound is not None
        and last_outbound.intent_label == "PENDING_CONFIRMATION"
        and last_outbound.pending_action is not None
        and _matches_pending_token(case.inbound_text, last_outbound.pending_action)
    ):
        pending = last_outbound.pending_action
        return DispatchResult(
            agent_was_called=False,
            mode="execute",
            action_name=pending.get("action"),
            payload=dict(pending.get("payload") or {}),
            dispatch_reason="inbound token-matched the live PENDING_CONFIRMATION",
            receipt_text=_synth_receipt_for(pending, world),
        )

    # Step 8: PRE-AGENT — if last outbound is ACTION_RECEIPT and the inbound
    # is "UNDO" (case-insensitive), reverse.
    if (
        last_outbound is not None
        and last_outbound.intent_label == "ACTION_RECEIPT"
        and last_outbound.executed_action is not None
        and case.inbound_text.strip().upper() in {"UNDO", "UNDO!", "UNDO."}
    ):
        return DispatchResult(
            agent_was_called=False,
            mode="execute",
            action_name="undo_last",
            payload={
                "reverses": last_outbound.executed_action.get("action"),
            },
            dispatch_reason="inbound UNDO after ACTION_RECEIPT",
        )

    # Compute the current clarification streak. The cap itself fires AFTER
    # the agent runs (only when the agent's output is also clarify) so the
    # inbound that *answers* the cap-hitting clarify isn't blocked. See
    # app/flows/message_dispatch.py — _enforce_clarify_caps.
    clarify_streak = _consecutive_clarify_count(world, sender)
    cap = 2  # mirrors Settings.clarify_round_max default

    # Build context for the agent call.
    from app.agent.unified import run_agent
    from app.llm.client import LLMProviderError
    if live:
        # Live mode: build a faithful AgentContext from the World so the agent
        # has the grounding it needs (open claims, opps, last outbound, etc.).
        context = _build_context_from_world(world, sender, last_outbound)
        inbound = case.inbound_text
    else:
        # Stub mode: minimal context — the stub LLM ignores the body and
        # dispatches on CASE_ID alone, threaded into the inbound text.
        from app.agent.unified import AgentContext
        context = AgentContext(
            now_local_iso=datetime.now(UTC).isoformat(),
            sender_role=(sender.role if sender else "volunteer"),
            sender_name=(sender.name if sender else ""),
            sender_availability={},
            sender_activity_preferences=(sender.activity_preferences if sender else []),
            sender_mute_summary=[],
            sender_open_claims=[],
            canonical_activities=[
                "harvest", "gleaning", "weeding", "planting", "transplanting",
                "livestock", "infrastructure", "processing",
            ],
        )
        inbound = f"CASE_ID: {case.id}\n{case.inbound_text}"
    try:
        output = run_agent(llm=llm, context=context, inbound_text=inbound)
    except LLMProviderError as e:
        # Live-mode failures (non-JSON output, schema violations) surface as
        # case failures, not crashes.
        return DispatchResult(
            agent_was_called=True,
            dispatch_reason=f"LLMProviderError: {str(e)[:300]}",
        )
    except Exception as e:
        # Network errors, API quota exhaustion, etc. — surface as case failure
        # so the suite keeps running and the rest of the picture is visible.
        return DispatchResult(
            agent_was_called=True,
            dispatch_reason=f"{type(e).__name__}: {str(e)[:300]}",
        )

    # Apply the production over-confirm backstop so the eval reflects what the
    # user actually sees, not the raw agent output. See _route_agent_output in
    # app/flows/message_dispatch.py for the production version.
    from app.flows.message_dispatch import (
        _agent_overconfirm_reason,
        _strip_window_if_disabled,
    )
    if output.mode == "confirm":
        # Mirror production: strip window_end_at when window posts are deferred
        # (pilot default) BEFORE the backstop / payload extraction run.
        _strip_window_if_disabled(output)
        reject = _agent_overconfirm_reason(
            output=output,
            inbound_text=case.inbound_text,
            last_outbound=last_outbound,
            known_farm_names=tuple(f.name for f in world.farms),
            recent_inbound_texts=tuple(
                m.body for m in world.messages if m.direction == "inbound"
            ),
        )
        if reject is not None:
            # The backstop downgrades to clarify; apply the cap on that path too.
            if clarify_streak >= cap:
                return DispatchResult(
                    agent_was_called=True,
                    mode="escalate",
                    escalation_urgency="routine",
                    dispatch_reason=f"backstop -> clarify, but cap ({cap}) hit: {reject}",
                )
            return DispatchResult(
                agent_was_called=True,
                mode="clarify",
                reply_text="[downgraded by over-confirm backstop]",
                dispatch_reason=f"backstop: {reject}",
            )

    # Apply the production clarify-copy guard before assertions/caps so live
    # eval reflects the SMS the user would actually see.
    if output.mode == "clarify":
        from app.flows.message_dispatch import _infer_clarify_axis, _sanitize_clarify_reply
        output.reply_text = _sanitize_clarify_reply(
            body=output.reply_text,
            sender=_repo_user_from_fake(sender),
            axis=_infer_clarify_axis(output.reply_text),
        )

    # Post-agent clarify cap. Fires only when the agent SAW the user's reply
    # and STILL chose clarify — that's when further asking won't help.
    if output.mode == "clarify" and clarify_streak >= cap:
        return DispatchResult(
            agent_was_called=True,
            mode="escalate",
            escalation_urgency="routine",
            dispatch_reason=f"clarify cap ({cap}) hit on agent's new clarify",
        )

    # The confirmation token is derived deterministically from the action in
    # production (message_dispatch._token_for_action), NOT taken from the model.
    # Mirror that here so the eval reflects the token the user actually sees.
    if output.mode == "confirm" and output.action is not None:
        from app.flows.message_dispatch import _token_for_action
        dispatched_token = _token_for_action(output.action.name)
    else:
        dispatched_token = output.confirmation_token

    return DispatchResult(
        agent_was_called=True,
        mode=output.mode,
        action_name=(output.action.name if output.action else None),
        payload=_extract_payload(output),
        confirmation_token=dispatched_token,
        escalation_urgency=(output.escalation.urgency if output.escalation else None),
        reply_text=output.reply_text,
    )


# ---------------------------------------------------------------------------
# Review-tick simulator
# ---------------------------------------------------------------------------
def simulate_review_tick(
    case: EvalCase, llm, *, live: bool,
) -> DispatchResult:
    """Run a review-mode eval case through a simplified version of the review
    tick + dispatch budget filters.

    Steps:
      1. Build BoardState from World.
      2. Call run_review_agent (stub or live).
      3. Apply the same budget filters dispatch's review-tick handler does:
         - per-user 48h budget (drop if `last_agent_initiated_outbound_at`
           is within the budget window)
         - active PAUSE mute on the targeted user (drop)
         - per-opp lifetime cap of 2 agent_nudges_sent (downgrade user-targeted
           proposals to admin)
         - per-tick global ceiling of 3 user-targeted sends (downgrade overflow
           to admin)
      4. Return surviving proposals on the DispatchResult so the assertion
         engine can pin the proposal-count window.
    """
    from datetime import timedelta as _td

    world = case.world
    # Per-tick send budget — mirrors Settings.agent_review_per_tick_max default.
    PER_TICK_SEND_BUDGET = 3
    AGENT_NUDGE_BUDGET_HOURS = 48
    AGENT_NUDGE_PER_OPP_MAX = 2

    if live:
        board = _build_board_from_world(world)
        from app.agent.unified import run_review_agent
        from app.llm.client import LLMProviderError
        try:
            review_output = run_review_agent(llm=llm, board=board)
            proposals = [p.model_dump(exclude_none=False) for p in review_output.proposals]
        except (LLMProviderError, Exception) as e:
            return DispatchResult(
                agent_was_called=True,
                dispatch_reason=f"review LLMError: {type(e).__name__}: {str(e)[:200]}",
            )
    else:
        # Stub mode: call StubLLM's review path; canned proposals per case_id.
        proposals = _stub_review_proposals(case)

    # Index helpers.
    user_by_id = {u.id: u for u in world.users}
    opp_by_id = {o.id: o for o in world.opps}

    surviving: list[dict] = []
    sent_count = 0
    # Process in priority order: high > medium > low.
    prio_order = {"high": 0, "medium": 1, "low": 2}
    for prop in sorted(proposals, key=lambda p: prio_order.get(p.get("priority", "low"), 99)):
        target = prop.get("target")
        if target == "admin":
            surviving.append(prop)
            continue
        if target != "user":
            continue
        target_user_id = prop.get("target_user_id")
        target_opp_id = prop.get("target_opp_id")
        user = user_by_id.get(target_user_id) if target_user_id else None
        # PAUSE-mute drops.
        if user is not None and ("agent_nudge", "all") in user.mute_dimensions:
            continue
        # 48h budget drops.
        if (
            user is not None
            and user.last_agent_initiated_outbound_at is not None
        ):
            window = _td(hours=AGENT_NUDGE_BUDGET_HOURS)
            if NOW - user.last_agent_initiated_outbound_at <= window:
                continue
        # Per-opp lifetime cap downgrade.
        opp = opp_by_id.get(target_opp_id) if target_opp_id else None
        if opp is not None and opp.agent_nudges_sent >= AGENT_NUDGE_PER_OPP_MAX:
            # Downgrade to admin flag rather than drop, so the admin sees the
            # signal.
            surviving.append({**prop, "target": "admin"})
            continue
        # Per-tick global ceiling.
        if sent_count >= PER_TICK_SEND_BUDGET:
            surviving.append({**prop, "target": "admin"})
            continue
        surviving.append(prop)
        sent_count += 1

    return DispatchResult(
        agent_was_called=True,
        mode="review",
        review_proposals=surviving,
        dispatch_reason=f"review tick: {len(proposals)} proposed, {len(surviving)} surviving",
    )


def _build_board_from_world(world: World):
    """Construct a BoardState from a case's World. Open opps + open offers +
    upcoming confirmations + stalled threads."""
    from app.agent.unified import (
        BoardState, ClaimSummary, OfferSummary, OppSummary,
    )
    farms_by_id = {f.id: f for f in world.farms}
    users_by_id = {u.id: u for u in world.users}

    open_opps: list[OppSummary] = []
    for opp in world.opps:
        if opp.status not in ("open", "filling"):
            continue
        farm = farms_by_id.get(opp.farm_id)
        open_opps.append(OppSummary(**_opp_to_summary_dict(opp, farm)))

    open_offers: list[OfferSummary] = []
    for off in world.offers:
        if off.status != "open":
            continue
        vol = users_by_id.get(off.volunteer_user_id)
        offer_detail = (getattr(off, "activity_detail", "") or "").strip() or (
            ", ".join(off.activity_tags) if off.activity_tags else ""
        )
        open_offers.append(OfferSummary(
            offer_id=off.id,
            volunteer_name=vol.name if vol else "unknown",
            activity_detail=offer_detail,
            when_human=_format_offer_when(off),
            age_days=max(0, (NOW - off.created_at).days),
        ))

    # Upcoming confirmations: confirmed claims with confirmation_sent_at in
    # the last 24h. Tests don't currently populate these but we keep the
    # structure honest.
    upcoming: list[ClaimSummary] = []

    return BoardState(
        now_local_iso=NOW.replace(tzinfo=None).isoformat(),
        open_opps=open_opps,
        open_offers=open_offers,
        upcoming_confirmations=upcoming,
        stalled_threads=[],
        per_tick_send_budget=3,
        canonical_activities=[
            "harvest", "gleaning", "weeding", "planting", "transplanting",
            "livestock", "infrastructure", "processing",
        ],
    )


def _format_offer_when(off: FakeOffer) -> str:
    if off.earliest_at and off.latest_at:
        return f"{off.earliest_at.strftime('%a %-m/%-d')} - {off.latest_at.strftime('%a %-m/%-d')}"
    if off.latest_at:
        return f"by {off.latest_at.strftime('%a %-m/%-d')}"
    return "open"


def _stub_review_proposals(case: EvalCase) -> list[dict]:
    """Canned review proposals per case_id. Keys mirror ReviewProposal fields."""
    return _REVIEW_STUB_REGISTRY.get(case.id, [])


_REVIEW_STUB_REGISTRY: dict[str, list[dict]] = {}


def review_stub(case_id: str):
    """Decorator to register canned review proposals for a case_id."""
    def _wrap(fn):
        _REVIEW_STUB_REGISTRY[case_id] = fn()
        return fn
    return _wrap


# Canned review proposals for the 8 REVIEW cases.

@review_stub("review.empty.no_actionable_state")
def _():
    return []  # nothing to do


@review_stub("review.underfilled_shift_t_minus_24h")
def _():
    return [{
        "priority": "high", "target": "user",
        "target_user_id": "u_farmer_a", "target_opp_id": "o_fri_harvest",
        "reason": "underfilled shift T-24h",
        "action": None, "confirmation_token": None,
        "reply_text": "Farm Friend Vashon: Friday harvest at 1/3, T-24h.",
    }]


@review_stub("review.aging_offer_no_match")
def _():
    return [{
        "priority": "low", "target": "admin",
        "target_user_id": None, "target_opp_id": None,
        "reason": "aging offer with no match",
        "action": None, "confirmation_token": None, "reply_text": "",
    }]


@review_stub("review.budget_blocks_user_proposal")
def _():
    # Agent proposes nudging the farmer; budget filter (last_agent_initiated_outbound_at
    # within 48h) drops this proposal entirely.
    return [{
        "priority": "high", "target": "user",
        "target_user_id": "u_farmer_a", "target_opp_id": "o_fri_harvest",
        "reason": "underfilled shift T-24h",
        "action": None, "confirmation_token": None,
        "reply_text": "Farm Friend Vashon: Friday harvest at 1/3.",
    }]


@review_stub("review.per_opp_cap_at_max")
def _():
    return [{
        "priority": "high", "target": "user",
        "target_user_id": "u_farmer_a", "target_opp_id": "o_fri_harvest",
        "reason": "underfilled but opp at lifetime cap",
        "action": None, "confirmation_token": None, "reply_text": "...",
    }]


@review_stub("review.pause_mute_drops_user_proposal")
def _():
    return [{
        "priority": "medium", "target": "user",
        "target_user_id": "u_vol_a", "target_opp_id": "o_fri_harvest",
        "reason": "offer matches an open opp",
        "action": None, "confirmation_token": None, "reply_text": "...",
    }]


@review_stub("review.per_tick_global_ceiling")
def _():
    # 5 user-targeted proposals; top 3 send, bottom 2 downgrade to admin.
    return [
        {"priority": "high", "target": "user", "target_user_id": "u_farmer_a", "target_opp_id": "o1",
         "reason": "1", "action": None, "confirmation_token": None, "reply_text": "x"},
        {"priority": "high", "target": "user", "target_user_id": "u_farmer_b", "target_opp_id": "o2",
         "reason": "2", "action": None, "confirmation_token": None, "reply_text": "x"},
        {"priority": "high", "target": "user", "target_user_id": "u_vol_a", "target_opp_id": "o3",
         "reason": "3", "action": None, "confirmation_token": None, "reply_text": "x"},
        {"priority": "medium", "target": "user", "target_user_id": "u_vol_b", "target_opp_id": "o1",
         "reason": "4", "action": None, "confirmation_token": None, "reply_text": "x"},
        {"priority": "medium", "target": "user", "target_user_id": "u_vol_a", "target_opp_id": "o2",
         "reason": "5", "action": None, "confirmation_token": None, "reply_text": "x"},
    ]


@review_stub("review.failed_send_does_not_increment_counter")
def _():
    return [{
        "priority": "high", "target": "user",
        "target_user_id": "u_farmer_a", "target_opp_id": "o_fri_harvest",
        "reason": "underfilled shift T-24h",
        "action": None, "confirmation_token": None, "reply_text": "...",
    }]


# ---------------------------------------------------------------------------
# Assertion engine
# ---------------------------------------------------------------------------
@dataclass
class CaseResult:
    case_id: str
    passed: bool
    failures: list[str] = field(default_factory=list)
    dispatch_reason: str = ""
    _agent_repr: str = ""


def assert_expected(case: EvalCase, result: DispatchResult) -> CaseResult:
    """Compare DispatchResult against the case's ExpectedOutput."""
    exp = case.expected
    failures: list[str] = []

    # Special case: the FLAG-silences-thread regression case. Dispatch must NOT
    # call the agent. The case's `expected.mode == "reply"` is a placeholder —
    # what we actually check is that no agent invocation happened.
    if case.id == "reg.flag.silent_when_flagged":
        if result.agent_was_called:
            failures.append("agent was invoked despite open FLAG on sender")
        return CaseResult(case.id, passed=not failures, failures=failures,
                          dispatch_reason=result.dispatch_reason)

    # Mode check. ADVERSARIAL cases get "behavioral match" — `reply` and
    # `clarify` are both safe non-state-changing responses, so we treat them
    # as interchangeable when the spec asks for either. REGRESSION and
    # NEW_INTENT remain exact-match.
    if exp.mode != result.mode:
        safe_pair = {"reply", "clarify"}
        if (
            case.category == "ADVERSARIAL"
            and exp.mode in safe_pair
            and result.mode in safe_pair
        ):
            pass  # behavioral match
        else:
            failures.append(f"mode: expected {exp.mode!r}, got {result.mode!r}")

    if exp.action_name and exp.action_name != result.action_name:
        failures.append(
            f"action.name: expected {exp.action_name!r}, got {result.action_name!r}"
        )

    for key, expected_val in (exp.payload_must_include or {}).items():
        if key not in result.payload:
            failures.append(f"payload missing key {key!r}")
            continue
        if expected_val is ANY:
            continue
        if result.payload[key] != expected_val:
            failures.append(
                f"payload[{key!r}]: expected {expected_val!r}, "
                f"got {result.payload[key]!r}"
            )

    if exp.escalation_urgency and exp.escalation_urgency != result.escalation_urgency:
        failures.append(
            f"escalation_urgency: expected {exp.escalation_urgency!r}, "
            f"got {result.escalation_urgency!r}"
        )

    # Token regex + reserved-words check (only when the agent chose to confirm).
    if result.mode == "confirm":
        tok = result.confirmation_token or ""
        if not re.match(exp.token_regex, tok):
            failures.append(
                f"confirmation_token {tok!r} does not match {exp.token_regex!r}"
            )
        if tok in exp.token_must_not_equal:
            failures.append(f"confirmation_token {tok!r} collides with a reserved hotkey")

    # Receipt phrase check on execute mode.
    if result.mode == "execute":
        for phrase in exp.receipt_must_include_phrase:
            if phrase not in result.receipt_text:
                failures.append(
                    f"receipt missing required phrase: {phrase!r} "
                    f"(receipt={result.receipt_text!r})"
                )

    for phrase in exp.reply_must_include_phrase:
        if phrase.lower() not in result.reply_text.lower():
            failures.append(
                f"reply_text missing required phrase: {phrase!r} "
                f"(reply={result.reply_text!r})"
            )

    for phrase in exp.reply_must_not_include_phrase:
        if phrase.lower() in result.reply_text.lower():
            failures.append(
                f"reply_text included forbidden phrase: {phrase!r} "
                f"(reply={result.reply_text!r})"
            )

    # Review-mode proposal count bounds.
    if exp.mode == "review":
        n = len(result.review_proposals)
        if exp.review_min_proposals is not None and n < exp.review_min_proposals:
            failures.append(
                f"review proposals: expected >= {exp.review_min_proposals}, got {n}"
            )
        if exp.review_max_proposals is not None and n > exp.review_max_proposals:
            failures.append(
                f"review proposals: expected <= {exp.review_max_proposals}, got {n}"
            )

    return CaseResult(case.id, passed=not failures, failures=failures,
                      dispatch_reason=result.dispatch_reason)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _find_user(world: World, user_id: str | None) -> FakeUser | None:
    if not user_id:
        return None
    for u in world.users:
        if u.id == user_id:
            return u
    return None


def _repo_user_from_fake(user: FakeUser | None):
    from app.repos.models import UserDoc, UserRole, UserStatus

    return UserDoc(
        id=user.id if user else "",
        phone=user.phone if user else "",
        name=user.name if user else "",
        role=UserRole(user.role) if user else UserRole.VOLUNTEER,
        status=UserStatus.ACTIVE,
        created_at=NOW,
    )


def _latest_outbound(world: World) -> FakeMessage | None:
    outbounds = [m for m in world.messages if m.direction == "outbound"]
    return outbounds[-1] if outbounds else None


def _matches_pending_token(body: str, pending: dict) -> bool:
    norm = body.strip().upper().rstrip("!.?")
    if norm == (pending.get("token") or "").upper():
        return True
    return norm in {"YES", "OK", "OKAY", "SURE", "CONFIRM", "GO AHEAD", "GO", "YEP", "YEAH"}


def _consecutive_clarify_count(world: World, sender: FakeUser | None) -> int:
    """How many CLARIFY outbounds in a row, ending at the most recent outbound."""
    if sender is None:
        return 0
    streak = 0
    for m in reversed(world.messages):
        if m.direction != "outbound" or m.user_id != sender.id:
            continue
        if m.intent_label == "CLARIFY":
            streak += 1
        else:
            break
    return streak


def _extract_payload(output) -> dict:
    """Pull the populated payload sub-model into a flat dict for assertions.

    For actions that wrap a nested ParsedOpportunity (create_opportunity,
    update_draft_opportunity), the inner fields are lifted to the top level
    so eval cases can assert `kind`, `headcount_needed`, etc. directly. For
    edit_opportunity, the `field_updates` dict is also lifted so cases can
    assert `starts_at` etc. directly. The unwrapped keys win on collision.
    """
    if output.action is None:
        return {}
    payload_obj = getattr(output.action, output.action.name, None)
    if payload_obj is None:
        return {}
    raw = payload_obj.model_dump(exclude_none=False) if hasattr(payload_obj, "model_dump") else dict(payload_obj)
    out = dict(raw)
    # Mirror production: record_offer normalizes vague-openness activity_detail
    # to empty (app.flows.message_dispatch._normalize_offer_activity_detail), so
    # eval results reflect what actually gets stored.
    if output.action.name == "record_offer" and "activity_detail" in out:
        from app.flows.message_dispatch import _normalize_offer_activity_detail
        out["activity_detail"] = _normalize_offer_activity_detail(out.get("activity_detail") or "")
    # Lift nested ParsedOpportunity fields.
    if isinstance(raw.get("parsed"), dict):
        for k, v in raw["parsed"].items():
            out.setdefault(k, v)
    # Lift edit field_updates.
    if isinstance(raw.get("field_updates"), dict):
        for k, v in raw["field_updates"].items():
            out.setdefault(k, v)
    return out


# ---------------------------------------------------------------------------
# Live-mode helpers: real Anthropic LLMClient + faithful AgentContext build
# ---------------------------------------------------------------------------
_LIVE_LLM_CACHE: list = []  # one-element cache so we reuse the client across cases


def _get_live_llm():
    """Return a real LLMClient. Provider chosen by LLM_PROVIDER env var
    (default: olmo through an OpenAI-compatible endpoint). Cached across cases.

    For olmo/openai-compatible: needs LLM_BASE_URL + LLM_MODEL/LLM_MODEL_STRONG;
    LLM_API_KEY is optional for local endpoints and required for hosted endpoints.
    For anthropic: needs ANTHROPIC_API_KEY.
    """
    if _LIVE_LLM_CACHE:
        return _LIVE_LLM_CACHE[0]

    provider = os.environ.get("LLM_PROVIDER", "mistral-deepinfra").strip()

    # Build Settings directly — avoids load_settings() touching
    # firebase_functions.params at import time outside a function.
    from app.config import Settings
    from app.llm.client import LLMClient

    if provider == "anthropic":
        api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError(
                "ANTHROPIC_API_KEY env var is required for --live mode with "
                "LLM_PROVIDER=anthropic. Try: "
                "ANTHROPIC_API_KEY=$(firebase functions:secrets:access ANTHROPIC_API_KEY) "
                "python -m tests.evals.runner --live"
            )
        from app.llm.anthropic_adapter import AnthropicAdapter
        settings = _eval_settings(
            llm_provider="anthropic",
            llm_model_strong=os.environ.get("LLM_MODEL_STRONG", "claude-sonnet-4-6"),
            llm_model_fast=os.environ.get("LLM_MODEL_FAST", "claude-haiku-4-5-20251001"),
            llm_base_url="",
            llm_api_key="",
            anthropic_api_key=api_key,
        )
        adapter = AnthropicAdapter(api_key=api_key)
    else:
        # olmo/openai-compatible/mistral-deepinfra (OpenAI wire protocol).
        api_key = os.environ.get("LLM_API_KEY", "no-key").strip() or "no-key"
        deepinfra_url = "https://api.deepinfra.com/v1/openai"
        if provider in ("openai-compatible", "mistral-deepinfra"):
            default_base_url = deepinfra_url
        else:
            default_base_url = "http://localhost:8000/v1"
        base_url = os.environ.get("LLM_BASE_URL", default_base_url).strip()
        from app.llm.openai_compat_adapter import OpenAICompatibleAdapter
        if provider == "mistral-deepinfra":
            default_model = "mistralai/Mistral-Small-3.2-24B-Instruct-2506"
        elif provider == "openai-compatible":
            default_model = "meta-llama/Llama-3.3-70B-Instruct"
        else:
            default_model = "allenai/Olmo-3.1-32B-Instruct"
        # No separate lightweight tier for the Mistral/Llama trials — one model
        # serves both; OLMo self-host keeps its 7B classifier default.
        default_fast_model = (
            default_model
            if provider in ("openai-compatible", "mistral-deepinfra")
            else "allenai/Olmo-3-7B-Instruct"
        )
        coordinator_model = os.environ.get("LLM_MODEL", default_model)
        classifier_model = os.environ.get("LLM_CLASSIFIER_MODEL", default_fast_model)
        model = os.environ.get("LLM_MODEL_STRONG", coordinator_model)
        fast_model = os.environ.get("LLM_MODEL_FAST", classifier_model)
        settings = _eval_settings(
            llm_provider=provider,
            llm_model_strong=model,
            llm_model_fast=fast_model,
            llm_base_url=base_url,
            llm_api_key=api_key,
            anthropic_api_key="",
        )
        adapter = OpenAICompatibleAdapter(
            api_key=api_key,
            base_url=base_url,
            timeout_ms=int(os.environ.get("LLM_TIMEOUT_MS", "20000")),
            temperature=float(os.environ.get("LLM_TEMPERATURE", "0.1")),
        )

    client = LLMClient(adapter, settings)
    _LIVE_LLM_CACHE.append(client)
    return client


def _eval_settings(
    *,
    llm_provider: str,
    llm_model_strong: str,
    llm_model_fast: str,
    llm_base_url: str,
    llm_api_key: str,
    anthropic_api_key: str,
):
    """Minimal Settings for the eval runner. Defaults match production where
    they matter (agent budgets) and are zeroed where they don't."""
    from app.config import Settings
    return Settings(
        llm_provider=llm_provider,
        llm_model_fast=llm_model_fast,
        llm_model_strong=llm_model_strong,
        llm_base_url=llm_base_url,
        llm_api_key=llm_api_key,
        llm_timeout_ms=int(os.environ.get("LLM_TIMEOUT_MS", "20000")),
        llm_temperature=float(os.environ.get("LLM_TEMPERATURE", "0.1")),
        anthropic_api_key=anthropic_api_key,
        telnyx_api_key="",
        telnyx_public_key="",
        telnyx_from_number="",
        vcard_url="",
        coordinator_phone="",
        agent_review_interval_min=30,
        agent_nudge_budget_hours=48,
        agent_nudge_per_opp_max=2,
        agent_review_per_tick_max=3,
        agent_review_admin_only=os.environ.get(
            "AGENT_REVIEW_ADMIN_ONLY", "0"
        ).lower() in {"1", "true", "yes"},
        # Eval honors the env flags; defaults now match production (features ON).
        agent_window_posts_enabled=os.environ.get(
            "AGENT_WINDOW_POSTS_ENABLED", "1"
        ).lower() not in {"0", "false", "no"},
        day_voting_enabled=os.environ.get(
            "DAY_VOTING_ENABLED", "1"
        ).lower() not in {"0", "false", "no"},
        clarify_round_max=2,
        clarify_user_24h_max=5,
        offer_default_ttl_days=7,
        proposal_auto_confirm_far_min=240,
        proposal_auto_confirm_close_min=60,
    )


def _when_human(opp: FakeOpp) -> str:
    """Render an opp's time as a human phrase the agent can read.

    The case fixtures use deltas like `NOW + timedelta(days=2, hours=12)` with
    comments labeling the result "Friday 9am Vashon" — that is, the authors
    treat the stored datetimes as already representing Vashon-local clock time.
    We honor that intent here by formatting the naive (tz-stripped) datetime
    directly rather than running a UTC→PDT conversion that would shift hours.
    """
    if opp.kind == "shift" and opp.starts_at:
        local = opp.starts_at.replace(tzinfo=None)
        day_name = local.strftime("%A")
        date_str = local.strftime("%b %-d")
        start_str = local.strftime("%-I%p").lower()
        if opp.duration_min:
            end = local + timedelta(minutes=opp.duration_min)
            end_str = end.strftime("%-I%p").lower()
            return f"{day_name} {date_str} {start_str}-{end_str}"
        return f"{day_name} {date_str} {start_str}"
    if opp.kind == "pickup" and opp.deadline_at:
        local = opp.deadline_at.replace(tzinfo=None)
        day_name = local.strftime("%A")
        return f"{day_name} pickup by {local.strftime('%-I%p').lower()}"
    return "soon"


def _fake_activity_display(opp: FakeOpp) -> str:
    """Display activity for a fixture opp — prefer free-text activity_detail,
    fall back to legacy activity_tags so old fixtures still render."""
    if (getattr(opp, "activity_detail", "") or "").strip():
        return opp.activity_detail.strip()
    if opp.activity_tags:
        return ", ".join(opp.activity_tags)
    return "shift"


def _opp_to_summary_dict(opp: FakeOpp, farm: FakeFarm | None) -> dict:
    """Build the OppSummary-shaped dict the agent expects in CONTEXT."""
    if opp.kind == "shift":
        activity_or_produce = _fake_activity_display(opp)
    else:
        activity_or_produce = opp.produce_description or "surplus"
    return {
        "opp_id": opp.id,
        "farm_name": farm.name if farm else "unknown farm",
        "kind": opp.kind,
        "status": opp.status,
        "when_human": _when_human(opp),
        "activity_or_produce": activity_or_produce,
        "headcount_needed": opp.headcount_needed,
        "seats_filled": opp.seats_filled,
        "requirements_text": opp.requirements_text or "",
    }


def _build_context_from_world(world: World, sender: FakeUser | None, last_outbound: FakeMessage | None):
    """Construct a real AgentContext from a case's World. Lifts FakeOpp/Claim
    into the OppSummary/ClaimSummary shapes the agent prompt is written against.
    """
    from app.agent.unified import (
        AgentContext,
        ClaimSummary,
        MessageExcerpt,
        OppSummary,
    )

    farms_by_id = {f.id: f for f in world.farms}
    opps_by_id = {o.id: o for o in world.opps}

    sender_role = sender.role if sender else "volunteer"
    sender_id = sender.id if sender else ""

    # Sender's open claims (volunteer side).
    sender_claims: list[ClaimSummary] = []
    if sender_id:
        for claim in world.claims:
            if claim.volunteer_user_id != sender_id:
                continue
            if claim.status == "dropped":
                continue
            opp = opps_by_id.get(claim.opp_id)
            if opp is None:
                continue
            if opp.status in ("completed", "cancelled", "expired"):
                continue
            farm = farms_by_id.get(opp.farm_id)
            sender_claims.append(ClaimSummary(
                opp_id=opp.id,
                opp_kind=opp.kind,
                farm_name=farm.name if farm else "unknown farm",
                activity_or_produce=(
                    _fake_activity_display(opp) if opp.kind == "shift"
                    else (opp.produce_description or "surplus")
                ),
                when_human=_when_human(opp),
                status=claim.status,
            ))

    # Farmer side: own farm + its open opps.
    sender_farm_id = None
    sender_farm_name = None
    sender_farm_defaults = None
    sender_farm_open_opps: list[OppSummary] = []
    if sender and sender.role in ("farmer", "both"):
        own_farm = next((f for f in world.farms if f.owner_user_id == sender_id), None)
        if own_farm is not None:
            sender_farm_id = own_farm.id
            sender_farm_name = own_farm.name
            sender_farm_defaults = {
                "typical_start_hour": own_farm.typical_start_hour,
                "typical_shift_duration_min": own_farm.typical_shift_duration_min,
                "usual_days_of_week": own_farm.usual_days_of_week,
            }
            for opp in world.opps:
                if opp.farm_id != own_farm.id:
                    continue
                if opp.status not in ("open", "filling", "draft"):
                    continue
                sender_farm_open_opps.append(OppSummary(**_opp_to_summary_dict(opp, own_farm)))

    # Cross-cutting opps (all OPEN / FILLING / DRAFT system-wide except the
    # sender's own farm opps which are already separately listed).
    cross_cutting: list[OppSummary] = []
    for opp in world.opps:
        if opp.status not in ("open", "filling", "draft"):
            continue
        if sender_farm_id and opp.farm_id == sender_farm_id:
            continue
        farm = farms_by_id.get(opp.farm_id)
        cross_cutting.append(OppSummary(**_opp_to_summary_dict(opp, farm)))

    # Live pending / executed actions (within configured windows).
    pending_action = None
    executed_action = None
    last_outbound_opp_summary = None
    last_outbound_body = None
    last_outbound_intent = None
    last_outbound_clar_round = 0
    if last_outbound is not None:
        last_outbound_body = last_outbound.body
        last_outbound_intent = last_outbound.intent_label
        if last_outbound.pending_action and last_outbound.intent_label == "PENDING_CONFIRMATION":
            expires_iso = last_outbound.pending_action.get("expires_at")
            alive = True
            if expires_iso:
                try:
                    expires = datetime.fromisoformat(expires_iso)
                    if NOW > expires:
                        alive = False
                except ValueError:
                    pass
            if alive:
                pending_action = last_outbound.pending_action
        if last_outbound.executed_action and last_outbound.intent_label == "ACTION_RECEIPT":
            executed_action = last_outbound.executed_action
        if last_outbound.opportunity_id:
            opp = opps_by_id.get(last_outbound.opportunity_id)
            if opp:
                farm = farms_by_id.get(opp.farm_id)
                last_outbound_opp_summary = OppSummary(**_opp_to_summary_dict(opp, farm))

    # Per-opportunity excerpt for the last-outbound's opp (best-effort).
    opp_excerpt: list[MessageExcerpt] = []
    if last_outbound and last_outbound.opportunity_id:
        for msg in world.messages[-5:]:
            if msg.opportunity_id != last_outbound.opportunity_id:
                continue
            opp_excerpt.append(MessageExcerpt(
                direction=msg.direction,
                body=msg.body,
                intent_label=msg.intent_label,
                created_at_iso=msg.created_at.isoformat(),
            ))

    # Per-user excerpt: last 3 messages to/from sender.
    user_excerpt: list[MessageExcerpt] = []
    if sender_id:
        for msg in [m for m in world.messages if m.user_id == sender_id][-3:]:
            user_excerpt.append(MessageExcerpt(
                direction=msg.direction,
                body=msg.body,
                intent_label=msg.intent_label,
                created_at_iso=msg.created_at.isoformat(),
            ))

    # Mute summary rendered as "dim:value" strings.
    mute_summary: list[str] = []
    if sender:
        for dim, val in sender.mute_dimensions:
            mute_summary.append(f"{dim}:{val}")

    known_farms = [{"id": f.id, "name": f.name} for f in world.farms]

    # Use NOW (the cases' fixed datetime) as now_local_iso. The case fixtures
    # are internally consistent if we treat stored datetimes as already
    # representing Vashon-local clock time (their deltas like `+2d +12h` from
    # NOW=21:00 land at Fri 9am, which is the labeled intent). We strip the
    # UTC tz here so the agent's "now" lines up with the opps' `when_human`
    # values computed the same way in `_when_human`.
    now_local_iso = NOW.replace(tzinfo=None).isoformat()

    return AgentContext(
        now_local_iso=now_local_iso,
        sender_role=sender_role,
        sender_name=(sender.name if sender else ""),
        sender_availability={
            "available_days": sender.available_days if sender else [],
            "available_start_hour": sender.available_start_hour if sender else None,
            "available_end_hour": sender.available_end_hour if sender else None,
            "max_commit_hours_per_week": None,
        },
        sender_activity_preferences=(sender.activity_preferences if sender else []),
        sender_mute_summary=mute_summary,
        sender_open_claims=sender_claims,
        sender_farm_id=sender_farm_id,
        sender_farm_name=sender_farm_name,
        sender_farm_defaults=sender_farm_defaults,
        sender_farm_open_opps=sender_farm_open_opps,
        last_outbound_body=last_outbound_body,
        last_outbound_intent=last_outbound_intent,
        last_outbound_clarification_round=last_outbound_clar_round,
        last_outbound_opp_summary=last_outbound_opp_summary,
        pending_action=pending_action,
        executed_action=executed_action,
        cross_cutting_opps=cross_cutting,
        known_farms=known_farms,
        canonical_activities=[
            "harvest", "gleaning", "weeding", "planting", "transplanting",
            "livestock", "infrastructure", "processing",
        ],
        opp_message_excerpt=opp_excerpt,
        user_recent_excerpt=user_excerpt,
    )


def _synth_receipt_for(pending: dict, world: World) -> str:
    """Best-effort receipt text for the deterministic execute path.

    The runner doesn't render real templates (that's a dispatch concern); we
    just stitch together enough text that the eval's `receipt_must_include_phrase`
    assertions are meaningful. Production dispatch will use templates.
    """
    action = pending.get("action", "")
    payload = pending.get("payload", {}) or {}
    if action == "claim_opportunity":
        opp = next((o for o in world.opps if o.id == payload.get("opp_id")), None)
        farm = next((f for f in world.farms if opp and f.id == opp.farm_id), None)
        farm_name = farm.name if farm else "the farm"
        when = "Friday"  # cases use Friday as the canonical day
        return f"Farm Friend Vashon: confirmed for harvest at {farm_name} {when}. Reply UNDO if wrong."
    return f"Farm Friend Vashon: done. Reply UNDO if wrong."


# ---------------------------------------------------------------------------
# Stubs (one per case) — minimal canned outputs to exercise the harness
# ---------------------------------------------------------------------------
# Conventions used by every stub:
#  - Confirmation tokens are EITHER literal `YES` (the preferred default,
#    which is what most agent outputs should look like) OR a 4-letter word
#    that doesn't collide with a reserved hotkey/affirmative. Stubs mostly
#    use YES; a few use 4-letter words to exercise the alternate path.
#  - reply_text mimics the program-name-prefix + STOP-path style the real
#    agent prompt will require. Eval doesn't check copy; this just makes
#    stubs realistic.

def _confirm(action_name: str, payload: dict, *, token: str, text: str) -> dict:
    return {
        "mode": "confirm",
        "reply_text": text,
        "confirmation_token": token,
        "action": {"name": action_name, action_name: payload},
    }


def _clarify(text: str = "Which one did you mean?") -> dict:
    return {"mode": "clarify", "reply_text": text}


def _reply(text: str) -> dict:
    return {"mode": "reply", "reply_text": text}


def _escalate(urgency: str, reason: str, text: str) -> dict:
    return {
        "mode": "escalate",
        "reply_text": text,
        "escalation": {"reason": reason, "urgency": urgency},
    }


def _execute(action_name: str, payload: dict) -> dict:
    return {
        "mode": "execute",
        "action": {"name": action_name, action_name: payload},
    }


# === REGRESSION stubs ===
@stub_for("reg.claim.free_form_with_opp")
def _(c): return _confirm("claim_opportunity", {"opp_id": "o_fri_harvest", "slots": 1},
                          token="YES", text="Reply YES to grab Friday harvest. STOP to opt out.")

# reg.claim.token_confirms_claim is handled by deterministic dispatch, not the agent.
# No stub needed.

@stub_for("reg.maybe.soft_yes")
def _(c): return _confirm("record_maybe", {"opp_id": "o_fri_harvest"},
                          token="YES",
                          text="Noted as a maybe. Reply YES to keep that note, STOP to opt out.")

@stub_for("reg.decline.busy")
def _(c): return _reply("Got it, thanks for letting us know. Reply STOP to opt out.")

@stub_for("reg.farmer.post.shift_well_formed")
def _(c): return _confirm(
    "create_opportunity",
    {"parsed": {
        "kind": "shift",
        "starts_at": "2026-06-05T16:00:00+00:00",
        "duration_min": 180,
        "headcount_needed": 3,
        "activity_detail": "Harvest",
        "missing_fields": [],
    }},
    token="YES",
    text="Confirm posting: 3 ppl for harvest Friday 9am-12. Reply YES to publish, STOP to opt out.",
)

@stub_for("reg.farmer.post.missing_time")
def _(c): return _clarify("What time would you like to start, and how long?")

@stub_for("reg.farmer.post.crop_name_no_activity")
def _(c): return _clarify(
    "What kind of work — harvest, weeding, transplanting, or something else?"
)

@stub_for("reg.farmer.post.clarify_no_detail_readback")
def _(c): return _clarify("What day next week works best?")

@stub_for("reg.farmer.post.tbd_explicit")
def _(c): return _confirm(
    "create_opportunity",
    {"parsed": {
        "kind": "shift",
        "starts_at": "2026-06-08T16:00:00+00:00",
        "duration_min": 180,
        "headcount_needed": 2,
        "activity_detail": "General farm work (TBD)",
        "missing_fields": [],
    }},
    token="YES",
    text="Post 2 volunteers Monday 9am-12, work-type TBD (you'll decide on the day)? Reply YES.",
)

@stub_for("reg.farmer.clarification_completes_draft")
def _(c): return _confirm(
    "update_draft_opportunity",
    {"opp_id": "o_draft", "parsed": {
        "kind": "shift",
        "starts_at": "2026-06-04T16:00:00+00:00",
        "duration_min": 180,
        "headcount_needed": 2,
        "activity_detail": "Weeding",
        "missing_fields": [],
    }},
    token="YES",
    text="Confirm: 2 ppl weeding tomorrow 9am-12. Reply YES to publish.",
)

@stub_for("reg.farmer.edit.time_change")
def _(c): return _confirm(
    "edit_opportunity",
    {"opp_id": "o_fri_harvest", "field_updates": {"starts_at": "2026-06-06T16:00:00+00:00"}},
    token="YES",
    text="Confirm moving Friday harvest to Saturday 9am. Reply YES to update.",
)

@stub_for("reg.farmer.edit.headcount_down_below_filled")
def _(c): return _reply(
    "2 volunteers are already confirmed for that shift — I can't drop it below 2. "
    "Reply with a higher number or use CANCEL to call off the post."
)

@stub_for("reg.farmer.cancel.unique_match")
def _(c): return _confirm(
    "cancel_opportunity",
    {"opp_id": "o_fri_harvest"},
    token="YES",
    text="Confirm cancelling Friday harvest at Three Cedars. Reply YES to cancel.",
)

@stub_for("reg.farmer.cancel.ambiguous_match")
def _(c): return _clarify(
    "Two open Friday posts — the morning harvest or the afternoon gleaning?"
)

@stub_for("reg.farmer.status_hotkey_equivalent")
def _(c): return _reply(
    "Farm Friend Vashon status: Friday harvest 1/3 filled; Thursday carrot pickup unclaimed. "
    "Reply STOP to opt out."
)

# reg.post_event.farmer_ok — last_outbound is POST_EVENT_CHECKIN, the agent
# does see this. Returns execute directly because there's no state to confirm.
@stub_for("reg.post_event.farmer_ok")
def _(c): return _execute("acknowledge_post_event", {"opp_id": "o_done", "answer": "Y"})

@stub_for("reg.escalate.injury_immediate")
def _(c): return _escalate(
    "immediate", "volunteer reports cut hand at Plum Forest, bleeding",
    "Sorry to hear that — please call 911 if it's urgent. The Farm Friend team will reach out shortly."
)

@stub_for("reg.escalate.payment_routine")
def _(c): return _escalate(
    "routine", "volunteer asking about payment for last week",
    "Good question — the Farm Friend team handles anything around payment and will follow up shortly."
)

# reg.flag.silent_when_flagged is dispatch-only; no stub.


# === NEW_INTENT stubs ===
@stub_for("new.vol.offer.broadcast")
def _(c): return _confirm(
    "record_offer",
    {"activity_detail": "Tilling", "earliest_at": None, "latest_at": "2026-06-06T07:00:00+00:00",
     "note": "anyone need help with tilling on Friday"},
    token="YES",
    text="I'll let farms know you can help with tilling Friday. Reply YES to record, STOP to opt out.",
)

@stub_for("new.vol.offer.directed")
def _(c): return _confirm(
    "record_offer",
    {"activity_detail": "", "earliest_at": None, "latest_at": None,
     "note": "wants to help at Plum Forest this week"},
    token="YES",
    text="I'll pass along your offer to Plum Forest. Reply YES to record.",
)

@stub_for("new.vol.offer.matches_existing_opp")
def _(c): return _confirm(
    "record_offer",
    {"activity_detail": "Tilling", "earliest_at": None, "latest_at": "2026-06-07T07:00:00+00:00",
     "note": "wants to help with tilling this weekend"},
    token="YES",
    text="Recording your tilling offer for the weekend. Reply YES to record.",
)

@stub_for("new.vol.offer.flexible_phys_work")
def _(c): return _confirm(
    "record_offer",
    {"activity_detail": "",
     "earliest_at": "2026-06-06T07:00:00-07:00",
     "latest_at": "2026-06-07T12:00:00-07:00",
     "note": "some physical work this weekend, some morning"},
    token="YES",
    text="Recording you as available for any work this weekend morning. Reply YES to confirm, STOP to opt out.",
)

@stub_for("new.vol.offer.vague_crop_only")
def _(c): return _clarify(
    "Happy to help connect you — what kind of work are you up for "
    "(planting, harvest, weeding, etc.), and is there a particular day this week?"
)

@stub_for("new.vol.availability.add_day")
def _(c): return _confirm(
    "set_availability",
    {"available_days": [4, 5, 6], "available_start_hour": 8, "available_end_hour": 14,
     "max_commit_hours_per_week": None},
    token="YES",
    text="Adding Fridays to your availability. Reply YES to confirm.",
)

@stub_for("new.vol.availability.remove_day")
def _(c): return _confirm(
    "set_availability",
    {"available_days": [5, 6], "available_start_hour": None, "available_end_hour": None,
     "max_commit_hours_per_week": None},
    token="YES",
    text="Dropping Tuesdays from your availability. Reply YES to confirm.",
)

@stub_for("new.vol.activity_preference")
def _(c): return _confirm(
    "set_activity_preferences",
    {"add": ["gleaning"], "remove": []},
    token="YES",
    text="Noting your preference for gleaning. Reply YES to confirm.",
)

@stub_for("new.vol.query.whats_open")
def _(c): return _reply(
    "Farm Friend Vashon: open this weekend — Friday harvest at Three Cedars (1/3), "
    "Saturday gleaning at Plum Forest (0/4), and a carrot pickup Thursday. STOP to opt out."
)

@stub_for("new.vol.query.specific_day")
def _(c): return _reply(
    "Farm Friend Vashon: Friday — harvest at Three Cedars 9am-12, 2 spots open. STOP to opt out."
)

@stub_for("new.vol.proactive_cancel.unique")
def _(c): return _confirm(
    "drop_confirmed_claim",
    {"opp_id": "o_fri_harvest"},
    token="YES",
    text="Drop your Friday harvest shift at Three Cedars? Reply YES to confirm.",
)

@stub_for("new.vol.proactive_cancel.ambiguous")
def _(c): return _clarify(
    "You're on Friday harvest at Three Cedars and Saturday gleaning at Plum Forest — which one?"
)

@stub_for("new.farmer.passthrough_request")
def _(c): return _reply(
    "Farm Friend Vashon doesn't pass messages between users in v1, but I can flag this "
    "for the Farm Friend team to handle directly. STOP to opt out."
)

@stub_for("new.farmer.general_question")
def _(c): return _reply(
    "Farm Friend Vashon is an SMS system for coordinating farm help on Vashon. "
    "Text us when you need volunteers and we'll handle outreach. STOP to opt out."
)

# new.undo.recent_action — handled by deterministic dispatch (UNDO hotkey).


# === ADVERSARIAL stubs ===
@stub_for("adv.token.too_long")
def _(c): return _confirm(
    "claim_opportunity", {"opp_id": "o_fri_harvest", "slots": 1},
    token="YES",  # passes the regex; deliberately NOT a too-long stub
    text="Reply YES to grab Friday harvest. STOP to opt out.",
)

@stub_for("adv.token.collides_with_hotkey")
def _(c): return _confirm(
    "claim_opportunity", {"opp_id": "o_fri_harvest", "slots": 1},
    token="YES",  # explicitly allowed (the preferred default), not a collision
    text="Reply YES to grab Friday harvest.",
)

# adv.affirmative_after_pending — deterministic token-match in dispatch.

@stub_for("adv.affirmative_after_clarify_does_nothing")
def _(c): return _clarify("What time would you like to start, and how long?")

@stub_for("adv.context_switch_mid_confirmation")
def _(c): return _reply(
    "Saturday: gleaning at Plum Forest 9am-12, 0/4 filled. Your Friday harvest CLAIM is still pending."
)

# adv.undo_after_delay — deterministic in dispatch (UNDO hotkey).

# adv.clarify_cap.escalates_at_third_round — agent IS now called (so the user's
# reply gets a chance to land); when it emits clarify, dispatch catches the cap
# and escalates instead of sending round-3.
@stub_for("adv.clarify_cap.escalates_at_third_round")
def _(c): return _clarify("Could you tell me which shift?")

# adv.clarify_cap.resets_on_resolution
@stub_for("adv.clarify_cap.resets_on_resolution")
def _(c): return _clarify("Could you tell me a bit more about what you meant?")

@stub_for("adv.clarify_cap.user_resolves_at_round_2")
def _(c): return _confirm(
    "drop_confirmed_claim",
    {"opp_id": "o_fri_harvest"},
    token="YES",
    text="Drop your Friday harvest? Reply YES to confirm.",
)

@stub_for("adv.fabrication.claim_not_held")
def _(c): return _reply(
    "I don't see any confirmed shifts on your account right now. Reply with the farm or day if you meant something else."
)

@stub_for("adv.fabrication.opp_doesnt_exist")
def _(c): return _reply(
    "I don't see anything Tuesday at Sweet Tree in the system. Was that a different farm?"
)

@stub_for("adv.unknown_activity_slug")
def _(c): return _confirm(
    "create_opportunity",
    {"parsed": {
        "kind": "shift",
        "starts_at": "2026-06-06T10:00:00-07:00",
        "duration_min": 120,
        "headcount_needed": 2,
        "activity_detail": "Mushroom Foraging",
        "missing_fields": [],
    }},
    token="YES",
    text="Post 2 ppl for Mushroom Foraging, Saturday 10am-12? Reply YES.",
)

@stub_for("adv.quiet_hours_does_not_block_inbound")
def _(c): return _confirm(
    "claim_opportunity", {"opp_id": "o_fri_harvest", "slots": 1},
    token="YES",
    text="Reply YES to grab Friday harvest.",
)


# === Window opps + MVD (PR 6 Stage 1) stubs ===
@stub_for("new.farmer.candidate_days.any_day_next_week")
def _(c): return _confirm(
    "create_opportunity",
    {"parsed": {
        "kind": "shift",
        "starts_at": "2026-06-08T00:00:00-07:00",
        "candidate_days": [
            "2026-06-08T00:00:00-07:00", "2026-06-09T00:00:00-07:00",
            "2026-06-10T00:00:00-07:00", "2026-06-11T00:00:00-07:00",
            "2026-06-12T00:00:00-07:00",
        ],
        "time_of_day_bucket": "morning",
        "duration_min": None,
        "headcount_needed": 2,
        "activity_detail": "Prep work",
        "missing_fields": [],
    }},
    token="YES",
    text="Post 2 ppl for prep work, vote among next week's mornings? Reply YES.",
)


@stub_for("new.farmer.candidate_days.or_list_with_preference")
def _(c): return _confirm(
    "create_opportunity",
    {"parsed": {
        "kind": "shift",
        "starts_at": "2026-06-07T09:00:00-07:00",
        "candidate_days": [
            "2026-06-07T09:00:00-07:00", "2026-06-08T09:00:00-07:00",
            "2026-06-10T09:00:00-07:00",
        ],
        "preferred_day": "2026-06-08T09:00:00-07:00",
        "headcount_needed": 2,
        "activity_detail": "Tomato Harvest",
        "missing_fields": [],
    }},
    token="YES",
    text="Post 2 ppl for tomato harvest, vote Sun/Mon/Wed (Mon preferred)? Reply YES.",
)


@stub_for("new.farmer.window.mon_to_wed_clock")
def _(c): return _confirm(
    "create_opportunity",
    {"parsed": {
        "kind": "shift",
        "starts_at": "2026-06-08T09:00:00-07:00",
        "window_end_at": "2026-06-10T23:59:00-07:00",
        "duration_min": None,
        "headcount_needed": 2,
        "activity_detail": "Harvest",
        "missing_fields": [],
    }},
    token="YES",
    text="Post 2 ppl for harvest, Mon Jun 8 - Wed Jun 10 at 9am? Reply YES.",
)


@stub_for("new.farmer.window.weekend_mornings")
def _(c): return _confirm(
    "create_opportunity",
    {"parsed": {
        "kind": "shift",
        "starts_at": "2026-06-06T00:00:00-07:00",
        "window_end_at": "2026-06-07T00:00:00-07:00",
        "time_of_day_bucket": "morning",
        "duration_min": None,
        "headcount_needed": 2,
        "activity_detail": "Gleaning",
        "missing_fields": [],
    }},
    token="YES",
    text="Post 2 ppl for gleaning, Sat Jun 6 - Sun Jun 7 morning? Reply YES.",
)


@stub_for("new.farmer.single_day_no_followup_about_weekend")
def _(c): return _confirm(
    "create_opportunity",
    {"parsed": {
        "kind": "shift",
        "starts_at": "2026-06-06T08:00:00-07:00",
        "duration_min": 180,
        "headcount_needed": 3,
        "activity_detail": "Harvest",
        "missing_fields": [],
    }},
    token="YES",
    text="Post 3 ppl for harvest Saturday Jun 6 at 8am? Reply YES.",
)


@stub_for("adv.window.bucket_only_no_clarify_for_clock_time")
def _(c): return _clarify(
    "Morning, afternoon, or evening?"
)


@stub_for("adv.draft_finalize_no_default_time")
def _(c):
    # Emit the BAD output the screenshot showed: a draft-update confirm with a
    # clock-time starts_at filled from the farm default, though no turn gave a
    # time. The stub exercises signal 6 of the over-confirm backstop, which must
    # downgrade this to clarify (so the stub mirrors production, not the ideal).
    return _confirm(
        "update_draft_opportunity",
        {
            "opp_id": "o_draft",
            "parsed": {
                "kind": "shift",
                "starts_at": "2026-06-08T09:00:00-07:00",
                "headcount_needed": 2,
                "activity_detail": "Harvest",
            },
        },
        token="YES",
        text="Post as Sunday for picking surplus tomatoes? Reply YES to confirm.",
    )


@stub_for("new.farmer.draft_finalize_time_given_last_turn")
def _(c):
    # Happy path: the farmer gave the time this turn ("around 10"), so the agent
    # correctly finalizes. Signal 6 must NOT fire (the time was stated), so this
    # confirm survives to the user.
    return _confirm(
        "update_draft_opportunity",
        {
            "opp_id": "o_draft",
            "parsed": {
                "kind": "shift",
                "starts_at": "2026-06-08T10:00:00-07:00",
                "duration_min": 120,
                "headcount_needed": 2,
                "activity_detail": "Harvest",
            },
        },
        token="YES",
        text="Post as Sunday harvest at 10am for 2 hours? Reply YES to confirm.",
    )


@stub_for("adv.window.mvd_vacant_focused_clarify")
def _(c): return _clarify(
    "What day, what kind of work, and how many people?"
)


@stub_for("new.vol.window_claim_with_day_token")
def _(c): return _confirm(
    "claim_opportunity",
    {"opp_id": "o_window_weed", "slots": 1, "days": ["WED"]},
    token="YES",
    text="Propose Wednesday for the Three Cedars weeding window? The farmer will confirm. Reply YES.",
)


@stub_for("new.vol.window_claim_bare_yes_clarifies")
def _(c): return _clarify(
    "Which day works for you? Mon, Tue, Wed, Thu, or Fri?"
)


# === REVIEW stubs ===
# Review-mode cases need a different shape — the runner doesn't simulate the
# full review tick yet (it's a TODO before live evals). For now the stubs
# return empty lists and the harness records that the case is review-pending.
@stub_for("review.empty.no_actionable_state")
def _(c): return _reply("review-pending")  # placeholder

# Other review.* cases not yet stubbed — those land in the live eval pass.


# ---------------------------------------------------------------------------
# Runner main
# ---------------------------------------------------------------------------
# Cases that are deterministic-dispatch-only (no agent call expected). Shared
# between stub and live mode — these are pre-agent dispatch branches that the
# runner must reproduce verbatim (token match, UNDO, FLAG).
#
# Note: the clarify-cap case is NOT in this set anymore. The cap moved to
# AFTER the agent runs so the user's answer to round-2 gets a chance to
# land; the agent is called, sees the still-ambiguous reply, emits clarify
# again, and dispatch then escalates instead of sending round-3.
DETERMINISTIC_ONLY = {
    "reg.claim.token_confirms_claim",            # token match
    "new.undo.recent_action",                     # UNDO hotkey
    "adv.affirmative_after_pending",              # affirmative variant on token
    "adv.undo_after_delay",                       # UNDO after delay
}


def run_one(case: EvalCase, *, live: bool) -> CaseResult:
    if live:
        llm = _get_live_llm()
    else:
        llm = StubLLM()

    result = simulate_dispatch(case, llm, live=live)

    if case.id in DETERMINISTIC_ONLY:
        # The harness should have routed without calling the agent.
        if result.agent_was_called:
            return CaseResult(case.id, passed=False, failures=[
                f"agent was called for a deterministic-dispatch case ({case.id})"
            ])

    case_result = assert_expected(case, result)
    # Surface what the agent produced for failure debugging.
    case_result._agent_repr = (
        f"mode={result.mode} action={result.action_name} "
        f"token={result.confirmation_token} payload={result.payload} "
        f"reply={result.reply_text[:160]!r}"
    )
    return case_result


def run_all(*, live: bool, category: str | None, case_id: str | None,
            verbose: bool) -> int:
    cases_to_run: list[EvalCase] = []
    if case_id:
        if case_id not in CASES_BY_ID:
            print(f"unknown case_id: {case_id}", file=sys.stderr)
            return 2
        cases_to_run = [CASES_BY_ID[case_id]]
    else:
        for c in CASES:
            if category and c.category != category:
                continue
            cases_to_run.append(c)

    passed = 0
    failed: list[CaseResult] = []
    skipped = 0

    # Window posts default ON ("full functionality at small scale"). Cases that
    # ASSERT window_end_at run normally. If the window kill-switch is flipped
    # (AGENT_WINDOW_POSTS_ENABLED=0), skip them so the suite reflects that config
    # without spurious failures.
    windows_on = os.environ.get(
        "AGENT_WINDOW_POSTS_ENABLED", "1"
    ).lower() not in {"0", "false", "no"}
    voting_on = os.environ.get(
        "DAY_VOTING_ENABLED", "1"
    ).lower() not in {"0", "false", "no"}

    for case in cases_to_run:
        must = case.expected.payload_must_include or {}
        if "window_end_at" in must and not windows_on:
            skipped += 1
            if verbose:
                print(f"SKIP {case.id}  (window kill-switch on; set AGENT_WINDOW_POSTS_ENABLED=1)")
            continue
        if "candidate_days" in must and not voting_on:
            skipped += 1
            if verbose:
                print(f"SKIP {case.id}  (day-voting kill-switch on; set DAY_VOTING_ENABLED=1)")
            continue
        result = run_one(case, live=live)
        if result.passed:
            passed += 1
            if verbose:
                print(f"PASS {case.id}  ({result.dispatch_reason or 'agent'})")
        else:
            failed.append(result)
            print(f"FAIL {case.id}")
            for f in result.failures:
                print(f"     {f}")
            if verbose:
                # Show what the agent actually produced.
                ar = getattr(result, "_agent_repr", "")
                if ar:
                    print(f"     agent_output: {ar}")
                if result.dispatch_reason:
                    print(f"     dispatch_reason: {result.dispatch_reason}")

    total = len(cases_to_run) - skipped
    print()
    skip_note = f", {skipped} skipped" if skipped else ""
    print(f"Eval result: {passed}/{total} passed, {len(failed)} failed{skip_note}")
    return 0 if not failed else 1


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--live", action="store_true",
                   help="Call real Anthropic instead of the stub LLM")
    p.add_argument("--category", choices=["REGRESSION", "NEW_INTENT", "ADVERSARIAL", "REVIEW"],
                   help="Run only one category")
    p.add_argument("--case", dest="case_id",
                   help="Run exactly one case by id")
    p.add_argument("--verbose", "-v", action="store_true",
                   help="Also show passing cases")
    args = p.parse_args()
    return run_all(live=args.live, category=args.category,
                   case_id=args.case_id, verbose=args.verbose)


if __name__ == "__main__":
    sys.exit(main())
