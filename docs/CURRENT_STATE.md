# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Record only verified facts,
> and only ones still true. Architecture docs own enduring contracts; *why* a past change was made
> belongs in [SESSION_LOG.md](SESSION_LOG.md), not here. When an item closes, delete it rather than
> striking it through — the log keeps the history.

## Release state

Farm Friend is **pre-go-live**. Production runs one image across Cloud Run web revision
`farm-friend-web-00042-rfs` and worker revision `farm-friend-worker-00041-g59`, both at digest
`sha256:efc4271941f4d0d764d878b085b66bed3a0278527d568c7ec280c3a51ff0fd1e` (`main` at `6ab087e`).
Production Postgres is `neondb` with **29 migrations** (`0000`–`0028`).

**`main` and production are IN SYNC** as of 2026-08-08, and **no migrations are owed** — `0026`
through `0028` were applied before the image was promoted, in that order, and verified by effect
(count 26 → 29, every new column, all three `pending_phone` CHECK constraints, and the partial index
*with* its `where (redeemed_at is null)` predicate). Production was fingerprinted first and 36 farms
survived. Deploy assertions: plan `0 to add, 2 to change, 0 to destroy`, `plan-assertions` 55/55,
`deploy_assertions` and `served_card_assertions` pass.

**Nothing has been exercised against Telnyx or in a browser on production.** The `START` onboarding
path is proven through the real webhook handler against real Postgres only. No SMS has completed
onboarding on the deployed code, and no farmer has filled in the form on production.

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

**Latest, 2026-08-08** (onboarding form + `START` onboarding, deployed): **1580 unit** (130 files),
**821 integration** (59 files), typecheck, lint. Integration ran against **local Postgres**, never
Neon. No `packages/ai` file changed, so no `evals`/`evals:live` run was owed.

**Last `evals:live`: 2026-08-06, 25/25** against `mistralai/Mistral-Small-24B-Instruct-2501`
(containment 4/4, closure 7/7, quality 9/9, recall 5/5). Owed again on any change to a seam's
projection, schema, or output contract.

Standing rules: real-Postgres integration runs from an empty schema against local Postgres, **never**
production Neon. Never carry an old test count forward as current evidence. Per-tranche verification
narratives live in [SESSION_LOG.md](SESSION_LOG.md).

## Standing facts a cold start needs

Reasoning, the defects found on the way, and the sabotage lists: [SESSION_LOG.md](SESSION_LOG.md).

**Onboarding completes by a bare `START`, matched by phone.** `JOIN <token>` is gone — a farmer
hand-copying 64 hex characters failed silently on any slip. The farmer states a phone on the
onboarding form (`farmer_invitations.pending_phone_*`); an inbound bare `START` matches it against
unredeemed invitations and runs the redemption. `JOIN` remains a registered compliance opt-in, and
`JOIN` followed by anything is ordinary free text.

- **The consent rule differs by credential, and inverting it is the trap.** The phone path must NOT
  pass `firstTimeOnly` — `START` is the carrier's own keyword and the only word that clears its
  opt-out list, so it is exactly what a *returning* farmer sends. Refusing an existing record would
  spend their invitation and leave consent `stopped` with nothing reporting it. The token path kept
  the flag (B-011). A web form still cannot re-enroll an opted-out person, because a tick writes no
  consent at all.
- **Only `START` may complete onboarding, never bare `JOIN`** — `JOIN` cannot lift a carrier block.
- **The carrier transition runs first, the redemption second.** `START` enrolls unconditionally
  whether or not an invitation is waiting.
- **The SMS agreement is a field on the listing form, above Submit, and gates it.** Without
  `agreed_to_sms_at` the redemption authorizes nobody. `AgreementStep` is deleted.
- **A mistyped phone has no other signal**, which is why the confirm dialog blocks: ten valid digits
  are indistinguishable from the right ten. A wrong number grants nothing and leaves the invitation
  unredeemed and retryable.

**Every farm is placed; `visitability` decides what the map INVITES, not what it stores.** A
`contact_only` farm may carry a full address and coordinates. F-038's protection moved from a database
constraint into `buildMapView` — a farm with no stand gets a pin and a `contact-only` marker but **no
directions link** — so it is now a conditional with a test behind it rather than an unbypassable
constraint. max accepted that trade knowingly.

- **`address_public` is display-only, and the directions link needs separate suppression**, because
  the route is built from the coordinate rather than the address string. Admin deliberately shows the
  address, marked "hidden from customers", because support work needs it.
- **The whole-listing writer makes every new column a B-037 risk.** `saveOnboardingListing` writes
  every column on every save, so any door or reader that cannot see a column silently reverts it.

## What is live

- **Public discovery:** model-free map/list, offering filters, honest recency, closures, participant
  names, transient browser proximity, destination links, and code-bound stock-out reporting.
- **Farmer workflows:** deterministic bare `START` onboarding, `LINK`, `STAND`, `SETTINGS`, and
  `SAME`; one exact stand per credential; SMS/web proposal and confirmation; closures, participants, reminders.
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
- **F-029:** finish live carrier launch verification — the `START` onboarding path has never
  been exercised against Telnyx from a real handset.
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
