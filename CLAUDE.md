# Farm Friend

SMS-first agentic system for coordinating volunteer help on Vashon Island farms.

## Status (as of 2026-05-27)

**v1 codebase is built and deployed.** All Firebase functions, Firestore data model, admin SPA, and SMS pipeline are live in the `farm-friend-vashon` project. End-to-end smoke test confirmed: an inbound farmer SMS gets parsed (now by the unified agent), persists as an `Opportunity`, and the admin SPA picks it up in real time.

**v1.1 — post-refactor hardening + OSS LLM swap (in progress, 2026-05-27):** a fresh architectural review on top of the unified-agent refactor surfaced a small set of fixes that all landed in the same session:
- SMS-compliance template drift fixed (`render_intro_*`, `render_orphan_yes`, `render_fallback_ambiguous` now carry "Farm Friend Vashon" + STOP path; unknown-sender JOIN ack now persists an outbound MessageDoc for audit).
- Dead/stale code removed: `classifier_confidence_threshold`, `MessageDoc.confidence`, unused `IntentLabel.YES` / `IntentLabel.EDIT`, stale "classifier"/"ambiguous"/"four-branch" comments throughout.
- `_apply_farm_defaults` is now actually called from dispatch (`_execute_create_opportunity` and `_execute_update_draft_opportunity`) as the docstring always claimed — fills `duration_min` from `typical_shift_duration_min` when the farmer didn't specify, never fills required fields.
- Headcount-up edits past `seats_filled` now call `set_next_escalation` so the existing tick re-pings the pool (`farmer_ops.apply_edit`).
- Stale-draft tick uses `last_updated_at` (auto-bumped on every `update_fields` write) as the staleness clock so a live clarification mid-dialog doesn't get flagged. `last_updated_at` is a new optional field on `OpportunityDoc`; legacy drafts without it fall back to `created_at`.
- Clarification-streak counter is now derived by walking the message stream (`_consecutive_clarify_count`) rather than read off the latest outbound's `clarification_round` field — robust to non-CLARIFY outbounds sitting between two CLARIFY turns.
- Dead `if mutes_repo.is_muted(...): pass` branch removed from `board_review._route_review_proposals` (the agent_nudge mute check is the real one).
- **LLM default is now an OSS model:** Llama 3.3 70B Instruct on DeepInfra (`LLM_PROVIDER=openai-compatible`, `LLM_BASE_URL=https://api.deepinfra.com/v1/openai`). Anthropic Sonnet 4.6 is still selectable by setting `LLM_PROVIDER=anthropic`. **Eval gate cleared 2026-05-27:** the live `--live` run against DeepInfra hits 53/54 deterministically; the single flake (`reg.farmer.cancel.unique_match`) passes on re-run in isolation — same intermittent behavior the Sonnet 4.6 baseline showed. Pass-rate parity with the Anthropic baseline achieved.
- **Three things were needed to get there**, all worth knowing for a future provider swap:
  - **Adapter quirk for DeepInfra:** `response_format=json_schema` is accepted by the API but not actually enforced — Llama writes prose anyway. The adapter (`openai_compat_adapter.py`) now detects `deepinfra` in the base URL and skips straight to `json_object` + schema-in-system-prompt. Other OpenAI-compatible providers that honor `json_schema` (OpenAI proper, vLLM with guided_json) keep the fast path. There's also a `LLM_FORCE_JSON_OBJECT=1` env override for any provider that needs the same treatment.
  - **Prompt round (`prompts/agent.md`):** added "Rule 0: Default to asking, not acting" at the top of the system prompt with 7 worked examples covering the exact failure modes (polite-decline, missing-time, crop-name-no-activity, headcount-down hard-block, unknown-activity-slug, affirmative-to-clarify, volunteer-offer-as-question). Tightened token-length rule with character counts and good/bad examples.
  - **Server-side over-confirm backstop** (`_route_agent_output` + `_agent_overconfirm_reason` in `message_dispatch.py`): when the agent emits `mode=confirm + action=create_opportunity` with self-incriminating `parse_notes` ("default", "inferred", "typical") OR with `starts_at` filled but no clock-time signal in the inbound OR with a canonical activity slug populated but no activity word in the inbound, dispatch downgrades to `mode=clarify` and flags for admin. Scoped to `create_opportunity` only — `update_draft_opportunity` legitimately carries fields forward from the draft. Eval runner mirrors this so eval results reflect what real users see.

96/96 unit tests pass and the OSS path is eval-green. Cutover is unblocked.

**Unified-agent refactor — shipped, eval-gated, ready for pilot (as of 2026-05-27):** the v1 classifier/ambiguous/parser trio has been replaced by `app/agent/unified.py` (one role-aware agent, one prompt at `app/prompts/agent.md`, structured JSON output) plus a rewritten `_dispatch` in `app/flows/message_dispatch.py`. The reactive path handles inbound messages with token-gated state changes (5-8 char uppercase alphanumeric, no hyphens) and 5-min UNDO via `ACTION_RECEIPT` outbounds. A proactive review path (`tick_agent_review` every 30 min, gated by quiet hours) runs the same agent in review mode and surfaces nudges through deterministic budget filters: per-user 48h budget, per-opp 2-lifetime cap, per-tick global ceiling of 3. Users can `PAUSE` / `RESUME` agent-initiated nudges. The motivating bug — volunteer-initiated "anyone need tilling Friday?" — is now a first-class `record_offer` flow. Plan: `docs/refactor-unified-agent.md`. Eval spec: `functions/tests/evals/cases.py` (50 cases: 16 REGRESSION, 13 NEW_INTENT, 13 ADVERSARIAL, 8 REVIEW). **Live `--live` eval against real Anthropic passes all 42 non-REVIEW cases**; REGRESSION + NEW_INTENT exact-match, ADVERSARIAL behavioral match (with `reply`/`clarify` interchangeable for non-state-changing intents). REVIEW cases are still skipped in the runner — they need the `board_review` integration but that's not on the cutover path. Sonnet 4.6 is mildly non-deterministic — expect 1–2 sporadic JSON-shape flakes per full sweep; re-running the affected case individually almost always passes.

**Recent hardening pass (2026-05-26)** added: transactional claim resolution, inbound webhook idempotency, post-event reschedule on edits, intent-label-based post-event detection, orphan-YES flag-and-reply, **pre-event confirmation reminders + volunteer CANCEL flow**, **quiet hours (11pm–7am Vashon)**, **first-class `ESCALATE` intent with `routine`/`immediate` urgency** that texts the coordinator on urgent triggers. Admin SPA repainted as a dark-mode control panel. See "Next steps" → "Recent fixes" for the full list and what's still deferred.

**Blocked on Telnyx A2P 10DLC campaign approval** (submitted 2026-05-25; brand verified within hours, campaign in carrier review; expected to clear within a few days based on the preview showing no MNO Review required).

**Once approval lands**, the remaining work to start the real pilot is small (see "Next steps" at the bottom of this file).

## What this is

Farms (mostly small, VIGA-affiliated) need volunteer help — gleaning, weeding, harvest. Volunteers (a mix of retirees, gardeners, food-system enthusiasts) want to help but need low-friction discovery and signup. The previous human-coordinator approach didn't scale. Farm Friend replaces it with an agentic SMS workflow: the system decides who to ping, when to escalate, how to interpret replies, and when to check in after an event — autonomously.

## Roles

- **Coordinator (Max)** — sole admin. Approves new users into the pool; monitors flagged messages and system health; receives immediate SMS for urgent escalations (injury, safety, payment, distress). Does *not* participate in every event cycle.
- **Farmer** — interacts only via SMS. Posts shifts and surplus pickups in free-form text, nominates "insiders" (trusted volunteers) by texting in their phone numbers, answers a post-event check-in.
- **Volunteer** — interacts only via SMS. Claims opportunities via `YES`; uses hotkeys to mute/opt-out.

## Opportunity types

Two distinct posting types share users, insiders, mute rules, and the agent layer but have their own shapes:

- **Volunteer Shift** — timed, headcount-bounded work at the farm with an `activity` from the canonical list:
  - **Work-type slugs** (used on both farmer and volunteer sides): `harvest`, `gleaning`, `weeding`, `planting`, `transplanting`, `livestock`, `infrastructure`, `processing`. Harvest and gleaning are distinct (harvest = main crop, may need technique; gleaning = leftovers, usually for food bank).
  - **Side-asymmetric slugs** (not interchangeable):
    - `tbd` — **farmer-side only.** Used when the farmer explicitly says they don't yet know what the work will be ("not sure what we'll do — just need extra hands"). Means "work type is intentionally open; whoever shows up will do whatever needs doing." Outreach copy renders this as "general farm work — TBD" so volunteers know what they're signing up for.
    - `flexible` — **volunteer-side only.** Used on offers when the volunteer signals openness to any activity ("I'm open to anything", "any physical work"). Matching: a `flexible` offer matches any opp; a `tbd` opp matches any offer. The agent prompt forbids cross-stream use (no `tbd` on offers, no `flexible` on opps).
  - **`activity_tags` is REQUIRED for shifts** (`parser.py:REQUIRED_SHIFT_FIELDS`). Empty list counts as missing. The agent must either resolve to a canonical slug from explicit signal, or recognize explicit `tbd`/`flexible` framing, or clarify — it must never infer activity from a crop name ("tomatoes" alone is not enough).
- **Surplus Pickup** — single-claim race for already-set-aside produce that needs to be picked up and taken to a destination (food bank, community fridge, mutual aid). Faster outreach pacing (perishable). Often needs a vehicle.

Farmers can suggest new activities (texted as part of a post); the agent flags unknown activities for admin approval into the canonical list. Mute rules act on activity slugs directly (`STOP harvest` is distinct from `STOP gleaning`).

## Design philosophy

- **The system runs autonomously; the coordinator moderates.** Default to letting the agent act and surfacing the result to the admin view, rather than blocking on human approval. The one manual gate is admitting new users.
- **SMS is the universal channel, but the core is channel-agnostic.** Everything routes through a `MessagingProvider` abstraction. Don't bake Telnyx-specific assumptions into business logic.
- **Tiered outreach, not blast.** Farmers nominate insiders; insiders ping first; broader pool only if seats stay unfilled. Keeps message volume (and cost) low and quality high.
- **The agent does the nagging.** Post-event check-ins, escalations, follow-ups, and pre-event confirmation reminders — the system remembers so humans don't have to.
- **One pre-event reminder per commitment, with an easy out.** Confirmed volunteers get one "you're scheduled to help… reply CANCEL if you can't make it" SMS in the 24h before a shift (3h before a pickup). Silence = still in. A CANCEL drops the seat, re-fires outreach for the gap, and notifies the farmer. Designed to catch the most common failure mode (people forget plans) without nagging.
- **Quiet hours: 11pm–7am Vashon local.** All scheduled/broadcast outbound (initial outreach, escalation, post-event checkin, confirmation reminder, unfilled-at-start) is deferred during this window; the next scheduled tick after 7am picks it up. Direct one-to-one replies and notifications to explicit user actions (claim acks, edit/cancel fan-outs, volunteer-drop notifications) send anytime — deferring an acknowledgment of something the user just did is worse than slightly off-hours timing.
- **FLAG is sacred.** Any user can text `FLAG` to report a bad system reply. Stops auto-replies on that thread and surfaces to admin immediately. The trust safety valve.
- **The LLM handles operational complexity; it escalates only on narrow, well-defined triggers.** Scheduling conflicts, swap requests, plan changes, and weird postings are *not* escalations — the system has flows and the model has latitude to use them. The model escalates (intent=`ESCALATE`) only for: injury/medical, liability/insurance/legal, payment/money, property damage, interpersonal disputes/harassment, emotional distress, or threats/safety. The model also chooses urgency: `routine` (flag for the next admin review) or `immediate` (also text the coordinator's phone right now). Overcautious escalation is a real failure mode — operational complexity is the system's job, not Max's.
- **Deterministic before LLM.** Hotkeys are parsed by regex first. The LLM only runs on messages that aren't a hotkey. Cheaper, faster, and more reliable for the common path.

## SMS compliance (A2P 10DLC — authoritative requirements)

**`docs/sms-compliance-requirements.md` is the source of truth for all SMS-facing behavior.** It encodes the language we submitted to Telnyx for carrier campaign approval. Any change that affects SMS copy, keyword handling, opt-in/opt-out, or LLM invocation rules must be checked against that document. If this CLAUDE.md and the compliance doc ever disagree, the compliance doc wins.

Hard rules derived from the compliance doc:

- **Program name:** Outbound SMS uses "Farm Friend Vashon" — full name, not "Farm Friend" — on all compliance-required messages (opt-in confirmation, opt-out confirmation, help reply, FLAG ack) and on every operational alert where space allows.
- **Mandatory deterministic keywords** (parsed BEFORE any LLM call; LLM must NOT run on any of these):
  - Opt-in: `JOIN`, `START`
  - Opt-out: `STOP`, `UNSUBSCRIBE`, `END`, `QUIT` (all are global unsubscribe; `CANCEL` is context-sensitive — see below)
  - Help: `HELP`, `INFO`
  - Operational: `YES`, `YES N`, `MUTE`, `FLAG`
- **Exact copy** is required for opt-in confirmation, opt-out confirmation, and the help reply. See the compliance doc §"Required Auto-Responses." The unified agent NEVER drafts these — they are sent verbatim by the deterministic hotkey path. Updating the wording requires re-registering the campaign with Telnyx.
- **`YES` is claim-only, never opt-in.** A `YES` from an unsubscribed or unknown number does NOT subscribe them — it gets the orphan-YES flag-and-reply treatment. New users must text `JOIN` or `START`.
- **`CANCEL` is context-sensitive — a documented divergence from the campaign language.** The campaign description lists CANCEL among opt-out keywords. Our implementation keeps the legacy farmer-cancel and volunteer-drop meanings *when there is clear context* (the sender is a farmer with an open post they're referencing, or a volunteer whose last outbound was a `CONFIRMATION_REMINDER`). With no context, `CANCEL` falls through to global unsubscribe like `STOP`. **This is a deliberate product decision** to preserve the v1 SMS UX; if a carrier raises it during audit, the answer is "behavior matches user intent in context; ambiguous CANCEL always unsubscribes." Re-evaluate if it ever causes a real complaint.
- **Frequency disclosure.** Opt-in flow and printed signup must say "Message frequency varies based on farm needs, usually 0–6 messages per week." The unified agent's per-user 48h budget (1 agent-initiated outbound per 48h, not counting scheduled flows the user consented to) is the operational mechanism that keeps us within this band; the budget is configurable but should not be raised without re-evaluating the campaign registration.
- **All operational alerts include an opt-out path.** Every outbound the agent drafts (confirmation prompts, receipts, review-tick nudges, op-alert SMS) carries either an explicit STOP path or is part of a thread where STOP was offered recently. The deterministic hotkey path is the safety net; agent-drafted prose should still mention STOP where the message is initiating contact or asking for an action.

The compliance doc also has a launch checklist (§"Implementation Checklist"). It must be green before the pilot starts.

## Hotkey vocabulary (the SMS API)

Compliance-required keywords (see `docs/sms-compliance-requirements.md`):
- `JOIN` / `START` — opt-in (admin-approved). `START` is a synonym for `JOIN`.
- `STOP` / `UNSUBSCRIBE` / `END` / `QUIT` — global unsubscribe (TCPA). All four behave identically.
- `HELP` / `INFO` — return the compliance-required help reply.
- `YES` / `YES N` — claim an opportunity (optionally N slots). NOT an opt-in.
- `MUTE` — silence followups on the current opportunity only.
- `FLAG` — report wrong/confusing system reply.

Product keywords:
- `MAYBE` — express soft interest, no seat held.
- `CANCEL` — context-sensitive (see "SMS compliance" above for the divergence note). For volunteers with a recent `CONFIRMATION_REMINDER`: drops a confirmed claim. For farmers with an open post: cancels it. With no context: behaves like `STOP`.
- `STOP {activity}` — mute an activity type.
- `STOP {farm name}` — mute a specific farm.
- `UNAVAILABLE {window}` — silence everything during a window.
- `STATUS` — farmer-only: snapshot of open posts and how they're filling.
- `INSIDER {phone} {name}` — farmer-only: nominate a trusted volunteer.

Refactor-introduced keywords (active 2026-05-26 refactor; see `docs/refactor-unified-agent.md`):
- `UNDO` — reverse the most recent agent-executed action within 5 minutes.
- `PAUSE` — mute agent-initiated nudges (review-tick proposals) for 14 days. Does NOT affect scheduled flows the user consented to (confirmation reminders, post-event check-ins) or direct replies to user-initiated messages.
- `RESUME` — undo `PAUSE`.

Confirmation tokens (drafted by the unified agent per action; not a fixed vocabulary):
- Tokens are 5–8 uppercase alphanumeric, no hyphens, must not collide with any keyword above.
- Examples the agent might pick: `CONFIRM`, `DROP`, `EDITOK`, `ADDSAT`, `OFFER`, `DROPOPP`.
- Affirmative variants (`yes`, `ok`, `sure`, `confirm`, `go ahead`) are accepted as a token match for a live `PENDING_CONFIRMATION`. Receipt rail catches mis-resolution.

## Stack

- **Backend:** Firebase (chosen for builder familiarity from the Splash project)
  - **Firebase Functions (Python, 2nd gen)** — HTTP webhook for inbound SMS, scheduled functions for tier escalation and post-event checkins, callable functions for admin actions
  - **Firestore** — document database with real-time updates (powers the admin view live)
  - **Firebase Auth** — admin login (Google sign-in for Max)
  - **Firebase Hosting** — static hosting for the admin SPA
  - **Cloud Scheduler** (via scheduled functions) — recurring escalation checks
- **SMS:** Telnyx (abstracted behind `MessagingProvider`)
- **LLM:** abstracted via internal `LLMClient` (OpenAI-format wire protocol, opt-in Anthropic cache hints). **v1.1 default is an OSS path: Llama 3.3 70B Instruct hosted on DeepInfra**. Anthropic Sonnet 4.6 remains a config-switchable fallback. The unified-agent refactor consolidated the v1 trio of LLM calls into a single `model_tier="strong"` call per inbound, so a single OSS model in that size class is sufficient (no separate fast path is needed in production).
  - Current default: `LLM_PROVIDER=openai-compatible`, `LLM_BASE_URL=https://api.deepinfra.com/v1/openai`, `LLM_MODEL_STRONG=meta-llama/Llama-3.3-70B-Instruct`. Key from `LLM_API_KEY` secret.
  - Fallback: `LLM_PROVIDER=anthropic`, `LLM_MODEL_STRONG=claude-sonnet-4-6` (cached system prompt honored).
  - Other OpenAI-compatible providers (Together, Fireworks, Groq, vLLM, Ollama) work by swapping `LLM_BASE_URL`. No SDK changes needed.
  - The adapter prefers `response_format=json_schema` and falls back to `json_object` with the schema concatenated into the existing system message (single system message, no second one prepended — some providers honor only the first).
- **Admin UI:** Vanilla TypeScript + Alpine.js on Firebase Hosting, talking to Firestore directly via the Firebase JS SDK

## Firebase conventions

- **Functions in Python, 2nd gen.** Python is GA on Firebase Functions; keeps agent code + business logic in one language. Defer to `firebase-functions` Python SDK patterns.
- **Repository layer required.** All Firestore reads/writes go through repository functions in `functions/app/repos/` (e.g., `users_repo.get_by_phone`). Business logic does not import the Firestore SDK directly. This isolates the data store so migration is a single-layer change.
- **Collections** (top-level, with subcollections where relational):
  - `users` (phone-indexed; includes onboarding-captured availability)
  - `farms` (owned by a farmer user; includes onboarding-captured defaults like `typical_start_hour`, `typical_shift_duration_min`)
  - `farms/{farmId}/insiders` (subcollection: volunteer_id, added_at)
  - `opportunities` (kind: shift | pickup; status: draft | open | filling | full | completed | cancelled | expired; tracks `post_event_checkin_at`, `next_escalation_at`, once-per-opp farmer notification flags)
  - `opportunities/{oppId}/outreach` (subcollection: per-tier ping log)
  - `opportunities/{oppId}/claims` (subcollection; tracks `status` ∈ confirmed|interested|waitlist|dropped, plus `confirmation_sent_at` for the pre-event reminder idempotency marker)
  - `mute_rules` (volunteer_id, dimension, value)
  - `messages` (direction, body, `intent_label`, confidence, user_id, opportunity_id, provider_msg_id) — TTL purge after 90 days unless flagged. `intent_label` on *outbound* messages is load-bearing: `POST_EVENT_CHECKIN` and `CONFIRMATION_REMINDER` let inbound dispatch route Y/N and CANCEL replies correctly without substring-matching the body.
  - `flags` (message_id, flagged_by, reason, resolved_at). An open flag for a user pauses LLM auto-replies on their thread.
  - `offers` (volunteer-initiated offers of help: activity tags, time window, status, optional matched_opportunity_id). Added by the unified-agent refactor.
  - `pending_users` (JOIN requests + farmer nominations awaiting admin approval)

- **Scheduled functions** (all in `main.py`, all Cloud Scheduler-driven). Each tick gates on quiet hours at its entry point — if it's 11pm–7am Vashon, the tick no-ops and the next run catches up.
  - `tick_outreach` (every 5 min) — escalates opps whose insider tier has timed out; also re-fires deferred initial outreach when an opp's insider tier was never pinged (quiet-hours deferral).
  - `tick_confirmations` (every 15 min) — sends the one-shot pre-event reminder to each CONFIRMED claim within 24h (shifts) or 3h (pickups) of the event.
  - `tick_post_event` (every 15 min) — sends the "any issues? Y/N" check-in to the farmer the morning after.
  - `tick_unfilled_at_start` (every 15 min) — notifies the farmer once if a shift starts unfilled.
  - `tick_stale_drafts` (every 30 min) — flags drafts >2h old that never completed clarification.
- **Indexes**: define in `firestore.indexes.json` and check in. Don't rely on auto-creation in dev.
- **Security rules**: `firestore.rules` denies all client access by default. Admin SPA reads via Auth; Functions write with service-account creds. Public clients cannot read or write anything.
- **Don't use Firestore real-time listeners on the server side.** Functions read on demand; real-time is for the admin SPA only.

## How the system works end-to-end

This section is the map. If you're trying to find where a behavior lives, start here. Specific invariants are in "Architecture invariants" at the bottom of the file.

### Inbound flow (one SMS arrives)

The whole inbound pipeline lives in `app/flows/message_dispatch.py:_dispatch`. The order matters — earlier steps short-circuit later ones.

1. **Telnyx webhook** (`inbound_sms` HTTP function) → signature verification → JSON parse → `_dispatch`.
2. **Idempotency**: if `provider_msg_id` already exists in `messages`, return silently (handles Telnyx retries).
3. **Sender lookup** by phone. Unknown phone → `_handle_unknown_sender` → creates a `pending_users` doc for admin review, no auto-reply.
4. **UNSUBSCRIBED gate**: if `sender.status == UNSUBSCRIBED`, persist inbound for audit but do not reply.
5. **Persist inbound** as a `messages` doc (intent label filled in later).
6. **Deterministic hotkey parse** (`app/agent/hotkeys.parse`) — runs BEFORE any LLM call. Matches: `STOP`/`UNSUBSCRIBE`/`END`/`QUIT`/`CANCEL` (context-sensitive), `HELP`/`INFO`, `JOIN`/`START`, `YES`/`YES N`, `MAYBE`, `MUTE`, `STOP <activity|farm>`, `UNAVAILABLE <window>`, `STATUS`, `INSIDER <phone>`, `FLAG`, `UNDO`, `PAUSE`/`RESUME`, plus post-event Y/N when the prior outbound was a `POST_EVENT_CHECKIN`. Match → `_handle_hotkey` → return. **Compliance-required keywords never reach the LLM.**
7. **FLAG gate**: if `sender.id` has any open flag, return silently. Auto-replies pause until admin resolves the flag.
8. **PRE-AGENT step 1 — token match**: if the most-recent outbound to this user is a live `PENDING_CONFIRMATION` and the inbound matches its `pending_action.token` (literal or an affirmative variant), execute the persisted action directly via `_execute_pending_action`. No LLM call.
9. **PRE-AGENT step 2 — UNDO window**: if the inbound contains "UNDO" and the most-recent outbound is an `ACTION_RECEIPT` within `settings.undo_window_min` (default 5 min), reverse the executed action.
10. **PRE-AGENT step 3 — clarification cap**: if the consecutive CLARIFY-outbound streak to this user is at `settings.clarify_round_max` (default 2), escalate to admin without another LLM call. Also a soft 24h cap of `clarify_user_24h_max` (default 5) CLARIFY outbounds per user per day.
11. **Build `AgentContext`** (`_build_agent_context`): sender state, sender's open claims, sender's farm + open opps if applicable, cross-cutting open opps system-wide, recent message excerpts, live pending action and executed action, known farms, canonical activities, mute summary.
12. **Call `run_agent`** (`app/agent/unified.py`) — one LLM call, one JSON output (`AgentOutput`). Any exception → flag for admin + fallback reply.
13. **Route on `output.mode`** (`_route_agent_output`):
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
| `tick_stale_drafts` | every 30 min | Flag drafts older than 2h that never completed clarification. |
| `tick_agent_review` | every 30 min | Run the unified agent in `review` mode against board state; apply budget filters (per-user 48h, per-opp 2-lifetime, per-tick 3-global); send top proposals as `PENDING_CONFIRMATION`s. |

### State machines

- **Opportunity**: `draft → open → filling → full → completed` (or `cancelled` / `expired` from any state). Edges worth knowing: claim of last seat flips `filling → full`; volunteer drop flips `full → filling` and re-fires outreach; headcount edit up past `seats_filled` flips `full → filling`; headcount edit down below `seats_filled` is rejected (hard rule).
- **Claim**: `confirmed | interested (MAYBE — no seat) | waitlist | dropped`. CONFIRMED is the only status that consumes a seat. Drop is atomic and decrements `seats_filled` in a transaction.
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

## Operating constraints

- **Cost-sensitive.** Max is paying out of pocket for a pilot. Target: under $30/month total at pilot scale (~50 volunteers, 2–3 farms). Watch SMS volume and LLM call frequency.
- **Pilot scale.** 2–5 farms, 20–50 volunteers in v1. Don't optimize for scale we don't have.
- **Privacy.** Firestore is encrypted at rest by default. Minimal PII; 90-day TTL on `messages` (Firestore TTL field). Don't log raw PII in observability tools.
- **TCPA compliance.** `STOP` must immediately unsubscribe and prevent further outbound messages to that number. `HELP` must return a description of the service.
- **Quiet hours.** 11pm–7am Vashon local. Gated at the entry point of each scheduled tick (so the tick simply no-ops and the next run catches up) and as an optional flag on `safe_send` for any explicit broadcast paths. Helpers live in `app/flows/_time.py`: `is_quiet_hours()`, `next_quiet_hours_end()`. Quiet hours do NOT gate ESCALATE handoffs to the coordinator — an injury report at 2am needs to land.
- **Cold starts.** Firebase Functions 2nd gen has cold starts. Set `min_instances=1` on the SMS webhook function so Telnyx never times out. Other functions can scale to zero.

## Don't

- Don't add a farmer-facing web portal in v1 — farmers stay on SMS.
- Don't build a public volunteer signup page in v1 — admin onboards manually.
- Don't add reputation scores, skill registries, or training tracking — replaced by activity-type mutes + farmer free-text requirements.
- Don't blast the broader pool when insider tier would suffice.
- Don't auto-reply on a thread after the user has texted `FLAG` until admin clears it.
- Don't store raw message content longer than 90 days unless it's tied to an active opportunity or open flag.
- Don't add `litellm` or similar omnibus LLM-routing libraries; hand-roll the thin adapters.
- Don't change the default LLM provider without first re-running the live eval (`python -m tests.evals.runner --live` from `functions/`) against the candidate and requiring pass-rate parity with the existing baseline (Sonnet 4.6 cleared 42/42 non-REVIEW cases; Llama 3.3 70B is the current default, pending its own eval pass).
- Don't import the Firestore SDK from business logic — go through the `repos/` layer.

## Repo conventions

- Monorepo. `functions/` is the Firebase Functions Python package; `web/` is the admin SPA; `firestore.rules`, `firestore.indexes.json`, `firebase.json` at the root.
- `functions/` uses Python 3.12, `pyproject.toml`.
- SMS-facing copy lives in `functions/app/copy/` as plain text or Jinja templates, not interpolated in business logic. Easy to A/B and review.
- Tests in `functions/tests/`. Use the Firestore emulator for integration tests.
- All datetime values are timezone-aware UTC at the boundary; convert to America/Los_Angeles only for human-facing SMS copy.

---

## Next steps

This list is the source of truth for "what's the next thing to do." Update it as state changes — it's what a fresh session needs to read to know where to pick up.

### Blocked on external (no action needed from us right now)

- [ ] **Telnyx campaign approval.** Submitted 2026-05-25. Brand verified. Carrier preview showed no MNO Review required. Check the Telnyx 10DLC Campaigns dashboard. Expected: hours to a few days.

### P0 — must land before pilot

- [x] **Unified-agent refactor — code complete.** Files: `app/agent/unified.py`, `app/prompts/agent.md`, `app/flows/board_review.py`, dispatch rewrite in `app/flows/message_dispatch.py`. Retired: `app/agent/classifier.py`, `app/agent/ambiguous.py`, `app/prompts/{classifier,ambiguous,parser,parser_merge,parser_edit}.md`, the LLM-calling functions in `app/agent/parser.py`, `IntentLabel.AMBIGUOUS`, the four-branch fan-out in `_dispatch`, `app/repos/destinations_repo.py` + `DestinationDoc`.
- [x] **Live eval pass (the cutover gate).** Runner's `--live` branch wires `run_agent` to a real Anthropic `LLMClient` via `_get_live_llm`; `_build_context_from_world` lifts each case's `World` into a real `AgentContext`. Prompt iterated against live output until all 42 non-REVIEW cases pass (REGRESSION + NEW_INTENT exact-match, ADVERSARIAL behavioral match with `reply`/`clarify` interchangeable for non-state-changing intents). REVIEW cases are still skipped in the runner — they need the `board_review` integration (deferred; not blocking cutover). To re-run: `ANTHROPIC_API_KEY=$(firebase functions:secrets:access ANTHROPIC_API_KEY) venv/bin/python -m tests.evals.runner --live` from `functions/`. Sonnet 4.6 is mildly non-deterministic — expect 1–2 sporadic JSON-shape flakes per full run; re-running the affected case individually almost always passes. The runner surfaces provider errors as case failures rather than crashing the suite, so partial-credit runs are still informative.
- [x] **SMS compliance pass — code complete.** `docs/sms-compliance-requirements.md` is the authoritative spec.
  - [x] `START`, `UNSUBSCRIBE`, `END`, `QUIT`, `INFO` recognized by `app/agent/hotkeys.py` as deterministic synonyms (`START`→JOIN, `UNSUBSCRIBE/END/QUIT`→STOP, `INFO`→HELP).
  - [x] `copy/templates.py` opt-in / opt-out / help / FLAG ack templates match the exact compliance text with `Farm Friend Vashon:` prefix. Pinning tests in `tests/test_copy.py` catch any future drift.
  - [x] Opportunity-alert and confirmation-reminder copy carry the program-name prefix and explicit STOP path. Confirmation reminder uses `DROP` instead of `CANCEL` (CANCEL is a compliance opt-out keyword).
  - [x] `PAUSE` / `RESUME` hotkeys recognized by the parser. Dispatch creates an `agent_nudge` `MuteRuleDoc` for PAUSE; RESUME removes it.
  - [x] `CANCEL` context-sensitivity documented in CLAUDE.md §"SMS compliance"; the hotkey path routes accordingly.
  - [ ] Walk the compliance doc's "Implementation Checklist" §line 297 against the final deployed system before pilot. All items must be checked before any real user gets a JOIN.

### Ready to do once Telnyx campaign is approved

1. [ ] Get the real Telnyx `from`-number (the 10DLC number you provisioned).
2. [ ] Update `functions/.env.farm-friend-vashon` — change `TELNYX_FROM_NUMBER=+15555550100` to the real number.
3. [ ] Update `web/public/farmfriend.vcf` — replace the placeholder `+15555550100` on the `TEL` line with the real number.
4. [ ] `firebase deploy` to push both updates.
5. [ ] In Telnyx Mission Control → Messaging → your profile, configure the **inbound webhook** to `https://us-west1-farm-friend-vashon.cloudfunctions.net/inbound_sms`.
6. [ ] Re-run the end-to-end smoke test, this time with a *real* phone number for the volunteer (your own second number or a Google Voice line). Verify the volunteer actually receives the outbound SMS.

### OSS LLM swap — done, deploy at any time

The adapter is wired, defaults are set, the live eval cleared 53/54 deterministically (1 flake same shape as Sonnet 4.6's). To take it live: just `firebase deploy`. The DeepInfra `LLM_API_KEY` is already in Secret Manager from the eval setup.

To swap back to Anthropic without code changes: set `LLM_PROVIDER=anthropic` in `.env.farm-friend-vashon` and re-deploy. The Anthropic adapter and Sonnet 4.6 baseline are intentionally preserved as a fast fallback.

How the eval went, for reference if a future swap surfaces similar issues:
- **Round 1 (baseline OSS, no adjustments):** 46/54. Two failure modes — adapter not enforcing JSON, and Llama over-confirming.
- **Round 2 (adapter fix: DeepInfra → json_object always):** schema failures gone, 50/54. Behavioral failures remained.
- **Round 3 (prompt: Rule 0 + 7 worked examples):** 52/54 — over-confirm cases halved.
- **Round 4 (server-side over-confirm backstop, scoped to create_opportunity):** 53/54 deterministic, 54/54 with single-case retry — parity with Sonnet 4.6.

### Hygiene before real users (do anytime)

- [ ] Delete the test data that's currently sitting in production Firestore: `Test Farm`, `Test Farmer`, `Test Volunteer`, and the two test opportunities (one `draft`, one `open`). Easiest path: a one-off script in `functions/scripts/`. Doc IDs were `Mdq9CTxUHKRfANApkjRx` (farm), `P0z4cHtjU6W2UwZ6tTcv` (farmer), `E2QEyfT8tMQr6Uy94UQq` (volunteer), `dPBDvJlCJMvYYVeBrtA0` + `RbDSNDL0YKXi7xJAXJ55` (opps).
- [x] ~~Decide what to do about the stale `LLM_API_KEY` secret~~ — superseded: the OSS LLM swap requires `LLM_API_KEY` to hold a real DeepInfra key. The placeholder value `unused` will be overwritten when the user provisions DeepInfra access.

### Pilot prep (do before approaching the first real farm)

- [ ] **Capture farm + volunteer defaults at onboarding.** The admin SPA Roster tab now has "Edit defaults" (farms: typical start hour / shift length / usual days) and "Edit availability" (volunteers: available days / hours / max hours/week). These feed the parser so the system doesn't bother farmers with questions like duration when there's a sensible default. Fill these in for the first pilot users when you admit them.
- [ ] Identify the first friendly farmer who'll be the pilot user. Seed them with `scripts/seed_smoke_test.py` (rename script's args or write a wrapper).
- [ ] Draft a 1-page flyer text for farmers markets / farm stands that says what Farm Friend is and how to opt in (`Text JOIN to <number>`).
- [ ] Manually test all hotkey paths against the deployed system: `YES`, `YES 2`, `MUTE`, `STOP weeding`, `STOP <farm>`, `UNAVAILABLE`, `FLAG`, `HELP`, `STOP`, `JOIN`, `INSIDER <phone>`.
- [ ] Test a deliberately-malformed farmer post → should land in the flags Worklist (admin escalation).
- [ ] Test post-event flow by manually advancing `post_event_checkin_at` on an opportunity and waiting for `tick_post_event` to fire.

### Coordination + LLM review (2026-05-26) — fixed in this pass

Reference notes for a fresh session: a full review on 2026-05-26 found six high-priority coordination/correctness gaps. All six were fixed in the same session:

1. **Claim races are now transactional.** `opportunities_repo.try_claim_in_transaction()` does the read/decide/seat-increment/status-flip atomically. `claim.handle_claim` calls it; the SMS side-effects (volunteer ack, farmer milestones) fire outside the transaction. Before this, two concurrent `YES` messages on a 1-seat shift could both land as CONFIRMED.
2. **Editing `starts_at` or `deadline_at` now reschedules `post_event_checkin_at`.** `farmer_ops.apply_edit` recomputes it via `flows._time.post_event_time_for` and clears `post_event_checkin_sent` if the new time is in the future. The helper was lifted out of `message_dispatch.py` into `_time.py` so both the new-post and edit paths share it.
3. **`YES`/`MAYBE` with no opportunity anchor is no longer silently dropped.** Routes through `_handle_orphan_claim_or_maybe` which flags for admin and replies `render_orphan_yes()`.
4. **Inbound webhook is idempotent.** `messages_repo.exists_by_provider_msg_id` early-returns from `_dispatch` if Telnyx redelivers. Single-field index — Firestore auto-indexes; no `firestore.indexes.json` change needed.
5. **Post-event checkin detection uses an intent label, not substring matching.** Outbound checkin SMS is stamped with `IntentLabel.POST_EVENT_CHECKIN`; `_is_post_event_question` reads that field. Reworded copy can no longer break the Y/N routing.
6. **(Deferred, not in this pass: the LLM consolidation win — see below.)**

### Known issues — current (post-v1.1) deferred list

The 2026-05-26 list is mostly obsolete: the unified-agent refactor superseded the architecture eight of those twelve items were diagnosing. The v1.1 hardening pass on 2026-05-27 resolved three more. What remains, plus new findings from that review:

**Resolved by the unified-agent refactor (2026-05-27):**
- Two LLM calls per farmer-with-open-opps → single agent call.
- Parser prompts duplicating each other → single `agent.md`.
- Classifier confidence miscalibrated / self-reported → no classifier exists.
- `_looks_like_posting` keyword gate missing laconic postings → agent decides directly.
- Classifier doesn't see prior INTERESTED claim → agent context includes `sender_open_claims`.
- `max_tokens` headroom → cleaned up (1024 reactive, 2048 review).
- Strong-model failures silent → `_dispatch` wraps `run_agent` in try/except → flag + fallback reply.

**Resolved in the v1.1 hardening pass (2026-05-27):**
- Headcount-up edit doesn't reactivate outreach → `farmer_ops.apply_edit` now calls `set_next_escalation` after FULL→FILLING.
- Stale-draft tick uses `created_at`, not activity → `OpportunityDoc.last_updated_at` auto-bumped on every `update_fields` write; the tick uses it as the clock with `created_at` fallback for legacy drafts.
- `flags_repo.is_user_flagged` only mutes the LLM path → in the rewritten `_dispatch`, the FLAG check sits between hotkey routing and agent invocation. Hotkeys (STOP/HELP/etc) still execute on a flagged user, which is intentional (compliance keywords must always work). A deliberate decision worth surfacing: should an open flag also pause `YES`/`MAYBE`/`MUTE`? Current answer is no; revisit if pilot reveals confusion.
- Clarification-streak counter could under-count when a non-CLARIFY outbound interleaves → now derived by walking the message stream.
- Dead `mutes_repo.is_muted` branch in board-review proposal routing → removed.
- Dead/stale identifiers (`classifier_confidence_threshold`, `MessageDoc.confidence`, unused `IntentLabel.YES`/`EDIT`, "classifier" comments) → removed.

**Still real — deferred:**
- **`INSIDER <phone>` for an existing user skips the admin gate.** `_handle_hotkey` adds the insider link directly when the nominated phone is already a user, but routes unknown phones through `pending_users`. Two paths to the same outcome (one gated, one not) — pick one. Probably route everything through `pending_users` so admin always sees nominations.
- **`_no_admins_exist()` bootstrap is racy.** Two concurrent `set_admin_claim` calls during first-run both see no admins and both succeed. Wrap in a transactional sentinel doc. Hypothetical at pilot scale.
- **`_build_agent_context` does an N+1 message read on every inbound.** Reads sender's last 50 messages, then for each unique `opportunity_id` does extra `get_by_id` calls. Fine at pilot scale; revisit if active volunteers with many recent claims become common. Also: the message read happens before the FLAG-pause check, so flagged users still pay the cost — move the FLAG check above the context build for a small win.
- **`cross_cutting_opps` and the hotkey-path `known_farms` both call `farms_repo.list_all()`** on every inbound. Cache once per request.
- **`_build_board_state` does `users_repo.list_active()` + per-user `latest_outbound_for_user`.** N+1 on each review tick; replace with a single message-collection query filtered by intent+age, grouped by user. Cost is negligible at pilot scale but worth a single-query rewrite when it gets touched.
- **Agent prompt read from disk on every call.** `PROMPT_PATH.read_text()` runs inside `run_agent`. Cheap on a warm function (page-cached) but unnecessary. Make it a module-level constant so it's read once at import.
- **Smoke-test bypass is unconditionally active when both the secret and header match.** Acceptable for pilot per CLAUDE.md note; harden before any wider rollout (gate on a separate `ENABLE_SMOKE_BYPASS` env var that's off in `.env.farm-friend-vashon`, rotate the secret monthly).

### Known limitations / deferred to v2

- **REVIEW eval cases are skipped in the runner.** The 8 REVIEW cases in `functions/tests/evals/cases.py` describe expected behavior for `tick_agent_review` (board-state context, budget filters, proposal ranking), but `runner.simulate_dispatch` doesn't yet build a `BoardState` and call `run_review_agent`. Reactive-path cases (REGRESSION + NEW_INTENT + ADVERSARIAL) are fully covered. Wiring REVIEW is a future eval-coverage task, not a cutover blocker.
- **No farmer web portal.** Farmers stay on SMS in v1. If the pilot reveals this is a real friction point, add a minimal portal.
- **No public self-signup page.** All onboarding is coordinator-mediated for the pilot.
- **No reputation / skill registry.** Replaced by activity-type mutes + farmer free-text requirements. Revisit only if real usage shows mutes aren't expressive enough.
- **No cost dashboard** in the admin SPA. Telnyx + Firebase + Anthropic each have their own billing UIs; revisit if real spend exceeds budget.
- **No automated test coverage** for the Firebase-touching layers (repos, flows that hit Firestore, dispatch). Pure-logic layers (hotkeys, copy, llm/client, time) have 48 unit tests. Add emulator-based integration tests if regression bugs start landing on the Firebase paths.
- **Bypass token in the webhook.** `app/flows/message_dispatch.py` has a smoke-test bypass that skips Telnyx signature verification when `X-Smoke-Test-Token` matches the `SMOKE_TEST_TOKEN` secret. Useful for testing but a real failure mode if the token leaks. Either rotate periodically or gate the bypass on a flag that's off in production. Acceptable for the pilot; remove or harden before any wider rollout.

### Architecture invariants that should stay true

These are baked into the design — changing any of them is a real refactor, not a minor tweak. Verify before deviating:

- **`docs/sms-compliance-requirements.md` is authoritative for SMS-facing behavior.** Keyword handling, opt-in/opt-out copy, help reply text, and the LLM-bypass list are derived from there. Drift between code and that doc must be fixed in the code, not the doc.
- **LLM never runs on a compliance-mandated keyword.** Hard list: `STOP`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT`, `HELP`, `INFO`, `JOIN`, `START`, `YES`, `YES N`, `MUTE`, `FLAG`. Deterministic parsing first; if there's a match, LLM is bypassed entirely.
- **The unified agent never drafts compliance-required copy.** Opt-in confirmation, opt-out confirmation, and the help reply are sent verbatim by the deterministic hotkey path. The agent's `mode="reply"` and `mode="confirm"` outputs are for everything else.
- **Every agent-drafted operational outbound includes the program name "Farm Friend Vashon" and an opt-out path** where the message initiates contact or asks for an action. Enforced by prompt and spot-checked in eval.
- `repos/` is the only package that imports `google.cloud.firestore`. Business logic goes through repos.
- All outbound SMS goes through `app.messaging._safe_send.safe_send()` — never call `provider.send()` directly. Failures must not crash the webhook.
- The deterministic hotkey parser runs BEFORE the unified agent. Common-path messages (YES / STOP / HELP / FLAG / MUTE / JOIN / INSIDER, plus PAUSE / RESUME / UNDO and post-event Y/N when expected) never cost an LLM call.
- **Pre-agent dispatch steps run before the agent.** In order: idempotency check, sender lookup, UNSUBSCRIBED gate, inbound persistence, hotkey parse, FLAG-pauses-thread, token-match against a live PENDING_CONFIRMATION, UNDO window, clarification cap (hard cap 2 consecutive, soft cap 5/24h). Each step that fires returns without invoking the agent.
- The LLMClient interface is `chat_json(messages, schema, *, cache_system_prompt=False)` — single entrypoint, JSON-only output. Don't add features that work only on Anthropic (tool-use loops, etc.) without first justifying it in the eval harness.
- `firebase_app.py`'s `db` and `auth` are lazy — they don't connect until first attribute access. Don't change to eager init or `firebase deploy` analyzer will fail.
- Opportunity state machine: `draft → open → filling → full → completed` (or `cancelled`/`expired`). Status flips happen even when outbound delivery fails — outreach is best-effort.
- **Required-field rules for opportunities live in code (`agent/parser.py: REQUIRED_SHIFT_FIELDS / REQUIRED_PICKUP_FIELDS`), not just in the prompt.** `compute_missing_fields()` is the authoritative server-side check; the LLM's own `missing_fields` output is overwritten by it after parsing/merging. `activity_tags` is on the required-shift list — empty list counts as missing; `["tbd"]` is a satisfying value. Changing what's required for a shift or pickup means updating both constants and the agent prompt (`prompts/agent.md`).
- **Clarification flow re-uses the `draft` status.** A draft opportunity within ~2h of creation is the dispatch path's signal to route an inbound farmer message to the merge parser instead of treating it as a new post. `tick_stale_drafts` (every 30 min) flags drafts older than 2h that never completed — admin handles abandoned ones manually.
- **Confirmation reminders are one-shot per claim, tracked on the claim doc.** `ClaimDoc.confirmation_sent_at` is the idempotency marker. The lead-time constants (`SHIFT_LEAD_TIME=24h`, `PICKUP_LEAD_TIME=3h`) live in `flows/confirmations.py`. A volunteer CANCEL only routes to a drop when the user's last outbound on the opp is a `CONFIRMATION_REMINDER` — outside that context, CANCEL retains its farmer-only meaning.
- **Volunteer drop unwinds atomically.** `opportunities_repo.drop_confirmed_claim_in_transaction` decrements `seats_filled`, flips FULL→FILLING, and marks the claim DROPPED in one txn. The flow then resets `next_escalation_at` to `now` so the existing `tick_outreach` re-pings the pool (skipping anyone already pinged/claimed/muted). Farmer is notified out-of-band; that send is best-effort.
- **ESCALATE is its own first-class agent mode, not a confidence fallback.** The unified agent emits `mode="escalate"` with `escalation.reason` and `escalation.urgency` (`routine` | `immediate`). Dispatch's `_handle_escalation` then: (1) creates a FLAG so further auto-replies on the thread pause until admin clears, (2) sends a contextual reply with a coordinator handoff line, (3) if `immediate`, texts `settings.coordinator_phone`. The coordinator phone is read from `COORDINATOR_PHONE` env var — without it, urgent escalations still flag + reply but do not page Max.
- **`OpportunityDoc.last_updated_at` is the staleness clock for drafts.** Auto-bumped by `opportunities_repo.update_fields` on every write. The stale-draft tick reads `last_updated_at` (with `created_at` fallback for legacy drafts). Don't introduce a code path that writes opp fields outside `update_fields` without also stamping this — otherwise a live clarification can get flagged as stale.
- **LLM provider is config-switchable.** The unified agent uses one `chat_json(model_tier="strong", …)` call per inbound and per review tick. The default is Llama 3.3 70B Instruct on DeepInfra (`LLM_PROVIDER=openai-compatible`); Anthropic Sonnet 4.6 is preserved as a fallback (`LLM_PROVIDER=anthropic`). Changing the default requires re-running `python -m tests.evals.runner --live` against the candidate and requiring pass-rate parity. The runner picks the provider from `LLM_PROVIDER` automatically.
- **`FlagDoc.message_id` is optional.** It's only set when the flag is anchored to a specific inbound MessageDoc. System-raised flags (review-tick proposals, agent-failure backstops, invalid-token rails, missing-fields fallbacks) leave it `None`. Pydantic v2 enforces this — passing a literal `None` to a `str` field crashes at validation; if you add a new flag-creation path, leave `message_id` unset (default `None`) for system-raised flags.
- **Over-confirm backstop on `create_opportunity`.** Smaller open-weight models occasionally emit `mode=confirm` with required fields filled from defaults (the prompt forbids this but the rule isn't always sticky on instruction-following). `_agent_overconfirm_reason` in `message_dispatch.py` runs before `_send_pending_confirmation` fires; it downgrades to `mode=clarify` and flags for admin if (1) `parse_notes` self-reports filling from defaults ("default", "inferred", "typical", "assumed", "guessing") OR (2) `starts_at` is set but the inbound has no clock-time signal OR (3) a canonical activity slug is in `activity_tags` but the inbound has no activity word. Scoped to `create_opportunity` only — `update_draft_opportunity` legitimately carries fields forward from the existing draft. The eval runner mirrors this so eval results reflect production behavior.

