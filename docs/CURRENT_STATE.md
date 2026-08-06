# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Record only verified facts.
> Architecture docs own enduring contracts; dated reasoning and deployment proof live in the
> session log.

## Release state

Farm Friend is **pre-go-live**. Production runs one image across Cloud Run web revision
`farm-friend-web-00032-msc` and worker revision `farm-friend-worker-00033-tp9`, both at digest
`sha256:95ae621177b59ce53834e8267da16d0e792950d5ed596bfae682b753755b4eb3` (`main` at `3b6e580`,
PR #82). Production Postgres is `neondb` with **all 22 migrations applied (`0000`–`0021`)**,
verified by effect on 2026-08-05 — see the [session log](SESSION_LOG.md) for the per-migration
checks and the fingerprint that preceded them.

**F-069 and F-070 are DEPLOYED** (2026-08-06). Neither adds a migration, so none was owed. Plan
assertions 37/37, deploy and served-card assertions pass. **Verified by effect in the served
bytes**, not from the green apply: the root page carries **12 secondary road paths and 1 highway
path** (F-070's exact geometry), and `POST /api/farmer/address-lookup` answers `invalid_request`
to a malformed token and a uniform `invitation_unavailable` to a well-formed unknown one, leaking
no key.

**Two changes are now MERGED and NOT DEPLOYED, in this order ahead of production:**

1. **F-071**, which carries migration **`0022_stand_retirement`**. That migration is **not applied
   to production** — apply it before promoting any image built from this base, per the RUNBOOK's
   ordering rule. It is additive (two nullable columns, one CHECK, one partial index), so the
   currently deployed image keeps serving correctly in the window between the migration and the
   deploy.
2. **The expanded stand card redesign** (2026-08-06). Presentation only — `stand-map.tsx`,
   `globals.css`, and its tests. **No migration, no schema, no API, no model seam**, so it adds
   nothing to the deploy ordering above. max chose merge-without-deploy for it, so it ships
   whenever the F-071 deploy is next run.

**`GEOCODING_API_KEY` is still unset in production**, so address lookup is off and the onboarding
form serves the pre-F-069 pin-drop behaviour — a supported deployment. The two live checks below
remain owed, and the geocoding one **cannot be run until that key is set**.

**Deployed twice on 2026-08-05, each verified by effect**: plan assertions 37/37 both times,
deploy and served-card assertions pass, and the live site serves **34 stands, 33 reading
`usuallySells` from `stand_items`** — so the promoted image and the migrated schema demonstrably
agree. `POST /api/farmer/listing` answers `400` to a malformed token before touching the database
and a uniform `410` to a well-formed unknown one, so it is not an oracle for whether a guessed token
names anything.

**All 35 seeded farms are now approved** (2026-08-05), recorded against the board account. The
admin's approval queue had held all 35 while approving them changed nothing a customer sees:
`listPublicStands` gates on `is_public`, **not** on approval, so those stands were already on the
map. What approval gates is whether the **farmer may publish an update** — `confirmProposal` and the
scheduled prompts both re-read it. The bulk write was insert-only, idempotent against the partial
unique index, fingerprinted before writing, and verified by effect (queue empty, 35 locations
untouched, a re-run writes zero). `scripts/approve-seeded-farms.ts` is retained and safe to re-run.
Admin copy in three places was corrected to match: approval is now the **exception**, and an empty
queue is the normal state rather than a sign something failed.

`0019`, `0020`, and `0021` were applied **before** the code that reads them was promoted, per the
RUNBOOK's ordering rule. All three are additive and backward-compatible (a column, a table, a
widened constraint), so the pre-tranche image kept serving correctly in the window between the
migration and the deploy. **`0020` backfilled 212 `stand_items` rows from real production data**;
listing data was unchanged (35 farms, 35 locations, 2 contacts, before and after). max declined a
pre-migration snapshot when asked.

The farmer-consent launch blocker closed in the previous tranche and is deployed; see the
[session log](SESSION_LOG.md) for its reasoning.

Four tranches have now landed on `main` and are **DEPLOYED**, with all their migrations applied
ahead of the image that reads them:

- the **listing ingestion work** (F-063, F-061, F-062, and F-064's guard) — migration `0019`
  (`inventory_revisions.source`);
- **F-066's one item vocabulary** — migration `0020` (`stand_items`);
- **F-067's self-serve farmer onboarding** — migration `0021`
  (`farmer_onboarding_requests_coherent_settlement` widened);
- **F-067's onboarding listing form** — the first farmer-facing writer of listing facts; no
  migration of its own.

F-066 and F-067's first half landed together as **PR #80** (`41e6dd0`); the listing form landed as
**PR #81**. Each merged base was re-verified green rather than assumed from the branch's own run.

**The schema is current; the listing DATA is not.** F-064's production ingest has still not run, so
production continues to serve the pre-tranche listing content — see "Open before go-live" below.

An earlier tranche produced two findings that outgrew it and drove the ingestion audit:

- **the map CSV is a hand-maintained derivative**, so the oddities in stand descriptions
  (`WA, WA 98070`, en-dashes in dated lines) are transcription residue from the manual step Farm
  Friend exists to remove;
- **`parseFormResponses` was suspected of describing a source VIGA has never produced. That is
  disproved** (audit 2026-08-04, **B-035 closed wont-fix**). VIGA supplies **three** CSVs, not two:
  a per-farm **profile form** (`2026 Farm Stand Information (Responses)…`, header matches
  `EXPECTED_COLUMNS` byte for byte, parses to 31 stands + 1 known refusal, **still open**), the map
  transcription (31 stands, the only coordinates), and the **weekly stock form** (734 rows, 49 farms
  — **now parsed and ingested for 2026**, F-062). Both "invented" fixtures are real data. The join
  is sound: 35 stands, 0 refusals.

`extractStockUpdate` parses VIGA's dated `"5/26/2026 Update: …"` lines. **How such a line is stored
is now resolved** — F-063's `source = 'viga'` is exactly that record — and the same parser gained
two fixes found only by measuring the real export: the separator is written as a dash in 5 of 18
lines, and one line uses a two-digit year. Its remaining job is to keep those lines out of the
public description, which it does.

## Verification

- Current `main` (the stand-card redesign): **112 unit files / 1243 tests**, **50 integration
  files / 688 tests**, typecheck and lint pass — **re-run on the merged base**, not carried over
  from the branch. **No `packages/ai` file changed, so no eval or `evals:live` run is owed.** **Not
  deployed**, and migration `0022` is not applied to production (see Release state).
  **Two live checks remain owed**, recorded rather than assumed: the onboarding form has **not been
  exercised in a real browser** since F-069, and the geocoding path has **never made a real billed
  call** — every test injects the provider, so the live request/response shape is unverified. The
  geocoding check is **blocked until `GEOCODING_API_KEY` is set** in production. **Per-tranche
  browser checks are no longer tracked here** (max, 2026-08-05): he runs browser testing himself in
  a pass before go-live, so listing them per item recorded a debt that was not one.
- **The card redesign was browser-checked at both widths, including in dark OS appearance.** Not
  logged as an owed item — the check is done. At 390px the phone sheet leads with the confirmed
  chips, wraps them to two rows and the "usually sells" sentence as prose; with the machine in dark
  appearance the page still served the light palette (body `#fbfaf7`, chips `#eaf3ed`), which is
  the pairing DEVELOPMENT.md §before you ship requires and that F-043 once shipped five defects
  past. Three tests were added and **each was sabotage-verified**; one of them exists because
  deleting a user-facing accessibility signal broke **zero** tests.
- Prior `main` (`3b6e580`, F-069 + F-070): **1234 unit tests**, **48 integration files / 665
  tests**, typecheck and lint pass. **Deployed** 2026-08-06. Superseded by the run above.
- Prior `main` (`84c512d`): **1120 unit tests**, **48 integration files / 655 tests**, typecheck
  and lint pass (2026-08-05). Superseded by the run above.
- Prior `main` (`41e6dd0`): **105 unit-test files / 1075 tests**, typecheck, lint, and **evals
  (critical 11/11, adversarial 29/29, advisory 4/4)** pass (verified 2026-08-05). Superseded by the
  run above and now deployed as part of `7c996a7`.
- Real-Postgres integration runs from an empty schema against a local Postgres — **never** against
  production Neon.
- **F-067's listing form verified END TO END in a real browser**, then read back from Postgres and
  from `/api/public/stands` rather than from the screen's success message: a farmer fills the form
  and the stand reaches the public map with address, pin, hours, payment methods, and their own
  item words, with no VIGA step. The pin landed at 47.4497 / -122.4733 — Vashon town, where the tap
  was — so the projection round-trips in a live browser, not only in tests. **Zero inventory
  revisions** were written, which is F-066's separation holding.
- **Five sabotages this tranche, each failing named tests**: dropping the pin requirement (caught
  by the integration test AND by `coherentVisitability`, proving both layers real), flipping the
  projection's y-inversion (3 tests), sending an address and pin regardless of the visitability
  branch (1), accepting a body-supplied `farmId` (1 — the cross-farm write vector), and adding an
  inventory write to the listing path (1, via a new architecture tripwire).
- **One sabotage escaped, which is the reason to run them.** A plural-stripping normalizer
  ("tomatoes" → "tomatoe") passed all 17 new integration tests: it mangles the key without
  colliding, and the database index applies the correct rule independently, so the stored rows
  looked right while the in-memory dedupe had stopped agreeing with the index that arbitrates.
  `standItemKey` is now exported and asserted directly — including that it returns the word
  itself, the assertion no collision test can make — and the escaped sabotage fails 4 named tests.
- **A test-defect of the same family was found in an existing file.**
  `farmer-onboarding-surface.test.ts` reads page source as raw text, so the comment recording that
  "VIGA reviews your request" was retired satisfied a search for that phrase. It now strips
  comments first, verified by effect (present in the raw file, absent after stripping, markup
  intact). This affected its pre-existing assertions too, not only the new ones.
- **Migration `0021` verified by effect**, and the check found a gap the suites could not: the
  integration suites build their own databases, so all 635 passed while the local dev database
  still held the pre-`0021` constraint. Confirmed via `pg_get_constraintdef` after applying, then
  sabotaged the constraint to confirm it still refuses a settlement recording neither an
  administrator nor an authorization.
- **F-067's self-serve chain verified end to end against real Postgres**, not only by suite: a
  coordinator names a new farm on an invitation, the farmer ticks the agreement and redeems it, and
  the farmer holds a live `farmer_authorizations` row for that farm with **no open onboarding
  request**, the audit event attributing the act to the farmer's contact hash rather than an
  administrator, and exactly one queued text.
- **Migration `0020` verified by effect on BOTH an empty and a populated pre-change schema.** The
  populated run applies every migration through `0019`, writes the rows a real database holds —
  including two offering rows differing only in case, which were legal before and collide under
  the new index — and only then applies `0020`. It asserts it is genuinely on the pre-change
  schema first, so it cannot pass by silently running against an already-migrated database.
- **Five sabotages this tranche, each failing named tests**: removing case normalization from the
  index (3 tests), deleting the confirmed-only half of the backfill (3), breaking the entry →
  item resolution in the public reader (1), and reverting the not-blank CHECK to the default
  `btrim` (1).
- **One sabotage found a gap in the tests rather than confirming them**, which is the reason to
  run them: reverting the seeder's `do update` to `do nothing` broke nothing. An item that exists
  only because a revision confirmed it would silently never become a standing claim — the
  approved tag dropped, no error anywhere. A test now covers it and fails under that sabotage.
- **Two real defects were caught by tests before they shipped**, both in the migration:
  `btrim(text)` strips spaces only, so a tab/newline-only name passed the not-blank CHECK and
  `"\tEggs\n"` was a distinct key from `"Eggs"`; and a padded entry name carried its padding into
  the item's display name. Every normalization now names its whitespace characters explicitly.
- **No model seam was added or changed**, so no eval or `evals:live` run is owed.
- **Migration `0019` verified by effect** against a freshly migrated database (B-022): the `source`
  column exists and is NOT NULL, carries **no default**, the CHECK constraint is present, and
  violating inserts are genuinely *refused* in both directions. The backfill was additionally
  verified against a **populated** pre-change schema, which is what caught that a backfill `UPDATE`
  aborts on `inventory_revisions_guard_history` — it would have failed against production.
- **Seventeen sabotages this tranche**, each failing named tests. Notable: the naive per-column
  CHECK that passes on NULL (5 tests), a surviving column DEFAULT (1), a weekly row overwriting a
  farmer's newer fact (1), and disabling the wrong-database guard (2).
- **Three sabotages found problems with the tests themselves**, which is the reason to run them:
  two early attempts silently failed to apply and proved nothing (every later one asserts its
  anchor is present before editing); the surviving-DEFAULT case passed every refusal test because
  the default quietly satisfied the NOT NULL; and the name-ambiguity guard was checked with a
  string that was a prefix of neither candidate, so the candidate list was empty either way and
  disabling the guard changed nothing. All three now catch their defect.
- **The launch ingest was rehearsed end to end** against a throwaway local database, in F-064's
  order, with every acceptance criterion checked by querying the result rather than reading script
  output: `farm_links` 34 rows and payment methods 53 rows (both empty before), 16 revisions all
  `source='viga'`, **0 unknown stands**, 0 visitable stands missing a coordinate, **0 descriptions
  leaking a structured fact**, and Handpicked Homestead `contact_only` with no address and no pin.
- **No model seam was added or changed**, so no eval or `evals:live` run is owed. The audit expected
  one for the weekly form's open-ended prose; measured against the real corpus those answers are
  comma-separated lists a deterministic parser reads cleanly.

**From the deployed tranche, still true:**

- **Migration `0018` verified by effect, not by exit status** (B-022): against a freshly migrated
  database the column exists and is nullable, the CHECK constraint is present, and a backdated
  agreement is genuinely *refused* by Postgres. Journal entries are strictly increasing.
- The stand-detail layout was measured **in a real browser at 1440px** across 16 stands spanning
  every shape (market, flower-only, contact-only, services): no band gap exceeds the 12px grid gap,
  and the action row wraps without overlap or overflow down to a 260px card.
- **Three surfaces are unverified at phone width**, all because jsdom reports every element as
  zero-sized: the farmer agreement step, the expanded stand detail, and now **F-067's onboarding
  listing form including its pin-drop map**. The browser in the working environment reports a
  successful resize while the viewport stays wide, and AppleScript window control times out; max
  chose to merge and look himself (**F-060**). The listing form was checked in a real browser and
  works end to end, but **at desktop width** — its markup and behaviour are covered by tests, its
  phone layout is not. The pin-drop map is the piece most worth max's own look, since it is
  thumb-driven by design. One cosmetic defect was seen at desktop width and filed as **B-036**: the
  "North ferry" label is clipped at the map's top edge.
- Deployed and verified **by effect** against the live service, not by the apply's exit status:
  `/api/farmer/onboarding` refuses a malformed token with `400` before touching the database, and
  answers a well-formed but unknown token with the uniform `410 invitation_unavailable` — so the
  endpoint is not an oracle for whether a guessed token names anything. Plan assertions 37/37,
  deploy and served-card assertions pass.
- Production build warnings remain unchanged: Next does not recognize `outputFileTracingRoot`, and
  the Next ESLint plugin is not installed. B-008 owns the lint configuration gap.

## What is live

- **Public discovery:** model-free map/list, offering filters, honest recency, closures, participant
  names, transient browser proximity, destination links, and code-bound stock-out reporting.
- **Farmer workflows:** deterministic `SIGNUP`, `LINK`, `STAND`, `SETTINGS`, and `SAME`; one exact
  stand per credential; SMS/web proposal and confirmation; closures, participants, and reminders.
  Invited onboarding establishes SMS consent.
- **Customer SMS:** model interpretation over typed retrieval, identifier validation, and
  code-rendered grounded answers. `MAP`, compliance commands, and confirmation routing are
  deterministic and run before any model.
- **Administration:** fixed-account password sign-in and server-rendered farm approval, farmer
  access, flag, stock-report, and stand-data workflows. Phones are masked at the query boundary.
- **Scheduled work:** Cloud Tasks handles immediate sender work; one Cloud Scheduler route runs
  recovery, prompts, delivery, callbacks, and retention.

## Two audit findings the build corrected

The [audit](LISTING_INGESTION_AUDIT_2026-08-04.md) is frozen; these are the corrections, measured
against the real corpus on 2026-08-04 while implementing.

- **Payment methods exist ONLY in the map transcription.** The profile form has no payment question
  — its header carries none. The audit's "22 payment lines" were map lines, not form lines. max
  chose to read them from the map's `Accepts: …` prose rather than ship an empty table.
- **The "0/31 stands with an empty remainder" figure measured the map description**, not the form's
  own columns. Rebuilt from the form, one stand of 35 ends with no prose at all — which is honest,
  since its card still carries hours, season, links, and payments from their own columns.

## Open before go-live

- **Approved farmers still start on no reminder schedule.** `authorizeFarmer` writes no
  `inventory_prompt_preferences` row, so the scheduled-prompt machinery — built and correct —
  reaches nobody. Next tranche; see `~/.claude/plans/warm-dazzling-kahn.md` work item 2.
- **Listing facts are no longer frozen for an ONBOARDING farmer** (F-067, extended by F-069):
  hours, address, pin, payment methods, what they usually sell, and — since F-069 — **season,
  structured hours, open days, and restocking cadence/days** are written by the onboarding form.
  **Still frozen for everyone else** — an already-onboarded farmer has no edit surface, and Farm
  Bucks and offering type remain editable by nobody. The form deliberately does not touch Farm
  Bucks: it is a VIGA eligibility fact with its own admin workflow, and a farmer cannot make
  themselves eligible by filling in a form.
- **F-069 is MERGED and DEPLOYED** (2026-08-06). Two changes max asked for on 2026-08-05:
  1. **Structured season / hours / stocking, and payments as a closed set.** F-035's filterable
     columns existed since the seeder but the onboarding form wrote none of them, so a farmer's
     listing was prose in `hours_text` and NULL everywhere a filter looks. `stocking_days`,
     `dawn_to_dusk` and `until_dusk` were already in the schema and are now offered as real
     answers. Payments became checkboxes over a closed set with a free-text tail
     (`packages/db/src/payment-methods.ts`), so "venmo"/"Venmo" stop being two unjoinable values.
     No migration was needed: **no schema change, columns only newly written.**
     `coherentAvailability` mirrors the five CHECK constraints in memory so a contradictory answer
     returns `incoherent_availability` rather than a 500.
  2. **The no-geocoder boundary was NARROWED, not removed** (max reaffirmed after pushback).
     `apps/web/lib/address-lookup.ts` is the one approved call site, behind
     `POST /api/farmer/address-lookup`. The lookup offers a **draft pin the farmer must confirm**;
     an off-island result is refused rather than shown, and every failure degrades to tapping the
     map. `MapProvider`, coordinate-inventing stubs, and mapping **dependencies** remain forbidden
     everywhere, and `architecture.test.ts` now fails on a *second* geocode caller. Its
     comment-stripping fix also closed a real weakness: the old tripwire matched its own prose.
  **Owed before this is trustworthy:** a real browser round trip, and one live geocoding call
  against the real provider with a real key. `GEOCODING_API_KEY` is **optional and unset** — until
  it is set, the form asks the farmer to tap the map, which is the pre-F-069 behaviour.
- **F-070 put the island's main roads on the map (deployed 2026-08-06; 12 secondary road paths verified in the served bytes).** F-043 drew one road on
  purpose ("side roads would turn a legible poster into a street map"), which was right while the
  artwork only oriented a customer. **The onboarding form gave it a second job** — it is how a
  farmer places their own pin — and one spine gives them nothing to place themselves against. max
  chose main arteries plus Westside Highway: twelve roads, 101 vertices against the coastline's
  246, residential grid excluded, drawn at half the highway's weight so the spine still reads as
  the spine (asserted in a test, not left to a screenshot). All traced from OpenStreetMap through
  the same `projectToIsland` as the pins; **Vashon Highway itself was replaced**, since its 13
  hand-placed vertices carried a comment admitting guessing "put the line in the water twice".
- **The ingestion tranche (F-063 → F-061 → F-062, plus F-064's guard) is merged and DEPLOYED —
  but its DATA has not been ingested.**
  F-063 added `inventory_revisions.source` (`sms` requires the full handset chain under a CHECK;
  `viga` requires none of it). F-061 rebuilt the description from the profile form's columns and
  gave `farm_links` and `sales_location_payment_methods` their first writer and reader. F-062
  ingests the weekly stock form as dated `viga` confirmations. **The two on-screen contradictions
  are gone at the data level**, verified over the real corpus — but **still not on the live map**.
  The code that fixes them is now deployed; what is missing is F-064's ingest run, so production
  continues to serve the pre-tranche listing CONTENT through the new code.
- ~~Migrations `0019`, `0020`, and `0021` are owed to production~~ — **DONE 2026-08-05**, in that
  order, before the image that reads them, and verified by effect rather than by exit status.
  `0020`'s table is now the only source of what a stand usually sells and `0021`'s widened
  settlement CHECK is what lets a farmer's own redemption settle their request, so deploying the
  image without them would have broken every listing read.
- **F-064's production run has NOT happened.** Still owed: a re-export of all three CSVs (the
  profile form is **still open**), a **`neondb` snapshot** — with an insert-only utility and GL-015
  open, the snapshot *is* the rollback — max's explicit approval for the bulk write, and the render
  check on a real card afterwards.
- **The three unmatched weekly farms were duplicates, and now resolve** (max confirmed
  2026-08-04). `Venison Valley Farm` and `Ostara` are word-prefixes of their seeded keys;
  `Maggie's Farm` is a **rename** stated in Green Ears' own form row ("Formerly Maggie's Farm")
  and reachable by no spelling rule. `resolveStandKey` stays an **exact** comparison of whole
  words anchored at the start — never a similarity score — and an ambiguous prefix resolves to
  nothing. Measured over the real 35: no seeded key is a word-prefix of another. Unknown stands
  went 3 → 0 and published rows 13 → 16.
- **Attribution for an admin inventory edit is still owed (F-065)** — a revision row carries no
  `admin_actor_id` and there is no general admin audit log, so that workflow must record its own
  action, matching how `stock_out_reports` and `farm_approvals` already work.
- **F-066 — one item vocabulary is BUILT, merged, and DEPLOYED.** `stand_items`
  holds one record per (stand, item name) with two independent states — `usually_carried`, and
  whether a dated revision names it. The separation that justified two tables survives: sharing
  the vocabulary is not sharing the one-current-per-location slot, proven by the schema test that
  standing claims leave a stand with no current revision. Migration **`0020`** creates the table,
  its unique index over `(location, lower(btrim(display_name)))`, and backfills from **both**
  `sales_location_offerings` and `inventory_entries` — the second half is what keeps a
  confirmed-only item as vocabulary without making it a standing claim. `sales_location_offerings`
  survives as the backfill's source with **no reader left**; dropping it is a later change.
  **`inventory_entries` was not modified**: its history guard refuses every update, so the entry →
  item link is the normalized name it already carries, and a confirmed item is resolved to its
  item's spelling in `readPublicStands` so both lists reach the view as one vocabulary.
  Normalization is case and whitespace only — never singular/plural or synonyms, asserted by a
  test that must be deleted before anyone can loosen it.
  **The farmer web form now EXISTS** (F-067, branch `f-067-listing-form`): `saveOnboardingListing`
  is the standing state's farmer-facing writer, so F-066's last acceptance criterion — SMS cannot
  write standing state — is now provable and proven. **Migrations `0019` and `0020` are on
  production** (2026-08-05); `0020`'s backfill wrote 212 item rows from the real listing data.
- **F-067 — self-serve onboarding is COMPLETE and DEPLOYED.** Redeeming an agreed invitation that
  **names a farm** now writes `farmer_authorizations` **and `farm_approvals`** in the same
  transaction as the consent and the redemption, so no administrator acts. Both were required:
  `confirmProposal` checks authorization and then approval independently, so granting only the
  first left the farmer authorized, texted "your farm is ready", and refused with `not_approved`
  on their first update. The approval names the administrator who **created the invitation** —
  the person who decided this farm participates — and is written via `on conflict do nothing`
  against the partial unique index, since `for update` cannot serialize a row that does not exist
  yet. The invitation is the authorization decision; the queue
  click it replaces re-approved a decision already made. The three paths that still need a human
  are unchanged and still queue: a bare uninvited `SIGNUP`, an invitation naming no farm, and an
  invitation whose agreement was never ticked. Migration **`0021`** widens the settlement CHECK from
  "an administrator settled it" to "an administrator **or** the authorization the redemption
  granted" — a settlement recording neither is still refused. The admin invite now **names a new
  farm at invite time**, which is what makes a brand-new farmer reachable by self-serve at all. The
  SIGNUP acknowledgement is omitted for a self-served farmer, since "VIGA will review it" is false
  for someone already set up and arrived beside the "your farm is ready" text.
  **The listing form is now BUILT** (branch `f-067-listing-form`, undeployed).
  `packages/db/src/onboarding-listing.ts` is the **first non-seeder writer of `sales_locations`** —
  before it, `public_address`, `hours_text` and the rest were read everywhere and only ever seeded.
  It supplies the three columns the schema refuses to default, writes payment methods and F-066
  standing items, and **updates the farm's existing stand rather than adding a second**, so a
  farmer invited against a seeded farm does not appear twice on the map. max chose **publish
  immediately, no VIGA review** ("the admin can fix anything that's erroneous", which leans on
  F-065) and **full listing details** over a minimal set.

  **The visitability branch is the form's structure, not a field on it.** `coherentVisitability`
  requires an address and a complete coordinate pair for a visitable stand and forbids all three
  for a contact-only one, so the form asks whether there is a stand to visit before it can know
  what to require. Refused in the writer AND enforced by the database: the constraint is the
  guarantee, the writer's check is what turns it into an answer the farmer can act on.

  **The pin is DROPPED, not looked up.** Nothing in the codebase can turn a typed address into a
  coordinate, and nothing should — a runtime geocoder/map package is a named non-goal and
  `maps/README.md` records that there is deliberately no mapping-provider seam. max chose
  (2026-08-05) that the farmer taps the drawn island; `unprojectFromIsland` is F-043's projection
  run backwards, so it is one statement about where the island is rather than a second one.

  **`apps/web/lib/farmer-listing.ts` is the boundary.** The invitation token is the only credential
  and it names the farm — a `farmId` in the request body is **ignored**, which is what stops any
  link overwriting any farm's public listing. It also strips an address and pin sent alongside
  `contact_only`, since a farmer who fills in an address and then changes their answer is the
  ordinary case rather than an attack.

  **A consequence max accepted, recorded once:** publish-on-submit means anyone holding an
  onboarding link can put a stand on VIGA's public map without proving they hold the farmer's
  phone. Flagged before building; max chose it anyway. Links are one-use, expire in seven days,
  and an admin can remove a bad listing.

  **The page no longer promises a VIGA review** — that copy was retired rather than reworded, since
  redemption now authorizes and approves in one transaction and a promised review is a step nobody
  performs.
- **F-029:** finish live carrier/JOIN launch verification.
- **F-056:** finish protected-page, logout, copied-cookie, throttle, expiry/revocation, mobile,
  keyboard/focus, and recovery-copy browser proof.
- **B-024:** **fixed in code** (F-061) and verified by effect on a rehearsal database — a farmer's
  written refusal makes the stand `contact_only` with no address and no pin, read as a general rule
  from her own words rather than by naming a farm. **Production still publishes her address** until
  F-064's ingest runs; the approved interim correction remains in place.
- **B-008:** replace the incomplete deployed-build lint gate.
- **B-034:** upgrade affected production dependencies and assess advisory reachability.
- **F-044:** verify public-map and authenticated-admin embeds on VIGA's actual Squarespace pages.
- Physical-handset vCard and paged-SMS checks remain owed.
- Exercise the full farmer onboarding/update, administrator, settings, customer inquiry, and farmer
  SMS journeys against production and verify database effects rather than screen messages. The
  consent path in particular is proven against real Postgres but **never against a real handset**.
