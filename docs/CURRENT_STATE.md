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

The most recent tranche is **presentation and ingestion groundwork** — web assets, one pure parser,
and documentation. It is **deployed**: plan assertions 37/37, deploy and served-card assertions
pass, and the served stylesheet was checked **by effect** — `.detail-actions` and `.detail-aside`
resolve to `display:flex` with their gaps, and `.stand-selected .stand-detail-body` is now
`minmax(0,1fr)`, so the old two-column split is genuinely gone from production rather than merely
absent from the source. The expanded stand detail was
rebuilt as three stacked full-width bands after a layout defect ("WebsiteGet directions" rendering
as one word) turned out to sit on a wrong structure: a narrow action column beside a chip box whose
heights can never match, leaving a distributed hole on well-tagged stands.

It also produced two findings that outgrew it, both now driving the ingestion audit:

- **the map CSV is a hand-maintained derivative**, so the oddities in stand descriptions
  (`WA, WA 98070`, en-dashes in dated lines) are transcription residue from the manual step Farm
  Friend exists to remove;
- **`parseFormResponses` was suspected of describing a source VIGA has never produced. That is
  disproved** (audit 2026-08-04, **B-035 closed wont-fix**). VIGA supplies **three** CSVs, not two:
  a per-farm **profile form** (`2026 Farm Stand Information (Responses)…`, header matches
  `EXPECTED_COLUMNS` byte for byte, parses to 31 stands + 1 known refusal, **still open**), the map
  transcription (31 stands, the only coordinates), and the **weekly stock form** (734 rows, 49 farms,
  **no parser, not ingested**). Both "invented" fixtures are real data. The join is sound: 35 stands,
  0 refusals.

`extractStockUpdate` parses VIGA's dated `"5/26/2026 Update: …"` lines and **deliberately has no
consumer**: max has decided such a line should count as a confirmation, but how it is stored is
unresolved, because `inventory_revisions` requires keys asserting a handset sent it.

## Verification

- Current `main`: **102 unit-test files / 993 tests**, typecheck, lint, and the production web build
  pass.
- Real-Postgres integration: **42 files / 580 tests pass on a complete run** from an empty schema.
  Not re-run this tranche, which touched no database code — the seeder change is a local-only test
  fixture.
- **Migration `0018` verified by effect, not by exit status** (B-022): against a freshly migrated
  database the column exists and is nullable, the CHECK constraint is present, and a backdated
  agreement is genuinely *refused* by Postgres. Journal entries are strictly increasing.
- Six sabotages this tranche, each failing a distinct named test: collapsing the action list back to
  bare anchors, forcing the phone sheet down the directory branch, and three on the dated-update
  parser (impossible-date guard, closure exclusion, latest-wins).
- The stand-detail layout was measured **in a real browser at 1440px** across 16 stands spanning
  every shape (market, flower-only, contact-only, services): no band gap exceeds the 12px grid gap,
  and the action row wraps without overlap or overflow down to a 260px card.
- **No model seam was added or changed by this work**, so no eval or `evals:live` run is owed.
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

## Open before go-live

- **Approved farmers still start on no reminder schedule.** `authorizeFarmer` writes no
  `inventory_prompt_preferences` row, so the scheduled-prompt machinery — built and correct —
  reaches nobody. Next tranche; see `~/.claude/plans/warm-dazzling-kahn.md` work item 2.
- **Listing facts are frozen** at whatever VIGA's CSV said: hours, season, offerings, payment
  methods, Farm Bucks, and address are editable by nobody. Work items 3 and 3b.
- **The listing ingestion audit (F-059) is complete** —
  [LISTING_INGESTION_AUDIT_2026-08-04.md](LISTING_INGESTION_AUDIT_2026-08-04.md). It corrected its
  own founding premise (B-035 is not a defect) and max settled four decisions: rebuild the
  description from the profile form's columns (**F-061**); ingest the weekly stock form (**F-062**);
  run the ingest **before any farmer onboards** (**F-064**); and record VIGA-sourced facts as
  confirmations through a **`source` column** rather than by fabricating an authorization
  (**F-063**) — `sms` requires the full handset chain under a CHECK, `viga` requires neither and
  covers the import, the weekly form, and later admin edits. Attribution for an admin edit belongs to
  that workflow (**F-065**), matching how `stock_out_reports` and `farm_approvals` already work.
- **The real ingestion defect is one line**: `seed-stands.ts:176` stores the volunteer's prose as the
  public description whenever a map row exists, discarding the form's clean columns for display. That
  causes both on-screen contradictions.
- **`sales_location_payment_methods` AND `farm_links` are both correctly-shaped tables that nothing
  writes or reads** — verified in both directions; their only non-schema appearances are test cleanup
  lists. Links are the most common structured fact in the corpus (41 lines) and are entirely
  un-ingested. GL-014 names the first; a rewrite is proposed in the audit.
- **The public map shows two on-screen contradictions** under real data: a "Hours not listed" badge
  beside prose reading `Open: Year Round`, and "Nothing confirmed recently" directly above a
  farmer-dated stock update. Both are ingestion artifacts, not rendering bugs.
- **F-029:** finish live carrier/JOIN launch verification.
- **F-056:** finish protected-page, logout, copied-cookie, throttle, expiry/revocation, mobile,
  keyboard/focus, and recovery-copy browser proof.
- **B-024:** encode the no-public-address source instruction before any reseed. Production remains
  hidden under the approved interim correction. Work item 3 retires this by making address
  visibility farmer-owned state.
- **B-008:** replace the incomplete deployed-build lint gate.
- **B-034:** upgrade affected production dependencies and assess advisory reachability.
- **F-044:** verify public-map and authenticated-admin embeds on VIGA's actual Squarespace pages.
- Physical-handset vCard and paged-SMS checks remain owed.
- Exercise the full farmer onboarding/update, administrator, settings, customer inquiry, and farmer
  SMS journeys against production and verify database effects rather than screen messages. The
  consent path in particular is proven against real Postgres but **never against a real handset**.
