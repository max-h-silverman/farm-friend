# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Record only verified facts,
> and only ones still true. Architecture docs own enduring contracts; *why* a past change was made
> belongs in [SESSION_LOG.md](SESSION_LOG.md), not here. When an item closes, delete it rather than
> striking it through — the log keeps the history.

## Release state

Farm Friend is **pre-go-live**. Production runs one image across Cloud Run web revision
`farm-friend-web-00041-r5m` and worker revision `farm-friend-worker-00040-bks`, both at digest
`sha256:6206537e9464c2fdc936ad3bd902342a6a445e6b7ca49b3386f8faebabaadbec` (`main` at `386c3d2`).
Production Postgres is `neondb` with **26 migrations** (`0000`–`0025`).

**Everything merged is now DEPLOYED** (2026-08-07). The three tranches max had been holding —
F-081's default reminder schedule, the farmer sign-up wizard plus the integration-suite guard, and
the self-consent and listing-merge tranche — shipped together at revision 00041/00040.

**No migration was owed and none is**, so production Postgres stays at 26.

**Verified by effect against the live service**, not from the apply's exit status: `plan-assertions`
55/55, `deploy_assertions` confirms each serving revision is newer than every secret version it
consumes, `served_card_assertions` confirms 153 bytes / 6 CRLF / 0 bare LF. New code confirmed
serving rather than merely restarted — health 200 with **34 stands**, bare `/farmer/start` **404**,
and a malformed lookup body **400** rather than 500.

**The description cleanup HAS BEEN RUN** (2026-08-07, max approved). 31 of 34 rows rewritten in one
transaction and verified by reading them back, then confirmed independently through
`/api/public/stands` — the surface a customer actually reads. **34 → 29 farms carry a description**;
the 5 emptied held nothing but structured facts, which still render from their own columns. A
re-run reports **0 would change**, which is idempotence proven by effect rather than by argument.
Prior values are backed up at `~/farm-friend-backups/farm-descriptions-backup-2026-08-07T21-53-18-994Z.json`
— with no `farms.description` history table, that file is the rollback.

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

**Latest, 2026-08-07** (the self-consent and listing-merge tranche, merged to `main`): **1553 unit**
(131 files), **802 integration** (58 files), typecheck, lint. Integration ran against **local
Postgres**, never Neon. **No `packages/ai` file changed and no migration**, both checked against the
diff rather than assumed, so no `evals`/`evals:live` run and nothing owed to production Postgres.

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

## Standing facts from the newest tranche (2026-08-07)

Reasoning and the findings behind each: [SESSION_LOG.md](SESSION_LOG.md), 2026-08-07.

- **Farm Friend cannot send the first SMS to a number that never opted in.**
  `isProactiveSendPermitted` allows an un-consented send only for `required_reply` — the
  carrier-required answer to that recipient's *own* message — and `authorizeDispatch` suppresses
  everything else. So any "type your number and we text you a code" design is unbuildable, and a
  self-serve opt-in must have the farmer text **us**. The word is **`START`**, never `JOIN` or
  `CONFIRM`: only `START` clears the carrier's own opt-out list, so any other word would record
  consent for someone every send is refused for.
- **`farms.description` now has a farmer-facing writer.** It renders on the public card and had
  none, so VIGA's seeded prose stayed welded under every listing a farmer published. In the writer,
  `undefined` means "this door states nothing" and `""` means "the farmer cleared it" — collapsing
  the two is B-037 one column over.
- **The migration door prefills the paragraph and nothing else**, deliberately: it replaces VIGA's
  seeded listing with what the farmer states, but the paragraph is the one field with nothing else
  to restore it.
- **The contact card reaches customers who arrive by text.** F-039 built it and linked it from the
  public web map only, so a customer who texted `JOIN` was never told it existed. It now rides in
  the welcome, which costs a **second segment** — the URL is 71 characters at the production host
  (max's call, 2026-08-07).

**Owed:** a human visual pass. The browser extension never connected, so the wizard styling,
dropdown widths, the 30rem breakpoint, and the new description box are unverified by eye.

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
  **The description half is DONE and no longer part of this item** (2026-08-07):
  `scripts/clean-farm-descriptions.ts` cleaned all 31 affected rows without a re-ingest or the CSVs.
  What F-064 still owes is the listing **content** — items, hours, and dated confirmations from the
  three exports.
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
- **Measuring a parser is not measuring the data.** A "53% of the text is cleaned" figure described
  `buildStandDescription`'s *output*, not the live cards — the cleanup was deployed and had never
  run. To say what a card shows, read `farms.description` from production.
- **The stored prose contains malformed dates.** One row begins literally `/22/2026 Update:`, its
  month lost upstream. Patterns anchored on a leading month digit miss it. Found by a dry run
  against real rows; no fixture would have contained it.
