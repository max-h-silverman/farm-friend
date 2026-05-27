# Refactor plan: Unified Agent

## Goal

Make Farm Friend handle the full set of straightforward intents — from either a farmer or a volunteer, inbound or outbound — as a neutral AI coordinator that has agency under supervision. Replace the current reactive classifier vocabulary with a single role-aware agent that drafts confirmations for state-changing actions and answers everything else directly.

Success criterion: the message that motivated this refactor ("hey does anyone need help with tilling on Friday?") gets a useful reply, not "Coordinator will follow up shortly."

## Non-goals

- No new admin SPA tabs or surfaces.
- No public volunteer signup page; admin onboarding still the gate.
- No reputation/skill registry.
- No farmer web portal.
- No change to the deterministic hotkey fast path.
- No change to the outreach tier or post-event tick architecture.
- No change to the LLM portability layer or the `chat_json` interface.

## Architectural principles

These principles override the rest of the plan if they conflict.

1. **Reuse before invent.** Every existing repo, flow, prompt, and data field stays unless this plan explicitly removes or amends it. Where a new behavior maps onto an existing flow, call the existing flow.
2. **The agent has zero write authority.** Its outputs are interpreted by the dispatch layer, which is the only code path that touches Firestore for state changes. This is a hard invariant.
3. **Tokens are the only confirmation surface.** No tool-use loops, no function-calling, no multi-turn agent reasoning. One LLM call per non-hotkey inbound; one structured JSON output; the dispatch layer takes it from there.
4. **Inferences are allowed; mis-inferences are recoverable.** Unique-match resolution is fine. Every state change emits a receipt SMS naming what was done. `UNDO` reverses within 5 minutes.
5. **No fabrication.** Agent's factual claims must be grounded in its context payload. Enforced by prompt + eval.
6. **Eval before cutover.** No traffic flips to the new agent until the eval harness passes existing-flow cases at parity.

## SMS compliance integration

`docs/sms-compliance-requirements.md` is the authoritative spec for SMS-facing behavior. This refactor must not regress any of those requirements. Concrete impacts:

- **Hotkey parser** gains `START`, `UNSUBSCRIBE`, `END`, `QUIT`, `INFO` as deterministic synonyms (handled before any LLM call).
- **Agent never drafts opt-in/opt-out/help copy.** Those three messages are deterministic templates rendered by the hotkey path. The agent's `mode="reply"` and `mode="confirm"` outputs cover everything else.
- **Every agent-drafted outbound** must include "Farm Friend Vashon" program-name prefix and an opt-out hint where the message is initiating contact or asking for an action. Enforced in the prompt; spot-checked in eval.
- **`CANCEL` is context-sensitive** with a documented divergence from the campaign description (see CLAUDE.md §"SMS compliance"). The agent does NOT draft a `CANCEL` token for any confirmation — it picks something distinctive like `DROPOPP` for farmer-cancels and `DROP` for volunteer-drops. The hotkey parser handles the divergence routing.
- **Confirmation reminder copy** changes from "reply CANCEL if you can't make it" to "reply DROP if you can't make it" as part of the refactor — the `CONFIRMATION_REMINDER` outbound stamps `pending_action.token = "DROP"`.
- **Anti-spam mute** is `PAUSE` / `RESUME`, not `QUIET` / `LOUD`. Avoids collision with `QUIT` (which is now a global unsubscribe per compliance).

## Prior decisions kept as-is

- Repository layer (`functions/app/repos/`) is the only place Firestore is touched. Unchanged.
- `LLMClient.chat_json(messages, schema, cache_system_prompt=False)` is the only LLM entrypoint. Unchanged.
- Deterministic hotkey parser runs before any LLM call. Unchanged.
- Outreach tier escalation, post-event check-in, confirmation reminder, quiet hours, stale draft tick — all unchanged.
- `IntentLabel` enum on `MessageDoc` is the routing signal for outbound message types. We add to it but don't restructure.
- ESCALATE-as-first-class-intent + coordinator phone handoff. Unchanged behavior; the unified agent emits the same shape.
- `safe_send` is still the only outbound path. Unchanged.
- FLAG-pauses-thread invariant. Unchanged.
- Quiet hours gating on scheduled ticks. Unchanged.
- TCPA `STOP` semantics. Unchanged.

## Prior decisions explicitly replaced

These are the only files/prompts the refactor retires:

- `app/agent/classifier.py` + `prompts/classifier.md` → replaced by the unified agent.
- `app/agent/ambiguous.py` + `prompts/ambiguous.md` → retired. The unified agent's clarify branch covers the same case; the eval harness verifies parity.
- `parse_opportunity` / `merge_clarification_into_draft` / `classify_farmer_message` in `app/agent/parser.py` (and their three prompts: `parser.md`, `parser_merge.md`, `parser_edit.md`) → folded into the unified agent. The `ParsedOpportunity` shape stays as a sub-schema referenced from the agent's output.
- The fan-out branches in `_dispatch` for farmer-with-open-opps, farmer-clarification-reply, farmer-post, and LLM-reply collapse into one branch that calls the unified agent.

All other code in `flows/` stays. The unified agent emits structured outputs that the dispatch layer maps onto existing flow functions:

- `claim_flow.handle_claim`, `handle_maybe`, `handle_volunteer_drop` — unchanged, called by dispatch on agent `execute` outputs.
- `farmer_ops.apply_edit`, `_do_cancel`, `handle_status` — unchanged, called by dispatch on agent `execute` outputs.
- `outreach_flow.send_initial_outreach` — unchanged, called by dispatch after a posting executes.
- `post_event_flow.handle_post_event_reply` — unchanged, called by dispatch on agent `execute` outputs.

## Data model additions

Minimal additions. Each is justified by a flow that doesn't work without it.

1. **`MessageDoc.pending_action: dict | None`** — set only on outbound messages with `intent_label == PENDING_CONFIRMATION`. Contains: `{"action": "<name>", "token": "<5–8 char uppercase>", "payload": {...}, "expires_at": <iso>}`. Used by dispatch to execute the action when a matching reply arrives. No new collection: one pending action per user thread is enough (the most recent outbound `PENDING_CONFIRMATION` is the live one).

2. **`MessageDoc.executed_action: dict | None`** — set only on outbound receipt messages (`intent_label == ACTION_RECEIPT`). Contains: `{"action": "<name>", "payload": {...}, "executed_at": <iso>, "undo_token": "UNDO"}`. Used to implement the 5-minute UNDO window. Lookup: dispatch reads the most recent outbound for the user; if it's an `ACTION_RECEIPT` within 5 min, an inbound `UNDO` reverses it.

3. **`UserDoc.activity_preferences: list[str]`** — positive preferences alongside the existing negative `mute_rules`. Empty default. Filled by the agent's `execute` path on availability/preference updates.

4. **`offers` top-level collection** (new). Schema:
   ```python
   class OfferDoc(BaseModel):
       id: str | None = None
       volunteer_user_id: str
       activity_tags: list[str]               # canonical slugs
       earliest_at: datetime | None = None    # bounded offer window
       latest_at: datetime | None = None
       note: str = ""                         # raw text the agent captured
       status: Literal["open", "matched", "expired", "cancelled"] = "open"
       matched_opportunity_id: str | None = None
       created_at: datetime
       expires_at: datetime                   # default: latest_at or +7 days
   ```
   New repo: `offers_repo` with `create`, `get_by_id`, `list_open_for_volunteer`, `list_open_matching(activity, day_window)`, `set_status`. Mirrors existing repo patterns.

5. **New `IntentLabel` values** (extending the existing enum — no replacement):
   - `PENDING_CONFIRMATION` — outbound: drafted action awaiting token reply
   - `ACTION_RECEIPT` — outbound: "here's what I did" after execute
   - `CLARIFY` — outbound: agent's clarification question
   - `OFFER` — inbound/outbound: volunteer-initiated offer
   - `AVAILABILITY` — inbound/outbound: volunteer updating standing availability
   - `QUERY` — inbound/outbound: status-of-things question that didn't match `STATUS` hotkey
   - `UNDO` — inbound: reverse the last executed action

No changes to existing labels.

## Unified agent contract

One file: `app/agent/unified.py`. One prompt: `app/prompts/agent.md`.

### Function signature

```python
def run_agent(
    *,
    llm: LLMClient,
    sender: UserDoc,
    inbound_text: str,
    context: AgentContext,
) -> AgentOutput:
    ...
```

### `AgentContext` (built by dispatch, passed in)

Pure data, no callbacks. Keeps the agent deterministic given input.

- `now_local: datetime` (Vashon-local)
- `sender_role: UserRole`
- `sender_availability: dict` (days/hours/max from `UserDoc`)
- `sender_activity_preferences: list[str]`
- `sender_mute_rules: list[MuteRuleDoc]`
- `sender_open_claims: list[dict]` (volunteer's own CONFIRMED/INTERESTED claims, with opp summary)
- `sender_farm: FarmDoc | None` (if farmer)
- `sender_farm_open_opps: list[OpportunityDoc]` (if farmer)
- `last_outbound: MessageDoc | None` (the message they may be replying to)
- `last_outbound_opp: OpportunityDoc | None`
- `pending_action: dict | None` (from `last_outbound.pending_action` if alive — i.e., not expired)
- `executed_action: dict | None` (from the most recent `ACTION_RECEIPT` outbound within 5 min)
- `cross_cutting_opps: list[OpportunityDoc]` — all OPEN/FILLING opps. With 2-3 farms + ~50 vols this is cheap; revisit if it grows.
- `known_farms: list[dict]` (id, name) — for resolving farm references
- `canonical_activities: tuple[str, ...]` — for grounding activity references

### `AgentOutput` schema

```python
class AgentOutput(BaseModel):
    mode: Literal["reply", "confirm", "execute", "clarify", "escalate"]
    reply_text: str = ""                 # the SMS body to send
    confirmation_token: str | None = None  # required iff mode == "confirm"; regex ^[A-Z][A-Z0-9]{4,7}$
    action: ActionSpec | None = None     # required iff mode in ("confirm", "execute")
    clarification_for: dict | None = None  # optional state to carry into next turn for clarify mode
    escalation: EscalationSpec | None = None  # required iff mode == "escalate"
    rationale: str = ""                   # admin-facing only; not sent
```

### `ActionSpec` (discriminated union)

One variant per action the agent is allowed to draft. The dispatch layer pattern-matches on `action.name` to call the existing flow function. **Every action below maps to an existing flow function**; no new flow code is added except for the offers and availability/preferences paths, which are inherently new.

- `claim_opportunity` → `claim_flow.handle_claim`
- `record_maybe` → `claim_flow.handle_maybe`
- `drop_confirmed_claim` → `claim_flow.handle_volunteer_drop`
- `cancel_opportunity` (farmer) → `farmer_ops._do_cancel`
- `edit_opportunity` (farmer) → `farmer_ops.apply_edit`
- `create_opportunity` (farmer posting) → `outreach_flow.send_initial_outreach` after `opportunities_repo.create`
- `update_draft_opportunity` (farmer mid-clarification) → existing merge path
- `acknowledge_post_event` (farmer Y/N) → `post_event_flow.handle_post_event_reply`
- `add_mute_rule` → `mutes_repo.add`
- `set_availability` → `users_repo.update_availability` (new thin repo method on the existing repo)
- `set_activity_preferences` → `users_repo.update_activity_preferences` (new thin repo method)
- `record_offer` → `offers_repo.create` + best-effort notify matching farmers (new)

### `EscalationSpec`

Exactly today's shape; the dispatch handler `_handle_escalation` is unchanged.

```python
class EscalationSpec(BaseModel):
    reason: str
    urgency: Literal["routine", "immediate"]
```

## Dispatch rewrite

`_dispatch` in `flows/message_dispatch.py` is the main edit site. Pseudocode:

```
1. idempotency check                              # unchanged
2. sender lookup                                  # unchanged
3. UNSUBSCRIBED check                             # unchanged
4. persist inbound MessageDoc                     # unchanged
5. hotkey parse                                   # unchanged
   if match: dispatch hotkey                      # unchanged, EXCEPT:
     - new UNDO hotkey path (see below)
     - new CONFIRM-shaped tokens routed to pending-action execute
6. FLAG check                                     # unchanged
7. PRE-AGENT: if last outbound is PENDING_CONFIRMATION and the inbound
   matches its token (literal or affirmative variant), execute the
   action deterministically — no LLM call. Send receipt.
8. PRE-AGENT: if last outbound is ACTION_RECEIPT within 5 min and inbound
   is "UNDO" (any case), reverse the executed action. Send undo receipt.
9. Build AgentContext (one function, ~30 lines).
10. Call run_agent.
11. Switch on AgentOutput.mode:
    - reply:    safe_send(reply_text), log as outbound with intent
    - clarify:  safe_send(reply_text), log with intent_label=CLARIFY
    - confirm:  safe_send(reply_text), log with intent_label=PENDING_CONFIRMATION
                + pending_action={action, token, payload, expires_at}
    - execute:  call the mapped flow, send receipt via safe_send,
                log receipt as ACTION_RECEIPT with executed_action
    - escalate: _handle_escalation(...) (unchanged)
```

Step 7 is the heart of the safety model: the LLM never executes. It drafts, the user confirms, the deterministic dispatch path executes against the persisted payload. The agent only sees the pending payload as context if the user replies with something *other* than a token (in which case the agent can decide to keep the pending action alive, replace it, or cancel it).

### Token matching (deterministic)

In `app/agent/hotkeys.py`, a small extension:

```python
def match_pending_token(*, body: str, pending: dict | None) -> bool:
    if not pending:
        return False
    body_norm = body.strip().upper().rstrip("!.")
    if body_norm == pending["token"]:
        return True
    # Affirmative variants accepted (per design decision).
    return body_norm in {"YES", "OK", "SURE", "CONFIRM", "GO AHEAD", "GO"}
```

The receipt rail is what makes the affirmative-variant acceptance safe.

### UNDO

`UNDO` joins the hotkey parser. It only matches when the last outbound to this user is an `ACTION_RECEIPT` with `executed_at` within 5 min. The dispatch path reverses by action name (each ActionSpec variant has a corresponding `undo_<name>` function in its source flow file, added only where reversal is non-trivial; simple inverses are inlined).

Reversible actions: `claim_opportunity` (drop), `drop_confirmed_claim` (re-claim if seat still open, else flag), `record_maybe` (delete the INTERESTED record), `set_availability` (revert via stored prior value in the receipt payload), `set_activity_preferences` (revert), `record_offer` (mark cancelled), `add_mute_rule` (remove), `edit_opportunity` (revert via prior values in receipt payload).

Irreversible / best-effort actions: `cancel_opportunity` (already fanned out — UNDO restores the opp to OPEN and sends "never mind" to the volunteers; receipt's executed_at + the fan-out log let us message the right set), `create_opportunity` (UNDO sets status to CANCELLED, fan-outs already sent get a "never mind"), `acknowledge_post_event` (no real-world side effect to undo; just allows re-answering).

Receipts always include enough payload to reverse. If reverse isn't safely possible, the receipt says "UNDO within 5 min" only when it actually is.

## Prompt

One prompt: `app/prompts/agent.md`. Structure (kept tight — duplicated text inflates Sonnet cost on every call):

1. **Role.** "You are the Farm Friend coordinator agent…"
2. **Hard rules** (six, in order): no fabrication; no direct writes; every state change goes through a confirmation token; tokens are 5–8 uppercase alphanumeric, no hyphens; receipts are always sent on execute; escalate only for the narrow human-risk triggers.
3. **Output modes** and when to use each.
4. **Token rules.** Pick a context-appropriate short token. Generic `CONFIRM` is allowed but action-specific tokens (`CANCEL`, `DROP`, `EDITOK`, `ADDSAT`, `OFFER`, `SWAPOK`) are clearer. Tokens must not collide with hotkeys (`STOP`, `HELP`, `JOIN`, `FLAG`, `YES`, `MAYBE`, `MUTE`, `STATUS`).
5. **Resolution rules.** Unique match → resolve silently (terse readback in the confirmation). Multiple matches → clarify first. No match → ask, don't guess.
6. **Inference policy.** Typos can be read through; the confirmation prose must name the date/farm/etc. so the user catches a misread. Unknown activity slugs → flag in the rationale, ask the user.
7. **The two roles** (farmer / volunteer) and what each can do. Cross-references to the action names.
8. **Context schema.** What fields appear in the user message and what they mean.
9. **Output schema.** Mirrors `AgentOutput` exactly; the JSON schema validation does the heavy lifting.
10. **Examples** (~6 worked examples covering: volunteer offer; farmer status query; ambiguous claim; clarification turn; mid-confirmation context switch; escalation).

`cache_system_prompt=True` on every call. Model tier: `strong` (Sonnet). Cost is OK at pilot volumes; revisit only if non-hotkey volume grows past ~1k/day.

## Eval harness

New: `functions/tests/evals/`. This is the gate — no traffic flips without it.

### Structure

- `cases.py` — list of `EvalCase` dicts. Each case: setup (sender, sender state, recent messages, opps), inbound text, expected `AgentOutput.mode`, expected `action.name` if applicable, expected payload fields (loose match — required keys present and matching, prose ignored), expected receipt shape if `mode == "execute"`.
- `runner.py` — fixture builder that constructs the `AgentContext`, calls `run_agent` against a stub `LLMClient` (real Anthropic in `--live`, deterministic stub for unit run), asserts on the structured output.
- `report.py` — pass/fail summary, regression diff against last run.

### Case coverage (minimum)

Existing flows that must not regress (~25 cases):

- Hotkey-adjacent free-form claims ("count me in", "I can do it") with and without opp context.
- Soft maybe / decline.
- Farmer posting (shift) — well-formed, missing fields, missing time, ambiguous date.
- Farmer posting (pickup) — well-formed, missing destination.
- Farmer clarification reply — completes draft, bails out, escalates mid-clarification.
- Farmer edit on open opp — time change, headcount up, headcount down past seats_filled, requirements update.
- Farmer cancel on open opp — single open opp, multiple opens (ambiguous), wrong opp.
- Post-event Y/N replies — context-correct, context-stale.
- ESCALATE triggers — injury, payment, distress, harassment, mixed (escalation + posting).
- FLAG-pauses-thread (sender has open flag, no auto-reply).

New intents that must work (~15 cases):

- Volunteer free-form offer broadcast ("anyone need tilling Friday?").
- Volunteer directed offer ("can I help at Plum Forest this week?").
- Volunteer availability update ("I'm free Saturdays now"; "drop Tuesdays from my schedule"; "increase to 10 hrs/wk").
- Volunteer activity preference ("I love gleaning, send me more").
- Volunteer status query ("what's open this weekend?"; "is there anything Friday?").
- Volunteer proactive cancel ("I can't make Friday after all" with one matching confirmed claim).
- Volunteer proactive cancel with ambiguous match (two Friday claims).
- Farmer status query in free-form ("how's tomorrow filling?").
- Farmer pass-through ("tell Alex thanks") — should clarify, the system doesn't pass messages in v1.
- Farmer general question ("how does this work?") — reply, don't escalate.

Adversarial cases (~10 cases):

- Token too long → schema fails → re-prompt OR flag (eval should catch the bad output).
- Token contains lowercase → same.
- Token collides with a hotkey (`STOP`/`HELP`/`YES`/etc.) → eval fails.
- Affirmative variant after PENDING_CONFIRMATION executes.
- Affirmative variant after CLARIFY (which has no token) does NOT execute anything.
- Mid-confirmation context switch — user pivots to a different request while a confirmation is pending.
- UNDO outside the 5-min window → does nothing, sends "too late to undo" reply.
- UNDO with no recent executed action → "nothing to undo" reply.
- Fabricated claim ("you have a shift Tuesday with Plum Forest" when sender has no such claim) → eval flags as fabrication, case fails.
- Quiet-hours interaction with a pending confirmation crossing the boundary.

### Pass criteria

- **Existing-flow cases: exact match.** Mode + action name + payload key set + payload field values must equal expected.
- **New-intent cases: exact match.**
- **Adversarial cases: behavioral match** (correct mode and rough action shape; prose latitude).

If any existing-flow case regresses, the cutover is blocked.

### Cost note

The eval harness in `--live` mode runs against real Anthropic. ~50 cases × Sonnet pricing per case ≈ trivial. We run `--live` before each cutover candidate; CI uses the stub.

## Proactive review (agent as coordinator-on-the-board)

The reactive design above handles inbound→outbound well, but a real coordinator's job includes noticing things that aren't immediate: an offer sitting unmatched for days, a shift still at 1/3 with 24h to go, a clarification thread that went silent. This section adds that capability without breaking the safety model.

### One review tick, same agent

New scheduled function: `tick_agent_review`, runs every 30 min during waking hours (gated by the existing `is_quiet_hours()` helper). It does the same things the inbound dispatch does — builds an `AgentContext`, calls `run_agent`, executes structured output — except:

- The "inbound text" is replaced by a structured **board state** payload.
- The agent runs in `mode="review"` (a new mode in `AgentOutput.mode`).
- The output is a **list** of `ActionSpec` ranked by importance, not a single action.
- Each action goes through the same confirmation/receipt/undo rails: nothing executes without the user replying to a token.

This means *new proactive behaviors are prompt changes, not new code*. The dispatch path that turns a single `ActionSpec` into a drafted confirmation is reused.

### Board state context

Built by a new function `build_board_context()` at tick time. Contents:

- All `open` and `filling` opportunities with: time-to-event, fill ratio, current_tier, `agent_nudges_sent`, the farmer's owner_user_id, recent inbound/outbound on the opp.
- All `open` offers with: age, activity_tags, time window, matching open opps the dispatch could compute via `offers_repo.list_open_matching`.
- Users with open claims in the next 24h (confirmation-window candidates — already handled by `tick_confirmations`, included here for visibility, the review agent does NOT re-send these).
- Users with the last inbound > 4h ago to whom we owe a reply (e.g. a draft we asked a clarification question for and the farmer never answered).
- Quotas remaining: per-user budget, per-opp nudge cap, per-tick global ceiling. The agent sees these and prioritizes accordingly.

The agent does NOT see: arbitrary user history, demographic info, or anything not needed for the immediate decision. Same "ground-only-in-context" principle as the inbound agent.

### Memory (longitudinal context) — minimal, safe form

The agent gets longitudinal awareness via **derived rollups built at context time**, not stored interpretations. Specifically:

- **Per-opportunity history excerpt.** Last 5 messages on the opp (any direction), with `intent_label`. Already cheap to query.
- **Per-user recent activity excerpt.** Last 3 claims (any status), last 3 inbounds. Already cheap.
- **`OpportunityDoc.agent_nudges_sent: int`** — new field. The only persisted "memory" we add. Used to enforce the per-opp nudge cap and to give the review agent a hint about whether this opp has already been worked. Increments only when an agent-initiated nudge for that opp actually goes out.

What we explicitly do NOT add in v1:
- No `UserDoc.coordinator_notes` (risk of the agent inventing personality judgments). Reconsider after pilot if real users feel impersonal.
- No event log collection. The `messages` collection already serves as an audit trail; rollups read from it.
- No vector embeddings, no semantic memory, no "agent state." The agent re-derives everything from context each tick.

### Nudge budgets — the anti-spam mechanism

This is enforced by dispatch, not by trusting the prompt. **No outbound goes through unless it fits the budget.** Three layers:

1. **Per-user budget: 1 agent-initiated outbound per 48h.** Tracked via `users_repo.last_agent_initiated_outbound_at` (new field). Does NOT count: replies to user-initiated inbound, scheduled flows (confirmation reminder, post-event check-in), STOP/HELP/system responses. DOES count: review-tick nudges, opportunistic follow-up suggestions.

2. **Per-opp nudge cap: 2 lifetime.** `OpportunityDoc.agent_nudges_sent`. After 2, the review agent can only flag to admin, not message users.

3. **Per-tick global ceiling: 3 outbound messages per `tick_agent_review` run.** The agent submits a ranked list; dispatch sends the top 3, flags the rest to the admin worklist if they would otherwise be ignored. Forces prioritization.

### `PAUSE` hotkey — user-side opt-out

New deterministic hotkey, mirrors `STOP` in form:

- `PAUSE` — mutes all agent-initiated nudges for 14 days. Stored as a `MuteRuleDoc` with `dimension="agent_nudge"` (new dimension value). Confirmation reminders, post-event check-ins, and direct replies to the user's own messages are unaffected.
- `RESUME` — undo. Removes the agent-nudge mute.

This is the user's safety valve. The 48h budget is what prevents most spam; `PAUSE` is for users who still feel pinged-at.

### What `mode="review"` returns

```python
class AgentReviewOutput(BaseModel):
    proposals: list[ReviewProposal]
    rationale: str = ""  # admin-facing
```

```python
class ReviewProposal(BaseModel):
    priority: Literal["high", "medium", "low"]
    target: Literal["user", "admin"]   # admin = worklist flag only, no SMS
    target_user_id: str | None = None  # required if target == "user"
    action: ActionSpec | None = None   # the drafted action (goes through confirm rail if executed)
    reason: str                        # admin-facing rationale for this proposal
    budget_category: Literal["user_nudge", "opp_nudge", "admin_flag"]
```

Dispatch processes the list in priority order:

1. Drop any `target=user` proposal where the user has an active `agent_nudge` mute (QUIET).
2. Drop any `target=user` proposal where the user is over the 48h budget.
3. Drop any opp-related proposal where `agent_nudges_sent >= 2`.
4. Send the top 3 remaining `target=user` proposals; everything else gets a flag in the admin worklist with the agent's reason.
5. Send `target=admin` proposals as worklist flags without budget consumption.

### Receipt and UNDO apply unchanged

A review-initiated `confirm` is sent through the same `PENDING_CONFIRMATION` channel; the user replies with the token; the action executes; a receipt is sent. UNDO works the same way. From the user's perspective, agent-initiated and user-initiated confirmations are indistinguishable.

### What gets enforced in eval

New eval cases:

- Review tick with no actionable state → empty proposal list.
- Review tick with one under-filled shift at T-24h → one proposal, priority high.
- Review tick with five aging unmatched offers → proposals ranked, top 3 sent, rest flagged.
- Review tick where the relevant user has an active `PAUSE` mute → proposal dropped.
- Review tick where the relevant opp has `agent_nudges_sent == 2` → proposal flagged to admin, not sent.
- Review tick crossing the 48h budget on the same user from two separate opps → one sent, one deferred.
- Review tick during quiet hours → tick no-ops (gated at entry).
- Receipt missing because `safe_send` returned None → `agent_nudges_sent` is NOT incremented (the send didn't happen).

### Data-model additions for the review path (in addition to those above)

- `OpportunityDoc.agent_nudges_sent: int = 0`
- `UserDoc.last_agent_initiated_outbound_at: datetime | None = None`
- New `MuteDimension` value: `agent_nudge`
- New `IntentLabel` values: `AGENT_NUDGE` (outbound category for budget accounting), `PAUSE`, `RESUME`

### What this section does NOT do

- **No new admin SPA tab** for board review. Admin sees flags in the existing Worklist; the review agent's flags integrate there.
- **No second agent prompt.** Same `agent.md` with a `mode="review"` branch documented inside. One prompt, one source of truth.
- **No new write surface.** Dispatch layer is still the only writer.
- **No bypass of safe_send or the 48h budget.** Anywhere. The agent cannot "send anyway because important" — escalation triggers for genuinely-urgent things go through `_handle_escalation`, which already has its own (correctly unlimited) coordinator-phone path.

## Cutover plan (pre-launch — nuke freely)

The pilot hasn't started, so there's no production traffic to protect. The refactor is a straight cutover, no flag, no shadow mode, no one-week watch. The eval harness is the gate.

1. Implement data-model additions, repo methods, new `offers_repo`, new `IntentLabel` values. Backwards-compatible at the data layer; existing data still loads.
2. Write eval cases (done — `functions/tests/evals/cases.py`). Build the runner.
3. Implement `run_agent`, the prompt, and the dispatch rewrite. Delete `classifier.py`, `ambiguous.py`, `parser.py`'s prompt-callers, all retired prompts, and the four-branch fan-out in `_dispatch` IN THE SAME CHANGE. No dead code lingers.
4. Iterate prompt + dispatch glue against `--live` eval until: every REGRESSION case passes (exact match), every NEW_INTENT case passes (exact match), every ADVERSARIAL case behaves correctly, every REVIEW case demonstrates correct budget filtering.
5. Deploy. The pilot starts when Telnyx clears AND this lands AND the compliance pass is green.

### What gets deleted in the cutover (not later)

- `app/agent/classifier.py`
- `app/agent/ambiguous.py`
- `app/prompts/classifier.md`
- `app/prompts/ambiguous.md`
- `app/prompts/parser.md`, `parser_merge.md`, `parser_edit.md` (folded into `agent.md`)
- `app/agent/parser.py` — the `classify_farmer_message`, `parse_opportunity`, `merge_clarification_into_draft` functions retire. The `ParsedOpportunity` dataclass survives as a sub-schema referenced from the agent's output. `REQUIRED_SHIFT_FIELDS` / `REQUIRED_PICKUP_FIELDS` constants survive (still authoritative).
- `app/repos/destinations_repo.py` + the `destinations` collection — confirmed dead code per the 2026-05-26 review.
- `IntentLabel.AMBIGUOUS` — replaced by `mode="clarify"` in the new agent.
- `MessageDoc.confidence` — classifier self-report, no longer used.
- The four-branch fan-out in `_dispatch`: `_handle_farmer_message_with_open_opps`, `_handle_farmer_post`, `_handle_clarification_reply`, `_handle_llm_reply`, the `_looks_like_posting` heuristic, the `_find_recent_draft` helper, the `_opp_for_edit_prompt` helper. All folded into the unified-agent path.
- `_handle_orphan_claim_or_maybe` — the new agent handles orphan-context CLAIM/MAYBE natively.

This is permission to be aggressive. If a function exists today only to serve a code path the refactor replaces, delete it.

## Anti-loop: maximum back-and-forth before escalation

A real coordinator doesn't ask the same person to rephrase three times. The unified agent must not either.

**Hard cap: 2 clarification rounds per thread.** After the agent has asked two clarifying questions in a row and the user's reply still produces `mode="clarify"`, dispatch does NOT call the agent again — it routes to `_handle_escalation` with `urgency="routine"`, reason "Two clarification rounds did not resolve the message."

### Mechanic

New field: `MessageDoc.clarification_round: int = 0`.

- Set only on outbound messages with `intent_label == CLARIFY`.
- Computed at the time the outbound is logged: `next_round = (last_outbound.clarification_round if last_outbound.intent_label == CLARIFY else 0) + 1`.
- The counter resets to 0 whenever the user's reply produces a `mode` other than `clarify` (they got unstuck).
- Dispatch reads the inbound side: if `last_outbound.intent_label == CLARIFY` and `last_outbound.clarification_round >= 2`, the agent is NOT invoked — straight to `_handle_escalation`.

The escalation path already triggers FLAG-pauses-thread, so once the loop tripwires, no further auto-replies fire until admin clears.

### Eval cases

- `adv.clarify_cap.escalates_at_third_round` — two CLARIFY outbounds on a thread; third inbound that would clarify again must escalate without calling the agent.
- `adv.clarify_cap.resets_on_resolution` — CLARIFY once, user resolves, later CLARIFY again — counter starts fresh at 1, not at "1 already."
- `adv.clarify_cap.user_resolves_at_round_2` — two CLARIFY outbounds, user finally answers clearly on round 2 reply → executes normally, no escalation, counter resets.

### Soft secondary rail

Per-user clarification budget: no more than 5 CLARIFY outbounds per 24h regardless of how they're distributed across threads. At pilot scale this almost never fires; it caps the pathological "one user, many confused threads" case. Enforced in the dispatch path the same way the agent-nudge budget is.

## What this plan does NOT add

Calling out, so it's explicit:

- **No new admin UI.** The existing Worklist, Opportunities, Roster tabs already render the new fields (`offers` shows up by being on a tab we'd add only if needed; for v1 the offers collection is admin-readable via Firestore console; the unified agent gives each volunteer-initiated offer a route, so the admin reads it via the receipt flow on the message thread).

  *Reconsider after pilot:* a small "Offers" tab on the SPA. Not in this refactor.

- **No tool-use loop.** The agent is one prompt, one JSON output, one execution. We do not add Anthropic tool-use bindings, multi-turn agent reasoning, or self-querying. Cost-predictability + eval-determinism wins; we revisit only if a real failure mode demands it.

- **No new collection besides `offers`.** Pending confirmations and executed actions live on `MessageDoc` (existing collection). UNDO and confirmation logic read from the same.

- **No restructure of `IntentLabel`.** New values added; existing values kept.

- **No change to the LLM portability layer.** `chat_json` is enough.

- **No bypass of `repos/`.** The unified agent is forbidden from importing Firestore; it reads only its `AgentContext` argument.

- **No bypass of `safe_send`.** Outbound sends still go through `safe_send`.

## Risk register

- **Cost.** One Sonnet call per non-hotkey inbound. Pilot scale: trivial. Watch.
- **Prompt drift.** A single ~400-line prompt is a complex artifact. The eval harness is the only thing that lets us iterate without regressing.
- **Token collisions.** Mitigated by the prompt + the schema regex + the eval cases that explicitly test hotkey-name tokens.
- **Affirmative-variant + receipt rail combo is the safety story.** If the receipt is missed (delivery failure), the user has no feedback that an action ran. Mitigation: `safe_send` returns None on failure; if a receipt fails to send, dispatch logs a flag for the admin.
- **UNDO on a fanned-out action is messy.** Best-effort reverse messages to the same recipients; receipt is honest about what's reversible.
- **Cross-cutting opps in every context payload.** With 2-3 farms it's fine; at 50 farms it's not. Cap at ~20 most-relevant opps if/when it matters.
- **Eval coverage is the gate; if cases are weak, the cutover bar is weak.** Treat the eval-case sheet as a first-class artifact reviewed before any agent code is written.

## File-level diff summary

New files:
- `app/agent/unified.py`
- `app/prompts/agent.md`
- `app/repos/offers_repo.py`
- `app/flows/board_review.py` — builds board context, calls agent in review mode, applies budget filters, dispatches proposals.
- `functions/tests/evals/__init__.py`, `cases.py`, `runner.py`, `report.py`

Modified files:
- `app/repos/models.py` — add `MessageDoc.pending_action`, `MessageDoc.executed_action`, `UserDoc.activity_preferences`, `UserDoc.last_agent_initiated_outbound_at`, `OpportunityDoc.agent_nudges_sent`, new `IntentLabel` values, new `MuteDimension.AGENT_NUDGE`, `OfferDoc`.
- `app/repos/users_repo.py` — add `update_availability`, `update_activity_preferences`, `set_last_agent_initiated_outbound_at`, `is_within_agent_nudge_budget`.
- `app/repos/opportunities_repo.py` — add `increment_agent_nudges_sent`.
- `app/repos/messages_repo.py` — small helpers for "latest outbound with intent X" and "is pending action alive."
- `app/agent/hotkeys.py` — `UNDO`, `PAUSE`, `RESUME` hotkeys; `match_pending_token` helper.
- `app/flows/message_dispatch.py` — collapse the four branches into one agent call; add steps 7 + 8; flag-guarded behind `USE_UNIFIED_AGENT`.
- `app/messaging/_safe_send.py` — accept `category` argument; on `AGENT_NUDGE` sends, dispatch updates the per-user/per-opp counters.
- `main.py` — add `tick_agent_review` scheduled function (every 30 min, quiet-hours-gated).
- `app/config.py` — `USE_UNIFIED_AGENT: bool = False`, `AGENT_REVIEW_INTERVAL_MIN: int = 30`, `AGENT_NUDGE_BUDGET_HOURS: int = 48`, `AGENT_NUDGE_PER_OPP_MAX: int = 2`, `AGENT_REVIEW_PER_TICK_MAX: int = 3`.

Deleted (only after one-week-clean post-cutover):
- `app/agent/classifier.py`
- `app/agent/ambiguous.py`
- `app/prompts/classifier.md`
- `app/prompts/ambiguous.md`
- `app/prompts/parser.md`, `parser_merge.md`, `parser_edit.md` (folded into `agent.md`)
- The retired branches in `message_dispatch.py`.

## Sequencing

1. Eval case sheet (`cases.py`) — written and reviewed with you before any agent code. This is the cheapest place to find disagreements.
2. Data model + repo additions + new `IntentLabel` values. Backwards-compatible; can ship independently.
3. `run_agent` + `agent.md`. Iterate against eval stub.
4. Dispatch rewrite + token matching + UNDO. Behind the flag.
5. Live eval run; iterate until parity.
6. Flag on in prod; one-week watch.
7. Cleanup pass (delete retired code).

Each step is independently revertable.
