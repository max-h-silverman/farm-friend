# Farm Friend — Architecture reference

The detailed map of how the system works and the invariants that must stay true. Read this before changing dispatch, the agent, flows, or anything in `app/agent/`, `app/flows/`, or `app/repos/`. Companion to `CLAUDE.md` (orientation), `docs/status.md` (history), and `docs/next-steps.md` (punch list).

## How the system works end-to-end

This section is the map. If you're trying to find where a behavior lives, start here. Specific invariants are in "Architecture invariants" below.

### Inbound flow (one SMS arrives)

The whole inbound pipeline lives in `app/flows/message_dispatch.py:_dispatch`. The order matters — earlier steps short-circuit later ones.

1. **Telnyx webhook** (`inbound_sms` HTTP function) → signature verification → JSON parse → `_dispatch`.
2. **Idempotency**: if `provider_msg_id` already exists in `messages`, return silently (handles Telnyx retries).
3. **Sender lookup** by phone. Unknown phone → `_handle_unknown_sender` → creates a `pending_users` doc for admin review, no auto-reply.
4. **UNSUBSCRIBED gate**: if `sender.status == UNSUBSCRIBED`, persist inbound for audit but do not reply.
5. **Persist inbound** as a `messages` doc (intent label filled in later).
6. **PENDING_CONFIRMATION token precedence**: if the most-recent outbound to this user is a live `PENDING_CONFIRMATION` and the inbound matches its `pending_action.token` (or an affirmative variant such as `YES`), execute the persisted action directly via `_execute_pending_action`. No LLM call. This must run before the hotkey parser so `YES` can confirm a pending action instead of claiming an opportunity.
7. **Deterministic hotkey parse** (`app/agent/hotkeys.parse`) — runs BEFORE any LLM call. Matches: `STOP`/`UNSUBSCRIBE`/`END`/`QUIT`/`CANCEL` (context-sensitive), `DROP` after reminder context, `HELP`/`INFO`, `JOIN`/`START`, `YES`/`YES N`, `YES <day>` for window claims, `MAYBE`, `MUTE`, `STOP <activity|farm>`, `UNAVAILABLE <window>`, `STATUS`, `INSIDER <phone>`, `FLAG`, `UNDO`, `PAUSE`/`RESUME`, `ACCEPT <token>` / `DECLINE <token>` for window-claim proposals, plus post-event Y/N when the prior outbound was a `POST_EVENT_CHECKIN`. Match → `_handle_hotkey` → return. **Compliance-required keywords never reach the LLM.**
8. **FLAG gate**: if `sender.id` has any open flag, return silently. Auto-replies pause until admin resolves the flag.
9. **PRE-AGENT UNDO window**: if the inbound contains "UNDO" and the most-recent outbound is an `ACTION_RECEIPT` within `settings.undo_window_min` (default 5 min), reverse the executed action.
10. **Build `AgentContext`** (`app/flows/agent_context.py`): sender state, sender's open claims, sender's farm + open opps if applicable, cross-cutting open opps system-wide, recent message excerpts, live pending action and executed action, known farms, canonical activities, mute summary.
11. **Call `run_agent`** (`app/agent/unified.py`) — one LLM call, one JSON output (`AgentOutput`). Any exception → flag for admin + fallback reply.
12. **Route on `output.mode`** (`_route_agent_output`):
    - `reply` → send `output.reply_text`, log as `QUESTION`
    - `clarify` → send `output.reply_text`, log as `CLARIFY` with `clarification_round` incremented
    - `confirm` → send `output.reply_text`, log as `PENDING_CONFIRMATION` with `pending_action` stored
    - `execute` → call mapped flow function (`claim_flow.handle_claim`, `farmer_ops.apply_edit`, etc.), send receipt, log as `ACTION_RECEIPT` with `executed_action`
    - `escalate` → `_handle_escalation`: create FLAG (pauses thread), send acknowledgment to user, text `coordinator_phone` if `urgency=immediate`

### Scheduled ticks (proactive flows)

All scheduled functions live in `main.py` (registration only) with logic in `app/flows/`. Each tick is **quiet-hours-gated at entry** — if the time is 11pm–7am Vashon-local, the tick no-ops and the next run catches up. Exception: `_handle_escalation` to the coordinator phone is never quiet-hours-gated.

| Tick | Cadence | Purpose |
|---|---|---|
| `tick_outreach` | every 5 min | Escalate opps whose insider-tier ping timed out; re-fire deferred initial outreach. |
| `tick_confirmations` | every 15 min | Send one-shot pre-event reminder to CONFIRMED claims within 24h (shifts) / 3h (pickups) of the event. |
| `tick_post_event` | every 15 min | Send "any issues? Y/N" check-in to the farmer the morning after a completed event. |
| `tick_unfilled_at_start` | every 15 min | Notify the farmer once if a shift starts unfilled. |
| `tick_proposals` | every 15 min | Auto-confirm stale PROPOSED window claims when the farmer has not accepted/declined in time. |
| `tick_stale_drafts` | every 30 min | Flag drafts older than 2h that never completed clarification. |
| `tick_agent_review` | every 30 min | Run the unified agent in `review` mode against board state; apply budget filters (per-user 48h, per-opp 2-lifetime, per-tick 3-global); send top proposals as `PENDING_CONFIRMATION`s. |

### State machines

- **Opportunity**: `draft → open → filling → full → completed` (or `cancelled` / `expired` from any state). Edges worth knowing: claim of last seat flips `filling → full`; volunteer drop flips `full → filling` and re-fires outreach; headcount edit up past `seats_filled` flips `full → filling`; headcount edit down below `seats_filled` is rejected (hard rule).
- **Claim**: `confirmed | proposed | interested (MAYBE — no seat) | waitlist | dropped`. CONFIRMED consumes `seats_filled`; PROPOSED holds window-claim capacity via `seats_held` until the farmer accepts or the auto-confirm timer fires. Drop is atomic and decrements the relevant counters in a transaction.
- **User**: `pending → active → suspended | unsubscribed`. Admin approves `pending → active`. `STOP` flips to `unsubscribed` and is permanent until admin clears.

### Cross-cutting safety mechanisms

These are spread across the codebase but conceptually belong together. Each one exists because a specific failure mode would otherwise be possible.

- **Receipt rail.** Every state-changing action emits an `ACTION_RECEIPT` outbound naming what was done. The receipt is what makes the affirmative-variant acceptance safe: if the user says "yes" to confirm and we did the wrong thing, they see the receipt and can `UNDO`.
- **UNDO window** (5 min default, `settings.undo_window_min`). After an `ACTION_RECEIPT`, the user can text `UNDO` to reverse. Outside the window, dispatch replies "too late to undo" and the user must take the forward action explicitly.
- **FLAG-pauses-thread.** Any user can text `FLAG` to report a bad reply. While any unresolved flag exists for that user, the agent does not auto-reply. Admin clears the flag to resume.
- **Quiet hours** (11pm–7am Vashon). All scheduled / broadcast outbound is deferred. Direct one-to-one replies to user-initiated messages send anytime.
- **Clarification cap.** Max 2 consecutive CLARIFY outbounds per thread; 3rd → routine escalation. Plus soft 24h-per-user cap of 5 CLARIFY outbounds.
- **Agent-nudge budget** (review tick only). Per-user 48h budget, per-opp 2-lifetime cap, per-tick global ceiling of 3. Enforced in dispatch, not in the prompt.
- **Token confirmation rail.** The unified agent never executes; it drafts. The user must reply with the action-specific token (or affirmative variant) before any state change runs. Dispatch is the only writer.
- **Repo-layer isolation.** All Firestore reads/writes go through `app/repos/*`. Business logic and the agent never import the Firestore SDK. Migration to a different store is a single-layer change.
- **`safe_send` invariant.** Every outbound SMS goes through `app/messaging/_safe_send.safe_send()`. Telnyx failures don't crash the webhook; they log and continue.

## LLM portability

The system is architected so the LLM can be swapped between Anthropic and any OpenAI-compatible provider (including self-hosted open-weight runtimes like vLLM) via config.

**An eval harness exists** at `functions/tests/evals/` — 50 cases (`cases.py`) covering REGRESSION, NEW_INTENT, ADVERSARIAL, and REVIEW categories, with a `runner.py` that supports both stub-LLM (for CI / harness-mechanic verification) and `--live` (real provider) modes. The runner picks the provider from the `LLM_PROVIDER` env var: `openai-compatible` needs `LLM_API_KEY` + `LLM_BASE_URL`; `anthropic` needs `ANTHROPIC_API_KEY`. Before swapping the default provider, re-run `python -m tests.evals.runner --live` against the candidate and require pass-rate parity with the existing baseline (Sonnet 4.6 hit 42/42 non-REVIEW cases). The cases were authored against the unified agent's output shape — if you swap to a provider whose JSON-following discipline is materially weaker, expect to either iterate the prompt or add a retry layer in the adapter.

**Don't reach for `litellm` or similar.** The Anthropic adapter is hand-rolled (~50 lines). The OpenAI-compatible path uses the OpenAI Python SDK with `base_url` swapped. Keep the dependency surface small.

**Provider-specific prompt tweaks are allowed but should be the exception.** Default to prompts that work cross-model; only branch when an eval shows a real quality gap on the target provider.

## Architecture invariants that should stay true

These are baked into the design — changing any of them is a real refactor, not a minor tweak. Verify before deviating:

- **`docs/sms-compliance-requirements.md` is authoritative for SMS-facing behavior.** Keyword handling, opt-in/opt-out copy, help reply text, and the LLM-bypass list are derived from there. Drift between code and that doc must be fixed in the code, not the doc.
- **LLM never runs on a compliance-mandated keyword.** Hard list: `STOP`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT`, `HELP`, `INFO`, `JOIN`, `START`, `YES`, `YES N`, `MUTE`, `FLAG`. Deterministic parsing first; if there's a match, LLM is bypassed entirely.
- **The unified agent never drafts compliance-required copy.** Opt-in confirmation, opt-out confirmation, and the help reply are sent verbatim by the deterministic hotkey path. The agent's `mode="reply"` and `mode="confirm"` outputs are for everything else.
- **Agent-drafted initiating outbounds include the program name "Farm Friend Vashon" and an opt-out path.** Direct in-thread replies, clarifications, confirmation prompts, receipts, and commitment acknowledgments do not repeat STOP. Enforced by prompt and spot-checked in eval.
- `repos/` is the only package that imports `google.cloud.firestore`. Business logic goes through repos.
- All outbound SMS goes through `app.messaging._safe_send.safe_send()` — never call `provider.send()` directly. Failures must not crash the webhook.
- The deterministic hotkey parser runs BEFORE the unified agent. Common-path messages (YES / STOP / HELP / FLAG / MUTE / JOIN / INSIDER, plus PAUSE / RESUME / UNDO and post-event Y/N when expected) never cost an LLM call.
- **Pre-agent dispatch steps run before the agent.** In order: idempotency check, sender lookup, UNSUBSCRIBED gate, inbound persistence, token-match against a live PENDING_CONFIRMATION, hotkey parse, FLAG-pauses-thread, UNDO window. Each step that fires returns without invoking the agent.
- The LLMClient interface is `chat_json(messages, schema, *, cache_system_prompt=False)` — single entrypoint, JSON-only output. Don't add features that work only on Anthropic (tool-use loops, etc.) without first justifying it in the eval harness.
- `firebase_app.py`'s `db` and `auth` are lazy — they don't connect until first attribute access. Don't change to eager init or `firebase deploy` analyzer will fail.
- Opportunity state machine: `draft → open → filling → full → completed` (or `cancelled`/`expired`). Status flips happen even when outbound delivery fails — outreach is best-effort.
- **Required-field rules for opportunities live in code (`agent/parser.py: REQUIRED_SHIFT_FIELDS / REQUIRED_PICKUP_FIELDS`), not just in the prompt.** `compute_missing_fields()` is the authoritative server-side check; the LLM's own `missing_fields` output is overwritten by it after parsing/merging. `activity_tags` is on the required-shift list — empty list counts as missing; `["tbd"]` is a satisfying value. Changing what's required for a shift or pickup means updating both constants and the agent prompt (`prompts/agent.md`).
- **Clarification flow re-uses the `draft` status.** A draft opportunity within ~2h of creation is the dispatch path's signal to route an inbound farmer message to the merge parser instead of treating it as a new post. `tick_stale_drafts` (every 30 min) flags drafts older than 2h that never completed — admin handles abandoned ones manually.
- **Confirmation reminders are one-shot per claim, tracked on the claim doc.** `ClaimDoc.confirmation_sent_at` is the idempotency marker. The lead-time constants (`SHIFT_LEAD_TIME=24h`, `PICKUP_LEAD_TIME=3h`) live in `flows/confirmations.py`. A volunteer DROP routes to a drop when the user's last outbound on the opp is a `CONFIRMATION_REMINDER`; legacy CANCEL works only in that reminder context. Outside clear farmer/reminder context, CANCEL unsubscribes.
- **Volunteer drop unwinds atomically.** `opportunities_repo.drop_confirmed_claim_in_transaction` decrements `seats_filled`, flips FULL→FILLING, and marks the claim DROPPED in one txn. The flow then resets `next_escalation_at` to `now` so the existing `tick_outreach` re-pings the pool (skipping anyone already pinged/claimed/muted). Farmer is notified out-of-band; that send is best-effort.
- **ESCALATE is its own first-class agent mode, not a confidence fallback.** The unified agent emits `mode="escalate"` with `escalation.reason` and `escalation.urgency` (`routine` | `immediate`). Dispatch's `_handle_escalation` then: (1) creates a FLAG so further auto-replies on the thread pause until admin clears, (2) sends a contextual reply with a coordinator handoff line, (3) if `immediate`, texts `settings.coordinator_phone`. The coordinator phone is read from `COORDINATOR_PHONE` env var — without it, urgent escalations still flag + reply but do not page Max.
- **`OpportunityDoc.last_updated_at` is the staleness clock for drafts.** Auto-bumped by `opportunities_repo.update_fields` on every write. The stale-draft tick reads `last_updated_at` (with `created_at` fallback for legacy drafts). Don't introduce a code path that writes opp fields outside `update_fields` without also stamping this — otherwise a live clarification can get flagged as stale.
- **LLM provider is config-switchable.** The unified agent uses one `chat_json(model_tier="strong", …)` call per inbound and per review tick. The default is Llama 3.3 70B Instruct on DeepInfra (`LLM_PROVIDER=openai-compatible`); Anthropic Sonnet 4.6 is preserved as a fallback (`LLM_PROVIDER=anthropic`). Changing the default requires re-running `python -m tests.evals.runner --live` against the candidate and requiring pass-rate parity. The runner picks the provider from `LLM_PROVIDER` automatically.
- **`FlagDoc.message_id` is optional.** It's only set when the flag is anchored to a specific inbound MessageDoc. System-raised flags (review-tick proposals, agent-failure backstops, invalid-token rails, missing-fields fallbacks) leave it `None`. Pydantic v2 enforces this — passing a literal `None` to a `str` field crashes at validation; if you add a new flag-creation path, leave `message_id` unset (default `None`) for system-raised flags.
- **Over-confirm backstop on `create_opportunity`.** Smaller open-weight models occasionally emit `mode=confirm` with required fields filled from defaults (the prompt forbids this but the rule isn't always sticky on instruction-following). `_agent_overconfirm_reason` in `message_dispatch.py` runs before `_send_pending_confirmation` fires; it downgrades to `mode=clarify` and flags for admin on any of three signals: (1) `parse_notes` self-reports filling from defaults ("default", "inferred", "typical", "assumed", "guessing"), (2) `starts_at` is set but the inbound has no clock-time signal and no `time_of_day_bucket`, (3) a canonical activity slug is in `activity_tags` but the inbound has no activity word, plus the non-flagging server-authoritative `compute_missing_fields` check that catches any still-missing required axis before confirmation. Scoped to `create_opportunity` only — `update_draft_opportunity` legitimately carries fields forward from the existing draft. The eval runner mirrors this so eval results reflect production behavior. User-facing clarify copy comes from `_clarify_for_overconfirm`, which translates internal reason strings into farmer-friendly questions via `_FIELD_QUESTIONS` — never leaks raw schema field names. Date-range phrasings now drive real window posts via `window_end_at` instead of a stopgap rejection.
- **In-thread agent replies do NOT include "STOP to opt out".** Direct replies, clarifications, confirmation prompts, receipts, and commitment acknowledgments stay clean. Only initiating-contact outbounds (broadcast outreach, intro messages, review-tick nudges to silent users) and the deterministic compliance hotkey replies (HELP/STOP/JOIN/FLAG) carry the STOP path. Agent prompt Rule 5 enforces this. Compliance copy (`render_help`, `render_stop_ack`, `render_join_ack`, `render_flag_ack`) is exempt — those are carrier-pinned and unchangeable without re-registering.
