# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Record only verified facts.
> Architecture docs own enduring contracts; dated reasoning and deployment proof live in the
> session log.

## Release state

Farm Friend is **pre-go-live**. Production runs one image across Cloud Run web revision
`farm-friend-web-00028-mwv` and worker revision `farm-friend-worker-00029-jzz`, both at digest
`sha256:d27f3639f4a7ccc05da41b77e5cdc3a8581871cb4c5eb393a02422322de6aca6` (`main` at `b8bc76d`).
Production Postgres is `neondb` with all 18 migrations applied (`0000`–`0018`, through journal
timestamp `1786700000000`).

Migration `0018` (`farmer_invitations.agreed_to_sms_at` plus its CHECK constraint) was applied
**before** the code that reads it was promoted, per the RUNBOOK's ordering rule.

The farmer-consent launch blocker closed in the previous tranche and is deployed; see the
[session log](SESSION_LOG.md) for its reasoning.

The most recent tranche is **presentation and ingestion groundwork, and changes no deployed
behavior** — it is web assets, one pure parser, and documentation. The expanded stand detail was
rebuilt as three stacked full-width bands after a layout defect ("WebsiteGet directions" rendering
as one word) turned out to sit on a wrong structure: a narrow action column beside a chip box whose
heights can never match, leaving a distributed hole on well-tagged stands.

It also produced two findings that outgrew it, both now driving the ingestion audit:

- **the map CSV is a hand-maintained derivative of the weekly form**, so the oddities in stand
  descriptions (`WA, WA 98070`, en-dashes in dated lines) are transcription residue from the manual
  step Farm Friend exists to remove. Across the 70 form rows dated 2026, `What do you have
  available` is filled **70/70** while address, currencies, and links appear **once each** — they
  sit behind an optional "first time this season" prompt. The only durable home for profile facts
  today is the volunteer's typed description;
- **`parseFormResponses` describes a source VIGA has never produced.** None of its `EXPECTED_COLUMNS`
  exists in either real file, and two of its own test fixtures (`13609 SW 220th St`, `Bank Road,
  East of Town`) appear in neither. The seeder's `--form` path and its 210-line test file are green
  over an invented format.

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
- **The listing ingestion audit is the next tranche** (**F-059**) and is scoped in
  [LISTING_INGESTION_AUDIT_PROMPT_2026-08-04.md](LISTING_INGESTION_AUDIT_PROMPT_2026-08-04.md).
  It must settle: which source is authoritative per field (the weekly form, or the volunteer's
  hand-typed map derivative); whether the customer-visible description should be *derived* from
  structured facts rather than stored raw; whether `parseFormResponses` is rewritten or deleted;
  and how a sheet-typed date is stored without fabricating an authorization (**B-035** covers
  the parser defect itself). max has decided the
  launch re-ingest replaces all seeded listing data — but it must not overwrite farmer-authored
  facts, and the seed utility is currently insert-only (GL-015).
- **`sales_location_payment_methods` is a correctly-shaped table that nothing writes or reads.** Its
  only non-schema appearances are test cleanup lists, which is why its emptiness went unnoticed. The
  gap is wiring, not schema. GL-014 already names it.
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
