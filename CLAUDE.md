# Farm Friend

SMS-first agentic system for coordinating volunteer help on Vashon Island farms.

## Status (as of 2026-05-26)

**v1 codebase is built and deployed.** All Firebase functions, Firestore data model, admin SPA, and SMS pipeline are live in the `farm-friend-vashon` project. End-to-end smoke test confirmed: an inbound farmer SMS gets parsed by Claude Haiku, persists as an `Opportunity`, and the admin SPA picks it up in real time.

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

- **Volunteer Shift** — timed, headcount-bounded work at the farm with an `activity` from the canonical list: `harvest`, `gleaning`, `weeding`, `planting`, `transplanting`, `livestock`, `infrastructure`, `processing`. Harvest and gleaning are distinct (harvest = main crop, may need technique; gleaning = leftovers, usually for food bank).
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

## Hotkey vocabulary (the SMS API)

- `YES` / `YES N` — claim an opportunity (optionally N slots)
- `MAYBE` — express soft interest, no seat held
- `CANCEL` — context-sensitive. For volunteers: drops a confirmed claim when sent in response to a confirmation reminder. For farmers: cancels an open post.
- `STOP {activity}` — mute an activity type
- `STOP {farm name}` — mute a specific farm
- `UNAVAILABLE {window}` — silence everything during a window
- `MUTE` — silence followups on the current opportunity only
- `FLAG` — report wrong/confusing system reply
- `JOIN` — request to join (admin-approved)
- `HELP` — list commands
- `STATUS` — farmer-only: snapshot of open posts and how they're filling
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
  - `users` (phone-indexed; includes onboarding-captured availability)
  - `farms` (owned by a farmer user; includes onboarding-captured defaults like `typical_start_hour`, `typical_shift_duration_min`)
  - `farms/{farmId}/insiders` (subcollection: volunteer_id, added_at)
  - `opportunities` (kind: shift | pickup; status: draft | open | filling | full | completed | cancelled | expired; tracks `post_event_checkin_at`, `next_escalation_at`, once-per-opp farmer notification flags)
  - `opportunities/{oppId}/outreach` (subcollection: per-tier ping log)
  - `opportunities/{oppId}/claims` (subcollection; tracks `status` ∈ confirmed|interested|waitlist|dropped, plus `confirmation_sent_at` for the pre-event reminder idempotency marker)
  - `mute_rules` (volunteer_id, dimension, value)
  - `messages` (direction, body, `intent_label`, confidence, user_id, opportunity_id, provider_msg_id) — TTL purge after 90 days unless flagged. `intent_label` on *outbound* messages is load-bearing: `POST_EVENT_CHECKIN` and `CONFIRMATION_REMINDER` let inbound dispatch route Y/N and CANCEL replies correctly without substring-matching the body.
  - `flags` (message_id, flagged_by, reason, resolved_at). An open flag for a user pauses LLM auto-replies on their thread.
  - `destinations` (food banks, community fridges) — declared but currently unused; see "Known issues" below.
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

### Coordination + LLM review (2026-05-26) — fixed in this pass

Reference notes for a fresh session: a full review on 2026-05-26 found six high-priority coordination/correctness gaps. All six were fixed in the same session:

1. **Claim races are now transactional.** `opportunities_repo.try_claim_in_transaction()` does the read/decide/seat-increment/status-flip atomically. `claim.handle_claim` calls it; the SMS side-effects (volunteer ack, farmer milestones) fire outside the transaction. Before this, two concurrent `YES` messages on a 1-seat shift could both land as CONFIRMED.
2. **Editing `starts_at` or `deadline_at` now reschedules `post_event_checkin_at`.** `farmer_ops.apply_edit` recomputes it via `flows._time.post_event_time_for` and clears `post_event_checkin_sent` if the new time is in the future. The helper was lifted out of `message_dispatch.py` into `_time.py` so both the new-post and edit paths share it.
3. **`YES`/`MAYBE` with no opportunity anchor is no longer silently dropped.** Routes through `_handle_orphan_claim_or_maybe` which flags for admin and replies `render_orphan_yes()`.
4. **Inbound webhook is idempotent.** `messages_repo.exists_by_provider_msg_id` early-returns from `_dispatch` if Telnyx redelivers. Single-field index — Firestore auto-indexes; no `firestore.indexes.json` change needed.
5. **Post-event checkin detection uses an intent label, not substring matching.** Outbound checkin SMS is stamped with `IntentLabel.POST_EVENT_CHECKIN`; `_is_post_event_question` reads that field. Reworded copy can no longer break the Y/N routing.
6. **(Deferred, not in this pass: the LLM consolidation win — see below.)**

### Known issues from 2026-05-26 review — deferred

These are the review findings we *didn't* fix this pass. Listed in rough priority order so a future session can pick them up:

- **Two LLM calls per farmer-with-open-opps posting.** `_handle_farmer_message_with_open_opps` calls the triage prompt (edit/cancel/new_post/clarify), and on `new_post` falls through to `_handle_farmer_post` which calls the parser. Fold both into a single prompt that can return either a triage decision or a parsed-new-post payload. Biggest LLM cost win available.
- **Parser prompts duplicate each other.** `parser.md`, `parser_merge.md`, `parser_edit.md` share ~90% of their content (classification rules, date semantics, required-field rules). Consolidate into one cached system prompt with a `mode` flag in the user message. Roughly doubles prompt-cache hit rate on the farmer path.
- **Headcount-up edit doesn't reactivate outreach.** `farmer_ops.apply_edit` flips FULL→FILLING when headcount increases past seats_filled, but never calls `set_next_escalation` — so the escalation tick never re-picks the opp. Fix: after the status flip, `opportunities_repo.set_next_escalation(opp_id, at=now, tier=current_tier)`.
- **`INSIDER <phone>` for an existing user skips the admin gate.** `_handle_hotkey` adds the insider link directly when the nominated phone is already a user, but routes unknown phones through `pending_users`. Two paths to the same outcome (one gated, one not) — pick one. Probably route everything through `pending_users` so admin always sees nominations.
- **`flags_repo.is_user_flagged` only mutes the LLM classifier path.** Farmer free-form postings, edits, and cancels run *before* the flag check in `_dispatch`. A farmer with an open flag will still have their posting parsed and replied to. Either move the flag check above the farmer branches, or document the scope intentionally.
- **Stale-draft tick uses `created_at`, not last-activity.** A clarification dialog crossing the 2h boundary will get flagged even if it's still alive. Track `last_updated_at` on drafts (update it on merge) and use that for the staleness clock.
- **Strong-model failures fall through silently.** `_handle_llm_reply` doesn't wrap `resolve_ambiguous` in a try/except. If Anthropic 5xxs or the Sonnet alias drifts, the user gets no reply at all. Catch `LLMProviderError` and route to the flag-for-admin branch.
- **Classifier confidence is self-reported and miscalibrated.** Consider asking the fast model to output a boolean `escalate` it derives from its own rationale instead of a fuzzy float, OR drop the threshold and always route `AMBIGUOUS` to the strong model.
- **`_looks_like_posting` keyword gate misses laconic postings.** A farmer texting "tomorrow 9am, 3 ppl" hits no keyword and gets routed to the volunteer classifier. For farmer-role senders with no open opps, just always run the parser (cost: one Haiku call; benefit: no missed postings).
- **`destinations` collection is dead code.** Declared in CLAUDE.md, has a repo, never read. Either wire it into the pickup parser as a canonical list, or delete the repo + collection for v1.
- **Classifier doesn't see the volunteer's prior `INTERESTED` claim.** "I'm in" after a MAYBE often hits AMBIGUOUS because the prompt has no signal that this user already expressed soft interest. Plumb prior claim status into the user prompt.
- **`max_tokens` headroom.** Parser uses 512, classifier/ambiguous use 400 — JSON outputs in these schemas top out around 200. Tightening reduces tail latency variance and caps worst-case cost. No correctness risk.
- **`_no_admins_exist()` bootstrap is racy.** Two concurrent `set_admin_claim` calls during first-run both see no admins and both succeed. Wrap in a transactional sentinel doc. Hypothetical at pilot scale.

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
- **Confirmation reminders are one-shot per claim, tracked on the claim doc.** `ClaimDoc.confirmation_sent_at` is the idempotency marker. The lead-time constants (`SHIFT_LEAD_TIME=24h`, `PICKUP_LEAD_TIME=3h`) live in `flows/confirmations.py`. A volunteer CANCEL only routes to a drop when the user's last outbound on the opp is a `CONFIRMATION_REMINDER` — outside that context, CANCEL retains its farmer-only meaning.
- **Volunteer drop unwinds atomically.** `opportunities_repo.drop_confirmed_claim_in_transaction` decrements `seats_filled`, flips FULL→FILLING, and marks the claim DROPPED in one txn. The flow then resets `next_escalation_at` to `now` so the existing `tick_outreach` re-pings the pool (skipping anyone already pinged/claimed/muted). Farmer is notified out-of-band; that send is best-effort.
- **ESCALATE is its own first-class intent, not a confidence fallback.** Classifier output schema includes `intent="ESCALATE"`, `escalation_reason`, and `escalation_urgency` (`routine` | `immediate`). The parser/merge prompts emit the same escalation via `kind="other"` with a `parse_notes` string prefixed `ESCALATE:` and dispatch keyword-sniffs the reason for urgency (see `_looks_immediate` in `message_dispatch.py`). The parser_edit prompt has its own `action="escalate"` branch. All three paths land in `_handle_escalation` which: (1) creates a FLAG so further auto-replies on the thread pause until admin clears, (2) sends a contextual reply with a coordinator handoff line, (3) if `immediate`, texts `settings.coordinator_phone`. The coordinator phone is read from `COORDINATOR_PHONE` env var — without it, urgent escalations still flag + reply but do not page Max.

