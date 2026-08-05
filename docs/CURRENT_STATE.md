# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Record only verified facts.
> Architecture docs own enduring contracts; dated reasoning and deployment proof live in the
> session log.

## Release state

Farm Friend is **pre-go-live**. Production runs one image across Cloud Run web revision
`farm-friend-web-00029-bgf` and worker revision `farm-friend-worker-00030-vzd`, both at digest
`sha256:3a25dd2c9f47e47ecac48547b81e366c2a88b0561cf84a385e2321f33977a464` (`main` at `38f02ed`).
Production Postgres is `neondb` with all 18 migrations applied (`0000`–`0018`, through journal
timestamp `1786700000000`) — **unchanged by this deploy, which carried no migration**.

Migration `0018` (`farmer_invitations.agreed_to_sms_at` plus its CHECK constraint) was applied
**before** the code that reads it was promoted, per the RUNBOOK's ordering rule.

The farmer-consent launch blocker closed in the previous tranche and is deployed; see the
[session log](SESSION_LOG.md) for its reasoning.

Three tranches are now ahead of production, all **NOT deployed**:

- the **listing ingestion work** (F-063, F-061, F-062, and F-064's guard), merged to `main`,
  carrying **migration `0019`** (`inventory_revisions.source`);
- **F-066's one item vocabulary**, carrying **migration `0020`** (`stand_items`);
- **F-067's self-serve farmer onboarding**, carrying **migration `0021`**
  (`farmer_onboarding_requests_coherent_settlement` widened).

F-066 and F-067 both sit on branch `f-067-self-serve-onboarding`, which carries F-066's three
commits as well — open as **PR #80**, mergeable and clean, and **deliberately not merged**: a
second session was active, and merging would move the base under anything branched from where this
one started. Merging it is the next session's first decision.

Production has received none of them, so it still runs the pre-tranche schema and the pre-tranche
listing data. **`0019`, `0020`, and `0021` are all owed to production, in that order, before the
image that reads them**, per the RUNBOOK's ordering rule. See the [session log](SESSION_LOG.md) for
the reasoning.

The tranche before it — presentation and ingestion groundwork — is deployed: plan assertions 37/37,
deploy and served-card assertions pass, and the served stylesheet was checked **by effect**.

That earlier tranche produced two findings that outgrew it and drove the ingestion audit:

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

- Current branch `f-067-self-serve-onboarding`: **105 unit-test files / 1075 tests**, typecheck,
  lint, and **evals (critical 11/11, adversarial 29/29, advisory 4/4)** pass (verified 2026-08-05).
  **Not deployed.**
- Real-Postgres integration: **47 files / 635 tests pass on a complete run** from an empty schema,
  against a local Postgres — never against production Neon.
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
- **Two surfaces are unverified at phone width**, both because jsdom reports every element as
  zero-sized: the farmer agreement step, and now the expanded stand detail. For the latter the
  browser in the working environment reports a successful resize while `window.innerWidth` stays
  1728, and AppleScript window control times out; max chose to merge and look himself (**F-060**).
  The phone sheet's *markup* is covered by a test; its *layout* is not.
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
- **Listing facts are frozen** at whatever VIGA's CSV said: hours, season, offerings, payment
  methods, Farm Bucks, and address are editable by nobody. Work items 3 and 3b.
- **The ingestion tranche (F-063 → F-061 → F-062, plus F-064's guard) is merged and UNDEPLOYED.**
  F-063 added `inventory_revisions.source` (`sms` requires the full handset chain under a CHECK;
  `viga` requires none of it). F-061 rebuilt the description from the profile form's columns and
  gave `farm_links` and `sales_location_payment_methods` their first writer and reader. F-062
  ingests the weekly stock form as dated `viga` confirmations. **The two on-screen contradictions
  are gone at the data level**, verified over the real corpus — but **not on the live map**, which
  still runs the pre-tranche image and data.
- **Migrations `0019`, `0020`, and `0021` are owed to production**, in that order, before the code
  that reads them (RUNBOOK ordering rule). Deploying the image without them would break every
  listing read: `0020`'s table is now the only source of what a stand usually sells, and `0021`'s
  widened settlement CHECK is what lets a farmer's own redemption settle their onboarding request.
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
- **F-066 — one item vocabulary is BUILT and merged to the branch, UNDEPLOYED.** `stand_items`
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
  **Still owed:** migrations `0019` and `0020` to production, and the farmer web form that is the
  standing state's only intended writer (work items 3/3b, now **F-067**) — today the seeder is its
  only writer, so a farmer still cannot edit their own mix.
- **F-067 — self-serve onboarding is HALF BUILT, UNDEPLOYED.** Redeeming an agreed invitation that
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
  **Still owed — the half that is not built:** the onboarding page still asks for nothing but a
  consent tick, so a new farm reaches the public map with a name and nothing else. **Nothing in the
  codebase writes listing facts today** — `public_address`, `hours_text`, and the rest are read
  everywhere and only ever seeded — so the form is the first farmer-facing write path for public
  listing data. max chose **publish immediately, no VIGA review** ("the admin can fix anything
  that's erroneous", which leans on F-065) and **full listing details** over a minimal set.
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
