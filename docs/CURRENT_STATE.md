# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Record only verified facts,
> and only ones still true. Architecture docs own enduring contracts; *why* a past change was made
> belongs in [SESSION_LOG.md](SESSION_LOG.md), not here. When an item closes, delete it rather than
> striking it through — the log keeps the history.

## Release state

Farm Friend is **pre-go-live**. Production runs one image across Cloud Run web revision
`farm-friend-web-00040-v47` and worker revision `farm-friend-worker-00039-zgv`, both at digest
`sha256:2896814e21914305fb0929768cfb007d4b297b21dbd25ce8e2209c313043a607` (`main` at `68a59e0`).
Production Postgres is `neondb` with **26 migrations** (`0000`–`0025`).

**Merged to `main` and NOT deployed** — max held the deploy:

- **F-081** (2026-08-07) — approved farmers start on a weekly reminder schedule.
- **The farmer sign-up flow** (`415d913`) and the integration-suite guard (`ef810f2`).

**No migration is owed.** None of the undeployed work carries one, so production Postgres stays at
26 and what production serves is the pre-F-081 image.

**Secrets and mount flags.** Web mounts `GEOCODING_API_KEY`, `SMTP_PASSWORD`, and F-079's three;
**the worker mounts none of them**, asserted unconditionally so flipping a flag can never hand a
salt to a process with no use for it. `infra/production.tfvars` is what keeps that true across
applies — every `mount_*` variable defaults to false, so a plan without `-var-file` silently
unmounts whatever the last apply enabled. `plan-assertions.py` fails by name on any plan that would
unmount a live secret.

**`EMAIL_HASH_SALT` can never be rotated** without re-ingesting the roster. A mismatch between it
and the ingest is this feature's quietest failure: every farmer's correct address fails to match,
nothing errors, and the door verifies nobody.

**The migration door's secret is obscurity, not a credential** — do not post it anywhere indexable.
Retrieve with `gcloud secrets versions access latest --secret=farm-friend-farmer-start-secret
--project farm-friend-vashon`. Rotating it is one new version plus an apply, and invalidates links
already sent.

## Verification

**Latest, 2026-08-07** (branch `farmer-self-consent-and-listing-merge`, uncommitted work below):
**1533 unit**, **796 integration** (58 files), typecheck, lint. Integration ran against **local
Postgres**, never Neon.

**Prior, 2026-08-07** (F-081, merged to `main`): 1496 unit (127 files), 796 integration, typecheck,
lint. **No `packages/ai` file changed, so no `evals` or `evals:live` run was owed** — checked
against the diff rather than assumed.

**Prior, 2026-08-07** (F-079 tranche, deployed): 1495 unit, 791 integration, typecheck, lint,
`evals` 44/44 (critical 11/11, advisory 4/4, adversarial 29/29), production build. Infra:
`plan-assertions.py` 55/55, `secrets-lifecycle.test.py` and `test_plan_assertions.py` pass.

**Last `evals:live`: 2026-08-06, 25/25** against `mistralai/Mistral-Small-24B-Instruct-2501`
(containment 4/4, closure 7/7, quality 9/9, recall 5/5). Owed again on any change to a seam's
projection, schema, or output contract.

Standing rules: real-Postgres integration runs from an empty schema against local Postgres, **never**
production Neon. Never carry an old test count forward as current evidence.

## Uncommitted on this branch (2026-08-07)

Branch `farmer-self-consent-and-listing-merge` holds **no commits**; everything here is working-tree
state. Nothing deployed, no migration — local tooling plus form and styling work.

- **The integration suite can no longer run DDL against a remote database.** The repo's `.env` held
  the production Neon string while every integration test creates and drops databases.
  `packages/db/src/integration-database-guard.ts` fails the run before any DDL unless the host is
  local or `ALLOW_INTEGRATION_TESTS_AGAINST_REMOTE_DB=1` is set deliberately, wired in at
  `vitest.integration.setup.ts` — one seam all 58 files pass through. Verified by effect in both
  directions. `.env`'s `DATABASE_URL` now points at local Postgres.
- **Email verification is walkable locally.** `EMAIL_PROVIDER=simulator` writes each message to a
  file under `SIMULATED_MAIL_DIR` (default `.mail/`, git-ignored) instead of sending — a file
  rather than the console deliberately, since a live code in log output is a credential in a stream
  that gets shipped. **Three barriers keep it off a deployment**: opt-in, never a default; refuses
  to construct under `NODE_ENV=production`; refuses to start if `SMTP_*` is also set. All three
  verified behaviourally.
- **The two farmer sign-up steps read as one flow**, both drawing from the stylesheet rather than
  one carrying inline styles. Both URLs were kept: step 2 re-checks eligibility and re-resolves the
  publish grant from an HttpOnly cookie server-side per request, and a client-side swap would move
  that decision into the browser.
- **Nothing in the farmer flow requires typing a date or a time.** Dropdowns throughout; the stored
  contract is unchanged (same `"HH:MM"` strings), with a test pinning 8:30am → 510 minutes. Changing
  a month **clears a day that month does not have**.
- **`daylight_hours` is no longer offered, only stored** — `open-now` answers it and `dawn_to_dusk`
  identically, so offering both split the data on a distinction no customer can see. **Typecheck
  caught a real regression**: `HoursKind` was derived from the offered options, so removing one
  broke *loading* a stored listing that used it — all 31 such farms would have had their hours
  blanked on opening the edit form. State is now typed from what can be **stored**, not what is
  **offered**, with a regression test.

**Owed:** a human visual pass. The browser extension never connected, so the wizard styling,
dropdown widths, and the 30rem breakpoint are unverified by eye.

## What is live

- **Public discovery:** model-free map/list, offering filters, honest recency, closures, participant
  names, transient browser proximity, destination links, and code-bound stock-out reporting.
- **Farmer workflows:** deterministic `JOIN <token>`, `LINK`, `STAND`, `SETTINGS`, and `SAME`; one
  exact stand per credential; SMS/web proposal and confirmation; closures, participants, reminders.
  Three onboarding doors — invited, grandfathered (`/farmer/start`), and the emailed-code migration
  door (`/farmer/start/<secret>`).
- **Customer SMS:** model interpretation over typed retrieval, identifier validation, and
  code-rendered grounded answers. `MAP`, compliance commands, and confirmation routing are
  deterministic and run before any model.
- **Administration:** fixed-account password sign-in and server-rendered farm approval, farmer
  access, flag, stock-report, and stand-data workflows. Phones are masked at the query boundary.
- **Scheduled work:** Cloud Tasks handles immediate sender work; one Cloud Scheduler route runs
  recovery, prompts, delivery, callbacks, and retention.

## Open before go-live

**Owed data runs and live checks**

- **F-064's production ingest has NOT happened.** Needs a re-export of all three CSVs (the profile
  form is still open), a **`neondb` snapshot** — with an insert-only utility and GL-015 open, the
  snapshot *is* the rollback — max's explicit approval for the bulk write, and a render check on a
  real card afterwards. Until it runs, production serves pre-tranche listing **content** through the
  new code.
- **B-024** — fixed in code (F-061) and verified on a rehearsal database: a farmer's written refusal
  makes the stand `contact_only` with no address and no pin. **Production still publishes her
  address** until F-064's ingest runs; the approved interim correction remains in place.
- **F-029:** finish live carrier/`JOIN` launch verification.
- **F-056:** finish protected-page, logout, copied-cookie, throttle, expiry/revocation, mobile,
  keyboard/focus, and recovery-copy browser proof.
- **F-044:** verify public-map and authenticated-admin embeds on VIGA's actual Squarespace pages.
  Includes whether `?hidden=true` needs to survive the embed — max's call.
- Physical-handset vCard and paged-SMS checks remain owed.
- Exercise the full farmer onboarding/update, administrator, settings, customer inquiry, and farmer
  SMS journeys against production, verifying database effects rather than screen messages. **The
  consent path in particular is proven against real Postgres but never against a real handset.**

**Open build items**

- **F-065 — attribution for a listing change.** A revision row carries no `admin_actor_id` and there
  is no general admin audit log. There are now **three writers of public listing state** (invited,
  grandfathered, edit) and none records who wrote. The edit path is the one holding an authorization
  to attribute to.
- **F-050 participants on the onboarding form — not attempted.** The field exists but on the stand
  settings page, and `saveSalesLocationParticipants` requires a `senderHash` (the farmer's verified
  phone). The onboarding form holds an invitation token or a farm ID and no phone at all, so this
  needs a way to attribute the write. Own item, own session.
- **B-008:** replace the incomplete deployed-build lint gate. Production build warnings are
  unchanged: Next does not recognize `outputFileTracingRoot`, and the Next ESLint plugin is not
  installed.
- **B-034:** upgrade affected production dependencies and assess advisory reachability.
- **B-036:** the "North ferry" label is clipped at the island map's top edge (cosmetic).
- Remaining go-live work is tracked in [GO_LIVE_GUIDE.md](GO_LIVE_GUIDE.md): **GL-007** (stock-out →
  farmer alert), **GL-008** (customer stock-out surface), **GL-015** (applying a stand-data
  decision), plus the P2 resilience band and P3 decisions.

**Unverified at phone width** — jsdom reports every element as zero-sized, so three surfaces are
covered by tests but not by eye: the farmer agreement step, the expanded stand detail, and F-067's
onboarding listing form including its map. Per-tranche browser checks are **not tracked here**
(max, 2026-08-05): he runs a browser pass himself before go-live.

**VIGA's call, not a code question:** whether Vashon Island Farmers Market belongs in the roster as
a farm at all — it is the market itself, not a stand with a farmer to onboard.

## Traps worth not rediscovering

- **`VIGA Map Stands.csv` writes multi-line descriptions unquoted**, so an ordinary CSV read splits
  one stand into many rows — a naive parse produced 275 phantom farms named things like
  `dawn to dusk`. The real count is **31 stands**, reassembled by treating a `POINT` in the first
  column as the only record boundary.
- **`drizzle-kit generate` silently drops CHECK constraints and partial unique indexes.** Hand-write
  the SQL and keep only its meta snapshot; verify by effect that each constraint genuinely refuses.
- **A migration command can exit 0 having skipped a migration** whose journal timestamp is not
  newer. Verify the schema effect, never the exit status.
- **`printf %s`, never `echo`, when adding a salt to Secret Manager.** A trailing newline produces
  hashes that look right in every listing and match nothing at runtime.
