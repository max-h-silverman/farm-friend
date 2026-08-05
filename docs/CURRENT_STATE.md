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

The most recent tranche is the **listing ingestion work** (F-063, F-061, F-062, and F-064's guard)
on branch `f-063-inventory-revision-source`. It is **built and locally verified but neither merged
nor deployed**, and it carries **migration `0019`**, which production has not received.

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

- Branch `f-063-inventory-revision-source`: **105 unit-test files / 1055 tests**, typecheck, and
  lint pass. **Not yet merged to `main` and not deployed.**
- Real-Postgres integration: **45 files / 603 tests pass on a complete run** from an empty schema,
  against a local Postgres — never against production Neon.
- **Migration `0019` verified by effect** against a freshly migrated database (B-022): the `source`
  column exists and is NOT NULL, carries **no default**, the CHECK constraint is present, and
  violating inserts are genuinely *refused* in both directions. The backfill was additionally
  verified against a **populated** pre-change schema, which is what caught that a backfill `UPDATE`
  aborts on `inventory_revisions_guard_history` — it would have failed against production.
- **Sixteen sabotages this tranche**, each failing named tests. Notable: the naive per-column CHECK
  that passes on NULL (5 tests), a surviving column DEFAULT (1 — which exposed a real gap, since
  every refusal test passed while the default silently satisfied the NOT NULL), a weekly row
  overwriting a farmer's newer fact (1), and disabling the wrong-database guard (2). **Two early
  sabotage attempts silently failed to apply and proved nothing**; every later one asserts its
  anchor is present before editing.
- **The launch ingest was rehearsed end to end** against a throwaway local database, in F-064's
  order, with every acceptance criterion checked by querying the result rather than reading script
  output: `farm_links` 34 rows and payment methods 53 rows (both empty before), 13 revisions all
  `source='viga'`, 0 visitable stands missing a coordinate, **0 descriptions leaking a structured
  fact**, and Handpicked Homestead `contact_only` with no address and no pin.
- **No model seam was added or changed**, so no eval or `evals:live` run is owed. The audit expected
  one for the weekly form's open-ended prose; measured against the real corpus those answers are
  comma-separated lists a deterministic parser reads cleanly.
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
- **The ingestion tranche (F-063 → F-061 → F-062, plus F-064's guard) is built on branch
  `f-063-inventory-revision-source` and is unmerged.** F-063 added `inventory_revisions.source`
  (`sms` requires the full handset chain under a CHECK; `viga` requires none of it). F-061 rebuilt
  the description from the profile form's columns and gave `farm_links` and
  `sales_location_payment_methods` their first writer and reader. F-062 ingests the weekly stock
  form as dated `viga` confirmations. **The two on-screen contradictions are gone at the data
  level**, verified over the real corpus.
- **F-064's production run has NOT happened.** Still owed: a re-export of all three CSVs (the
  profile form is **still open**), a **`neondb` snapshot** — with an insert-only utility and GL-015
  open, the snapshot *is* the rollback — max's explicit approval for the bulk write, and the render
  check on a real card afterwards.
- **Three weekly-form farms match no seeded stand**: `Venison Valley Farm`, `Ostara`,
  `Maggie's Farm`. max chose to add them as new stands; **not yet built**, because
  `Venison Valley Farm` is very likely a spelling variant of the seeded
  `Venison Valley Farm & Creamery` and adding it blind would duplicate a live stand.
- **Attribution for an admin inventory edit is still owed (F-065)** — a revision row carries no
  `admin_actor_id` and there is no general admin audit log, so that workflow must record its own
  action, matching how `stock_out_reports` and `farm_approvals` already work.
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
