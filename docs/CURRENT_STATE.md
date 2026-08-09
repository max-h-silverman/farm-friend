# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Record only verified facts,
> and only ones still true. Architecture docs own enduring contracts; *why* a past change was made
> belongs in [SESSION_LOG.md](SESSION_LOG.md), not here. When an item closes, delete it rather than
> striking it through — the log keeps the history.

## Release state

Farm Friend is **pre-go-live**. Production Postgres is `neondb` with **30 migrations**
(`0000`–`0029`). Cloud Run web is revision `farm-friend-web-00043-bn7`; worker is
`farm-friend-worker-00041-g59`.

**The DATA is current; the CODE is several releases behind.** Revision `00043` runs the image built
from `main` at `6ab087e`, started only to pick up a rotated secret. Everything merged since is
undeployed. **A deploy is owed and is the next release step.**

**Four migrations are written and unapplied in production**: `0030_stand_item_price`,
`0031_invitation_pending_stock` (F-090), `0032_structured_item_price` (F-092) and
`0033_price_basis_unit` (B-041). All verified by effect against a fresh database and applied to
local dev. `0031` **recreates the `inventory_revision_source` enum** to add `web`. `0032` **drops
`stand_items.price_text`** — safe because no row anywhere has ever carried a price (285 CSV stands,
one dollar sign, and it is a delivery threshold; 37 local stand items, none priced). `0033`
rewrites `stand_items_price_complete` and adds `stand_items_price_basis_unit`. It changes no
column — only which shapes the price columns admit — and it depends on `0032` having run first,
which the journal order guarantees.

**Production data was rebuilt from the CSVs on 2026-08-08.** Verified counts after the final
re-seed: 35 farms / 35 sales locations / 35 live approvals; 35 `farm_links`, 53 payment methods, 10
participants; 15 dated confirmations, all `source = 'viga'`; `open_days` on 24 of 35; 38 farm emails
across 32 farms; 1 administrator; **0 consents and 0 farmer authorizations**.

The rebuild **deleted 3 real SMS consent records** (max's explicit call). Those numbers must each
text `START` again before Farm Friend can message them — we cannot text first. The pre-wipe dump is
at `~/farm-friend-backups/neondb-PRE-WIPE-20260807-224344.dump`, verified restorable; it is the only
copy of that evidence.

**Two restore steps the seeders do NOT cover**: the fixed administrator
(`bootstrap-administrator.ts`) and the farm email roster (`ingest-farm-emails.ts`, which must reuse
the stored `EMAIL_HASH_SALT` or no farmer can verify). Neither is in the CSVs.

**Nothing has been exercised against Telnyx or in a browser on production.** The `START` onboarding
path is proven through the real webhook handler against real Postgres only.

### Secrets

- **Web mounts** `GEOCODING_API_KEY`, `SMTP_PASSWORD`, and F-079's three; **the worker mounts
  none**, asserted unconditionally. `infra/production.tfvars` keeps that true across applies — every
  `mount_*` defaults to false, so a plan without `-var-file` silently unmounts whatever the last
  apply enabled. `plan-assertions.py` fails by name on any plan that would unmount a live secret.
- **`EMAIL_HASH_SALT` can never be rotated** without re-ingesting the roster. A mismatch is this
  feature's quietest failure: every correct address fails to match, nothing errors, nobody verifies.
- **The migration door's secret is obscurity, not a credential** — never post it anywhere indexable.
  `gcloud secrets versions access latest --secret=farm-friend-farmer-start-secret --project
  farm-friend-vashon`. Rotating it invalidates links already sent.

## Verification

**Latest, 2026-08-08** (B-024, B-040–B-042, the submission flow): **1699 unit** (135 files),
typecheck, lint. Integration ran against **local Postgres**, never Neon. No `packages/ai` file
changed and prices reach no model seam, so no `evals`/`evals:live` was owed.

Sabotaged before believing: inverting `standItemPriceNeedsUnit` fails 5 renderer tests; restoring
the value-sniffing unit control fails B-040's test; `CHECK (true)` fails the constraint test;
removing either `[hidden]` rule fails the sweep, and blinding the sweep's own JSX matcher fails its
guard; B-024's refusal pattern was sabotaged in **both** directions — too tight fails the honour
test, too loose fails the false-positive test. Both constraint halves proven by direct insert
against local dev. The wizard, the price row and the new submission flow were **walked in a real
browser**; the stand page's two-tab fix was not — it is the same one-line rule as the wizard's, and
is covered by the sweep.

**A full `test:integration:local` fails intermittently** on three files that vary run to run, and
fails identically with this work stashed — B-020, not the change. Touched areas pass on their own:
52 onboarding-listing, 225 seed.

**Last `evals:live`: 2026-08-06, 25/25** against `mistralai/Mistral-Small-24B-Instruct-2501`
(containment 4/4, closure 7/7, quality 9/9, recall 5/5). Owed again on any change to a seam's
projection, schema, or output contract.

Standing rules: real-Postgres integration runs from an empty schema against local Postgres, **never**
production Neon. Never carry an old test count forward as current evidence. **Tests each build their
own database, so a green suite says nothing about the local dev database** — a missing migration
there 500s every page while all 1652 pass. Per-tranche narratives live in
[SESSION_LOG.md](SESSION_LOG.md).

## Standing facts a cold start needs

Reasoning, the defects found on the way, and the sabotage lists: [SESSION_LOG.md](SESSION_LOG.md).

**Onboarding completes by a bare `START`, matched by phone.** The farmer states a phone on the
onboarding form (`farmer_invitations.pending_phone_*`); an inbound bare `START` matches it against
unredeemed invitations and runs the redemption. `JOIN <token>` is gone; `JOIN` remains a registered
compliance opt-in, and `JOIN` followed by anything is ordinary free text.

- **The consent rule differs by credential, and inverting it is the trap.** The phone path must NOT
  pass `firstTimeOnly` — `START` is the carrier's own keyword and the only word that clears its
  opt-out list, so it is exactly what a *returning* farmer sends. The token path kept the flag
  (B-011). A web form still cannot re-enroll an opted-out person: a tick writes no consent at all.
- **Only `START` may complete onboarding, never bare `JOIN`** — `JOIN` cannot lift a carrier block.
- **The carrier transition runs first, the redemption second.**
- **The SMS agreement is a field on the listing form, above Submit, and gates it.** Without
  `agreed_to_sms_at` the redemption authorizes nobody.
- **A mistyped phone has no other signal**, which is why the confirm dialog blocks.

**A dated stock claim declares one of three provenances** (F-063, F-090), and a CHECK makes them
mutually exclusive: `sms` names a proposal + authorization + approval; `web` names an authorization
+ approval and **no proposal** (stated on the onboarding form, published when `START` proved the
handset); `viga` names none. Stock stated at onboarding is held on the invitation and publishes
inside the redemption transaction — never before, because a dated claim needs someone to stand
behind it. **Adding an enum value means recreating the type**, never `ALTER TYPE … ADD VALUE`.

**Every farm is placed; `visitability` decides what the map INVITES, not what it stores.** A
`contact_only` farm may carry a full address and coordinates. F-038's protection lives in
`buildMapView` — a farm with no stand gets a pin and a `contact-only` marker but **no directions
link** — a conditional with a test behind it rather than an unbypassable constraint.

- **`address_public` is display-only, and the directions link needs separate suppression**, because
  the route is built from the coordinate rather than the address string.
- **The whole-listing writer makes every new column a B-037 risk.** `saveOnboardingListing` writes
  every column on every save, so any door or reader that cannot see a column silently reverts it.
  **A reader that resolves a farm's stand must use the writer's exact query** — including its lack
  of a `retired_at` filter — or a form prefills from one stand and the save replaces another.

## What is live

- **Public discovery:** model-free map/list, offering filters, honest recency, closures, participant
  names, transient browser proximity, destination links, code-bound stock-out reporting, and
  farmer-stated item prices — **structured** as amount/quantity/unit/basis (F-092), rendered to one
  sentence by core's `renderStandItemPrice` and gated per stand by `sales_locations.prices_public`,
  which is **off by default** at the column, the migration and the form. The gate is **in the SQL**,
  so a withheld price never leaves the database. The unit is optional for a bundle and required for
  a unit price (B-041) — one rule, `standItemPriceNeedsUnit`, imported by every layer.
- **Farmer workflows:** deterministic bare `START` onboarding, `LINK`, `STAND`, `SETTINGS`, `SAME`;
  one exact stand per credential; SMS/web proposal and confirmation; closures, participants,
  reminders. Three onboarding doors — invited, grandfathered (`/farmer/start`), and the emailed-code
  migration door (`/farmer/start/<secret>`). Onboarding is a **four-step wizard** that prefills what
  VIGA already holds; the farmer's own stand page is **two tabs** (status/stock, details+settings).
- **Customer SMS:** model interpretation over typed retrieval, identifier validation, and
  code-rendered grounded answers. `MAP`, compliance commands, and confirmation routing are
  deterministic and run before any model.
- **Administration:** fixed-account password sign-in (the signed-out screen renders the fields
  directly) and server-rendered farm approval, farmer access, flag, stock-report, and stand-data
  workflows. Phones are masked at the query boundary.
- **Scheduled work:** Cloud Tasks handles immediate sender work; one Cloud Scheduler route runs
  recovery, prompts, delivery, callbacks, and retention.

## Open before go-live

**Owed data runs and live checks**

- **A deploy is owed**, including migrations `0030`/`0031`/`0032`/`0033`.
- **B-024 is fixed in the SEEDER but not in the live row.** Handpicked Homestead's home address
  was still published as a visitable stand as of the 2026-08-08 rebuild, which ran the old
  classifier. The fix takes effect only on a re-seed, so production must be **re-seeded or the row
  corrected by hand** — and verified by effect (`visitability = 'contact_only'`,
  `public_address IS NULL`, no coordinate reaching the map). Until then a private residence is on
  the map against the farmer's written request, which is the one open item that should block
  sharing the map with anyone.
- **F-029:** finish live carrier launch verification — the `START` onboarding path has never been
  exercised against Telnyx from a real handset.
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
  is no general admin audit log. Three writers of public listing state, none recording who wrote.
- **F-084 — participants on the onboarding form.** `saveSalesLocationParticipants` requires a
  verified `senderHash`; the onboarding form has no phone, so this needs an attribution decision
  first. Its own analysis allows "stays post-authorization" as a possible right answer.
- **F-076 — quantity/price editing on the today's-stock chips.** Now also the one place the two
  price shapes meet: `stand_items` is structured (F-092) while `inventory_entries.price_text` is
  still free text, and onboarding writes today's stock by rendering the structured price into it.
  Whether that column follows is the open question.
- **B-001:** an unreproducible integration flake from 2026-07-25 whose failing test name was never
  captured. Filed as a watch item, not diagnosed — a load-dependent flake is what latent
  nondeterminism looks like. Distinct from **B-020**, the reproducible cross-suite deadlock: three
  files fail intermittently on a full `test:integration:local`, with a different set each run, and
  they fail identically on a clean tree. Attributed by stashing, 2026-08-08.
- **B-008:** replace the incomplete deployed-build lint gate. Next does not recognize
  `outputFileTracingRoot`, and the Next ESLint plugin is not installed.
- **B-034:** upgrade affected production dependencies and assess advisory reachability.
- **B-036:** the "North ferry" label is clipped at the island map's top edge (cosmetic).
- Remaining go-live work is in [GO_LIVE_GUIDE.md](GO_LIVE_GUIDE.md): **GL-007** (stock-out → farmer
  alert), **GL-008** (customer stock-out surface), **GL-015** (its *stand-data flag* half), plus the
  P2 resilience band and P3 decisions.

**Unverified at phone width** — jsdom reports every element as zero-sized, so these are covered by
tests but not by eye: the farmer agreement step, the expanded stand detail, F-067's onboarding
listing form and its map, and **F-090's four-step wizard and two-tab stand page**. F-092's two-line
priced item rows *were* measured in a real browser at 500px (name ellipsises, controls hold size,
no sideways page scroll) — the rest of the form was not. Per-tranche browser checks are **not
tracked here** (max, 2026-08-05): he runs a browser pass himself before go-live.

**VIGA's call, not a code question:** whether Vashon Island Farmers Market belongs in the roster as
a farm at all — it is the market itself, not a stand with a farmer to onboard.

## Traps worth not rediscovering

- **`VIGA Map Stands.csv` writes multi-line descriptions unquoted**, so an ordinary CSV read splits
  one stand into many rows — a naive parse produced 275 phantom farms. The real count is **31
  stands**, reassembled by treating a `POINT` in the first column as the only record boundary.
- **`drizzle-kit generate` silently drops CHECK constraints and partial unique indexes.** Always
  RUN `generate` (it is what writes the meta snapshot), then append the CHECKs to the generated
  file by hand; verify by effect that each constraint genuinely refuses. Writing the `.sql`
  yourself instead skips the snapshot and strands the next author — see RUNBOOK §Migrations.
- **A column missing from `schema.ts` is DROPPED by the next `generate`, in whatever unrelated
  migration runs next.** `generate` diffs the database against that file, never against the
  journal. `farmer_invitations.pending_stock` — live, hand-written in `0031`, never mirrored —
  came within one unread line of being dropped by F-092's migration. Read generated SQL line by
  line and treat an unasked-for `DROP` as a schema-file omission.
- **A migration command can exit 0 having skipped a migration** whose journal timestamp is not
  newer, or one with no journal entry at all. Verify the schema effect against
  `information_schema`, never the exit status or the words "migrations applied". This bites
  locally exactly as it does in production.
- **A backtick inside a SQL comment ends the JS template literal.** It fails as a TypeScript syntax
  error pointing at the query, not at the comment.
- **`printf %s`, never `echo`, when adding a salt to Secret Manager.** A trailing newline produces
  hashes that look right in every listing and match nothing at runtime.
- **Measuring a parser is not measuring the data.** To say what a card shows, read
  `farms.description` from production.
- **The stored prose contains malformed dates.** One row begins literally `/22/2026 Update:`.
  Patterns anchored on a leading month digit miss it.
