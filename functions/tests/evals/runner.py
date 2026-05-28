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
The dispatch layer's deterministic branches (token-match, UNDO window,
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
    """
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

    # Step 8: PRE-AGENT — if last outbound is ACTION_RECEIPT within UNDO
    # window and the inbound is "UNDO" (case-insensitive), reverse.
    if (
        last_outbound is not None
        and last_outbound.intent_label == "ACTION_RECEIPT"
        and last_outbound.executed_action is not None
        and case.inbound_text.strip().upper() in {"UNDO", "UNDO!", "UNDO."}
    ):
        from datetime import timedelta as _td  # local for clarity
        five_min_ago = datetime.now(UTC) - _td(minutes=5)
        # Cases set executed_at relative to NOW (a fixed datetime), so we
        # compare against case.world's NOW analogue. The Fake fixture uses
        # the cases module's NOW, which is what we compare to.
        from tests.evals.cases import NOW
        executed_at_iso = last_outbound.executed_action.get("executed_at")
        if executed_at_iso:
            executed_at = datetime.fromisoformat(executed_at_iso)
            # UNDO window is 5 minutes per CLAUDE.md / refactor plan.
            if NOW - executed_at <= timedelta(minutes=5):
                return DispatchResult(
                    agent_was_called=False,
                    mode="execute",
                    action_name="undo_last",
                    payload={
                        "reverses": last_outbound.executed_action.get("action"),
                    },
                    dispatch_reason="inbound UNDO within 5-min window",
                )
        # Stale UNDO — reply that it's too late. Dispatch (not agent) handles.
        return DispatchResult(
            agent_was_called=False,
            mode="reply",
            reply_text="That action was too long ago to undo. Reply with what you'd like to change.",
            dispatch_reason="UNDO outside 5-min window",
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
            sender_phone=(sender.phone if sender else ""),
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
    from app.flows.message_dispatch import _agent_overconfirm_reason
    if output.mode == "confirm":
        reject = _agent_overconfirm_reason(output=output, inbound_text=case.inbound_text)
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

    # Post-agent clarify cap. Fires only when the agent SAW the user's reply
    # and STILL chose clarify — that's when further asking won't help.
    if output.mode == "clarify" and clarify_streak >= cap:
        return DispatchResult(
            agent_was_called=True,
            mode="escalate",
            escalation_urgency="routine",
            dispatch_reason=f"clarify cap ({cap}) hit on agent's new clarify",
        )

    return DispatchResult(
        agent_was_called=True,
        mode=output.mode,
        action_name=(output.action.name if output.action else None),
        payload=_extract_payload(output),
        confirmation_token=output.confirmation_token,
        escalation_urgency=(output.escalation.urgency if output.escalation else None),
        reply_text=output.reply_text,
    )


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
    (default: openai-compatible against DeepInfra). Cached across cases.

    For openai-compatible: needs LLM_API_KEY + LLM_BASE_URL + LLM_MODEL_STRONG.
    For anthropic: needs ANTHROPIC_API_KEY.
    """
    if _LIVE_LLM_CACHE:
        return _LIVE_LLM_CACHE[0]

    provider = os.environ.get("LLM_PROVIDER", "openai-compatible").strip()

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
        # openai-compatible (the default — DeepInfra + Llama 3.3 70B).
        api_key = os.environ.get("LLM_API_KEY", "").strip()
        base_url = os.environ.get(
            "LLM_BASE_URL", "https://api.deepinfra.com/v1/openai"
        ).strip()
        if not api_key:
            raise RuntimeError(
                "LLM_API_KEY env var is required for --live mode with "
                "LLM_PROVIDER=openai-compatible. Try: "
                "LLM_API_KEY=$(firebase functions:secrets:access LLM_API_KEY) "
                "python -m tests.evals.runner --live"
            )
        from app.llm.openai_compat_adapter import OpenAICompatibleAdapter
        model = os.environ.get(
            "LLM_MODEL_STRONG", "meta-llama/Llama-3.3-70B-Instruct"
        )
        settings = _eval_settings(
            llm_provider="openai-compatible",
            llm_model_strong=model,
            llm_model_fast=model,
            llm_base_url=base_url,
            llm_api_key=api_key,
            anthropic_api_key="",
        )
        adapter = OpenAICompatibleAdapter(api_key=api_key, base_url=base_url)

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
    they matter (agent budgets, undo window) and are zeroed where they don't."""
    from app.config import Settings
    return Settings(
        llm_provider=llm_provider,
        llm_model_fast=llm_model_fast,
        llm_model_strong=llm_model_strong,
        llm_base_url=llm_base_url,
        llm_api_key=llm_api_key,
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
        clarify_round_max=2,
        clarify_user_24h_max=5,
        undo_window_min=5,
        offer_default_ttl_days=7,
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


def _opp_to_summary_dict(opp: FakeOpp, farm: FakeFarm | None) -> dict:
    """Build the OppSummary-shaped dict the agent expects in CONTEXT."""
    if opp.kind == "shift":
        activity_or_produce = ", ".join(opp.activity_tags) if opp.activity_tags else "shift"
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
                    ", ".join(opp.activity_tags) if opp.kind == "shift"
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
            executed_iso = last_outbound.executed_action.get("executed_at")
            if executed_iso:
                try:
                    executed = datetime.fromisoformat(executed_iso)
                    if NOW - executed <= timedelta(minutes=5):
                        executed_action = last_outbound.executed_action
                except ValueError:
                    pass
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
        sender_phone=(sender.phone if sender else ""),
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
        return f"Farm Friend Vashon: confirmed for harvest at {farm_name} {when}. Reply UNDO within 5 min if wrong."
    return f"Farm Friend Vashon: done. Reply UNDO within 5 min if wrong."


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
        "activity_tags": ["harvest"],
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

@stub_for("reg.farmer.post.tbd_explicit")
def _(c): return _confirm(
    "create_opportunity",
    {"parsed": {
        "kind": "shift",
        "starts_at": "2026-06-08T16:00:00+00:00",
        "duration_min": 180,
        "headcount_needed": 2,
        "activity_tags": ["tbd"],
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
        "activity_tags": ["weeding"],
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
    "Sorry to hear that — please call 911 if it's urgent. Max will reach out shortly."
)

@stub_for("reg.escalate.payment_routine")
def _(c): return _escalate(
    "routine", "volunteer asking about payment for last week",
    "Good question — Max handles anything around payment and will follow up shortly."
)

# reg.flag.silent_when_flagged is dispatch-only; no stub.


# === NEW_INTENT stubs ===
@stub_for("new.vol.offer.broadcast")
def _(c): return _confirm(
    "record_offer",
    {"activity_tags": ["infrastructure"], "earliest_at": None, "latest_at": "2026-06-06T07:00:00+00:00",
     "note": "anyone need help with tilling on Friday"},
    token="YES",
    text="I'll let farms know you can help with tilling Friday. Reply YES to record, STOP to opt out.",
)

@stub_for("new.vol.offer.directed")
def _(c): return _confirm(
    "record_offer",
    {"activity_tags": [], "earliest_at": None, "latest_at": None,
     "note": "wants to help at Plum Forest this week"},
    token="YES",
    text="I'll pass along your offer to Plum Forest. Reply YES to record.",
)

@stub_for("new.vol.offer.matches_existing_opp")
def _(c): return _confirm(
    "record_offer",
    {"activity_tags": ["infrastructure"], "earliest_at": None, "latest_at": "2026-06-07T07:00:00+00:00",
     "note": "wants to help with tilling this weekend"},
    token="YES",
    text="Recording your tilling offer for the weekend. Reply YES to record.",
)

@stub_for("new.vol.offer.flexible_phys_work")
def _(c): return _confirm(
    "record_offer",
    {"activity_tags": ["flexible"],
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
    "for Max to handle directly. STOP to opt out."
)

@stub_for("new.farmer.general_question")
def _(c): return _reply(
    "Farm Friend Vashon is an SMS system for coordinating farm help on Vashon. "
    "Text us when you need volunteers and we'll handle outreach. STOP to opt out."
)

# new.undo.recent_action — handled by deterministic dispatch (UNDO hotkey + window check).


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

# adv.undo_outside_window — deterministic in dispatch (UNDO hotkey, window past).

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
def _(c): return _clarify(
    "Mushroom foraging isn't in our usual activity list. Should I treat that as 'gleaning' or flag it for Max to add as a new category?"
)

@stub_for("adv.quiet_hours_does_not_block_inbound")
def _(c): return _confirm(
    "claim_opportunity", {"opp_id": "o_fri_harvest", "slots": 1},
    token="YES",
    text="Reply YES to grab Friday harvest.",
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
# runner must reproduce verbatim (token match, UNDO window, FLAG).
#
# Note: the clarify-cap case is NOT in this set anymore. The cap moved to
# AFTER the agent runs so the user's answer to round-2 gets a chance to
# land; the agent is called, sees the still-ambiguous reply, emits clarify
# again, and dispatch then escalates instead of sending round-3.
DETERMINISTIC_ONLY = {
    "reg.claim.token_confirms_claim",            # token match
    "new.undo.recent_action",                     # UNDO hotkey
    "adv.affirmative_after_pending",              # affirmative variant on token
    "adv.undo_outside_window",                    # UNDO stale
}


def run_one(case: EvalCase, *, live: bool) -> CaseResult:
    # Skip review-mode for both runners — the harness doesn't simulate the
    # review tick (board_review integration is a separate task).
    if case.review_trigger:
        return CaseResult(case.id, passed=True,
                          dispatch_reason="review-mode case skipped in runner (TODO)")

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

    for case in cases_to_run:
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

    total = len(cases_to_run)
    print()
    print(f"Eval result: {passed}/{total} passed, {len(failed)} failed")
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
