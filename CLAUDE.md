# Farm Friend

SMS-first agentic system for coordinating volunteer help on Vashon Island farms.

## Where to find things

This file is the orientation layer — read it once. For anything else, go to the doc that owns it:

- **`docs/status.md`** — what's been built, what was just fixed, what's been deferred. Read when you need history / "why is the code shaped this way."
- **`docs/next-steps.md`** — the punch list. Read at the start of a work session. Update as state changes — it's what a fresh session needs to know where to pick up.
- **`docs/architecture.md`** — end-to-end inbound flow, scheduled ticks, state machines, cross-cutting safety mechanisms, LLM portability, **architecture invariants**. Read before touching dispatch, the agent, flows, or anything in `app/agent/` / `app/flows/` / `app/repos/`.
- **`docs/sms-compliance-requirements.md`** — authoritative SMS-facing spec (carrier-submitted). Wins any disagreement with this file.
- **`docs/agent-architecture-rethink.md`** — design record for multi-day window posts (implemented) and the planned Madison-persona prompt redesign (not yet implemented).
- **`docs/refactor-unified-agent.md`** — the unified-agent refactor plan (shipped 2026-05-27).

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
- **One pre-event reminder per commitment, with an easy out.** Confirmed volunteers get one "you're scheduled to help… reply DROP if you can't make it" SMS in the 24h before a shift (3h before a pickup). Silence = still in. A DROP drops the seat, re-fires outreach for the gap, and notifies the farmer. Legacy CANCEL still drops only when it is clearly replying to a reminder; ambiguous CANCEL unsubscribes.
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
- **`CANCEL` is context-sensitive — a documented divergence from the campaign language.** The campaign description lists CANCEL among opt-out keywords. Our implementation keeps the farmer-cancel meaning when the sender is a farmer with open posts, and keeps legacy volunteer-drop behavior only when the sender's last outbound was a `CONFIRMATION_REMINDER`. Reminder copy now asks volunteers for `DROP` to avoid using a carrier opt-out keyword. With no clear context, `CANCEL` falls through to global unsubscribe like `STOP`. **This is a deliberate product decision** to preserve the v1 SMS UX; if a carrier raises it during audit, the answer is "behavior matches user intent in context; ambiguous CANCEL always unsubscribes." Re-evaluate if it ever causes a real complaint.
- **Frequency disclosure.** Opt-in flow and printed signup must say "Message frequency varies based on farm needs, usually 0–6 messages per week." The unified agent's per-user 48h budget (1 agent-initiated outbound per 48h, not counting scheduled flows the user consented to) is the operational mechanism that keeps us within this band; the budget is configurable but should not be raised without re-evaluating the campaign registration.
- **Initiating operational alerts include an opt-out path.** Broadcast outreach, intro messages, and review-tick nudges to silent users carry STOP copy. Direct in-thread replies, clarifications, confirmation prompts, receipts, and commitment acknowledgments do not repeat STOP; the deterministic hotkey path remains the safety net.

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
- `DROP` — volunteer-only: drops a confirmed claim when replying to a recent `CONFIRMATION_REMINDER`.
- `CANCEL` — context-sensitive (see "SMS compliance" above for the divergence note). For farmers with open posts: cancels or asks which post to cancel. For volunteers with a recent `CONFIRMATION_REMINDER`: legacy synonym for `DROP`. With no context: behaves like `STOP`.
- `STOP {activity}` — mute an activity type.
- `STOP {farm name}` — mute a specific farm.
- `UNAVAILABLE {window}` — silence everything during a window.
- `STATUS` — farmer-only: snapshot of open posts and how they're filling.
- `INSIDER {phone} {name}` — farmer-only: nominate a trusted volunteer.

Refactor-introduced keywords (see `docs/refactor-unified-agent.md`):
- `UNDO` — reverse the most recent agent-executed action within 5 minutes.
- `PAUSE` — mute agent-initiated nudges (review-tick proposals) for 14 days. Does NOT affect scheduled flows the user consented to (confirmation reminders, post-event check-ins) or direct replies to user-initiated messages.
- `RESUME` — undo `PAUSE`.

Confirmation tokens (drafted by the unified agent per action; not a fixed vocabulary):
- The default confirmation token is `YES`. Specific tokens are exactly 4 uppercase letters, no digits or hyphens, and must not collide with any keyword above.
- Examples the agent might pick when `YES` would be ambiguous: `EDIT`, `POST`, `CANC`, `MABE`, `OFFR`, `LIKE`.
- Affirmative variants (`yes`, `ok`, `sure`, `confirm`, `go ahead`) are accepted as a token match for a live `PENDING_CONFIRMATION`. Receipt rail catches mis-resolution.

## Stack

- **Backend:** Firebase (chosen for builder familiarity from the Splash project)
  - **Firebase Functions (Python, 2nd gen)** — HTTP webhook for inbound SMS, scheduled functions for tier escalation and post-event checkins, callable functions for admin actions
  - **Firestore** — document database with real-time updates (powers the admin view live)
  - **Firebase Auth** — admin login (Google sign-in for Max)
  - **Firebase Hosting** — static hosting for the admin SPA
  - **Cloud Scheduler** (via scheduled functions) — recurring escalation checks
- **SMS:** Telnyx (abstracted behind `MessagingProvider`)
- **LLM:** abstracted via internal `LLMClient` (OpenAI-format wire protocol, opt-in Anthropic cache hints). **Current default is an OLMo OSS path through an OpenAI-compatible local or hosted endpoint.** Anthropic Sonnet 4.6 remains a config-switchable fallback. The unified-agent refactor consolidated the v1 trio of LLM calls into a single `model_tier="strong"` call per inbound; `model_tier="fast"` is preserved for cheap classifier/background work.
  - Current default: `LLM_PROVIDER=olmo`, `LLM_BASE_URL=http://localhost:8000/v1`, `LLM_MODEL=allenai/Olmo-3.1-32B-Instruct`, `LLM_CLASSIFIER_MODEL=allenai/Olmo-3-7B-Instruct`, `LLM_TIMEOUT_MS=20000`, `LLM_TEMPERATURE=0.1`. Key from `LLM_API_KEY` secret.
  - Avoid OLMo `Think` variants for normal SMS flows unless explicitly configured; this app needs concise structured outputs more than long reasoning traces.
  - Fallback: `LLM_PROVIDER=anthropic`, `LLM_MODEL_STRONG=claude-sonnet-4-6` (cached system prompt honored).
  - Generic OpenAI-compatible providers (Together, Fireworks, Groq, DeepInfra, vLLM, SGLang, Ollama) work by swapping `LLM_PROVIDER=openai-compatible`, `LLM_BASE_URL`, and model env vars. No SDK changes needed.
  - The adapter prefers `response_format=json_schema` and falls back to `json_object` with the schema concatenated into the existing system message (single system message, no second one prepended — some providers honor only the first).
- **Admin UI:** Vanilla TypeScript + Alpine.js on Firebase Hosting, talking to Firestore directly via the Firebase JS SDK

## Firebase conventions

- **Functions in Python, 2nd gen.** Python is GA on Firebase Functions; keeps agent code + business logic in one language. Defer to `firebase-functions` Python SDK patterns.
- **Repository layer required.** All Firestore reads/writes go through repository functions in `functions/app/repos/` (e.g., `users_repo.get_by_phone`). Business logic does not import the Firestore SDK directly. This isolates the data store so migration is a single-layer change.
- **Collections** (top-level, with subcollections where relational):
  - `users` (phone-indexed; includes onboarding-captured availability)
  - `farms` (owned by a farmer user; includes onboarding-captured defaults like `typical_start_hour`, `typical_shift_duration_min`)
  - `farms/{farmId}/insiders` (subcollection: volunteer_id, added_at)
  - `opportunities` (kind: shift | pickup; status: draft | open | filling | full | completed | cancelled | expired; supports multi-day windows via `window_end_at`, fuzzy `time_of_day_bucket`, `headcount_open`; tracks `post_event_checkin_at`, `next_escalation_at`, once-per-opp farmer notification flags)
  - `opportunities/{oppId}/outreach` (subcollection: per-tier ping log)
  - `opportunities/{oppId}/claims` (subcollection; tracks `status` ∈ confirmed|proposed|interested|waitlist|dropped, optional `scheduled_for_at` for window claims, plus `confirmation_sent_at` for the pre-event reminder idempotency marker)
  - `mute_rules` (volunteer_id, dimension, value)
  - `messages` (direction, body, `intent_label`, confidence, user_id, opportunity_id, provider_msg_id) — TTL purge after 90 days unless flagged. `intent_label` on *outbound* messages is load-bearing: `POST_EVENT_CHECKIN` and `CONFIRMATION_REMINDER` let inbound dispatch route Y/N and DROP/CANCEL reminder replies correctly without substring-matching the body.
  - `flags` (message_id, flagged_by, reason, resolved_at). An open flag for a user pauses LLM auto-replies on their thread.
  - `offers` (volunteer-initiated offers of help: activity tags, time window, status, optional matched_opportunity_id). Added by the unified-agent refactor.
  - `opportunities/{oppId}/post_event_pings` (sidecar for one post-event check-in per actual worked day on window opportunities)
  - `pending_users` (JOIN requests + farmer nominations awaiting admin approval)

- **Scheduled functions** (all in `main.py`, all Cloud Scheduler-driven). Each tick gates on quiet hours at its entry point — if it's 11pm–7am Vashon, the tick no-ops and the next run catches up. Full table in `docs/architecture.md`.
- **Indexes**: define in `firestore.indexes.json` and check in. Don't rely on auto-creation in dev.
- **Security rules**: `firestore.rules` denies all client access by default. Admin SPA reads via Auth; Functions write with service-account creds. Public clients cannot read or write anything.
- **Don't use Firestore real-time listeners on the server side.** Functions read on demand; real-time is for the admin SPA only.

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
- Don't change the default LLM provider without first re-running the live eval (`python -m tests.evals.runner --live` from `functions/`) against the candidate and requiring pass-rate parity with the existing baseline (Sonnet 4.6 cleared 42/42 non-REVIEW cases; the OLMo default still needs a live eval before pilot traffic).
- Don't import the Firestore SDK from business logic — go through the `repos/` layer.

## Repo conventions

- Monorepo. `functions/` is the Firebase Functions Python package; `web/` is the admin SPA; `firestore.rules`, `firestore.indexes.json`, `firebase.json` at the root.
- `functions/` uses Python 3.12, `pyproject.toml`.
- SMS-facing copy lives in `functions/app/copy/` as plain text or Jinja templates, not interpolated in business logic. Easy to A/B and review.
- Tests in `functions/tests/`. Use the Firestore emulator for integration tests.
- All datetime values are timezone-aware UTC at the boundary; convert to America/Los_Angeles only for human-facing SMS copy.
