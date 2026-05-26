# Farm Friend

SMS-first agentic system for coordinating volunteer help on Vashon Island farms.

## What this is

Farms (mostly small, VIGA-affiliated) need volunteer help — gleaning, weeding, harvest. Volunteers (a mix of retirees, gardeners, food-system enthusiasts) want to help but need low-friction discovery and signup. The previous human-coordinator approach didn't scale. Farm Friend replaces it with an agentic SMS workflow: the system decides who to ping, when to escalate, how to interpret replies, and when to check in after an event — autonomously.

## Roles

- **Coordinator (Max)** — sole admin. Approves new users into the pool; monitors flagged messages and system health. Does *not* participate in every event cycle.
- **Farmer** — interacts only via SMS. Posts shifts and surplus pickups in free-form text, nominates "insiders" (trusted volunteers) by texting in their phone numbers, answers a post-event check-in.
- **Volunteer** — interacts only via SMS. Claims opportunities via `YES`; uses hotkeys to mute/opt-out.

## Opportunity types

Two distinct posting types share users, insiders, mute rules, and the agent layer but have their own shapes:

- **Volunteer Shift** — timed, headcount-bounded work at the farm with an `activity` from the canonical list: `harvest`, `gleaning`, `weeding`, `planting`, `transplanting`, `livestock`, `infrastructure`, `processing`. Harvest and gleaning are distinct (harvest = main crop, may need technique; gleaning = leftovers, usually for food bank).
- **Surplus Pickup** — single-claim race for already-set-aside produce that needs to be picked up and taken to a destination (food bank, community fridge, mutual aid). Faster outreach pacing (perishable). Often needs a vehicle.

Farmers can suggest new activities (texted as part of a post); the agent flags unknown activities for admin approval into the canonical list. Mute rules act on activity slugs directly (`STOP harvest` is distinct from `STOP gleaning`).

## Design philosophy

- **The system runs autonomously; the coordinator moderates.** Default to letting the agent act and surfacing the result to the admin view, rather than blocking on human approval. The one manual gate is admitting new users.
- **SMS is the universal channel, but the core is channel-agnostic.** Everything routes through a `MessagingProvider` abstraction. Don't bake Telnyx-specific assumptions into business logic.
- **Tiered outreach, not blast.** Farmers nominate insiders; insiders ping first; broader pool only if seats stay unfilled. Keeps message volume (and cost) low and quality high.
- **The agent does the nagging.** Post-event check-ins, escalations, follow-ups — the system remembers so humans don't have to.
- **FLAG is sacred.** Any user can text `FLAG` to report a bad system reply. Stops auto-replies on that thread and surfaces to admin immediately. The trust safety valve.
- **Deterministic before LLM.** Hotkeys are parsed by regex first. The LLM only runs on messages that aren't a hotkey. Cheaper, faster, and more reliable for the common path.

## Hotkey vocabulary (the SMS API)

- `YES` / `YES N` — claim an opportunity (optionally N slots)
- `STOP {activity}` — mute an activity type
- `STOP {farm name}` — mute a specific farm
- `UNAVAILABLE {window}` — silence everything during a window
- `MUTE` — silence followups on the current opportunity only
- `FLAG` — report wrong/confusing system reply
- `JOIN` — request to join (admin-approved)
- `HELP` — list commands
- `STOP` — full unsubscribe (TCPA)
- `INSIDER {phone} {name}` — farmer-only: nominate a trusted volunteer

## Stack

- **Backend:** Firebase (chosen for builder familiarity from the Splash project)
  - **Firebase Functions (Python, 2nd gen)** — HTTP webhook for inbound SMS, scheduled functions for tier escalation and post-event checkins, callable functions for admin actions
  - **Firestore** — document database with real-time updates (powers the admin view live)
  - **Firebase Auth** — admin login (Google sign-in for Max)
  - **Firebase Hosting** — static hosting for the admin SPA
  - **Cloud Scheduler** (via scheduled functions) — recurring escalation checks
- **SMS:** Telnyx (abstracted behind `MessagingProvider`)
- **LLM:** abstracted via internal `LLMClient` (OpenAI-format wire protocol, opt-in Anthropic cache hints). **v1 default is Anthropic; the system is architected to support a fully self-hosted open-weight model later.**
  - v1 provider: Anthropic (Haiku 4.5 for parsing/classification, Sonnet 4.6 for ambiguous-reply handling). Prompt caching is used.
  - Future paths supported by config: vLLM/Ollama hosting Llama 3.3 70B Instruct, Qwen 2.5, etc.; or cloud open-weight providers (Groq, Together, Fireworks, DeepInfra).
- **Admin UI:** Vanilla TypeScript + Alpine.js on Firebase Hosting, talking to Firestore directly via the Firebase JS SDK

## Firebase conventions

- **Functions in Python, 2nd gen.** Python is GA on Firebase Functions; keeps agent code + business logic in one language. Defer to `firebase-functions` Python SDK patterns.
- **Repository layer required.** All Firestore reads/writes go through repository functions in `functions/app/repos/` (e.g., `users_repo.get_by_phone`). Business logic does not import the Firestore SDK directly. This isolates the data store so migration is a single-layer change.
- **Collections** (top-level, with subcollections where relational):
  - `users` (phone-indexed)
  - `farms` (owned by a farmer user)
  - `farms/{farmId}/insiders` (subcollection: volunteer_id, added_at)
  - `opportunities` (kind: shift | pickup; status: draft | open | filling | full | completed | cancelled | expired)
  - `opportunities/{oppId}/outreach` (subcollection: per-tier ping log)
  - `opportunities/{oppId}/claims` (subcollection)
  - `mute_rules` (volunteer_id, dimension, value)
  - `messages` (direction, body, intent, confidence, user_id, opportunity_id) — TTL purge after 90 days unless flagged
  - `flags` (message_id, flagged_by, reason, resolved_at)
  - `destinations` (food banks, community fridges)
  - `pending_users` (JOIN requests + farmer nominations awaiting admin approval)
- **Indexes**: define in `firestore.indexes.json` and check in. Don't rely on auto-creation in dev.
- **Security rules**: `firestore.rules` denies all client access by default. Admin SPA reads via Auth; Functions write with service-account creds. Public clients cannot read or write anything.
- **Don't use Firestore real-time listeners on the server side.** Functions read on demand; real-time is for the admin SPA only.

## LLM portability

The system is architected so the LLM can be swapped between Anthropic and any OpenAI-compatible provider (including self-hosted open-weight runtimes like vLLM) via config.

**Before swapping providers, build the eval harness first.** v1 deliberately ships without one because we only target Anthropic. The harness is a known prerequisite for any swap — golden test sets for the parser, classifier, and ambiguous handler (20–50 examples each), with pass-rate parity required before flipping the default. Do not change the default model in production without it.

**Don't reach for `litellm` or similar.** The Anthropic adapter is hand-rolled (~50 lines). The OpenAI-compatible path uses the OpenAI Python SDK with `base_url` swapped. Keep the dependency surface small.

**Provider-specific prompt tweaks are allowed but should be the exception.** Default to prompts that work cross-model; only branch when an eval shows a real quality gap on the target provider.

## Operating constraints

- **Cost-sensitive.** Max is paying out of pocket for a pilot. Target: under $30/month total at pilot scale (~50 volunteers, 2–3 farms). Watch SMS volume and LLM call frequency.
- **Pilot scale.** 2–5 farms, 20–50 volunteers in v1. Don't optimize for scale we don't have.
- **Privacy.** Firestore is encrypted at rest by default. Minimal PII; 90-day TTL on `messages` (Firestore TTL field). Don't log raw PII in observability tools.
- **TCPA compliance.** `STOP` must immediately unsubscribe and prevent further outbound messages to that number. `HELP` must return a description of the service.
- **Cold starts.** Firebase Functions 2nd gen has cold starts. Set `min_instances=1` on the SMS webhook function so Telnyx never times out. Other functions can scale to zero.

## Don't

- Don't add a farmer-facing web portal in v1 — farmers stay on SMS.
- Don't build a public volunteer signup page in v1 — admin onboards manually.
- Don't add reputation scores, skill registries, or training tracking — replaced by activity-type mutes + farmer free-text requirements.
- Don't blast the broader pool when insider tier would suffice.
- Don't auto-reply on a thread after the user has texted `FLAG` until admin clears it.
- Don't store raw message content longer than 90 days unless it's tied to an active opportunity or open flag.
- Don't add `litellm` or similar omnibus LLM-routing libraries; hand-roll the thin adapters.
- Don't change the default LLM provider without first building the eval harness and getting pass-rate parity.
- Don't import the Firestore SDK from business logic — go through the `repos/` layer.

## Repo conventions

- Monorepo. `functions/` is the Firebase Functions Python package; `web/` is the admin SPA; `firestore.rules`, `firestore.indexes.json`, `firebase.json` at the root.
- `functions/` uses Python 3.12, `pyproject.toml`.
- SMS-facing copy lives in `functions/app/copy/` as plain text or Jinja templates, not interpolated in business logic. Easy to A/B and review.
- Tests in `functions/tests/`. Use the Firestore emulator for integration tests.
- All datetime values are timezone-aware UTC at the boundary; convert to America/Los_Angeles only for human-facing SMS copy.
