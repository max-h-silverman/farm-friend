# Farm Friend — Session Log

Newest-first, on-demand build history: what was built each session, the decisions and rationale
that aren't obvious from the diff, and what was verified/owed. The **live snapshot** of what's
true/unfinished now lives in [../CLAUDE.md](../CLAUDE.md) "Current State & Open Items"; this file
is the *why behind past changes*.

---

## 2026-07-24 — Clean-room baseline reset: F-011 (Phase 4 finding 1)

Branch `f-011-baseline-reset`. First finding of the Phase 4 audit review defined by
[CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md](CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md), which is
now **tracked in the repo and is the design authority** — previously it existed only as an
untracked working-tree file.

**Why this was finding 1.** The declared baseline (seven architecture docs, `CLAUDE.md`, PM
`product.md`) asserted as settled fact a product the clean-room contract had replaced. Because
`CLAUDE.md` auto-loads into every agent's context and instructs agents to treat those docs as
source of truth, the stale baseline was actively *manufacturing* the work later findings exist to
delete: any session starting cold would have built tenancy scoping, two-axis migration provenance,
and gleaning tables. It also made every later finding's acceptance criteria unverifiable, since
"correct" was defined by documents that were wrong.

Deleted from the declared baseline: gleaning/volunteer scope and its "tables in the spine" pledge,
tenancy, the two-axis migration provenance model and claim states, `config`/`contracts` packages,
Expo, multi-level staff roles, and the permanent `MapProvider` seam (geocoding is now a one-time
seeding concern, and the coordinate-inventing stub is gone). Declared instead: the four-package
baseline (`core`/`db`/`sms`/`ai` + `apps/web`), the `core → no other package` dependency rule, the
single composition root, and one authoritative use case + durable path per workflow.

**Two judgment calls worth recording.** First, the old docs enumerated a closed inquiry-ranking
strategy set (`proximity | freshness | coverage | any`) — precisely the "fixed semantic strategy
catalog" the contract forbids. Restated as an **open interpretation the model proposes and code
validates and executes**, which resolves a contradiction in the contract's own terms rather than
transcribing it. Second, unproven guarantees were **demoted to requirements**: every architecture
doc now opens with a status note naming its own gaps, because the Phase 3 audit found documented
safety claims that executable code does not enforce.

`SESSION_LOG.md` was left unchanged (history may record superseded decisions) and is now labeled as
such in the docs index. `SMS_COMPLIANCE.md` got narrow edits only — gleaning removed, scoped `MUTE`
added, `FLAG` marked a product safety feature rather than a carrier-mandated keyword, and
speculative-schema identifiers (`subscriptions`, `people.phone`, the removed activation flow)
replaced with durable-record language.

**Review found two defects.** The commit was amended (`6765e29` → `b292bc7`) to fix the stale
schema names, which the first pass had filtered for gleaning but not for schema references. The
second was filed as **F-012** rather than fixed: the registered 10DLC campaign copy still presents
`FLAG` as a supported keyword and documents `MUTE` nowhere, so F-011 wrote the "FLAG is not
carrier-mandated" rule and left the live violation one file away. Correcting a submitted carrier
campaign is a real decision with an external dependency and is a listed unresolved launch decision
— it is a hard SMS-compliance gate before public SMS, but blocks none of the intervening
architectural findings.

**Scope held:** docs + `CLAUDE.md` only; no file under `apps/`, `packages/`, or any schema path was
touched. Excluding the added handoff, the rewrite was ~956 insertions against 812 deletions — a
reset, not an expansion.

**Verified:** `npm test` 46/46 (10 files), typecheck PASS, lint PASS; evals critical 3/3 + advisory
2/2 + adversarial 4/4 — unchanged from baseline, as expected for a docs-only change. These checks
prove isolated helpers and structural claims, **not** launch workflows. `DATABASE_URL` remains
unset, so the 3 Postgres integration tests still skip; a real-Postgres run remains owed.

## 2026-07-13 — VIGA 10DLC copy + outbound SMS segment cost controls (PR #7)

Branch `fix/telnyx-sms-costs`; PR #7 is open against `main`. Added paste-ready Squarespace,
privacy/terms, and Telnyx campaign-field copy for **VIGA Farm Friend** (`752e85d`). It describes
only the current farm-stand MVP, uses the live VIGA-hosted opt-in/privacy paths, and omits the
rejected future volunteer/gleaning campaign. Telnyx's keyword field rejects spaces, so the final
opt-out list uses `STOP,STOPALL,UNSUBSCRIBE,CANCEL,END,QUIT` and does not include `STOP ALL`.

Implemented provider-independent SMS cost controls (`e88c705`). `packages/sms` now estimates
GSM-7 vs. UCS-2 and billable segments (including two-septet GSM extension characters), normalizes
only unambiguous typographic variants at the mandatory `redactOutbound` boundary, and preserves
meaningful Unicode such as names, addresses, accents, and emoji. Outbound metrics contain only the
recipient hash, encoding, character/encoding-unit counts, and segments — never body text or raw
phones. `assembleSmsContext` adds a one-GSM-segment preference for coordinator replies while
explicitly forbidding destructive truncation. A 101-character smart-punctuation sample falls from
2 UCS-2 segments to 1 GSM-7 segment after normalization.

The repository does **not** yet contain a live Telnyx send: `TelnyxTransport.send` remains the
intentional Phase 0 throwing stub. PM F-010 was added (`~/pm` commit `1f6b87a`) as a high-priority
launch dependency; this session completed its provider-independent cost controls, while production
send, outbound-only raw phone lookup, post-acceptance metric emission, and adapter tests remain
open. No deploy is required for this library/documentation change.

**Verified:** `npm test` 46/46 (10 files), typecheck PASS, lint PASS, `git diff --check` PASS;
evals critical 3/3 + advisory 2/2 + adversarial 4/4. `npm run test:integration` completed with all
3 tests skipped because `DATABASE_URL` is not configured; a real-Postgres run remains owed.

## 2026-07-05 — Architecture and SMS follow-up cleanup merged (PRs #5 + #6)

Closed architecture, schema, and deterministic SMS-parser contradictions after Phase 0. Activation
became staff-initiated manual onboarding for roughly 35 stands: staff record farmer identity and
SMS consent provenance, then trigger one pre-seeded confirm-or-revise message; the prior claim-link
and form-submit automation was deleted. `people.phone` became the one normalized raw-phone column,
read only by outbound sending, while `phone_hash` remained the lookup/log key.

Pruned overlapping schema state (`farms.status`, snapshot `hidden`, and
`expected_fresh_until`); `farm_stands.visibility` is the single hide switch. Activation `YES`
writes a new `farmer_confirmed` snapshot rather than mutating provenance. Set provisional raw-body
retention (30 days plus flagged-thread exemption), per-consumer commitment expiry (48 hours for
publish/stock-out, 14 days for activation), whole-message token matching with fixed YES/NO
variants, `JOIN <program>`, and stand-resolution-before-alert for SMS stock-out reports.

**Verified before merge:** `npm test` 39/39 (9 files), typecheck PASS, lint PASS; evals critical
3/3 + advisory 2/2 + adversarial 4/4. Integration remained DB-gated.

## 2026-07-04 — Phase 0 built (F-006a + F-006b + F-006c), verified, not committed

Branch `feature/f-006-platform-spine` (off `main` = `3f76949`, the archived scaffold; the working
tree was the intentional clean-slate wipe). Built the full Phase-0 spine test-first, per the
approved plan (`we-re-building-farm-friend-generic-clock.md`). **Not committed** — the user
directed no commit/push/deploy without explicit go-ahead.

**PM restructure first (via `/pm`).** Split the oversized F-006 three ways (F-006a docs, F-006b
spine, F-006c auth+evals); added F-007a/b, F-008, F-009; reframed F-002 (publish, two-axis
provenance), F-003 (open-intent inquiry), F-005 (console consolidation, with flag review pulled
out to F-009 as a hard pre-launch gate). Dependency order encoded via table position + "Depends
on" notes. Reconciled `product.md` (coordinator framing, `contracts` package, two-axis migration
model, code-enforced-safety golden rule). ID strategy: kept existing IDs, rewrote in place. F-006
retained as a `wont-fix` stub recording the split.

**F-006a — docs + CLAUDE.md.** CLAUDE.md in Nudgenik house style; the `docs/` set reading in order
via `docs/README.md`. Key decisions captured: the **two-axis migration model** (lifecycle `status`
= shown-on-map vs. provenance = honesty-about-age; migrated shows as `current` but is labeled
honestly, never "confirmed today"), the **sharpened type-safety claim** (branded types make it a
*compile error to bypass* the assembler/redactor — provenance, not content; the runtime scan +
adversarial evals prove content), the **`ai_runs` MAY-store list**, and the **abuse/cost throttle
seam** location (decided in ARCHITECTURE, built in F-003/F-008).

**F-006b — spine.** npm-workspace monorepo (`core`, `db`, `sms`, `ai`, `config`, `contracts`) +
web/mobile shells + 5 scripts. Tenant-scoped Drizzle schema with the restored columns
(`farm_stands.claim_status/migrated_at/migrated_source/visibility/lat/lng`, `farms.status`,
`inventory_snapshots.status+provenance+confirmed_by_person_id`), nullable-FK+text stock-out shape,
gleaning tables (designed, unused), `ai_runs` (no model input). Provider seams: `SmsTransport`
(+simulator +Telnyx stub +**outbound redaction guard**), `LLMProvider` (+stub +openweight
+**`ModelSafeContext` assembler** +validate-and-repair), `Clock`, `MapProvider` (+**offline
stub**). The **branded type-level safety boundary** — `ModelSafeContext`/`RedactedOutbound` whose
only public constructor is the assembler/redactor; a deliberate bypass fails `tsc`, **proven
non-vacuous** (removing a `@ts-expect-error` makes `tsc` fail: "string not assignable to
RedactedOutbound"). The **generic commitment state machine** designed against two consumers
(publish/activation + gleaning): context-bound, exactly-once, expiring. First unit tests cover all
eight named invariants.

**F-006c — auth + evals.** Magic-link auth (issue/verify, HMAC signature + expiry code-enforced),
a server-side `requireRole` helper (admin⇒staff implication + tenant match) used by routes, plus a
web callback route and a role-guarded admin route. The eval harness (`evals/run.ts`, run via
`tsx`) with critical/advisory groups and the **adversarial group** that proves — by exercising the
*real* assembler + commitment machine — that an injected SMS can't smuggle a phone into context or
force a commit. **Proven non-vacuous**: neutering the assembler's phone scan fails the adversarial
group and exits non-zero.

**Notable engineering decisions.**
- Relative imports are **extensionless** (`moduleResolution: "Bundler"`, source-first workspace
  consumption) so both `tsc -b` and Next's webpack resolve them; Next couldn't resolve `.js`
  specifiers pointing at `.ts` source.
- React pinned to `18.2.0` across web + mobile to satisfy React Native 0.74's exact peer.
- Integration suite is `DATABASE_URL`-gated (skips cleanly) so `npm test` stays hermetic and
  CI-without-a-DB doesn't fail; it runs against local/Neon Postgres when the URL is set.

**Verified this session:** `npm run typecheck` PASS, `npm run lint` PASS, `npm test` **38 passed
(9 files)**, `npm run test:integration` 3 skipped (DB-gated), `npm run evals` critical 3/3 +
advisory 2/2 + adversarial 4/4. `apps/web` builds and live-served `/api/health` (200), the Telnyx
webhook (deterministic routing through core — `STOP`→global compliance, free-text→`none`), the
magic-link callback (bad token→401), and the guarded admin route (unauth→403). `apps/mobile`
type-checks.

**Owed / next:** commit + PR when the user gives the go-ahead. Run the integration suite against a
real Postgres to exercise the schema + seed. Then the launch set: F-007a → F-007b → F-002 → F-008
→ F-003 → F-009.
