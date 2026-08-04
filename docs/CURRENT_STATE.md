# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Record only verified facts.
> Architecture docs own enduring contracts; dated reasoning and deployment proof live in the
> session log.

## Release state

Farm Friend is **pre-go-live**. Production runs one image across Cloud Run web revision
`farm-friend-web-00027-5ng` and worker revision `farm-friend-worker-00028-67c`, both at digest
`sha256:2f089d8b4a0482a78cea6754b5dfa914800c7e5c021fb2dc9845ee455eab797a` (`main` at `4a8bca7`).
Production Postgres is `neondb` with 17 migrations applied (`0000`–`0017`, through journal
timestamp `1786500000000`).

Migration `0018` (`farmer_invitations.agreed_to_sms_at` plus its CHECK constraint) is applied,
before the code that reads it was promoted. The journal shows it landing once at `1786700000000`.

The most recent tranche closes the **farmer-consent launch blocker**. Before it, the standard
invited journey dead-ended in silence: a farmer completed onboarding, VIGA approved, and the
"your farm is ready" text — a proactive `inventory_prompt` — was correctly suppressed at the
dispatch claim because `SIGNUP` established no consent. The farmer was authorized, never told, and
nothing in the invitation, the page, or the reply ever named a way to fix it.

- **the onboarding page collects an agreement, and the prepared text is gated behind it.** The
  `sms:` link is unreachable until the server records the tick, so a farmer cannot spend the one-use
  invitation before the agreement exists;
- **the tick is not consent.** It stamps `agreed_to_sms_at` — where the agreement was shown. The
  consent record is written when `SIGNUP <token>` arrives from a handset, which is the evidence
  tying the person who agreed to the number that gets messaged, and it lands **in the same
  transaction that redeems the invitation** so the two cannot come apart;
- **one consent writer, not two.** `applyConsentTransition` became a `begin` wrapper over
  `applyConsentTransitionIn(tx, …)` (the `queueOutbox` shape). Onboarding passes `firstTimeOnly`,
  so a farmer who already texted `JOIN` keeps one unchanged record and a farmer who texted `STOP`
  is **not** silently re-enrolled by filling in a web form;
- **the reply says the true thing about messaging.** Consent established → the registered opt-in
  receipt verbatim; no consent basis → an instruction to reply `JOIN`; already consented → neither,
  since a second receipt would claim an agreement not made today.

Also corrected: the directory map key read "Don't take VIGA Bucks" of a single stand, and the test
asserted the same wrong wording.

## Verification

- Current `main`: 102 unit-test files / 985 tests, typecheck, lint, and the production web build
  pass.
- Real-Postgres integration: **42 files / 580 tests pass on a complete run** from an empty schema,
  including four new end-to-end journeys driven through the real signed webhook with a model that
  throws on any call.
- **Migration `0018` verified by effect, not by exit status** (B-022): against a freshly migrated
  database the column exists and is nullable, the CHECK constraint is present, and a backdated
  agreement is genuinely *refused* by Postgres. The generated journal timestamp came out **out of
  order** and was corrected to `1786700000000`; entries are now strictly increasing.
- Four sabotages, each failing a distinct named test: removing the consent write, removing
  `firstTimeOnly` (the guard that stops a STOPped sender being re-enrolled), inverting the
  agreement check so an unticked invitation would consent, and replacing the `AgreementStep` call
  site with a bare link.
- **No model seam was added or changed by this work**, so no eval or `evals:live` run is owed.
- The agreement step is proven in jsdom for order, disclosures, failure paths, and the
  double-submit guard. **It has not been looked at in a real browser at phone width** — jsdom
  reports every element as zero-sized and can see none of its layout.
- Production build warnings remain unchanged: Next does not recognize `outputFileTracingRoot`, and
  the Next ESLint plugin is not installed. B-008 owns the lint configuration gap.

## What is live

- **Public discovery:** model-free map/list, offering filters, honest recency, closures, participant
  names, transient browser proximity, destination links, and code-bound stock-out reporting.
- **Farmer workflows:** deterministic `SIGNUP`, `LINK`, `STAND`, `SETTINGS`, and `SAME`; one exact
  stand per credential; SMS/web proposal and confirmation; closures, participants, and reminders.
  Invited onboarding now establishes SMS consent (merged, not yet deployed).
- **Customer SMS:** model interpretation over typed retrieval, identifier validation, and
  code-rendered grounded answers. `MAP`, compliance commands, and confirmation routing are
  deterministic and run before any model.
- **Administration:** fixed-account password sign-in and server-rendered farm approval, farmer
  access, flag, stock-report, and stand-data workflows. Phones are masked at the query boundary.
- **Scheduled work:** Cloud Tasks handles immediate sender work; one Cloud Scheduler route runs
  recovery, prompts, delivery, callbacks, and retention.

## Open before go-live

- **Apply migration `0018` to production and deploy**, in that order. The merged code reads the new
  column.
- **Approved farmers still start on no reminder schedule.** `authorizeFarmer` writes no
  `inventory_prompt_preferences` row, so the scheduled-prompt machinery — built and correct —
  reaches nobody. Next tranche; see `~/.claude/plans/warm-dazzling-kahn.md` work item 2.
- **Listing facts are frozen** at whatever VIGA's CSV said: hours, season, offerings, payment
  methods, Farm Bucks, and address are editable by nobody. Work items 3 and 3b.
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
