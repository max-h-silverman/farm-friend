# Farm Friend — Next steps

The source of truth for "what's the next thing to do." Update as state changes — it's what a fresh session needs to read to know where to pick up. Companion to `CLAUDE.md` (orientation), `docs/status.md` (history), and `docs/architecture.md` (invariants).

## Blocked on external (no action needed from us right now)

- [ ] **Telnyx campaign approval.** Submitted 2026-05-25. Brand verified. Carrier preview showed no MNO Review required. Check the Telnyx 10DLC Campaigns dashboard. Expected: hours to a few days.

## Next major build: Architecture rethink — finish windows + Madison persona

- [ ] **Finish Stage 1 window-post hardening.** Core code is implemented: `OpportunityDoc.window_end_at`, `time_of_day_bucket`, `headcount_open`; `ClaimDoc.scheduled_for_at`; `ClaimStatus.PROPOSED`; `YES MON,WED`; `ACCEPT`/`DECLINE`; farmer-approval flow; `tick_proposals`; and `post_event_pings`. Remaining work before calling Stage 1 complete: admin SPA window display audit, targeted eval cases for window posts, and a live eval run against the current default LLM. Full design/history in `docs/agent-architecture-rethink.md`. **Pilot-risk note (2026-05-30 review):** the window-post + PROPOSED-claim subsystem is large and complex for pilot scale (2–5 farms). Strongly consider deferring window posts from the *agent's* responsibilities for the pilot (a farmer can post one day at a time) — it shrinks the prompt surface the model must get right. The code can stay; just don't have the agent emit `window_end_at` until post-pilot.
- [ ] **Stage 2: Madison persona + prompt rationalization.** Rewrite `app/prompts/agent.md` with the Madison framing (40, decade of farm experience, home garden, reports to the coordinator). Rewrite Rule 0 as "default to resolving, not to asking." Audit prose-only invariants for code backstops and remove the prose where covered. ~1 dev day plus eval re-tuning. Mostly prompt, almost no code. NOTE: the 2026-05-30 hardening pass already moved two of these out of prose into code — token selection (Rule 3 now just "always YES") and the headcount-edit hard block (now `_edit_headcount_block_reply`, pre-confirm). When doing the Madison rewrite, do NOT re-add prompt logic for either; the code is authoritative.

## P0 — must land before pilot

- [ ] **Live eval the default model before pilot traffic — THE GATE.** Code defaults now point at `LLM_PROVIDER=mistral-deepinfra` (Mistral Small 3.2 24B + DeepInfra URL + model id, no further tuning) — a pilot trial of a pragmatic open-weight option. Run `LLM_API_KEY=<deepinfra-key> python -m tests.evals.runner --live` from `functions/` and record the pass rate. **Neither Mistral 3.2 nor OLMo has been live-eval'd on this suite** — the prior 53/54 was Llama 3.3 70B, which does NOT transfer. Set an explicit go/no-go bar (suggest: 100% on REGRESSION + escalation cases, ≥90% behavioral on ADVERSARIAL). If the trialed model can't clear it, options are: (a) try the next provider-preference candidate (OLMo via `LLM_PROVIDER=olmo-openrouter`), or (b) shrink the agent's surface further (defer window posts / proactive nudges — already half-done via `AGENT_REVIEW_ADMIN_ONLY`). Do NOT ship and hope.
  - Expand the suite with small-model adversarial cases before the run: crop-name-only posts, default-time inference, "yes" answering a clarify, polite declines (must stay `reply`), offer-as-question, and malformed/non-JSON output recovery (exercises the new one-shot JSON-repair retry in `app/llm/client.py`).
- [x] **Pilot-hardening pass (2026-05-30).** Landed: `olmo-deepinfra` default profile (later superseded — the code default is now `mistral-deepinfra`, and `olmo-deepinfra` was removed because DeepInfra doesn't serve OLMo; real OLMo is `olmo-openrouter`); one-shot LLM JSON-repair retry + broadened timeout detection; loud-fail on unset `COORDINATOR_PHONE` for immediate escalations + `health` readiness check; deterministic confirmation-token derivation (model no longer picks tokens); pre-confirm headcount-edit hard block; `AGENT_REVIEW_ADMIN_ONLY` (review tick is admin-only during pilot); pruned vestigial `IntentLabel`s; `agent_decisions` audit collection. See `docs/status.md` (2026-05-30) for the full list. 250 unit tests + 63 stub-eval cases green.
- [x] **Unified-agent refactor — code complete.** Files: `app/agent/unified.py`, `app/prompts/agent.md`, `app/flows/board_review.py`, dispatch rewrite in `app/flows/message_dispatch.py`. Retired: `app/agent/classifier.py`, `app/agent/ambiguous.py`, `app/prompts/{classifier,ambiguous,parser,parser_merge,parser_edit}.md`, the LLM-calling functions in `app/agent/parser.py`, `IntentLabel.AMBIGUOUS`, the four-branch fan-out in `_dispatch`, `app/repos/destinations_repo.py` + `DestinationDoc`.
- [x] **Live eval pass (the cutover gate).** Runner's `--live` branch wires `run_agent` to a real Anthropic `LLMClient` via `_get_live_llm`; `_build_context_from_world` lifts each case's `World` into a real `AgentContext`. Prompt iterated against live output until all 42 non-REVIEW cases pass (REGRESSION + NEW_INTENT exact-match, ADVERSARIAL behavioral match with `reply`/`clarify` interchangeable for non-state-changing intents). REVIEW cases are still skipped in the runner — they need the `board_review` integration (deferred; not blocking cutover). To re-run: `ANTHROPIC_API_KEY=$(firebase functions:secrets:access ANTHROPIC_API_KEY) venv/bin/python -m tests.evals.runner --live` from `functions/`. Sonnet 4.6 is mildly non-deterministic — expect 1–2 sporadic JSON-shape flakes per full run; re-running the affected case individually almost always passes. The runner surfaces provider errors as case failures rather than crashing the suite, so partial-credit runs are still informative.
- [x] **SMS compliance pass — code complete.** `docs/sms-compliance-requirements.md` is the authoritative spec.
  - [x] `START`, `UNSUBSCRIBE`, `END`, `QUIT`, `INFO` recognized by `app/agent/hotkeys.py` as deterministic synonyms (`START`→JOIN, `UNSUBSCRIBE/END/QUIT`→STOP, `INFO`→HELP).
  - [x] `copy/templates.py` opt-in / opt-out / help / FLAG ack templates match the exact compliance text with `Farm Friend Vashon:` prefix. Pinning tests in `tests/test_copy.py` catch any future drift.
  - [x] Opportunity-alert copy carries the program-name prefix and explicit STOP path. Confirmation reminder uses `DROP` instead of `CANCEL` (CANCEL is a compliance opt-out keyword) and direct reminder copy does not repeat STOP.
  - [x] `PAUSE` / `RESUME` hotkeys recognized by the parser. Dispatch creates an `agent_nudge` `MuteRuleDoc` for PAUSE; RESUME removes it.
  - [x] `CANCEL` context-sensitivity documented in CLAUDE.md §"SMS compliance"; the hotkey path routes clear farmer/reminder context and otherwise unsubscribes.
  - [ ] Walk the compliance doc's "Implementation Checklist" §line 297 against the final deployed system before pilot. All items must be checked before any real user gets a JOIN.

## Ready to do once Telnyx campaign is approved

1. [ ] Get the real Telnyx `from`-number (the 10DLC number you provisioned).
2. [ ] Update `functions/.env.farm-friend-vashon` — change `TELNYX_FROM_NUMBER=+15555550100` to the real number.
3. [ ] Update `web/public/farmfriend.vcf` — replace the placeholder `+15555550100` on the `TEL` line with the real number.
4. [ ] `firebase deploy` to push both updates.
5. [ ] In Telnyx Mission Control → Messaging → your profile, configure the **inbound webhook** to `https://us-west1-farm-friend-vashon.cloudfunctions.net/inbound_sms`.
6. [ ] Re-run the end-to-end smoke test, this time with a *real* phone number for the volunteer (your own second number or a Google Voice line). Verify the volunteer actually receives the outbound SMS.

## Prior OSS LLM swap — reference only

The prior Llama/DeepInfra adapter work is still useful context for provider swaps. It cleared 53/54 deterministically (1 flake same shape as Sonnet 4.6's), but the current default is `mistral-deepinfra` and needs its own live eval before pilot traffic (see the P0 gate above).

To swap back to Anthropic without code changes: set `LLM_PROVIDER=anthropic` in `.env.farm-friend-vashon` and re-deploy. The Anthropic adapter and Sonnet 4.6 baseline are intentionally preserved as a fast fallback.

How the eval went, for reference if a future swap surfaces similar issues:
- **Round 1 (baseline OSS, no adjustments):** 46/54. Two failure modes — adapter not enforcing JSON, and Llama over-confirming.
- **Round 2 (adapter fix: DeepInfra → json_object always):** schema failures gone, 50/54. Behavioral failures remained.
- **Round 3 (prompt: Rule 0 + 7 worked examples):** 52/54 — over-confirm cases halved.
- **Round 4 (server-side over-confirm backstop, scoped to create_opportunity):** 53/54 deterministic, 54/54 with single-case retry — parity with Sonnet 4.6.

## Hygiene before real users (do anytime)

- [ ] Delete the test data that's currently sitting in production Firestore: `Test Farm`, `Test Farmer`, `Test Volunteer`, and the two test opportunities (one `draft`, one `open`). Easiest path: a one-off script in `functions/scripts/`. Doc IDs were `Mdq9CTxUHKRfANApkjRx` (farm), `P0z4cHtjU6W2UwZ6tTcv` (farmer), `E2QEyfT8tMQr6Uy94UQq` (volunteer), `dPBDvJlCJMvYYVeBrtA0` + `RbDSNDL0YKXi7xJAXJ55` (opps).
- [x] ~~Decide what to do about the stale `LLM_API_KEY` secret~~ — superseded: the OSS LLM path requires `LLM_API_KEY` to hold the local or hosted OpenAI-compatible endpoint key. For local vLLM/SGLang this can be any accepted placeholder; for hosted providers, use the provider key.

## Pilot prep (do before approaching the first real farm)

- [ ] **Capture farm + volunteer defaults at onboarding.** The admin SPA Roster tab now has "Edit defaults" (farms: typical start hour / shift length / usual days) and "Edit availability" (volunteers: available days / hours / max hours/week). These feed the parser so the system doesn't bother farmers with questions like duration when there's a sensible default. Fill these in for the first pilot users when you admit them.
- [ ] Identify the first friendly farmer who'll be the pilot user. Seed them with `scripts/seed_smoke_test.py` (rename script's args or write a wrapper).
- [ ] Draft a 1-page flyer text for farmers markets / farm stands that says what Farm Friend is and how to opt in (`Text JOIN to <number>`).
- [ ] Manually test all hotkey paths against the deployed system: `YES`, `YES 2`, `MUTE`, `STOP weeding`, `STOP <farm>`, `UNAVAILABLE`, `FLAG`, `HELP`, `STOP`, `JOIN`, `INSIDER <phone>`.
- [ ] Test a deliberately-malformed farmer post → should land in the flags Worklist (admin escalation).
- [ ] Test post-event flow by manually advancing `post_event_checkin_at` on an opportunity and waiting for `tick_post_event` to fire.
