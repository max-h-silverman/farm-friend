# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Record only verified facts,
> and only ones still true. Architecture docs own enduring contracts; *why* a past change was made
> belongs in [SESSION_LOG.md](SESSION_LOG.md), not here. When an item closes, delete it rather than
> striking it through — the log keeps the history.

## Release state

Farm Friend is **pre-go-live**. Production Postgres `neondb` has **36 migrations** (`0000`–`0035`);
Cloud Run web is `farm-friend-web-00048-g6r` and worker is `farm-friend-worker-00045-ctn`. Both run
digest `sha256:a2baa845810781c22195295ae74f90e93528462659c7a3073335380da2437882`.

**Production is level with main at `33bc946`** (deployed 2026-08-09): F-076's stock editor, F-097's
farmer-surface pass and F-098 are all live, and migrations `0034_invitation_pending_cadence` and
`0035_self_issued_invitation` are applied — verified by schema effect against `information_schema`,
not by the migrator's success message. No unapplied migration remains.

Verified against the deployed revision on 2026-08-09: the served favicon (`/icon.png`, 39,243 bytes),
the F-098 farmer surfaces (one commit button on the details tab, reminders on the stock tab, the new
link copy), and one web stand update end to end against a test farm — confirmed by the changed row
and its advanced `updated_at`, then restored. `deploy_assertions.py` and `served_card_assertions.py`
both passed; the plan carried 55/55 safety assertions and changed only the image digest.

**Max walks the farmer surfaces at phone width before a tranche ships.** He confirmed that pass for
this deploy; a session that opens by deploying has skipped the gate.

**Data, schema and runtime code are current.** Neon has all structured-price and pending-stock
columns, no legacy `price_text`, and the final price/location constraints. Verified corpus counts:
35 farms / locations / approvals, 35 links, 53 payments, 10 participants, 15 VIGA confirmations,
24 with open days, 38 farm emails across 32 farms, 1 administrator, 0 consents/authorizations.

The rebuild deliberately removed 3 real consents; those phones must text `START` again. Its verified
backup is `~/farm-friend-backups/neondb-PRE-WIPE-20260807-224344.dump`. Seeders do not restore the
fixed administrator or farm-email roster; email ingest must reuse the deployed `EMAIL_HASH_SALT`.

Telnyx remains untested live.

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

**Latest, 2026-08-09:** **1763 unit**, typecheck, lint and the production Cloud Build. Integration is
green for every suite touching F-098, including the self-issued claim end to end from an empty
schema; four unrelated suites fail under cross-suite contention and fail the same way on a clean
tree (B-020 below). Sabotage lists and what each check proved:
[SESSION_LOG.md](SESSION_LOG.md).

**B-020:** full integration can fail on varying files under cross-suite contention; it passed in
this wrap. Treat any named recurrence as real and attribute it against a clean tree.

**Last `evals:live`: 2026-08-06, 25/25** against `mistralai/Mistral-Small-24B-Instruct-2501`
(containment 4/4, closure 7/7, quality 9/9, recall 5/5). Owed again on any change to a seam's
projection, schema, or output contract.

Integration runs from an empty local Postgres schema, never Neon. Each file builds its own database,
so green tests prove nothing about the local dev database; verify migrations by schema effect.

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
  one exact stand per credential; closures, participants, reminders. Three onboarding doors —
  invited, grandfathered (`/farmer/start`), and the emailed-code migration door
  (`/farmer/start/<secret>`). Onboarding is a **four-step wizard** that prefills what VIGA already
  holds and asks the farmer's reminder cadence beside the SMS agreement (held on the invitation,
  applied at redemption); the farmer's own stand page is **two tabs** (status/stock,
  details+settings), and its settings panel is one section list behind one Save.
  - **Confirmation is asymmetric by channel, deliberately.** SMS proposes and waits for `YES`,
    because code interpreted prose and must show its reading first. The web editor **publishes in
    one press** and writes its confirmation message `suppressed` rather than sending it. The
    publication TRANSACTION is the same on both paths — authority, VIGA approval, retirement and
    exactly-once consumption are all still enforced under its locks.
  - **The stand link token is base64url** (22 chars). `isFarmerLinkToken` also accepts the 64-hex
    tokens minted before 2026-08-09; `LINK` re-mints in the new shape.
  - **Parsed and TAUGHT are different sets.** The setup text names `LINK`, names `STAND` only when
    the farm has more than one, and never names `SETTINGS` — a farmer has one edit page that
    `LINK` already opens. Both stay parsed and working. `FARMER_UNTAUGHT_KEYWORDS` records why,
    and the keyword tripwire requires every parsed keyword to sit in one list or the other.
    **`SETTINGS` returns to the taught set when account settings become a separate surface.**
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
- **B-001:** an unreproducible integration flake from 2026-07-25 whose failing test name was never
  captured — a watch item, not diagnosed. Distinct from **B-020** (see Verification above).
- **B-008:** replace the incomplete deployed-build lint gate. Next does not recognize
  `outputFileTracingRoot`, and the Next ESLint plugin is not installed.
- **B-034:** upgrade affected production dependencies and assess advisory reachability.
- **B-036:** the "North ferry" label is clipped at the island map's top edge (cosmetic).
- Remaining go-live work is in [GO_LIVE_GUIDE.md](GO_LIVE_GUIDE.md): **GL-007** (stock-out → farmer
  alert), **GL-008** (customer stock-out surface), **GL-015** (its *stand-data flag* half), plus the
  P2 resilience band and P3 decisions.

**Unverified at phone width** — jsdom reports every element as zero-sized, so these are covered by
tests but not by eye: the farmer agreement step, F-067's onboarding listing form and its map,
F-090's four-step wizard, and F-097's restyled surfaces (the settings panel, the saved-confirmation
screen, the onboarding cadence control, the map card's recency caption). Per-tranche browser checks
are **not tracked here** (max, 2026-08-05): he runs a browser pass himself before go-live.

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
  locally exactly as it does in production. **This is live right now, not hypothetical:**
  `0033`'s stamp is dated 2026-08-30, so anything `drizzle-kit generate` produces before that date
  is born older than the last applied migration and skips itself. Hand-correct the `when` in
  `_journal.json` and let `migration-ordering.test.ts` confirm it.
- **A backtick inside a SQL comment ends the JS template literal.** It fails as a TypeScript syntax
  error pointing at the query, not at the comment.
- **`printf %s`, never `echo`, when adding a salt to Secret Manager.** A trailing newline produces
  hashes that look right in every listing and match nothing at runtime.
- **Measuring a parser is not measuring the data.** To say what a card shows, read
  `farms.description` from production.
- **The stored prose contains malformed dates.** One row begins literally `/22/2026 Update:`.
  Patterns anchored on a leading month digit miss it.
