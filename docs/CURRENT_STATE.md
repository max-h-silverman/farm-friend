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

**`main` is AHEAD of production** as of F-088 (`e55cb92`, pushed 2026-08-07, not deployed). The
serving revisions above still run `386c3d2`. Everything before F-088 is deployed: F-081's default
reminder schedule, the farmer sign-up wizard plus the integration-suite guard, and the self-consent
and listing-merge tranche all shipped together at revision 00041/00040.

**TWO MIGRATIONS ARE NOW OWED TO PRODUCTION** (F-088, 2026-08-07): `0026_address_visibility` and
`0027_placeable_contact_only`. Both are applied and verified by effect on **local** Postgres only —
production `neondb` remains at 26 and the code on `main` now expects 28. **Deploying the image
before applying them breaks the listing writer and the public reader**, both of which reference
`sales_locations.address_public`. Apply first, then deploy.

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

**Latest, 2026-08-07** (F-088 address visibility, committed to `main`): **1562 unit** (131 files),
**805 integration** (58 files), typecheck, lint, production build. Integration ran against **local
Postgres**, never Neon. **No `packages/ai` file changed**, checked against the diff, so no
`evals`/`evals:live` run was owed. **Two migrations ARE owed to production** — see Release state.

**Prior, 2026-08-07** (the self-consent and listing-merge tranche, deployed): 1553 unit, 802
integration, typecheck, lint.

**Prior, 2026-08-07** (F-079 tranche, deployed): 1495 unit, 791 integration, typecheck, lint,
`evals` 44/44 (critical 11/11, advisory 4/4, adversarial 29/29), production build. Infra:
`plan-assertions.py` 55/55, `secrets-lifecycle.test.py` and `test_plan_assertions.py` pass.

**Last `evals:live`: 2026-08-06, 25/25** against `mistralai/Mistral-Small-24B-Instruct-2501`
(containment 4/4, closure 7/7, quality 9/9, recall 5/5). Owed again on any change to a seam's
projection, schema, or output contract.

Standing rules: real-Postgres integration runs from an empty schema against local Postgres, **never**
production Neon. Never carry an old test count forward as current evidence.

## Standing facts from the newest tranche (F-088, 2026-08-07)

Reasoning and the findings behind each: [SESSION_LOG.md](SESSION_LOG.md), 2026-08-07.

- **Every farm is placed, and `visitability` decides what the map INVITES — not what it stores.**
  `sales_locations_coherent_visitability` now states one rule over the shape of a location
  (complete, or absent) and names `visitability` only in the branch forbidding an unplaced
  *visitable* stand. A `contact_only` farm may carry a full address and coordinates.
- **F-038's protection moved from the database into `buildMapView`, and is weaker for it.** A farm
  with no stand gets its pin and its own `contact-only` marker but **no directions link** — the
  clause `stand.visitability !== "contact_only"` is what stops a customer being handed turn-by-turn
  navigation to a farm with nothing to buy. It was an unbypassable constraint; it is now a
  conditional with a test behind it. max accepted that trade knowingly.
- **The `contact-only` marker had existed and been unreachable all along.** `mapMarkerKind`, the `●`
  symbol, the "Farm, no stand" legend entry and its CSS were built long ago; the old constraint
  forbade the coordinate that would have rendered them.
- **`address_public` is display-only, and the directions link needs separate suppression.** The
  route is built from the *coordinate*, not the address string, so hiding an address does not hide
  the way there. Both the public card and the SMS answer path honour the flag (the latter in SQL, so
  a hidden address never leaves the database); **admin deliberately shows it**, marked "hidden from
  customers", because support work needs it.
- **The whole-listing writer means every new column is a B-037 risk.** `saveOnboardingListing`
  writes `address_public` on every save, so any door or reader that cannot see it would silently
  republish an address the farmer hid.

**Owed:** a human visual pass. The browser extension never connected, so the wizard styling,
dropdown widths, the 30rem breakpoint, the description box, and **F-088's inline address control,
always-on map and zoom** are unverified by eye.

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
  makes the stand `contact_only`. **Production still publishes her address** until F-064's ingest
  runs; the approved interim correction remains in place. **F-088 changed what that fix means**: a
  `contact_only` stand may now carry an address and a pin, so "refused" no longer implies "unplaced".
  The seeder still stores nothing for a farm that states nothing, and the protection a refusal buys
  is now the suppressed directions link and the "Farm, no stand" marker — verify the ingest honours
  that rather than assuming the old all-or-nothing shape.
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
