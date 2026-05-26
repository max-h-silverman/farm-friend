# Farm Friend

SMS-first agentic system for coordinating volunteer help on Vashon Island farms.

## Status (as of 2026-05-25)

**v1 codebase is built and deployed.** All Firebase functions, Firestore data model, admin SPA, and SMS pipeline are live in the `farm-friend-vashon` project. End-to-end smoke test confirmed: an inbound farmer SMS gets parsed by Claude Haiku, persists as an `Opportunity`, and the admin SPA picks it up in real time.

**Blocked on Telnyx A2P 10DLC campaign approval** (submitted 2026-05-25; brand verified within hours, campaign in carrier review; expected to clear within a few days based on the preview showing no MNO Review required).

**Once approval lands**, the remaining work to start the real pilot is small (see "Next steps" at the bottom of this file).

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

---

## Next steps

This list is the source of truth for "what's the next thing to do." Update it as state changes — it's what a fresh session needs to read to know where to pick up.

### Blocked on external (no action needed from us right now)

- [ ] **Telnyx campaign approval.** Submitted 2026-05-25. Brand verified. Carrier preview showed no MNO Review required. Check the Telnyx 10DLC Campaigns dashboard. Expected: hours to a few days.

### Ready to do once Telnyx campaign is approved

1. [ ] Get the real Telnyx `from`-number (the 10DLC number you provisioned).
2. [ ] Update `functions/.env.farm-friend-vashon` — change `TELNYX_FROM_NUMBER=+15555550100` to the real number.
3. [ ] Update `web/public/farmfriend.vcf` — replace the placeholder `+15555550100` on the `TEL` line with the real number.
4. [ ] `firebase deploy` to push both updates.
5. [ ] In Telnyx Mission Control → Messaging → your profile, configure the **inbound webhook** to `https://us-west1-farm-friend-vashon.cloudfunctions.net/inbound_sms`.
6. [ ] Re-run the end-to-end smoke test, this time with a *real* phone number for the volunteer (your own second number or a Google Voice line). Verify the volunteer actually receives the outbound SMS.

### Hygiene before real users (do anytime)

- [ ] Delete the test data that's currently sitting in production Firestore: `Test Farm`, `Test Farmer`, `Test Volunteer`, and the two test opportunities (one `draft`, one `open`). Easiest path: a one-off script in `functions/scripts/`. Doc IDs were `Mdq9CTxUHKRfANApkjRx` (farm), `P0z4cHtjU6W2UwZ6tTcv` (farmer), `E2QEyfT8tMQr6Uy94UQq` (volunteer), `dPBDvJlCJMvYYVeBrtA0` + `RbDSNDL0YKXi7xJAXJ55` (opps).
- [ ] Decide what to do about the stale `LLM_API_KEY` secret in Cloud Secret Manager (one accidental version, costs ~$0/month at zero accesses). Optionally: `firebase functions:secrets:destroy LLM_API_KEY`.

### Pilot prep (do before approaching the first real farm)

- [ ] **Capture farm + volunteer defaults at onboarding.** The admin SPA Roster tab now has "Edit defaults" (farms: typical start hour / shift length / usual days) and "Edit availability" (volunteers: available days / hours / max hours/week). These feed the parser so the system doesn't bother farmers with questions like duration when there's a sensible default. Fill these in for the first pilot users when you admit them.
- [ ] Identify the first friendly farmer who'll be the pilot user. Seed them with `scripts/seed_smoke_test.py` (rename script's args or write a wrapper).
- [ ] Draft a 1-page flyer text for farmers markets / farm stands that says what Farm Friend is and how to opt in (`Text JOIN to <number>`).
- [ ] Manually test all hotkey paths against the deployed system: `YES`, `YES 2`, `MUTE`, `STOP weeding`, `STOP <farm>`, `UNAVAILABLE`, `FLAG`, `HELP`, `STOP`, `JOIN`, `INSIDER <phone>`.
- [ ] Test a deliberately-malformed farmer post → should land in the flags Worklist (admin escalation).
- [ ] Test post-event flow by manually advancing `post_event_checkin_at` on an opportunity and waiting for `tick_post_event` to fire.

### Known limitations / deferred to v2

- **No eval harness** for LLM swaps. The architecture supports any OpenAI-compatible provider via `LLM_PROVIDER=openai-compatible` + `LLM_BASE_URL`, but before flipping the default away from Anthropic you must build golden test sets for the parser, classifier, and ambiguous handler with pass-rate parity. See "LLM portability" section above.
- **No farmer web portal.** Farmers stay on SMS in v1. If the pilot reveals this is a real friction point, add a minimal portal.
- **No public self-signup page.** All onboarding is coordinator-mediated for the pilot.
- **No reputation / skill registry.** Replaced by activity-type mutes + farmer free-text requirements. Revisit only if real usage shows mutes aren't expressive enough.
- **No cost dashboard** in the admin SPA. Telnyx + Firebase + Anthropic each have their own billing UIs; revisit if real spend exceeds budget.
- **No automated test coverage** for the Firebase-touching layers (repos, flows that hit Firestore, dispatch). Pure-logic layers (hotkeys, copy, llm/client, time) have 48 unit tests. Add emulator-based integration tests if regression bugs start landing on the Firebase paths.
- **Bypass token in the webhook.** `app/flows/message_dispatch.py` has a smoke-test bypass that skips Telnyx signature verification when `X-Smoke-Test-Token` matches the `SMOKE_TEST_TOKEN` secret. Useful for testing but a real failure mode if the token leaks. Either rotate periodically or gate the bypass on a flag that's off in production. Acceptable for the pilot; remove or harden before any wider rollout.

### Architecture invariants that should stay true

These are baked into the design — changing any of them is a real refactor, not a minor tweak. Verify before deviating:

- `repos/` is the only package that imports `google.cloud.firestore`. Business logic goes through repos.
- All outbound SMS goes through `app.messaging._safe_send.safe_send()` — never call `provider.send()` directly. Failures must not crash the webhook.
- The deterministic hotkey parser runs BEFORE the LLM classifier. Common-path messages (YES / STOP / HELP / FLAG / MUTE / JOIN / INSIDER) never cost an LLM call.
- The LLMClient interface is `chat_json(messages, schema, *, cache_system_prompt=False)` — single entrypoint, JSON-only output. Don't add features that work only on Anthropic (tool-use loops, etc.) without first justifying it in the eval harness.
- `firebase_app.py`'s `db` and `auth` are lazy — they don't connect until first attribute access. Don't change to eager init or `firebase deploy` analyzer will fail.
- Opportunity state machine: `draft → open → filling → full → completed` (or `cancelled`/`expired`). Status flips happen even when outbound delivery fails — outreach is best-effort.
- **Required-field rules for opportunities live in code (`agent/parser.py: REQUIRED_SHIFT_FIELDS / REQUIRED_PICKUP_FIELDS`), not just in the prompt.** `compute_missing_fields()` is the authoritative server-side check; the LLM's own `missing_fields` output is overwritten by it after parsing/merging. Changing what's required for a shift or pickup means updating both constants and the parser prompts.
- **Clarification flow re-uses the `draft` status.** A draft opportunity within ~2h of creation is the dispatch path's signal to route an inbound farmer message to the merge parser instead of treating it as a new post. `tick_stale_drafts` (every 30 min) flags drafts older than 2h that never completed — admin handles abandoned ones manually.

