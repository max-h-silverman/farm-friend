# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Record only verified facts,
> and only ones still true. Architecture docs own enduring contracts; *why* a past change was made
> belongs in [SESSION_LOG.md](SESSION_LOG.md), not here. When an item closes, delete it rather than
> striking it through — the log keeps the history.

## Release state

Farm Friend is **pre-go-live**. **Production and `main` are in sync** as of 2026-08-10. Production
Postgres `neondb` has **37 migrations** (`0000`–`0036`); Cloud Run web is `farm-friend-web-00056-kqm`
and worker is `farm-friend-worker-00051-7cl`, both on digest
`sha256:869abb4edd4fbf58c15fd54d884b46c02d758cfeedbc130dfcc50272bcad31dd`.

**Deployed runtime is `4308414`** (2026-08-10). This tranche shipped F-100's admin console
restructure, F-102's farm-card hierarchy, and B-049's SMS inquiry fixes. Migration `0036` (farm
retirement + the `address_unresolved` flag reason) is applied and **verified by schema effect**:
37 rows in the ledger, both `farms.retired_at` / `retired_by_administrator_id` present and
nullable, the `farms_coherent_retirement` CHECK in `pg_constraint`, `address_unresolved` in the
enum, and exactly the 2 mislabelled flags re-filed. No farm was retired by it (0 rows).

Backup taken immediately before the migration:
`~/farm-friend-backups/neondb-PRE-0036-20260810-110458.dump`.

**Every local branch is accounted for in `main`.** Four branches still held commits main lacked;
all are now merged. Two carried no change (`f-064-weekly-timeline-keys`, superseded — its
participants, GL-015 backfill, host publishing and migration 0029 had all landed by other routes)
and one was merged `-s ours` (`deploy-contact-only-hotfix`, whose older copy would have REVERTED
the stricter visitability rule that forbids inventing an address, F-038/B-024). Pre-merge state is
tagged `backup-premerge-*`.

**Max walks farmer surfaces at phone width before a UI tranche ships.** F-100's admin surfaces
shipped in this tranche **without that pass** — max asked for the deploy explicitly, so the gate
was waived rather than met. It is still owed by eye.

**Production data and schema are current.** Neon has all structured-price and pending-stock columns,
no legacy `price_text`, and the final price/location constraints. Verified corpus counts:
35 farms / locations / approvals, **212 reviewed usual items across 33 stands**, 35 links,
53 payments, 10 participants, 15 VIGA confirmations, 24 with open days, 39 farm emails across
32 farms, 1 administrator, 0 consents/authorizations. The public API returns Tian Tian's complete
nine-item usual list (including bok choy and a choy) and 3 Brothers' structured eggs with no
duplicate Additional information prose.

The rebuild deliberately removed 3 real consents; those phones must text `START` again. Its verified
backup is `~/farm-friend-backups/neondb-PRE-WIPE-20260807-224344.dump`. Seeders do not restore the
fixed administrator or farm-email roster; email ingest must reuse the deployed `EMAIL_HASH_SALT`.

### Secrets

- **Web mounts** `GEOCODING_API_KEY`, `GMAIL_OAUTH_CLIENT_SECRET`, `GMAIL_OAUTH_REFRESH_TOKEN`, and F-079's three; **the worker mounts
  none**, asserted unconditionally. `infra/production.tfvars` keeps that true across applies — every
  `mount_*` defaults to false, so a plan without `-var-file` silently unmounts whatever the last
  apply enabled. `plan-assertions.py` fails by name on any plan that would unmount a live secret.
- **`EMAIL_HASH_SALT` can never be rotated** without re-ingesting the roster. A mismatch is this
  feature's quietest failure: every correct address fails to match, nothing errors, nobody verifies.
- **The migration door's secret is obscurity, not a credential** — never post it anywhere indexable.
  `gcloud secrets versions access latest --secret=farm-friend-farmer-start-secret --project
  farm-friend-vashon`. Rotating it invalidates links already sent.

## Verification

**Current main:** **1786 unit**, **877 integration**, typecheck, lint, the web production build,
and **evals 44/44** (11 critical, 4 advisory, 29 adversarial). Also verified earlier on this main:
a complete seed dry run against the real exports (35 stands, 212 reviewed usual items, 0 unknown, 0
unresolved) and production cleanup dry-running at 25/25 descriptions clean.

**Sabotage proofs held this pass.** F-100's farm take-down: writing through to each stand's own
`retired_at` is caught, and `farms_coherent_retirement` genuinely refuses a half-cleared
retirement. The setup link is proven to render on the card that minted it. B-044's parser
regression and atomic offering restore checks still fail when their guarantees are broken.
B-049's three proofs also hold: the heading fix fails when the requested item is asserted
unconditionally, the opaque fact identifier fails when the `offering-` prefix returns, and the
response ceiling fails against the 1024 value that truncated real answers.

**B-020:** full integration can fail on varying files under cross-suite contention; it passed in
this wrap. Treat any named recurrence as real and attribute it against a clean tree.

**Last `evals:live`: 2026-08-10, 25/25** against `mistralai/Mistral-Small-24B-Instruct-2501`
(containment 4/4, closure 7/7, quality 9/9, recall 5/5). Owed again on any change to a seam's
projection, schema, or output contract.

**The SMS inquiry path was measured against the real model and a clone of the production corpus**
(2026-08-10), which is how B-049 was found — the suites were green throughout. Plain single-item
customer questions went from **11/20 answered to 19/20** locally. Containment held on every probe:
no injection, no raw phone, no prompt leak, no test farm, no invented stand. Re-measured against a
clone of POST-deploy production: 8/10, with the two failures being the broadest questions (see the
open item below).

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

- **Public discovery:** model-free map/list, offering filters, recency, closures, participants,
  proximity, directions, stock-out reporting, and farmer-stated structured prices. Price visibility
  defaults off and is enforced in SQL; `standItemPriceNeedsUnit` owns the shared validity rule.
- **Farmer workflows:** deterministic bare `START` onboarding, `LINK`, `STAND`, `SETTINGS`, `SAME`;
  one stand per credential; closures, participants, and reminders. Three doors feed one four-step
  onboarding flow; the farmer page has status/stock and details/settings tabs with one save action.
  SMS proposes stock and waits for `YES`; web publishes in one press through the same authority and
  exactly-once transaction. New links use 22-character base64url tokens; legacy 64-hex links remain
  valid. `SETTINGS` remains parsed but untaught until account settings become a separate surface.
- **Customer SMS:** model interpretation over typed retrieval, identifier validation, and
  code-rendered grounded answers. `MAP`, compliance commands, and confirmation routing are
  deterministic and run before any model.
- **Administration:** fixed-account password sign-in (the signed-out screen renders the fields
  directly) and three server-rendered surfaces, one per subject — **Farms** (one row per farm
  expanding to approval, details, access, setup links, stands, and take-down), **Messages**
  (flags, stock-outs, record questions), and **Users** (everyone who has texted, plus inviting a
  farmer and deciding access requests). No Home tab; `/admin` redirects to Farms and the pending
  counts sit on the tab that owns the work. Phones are masked at the query boundary. A farm
  take-down carries its stands without writing their own retirement, so restoring returns exactly
  what it held down.
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
- Exercise the administrator, settings, and farmer SMS journeys against production by database
  effect. Consent is proven against Postgres but not a handset. **The customer inquiry journey is
  done** (2026-08-10): driven through the real path against the real model and a clone of the
  production corpus, before and after this deploy.

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
- **B-050 — the broadest inquiries still fail, and the cause is the selection call's SHAPE.**
  Measured live against post-deploy production: "what's available today?" and "what's the closest
  farm stand to me" are rejected. At roughly 48 identifiers the model corrupts individual uuids —
  it dropped a character, producing `3f657a1-…` (7 hex digits, not 8) — so validation correctly
  refuses the selection and the customer gets nothing. **Not a budget problem**: the response
  ceiling and timeout were both already raised to clear the widest honest answer, and the response
  now completes. Asking for a full ranking of every candidate is the flaw, when only `PAGE_SIZE`
  (3) are ever rendered and the rest exist only to feed `MORE`. Returning an ordered short list
  plus a continuation, or having code order the tail, removes the failure mode rather than
  widening a bound. Everything narrower than "show me everything" works.
- **B-034:** upgrade affected production dependencies and assess advisory reachability.
- **B-036:** the "North ferry" label is clipped at the island map's top edge (cosmetic).
- **F-101 / B-048 — the admin UX audit's lower-ranked findings.** F-101 is copy and state:
  "onboarding link" vs "private link" are indistinguishable to a volunteer, several empty states,
  the unusable login email field, sign-out copy, and a test-farm row rendered from typed input.
  B-048 is data with no consumer: a flag's `reasonCode` and `hasReadableThread` are fetched and
  never rendered, so every flag card reads identically and "View thread" is offered on threads
  already purged.
- Remaining go-live work is in [GO_LIVE_GUIDE.md](GO_LIVE_GUIDE.md): **GL-007** (stock-out → farmer
  alert), **GL-008** (customer stock-out surface), **GL-015** (its *stand-data flag* half), plus the
  P2 resilience band and P3 decisions.

**Unverified at phone width** — jsdom reports every element as zero-sized, so these are covered by
tests but not by eye: the farmer agreement step, F-067's onboarding listing form and its map,
F-090's four-step wizard, F-097's restyled surfaces (the settings panel, the saved-confirmation
screen, the onboarding cadence control, the map card's recency caption), and **F-100's three admin
tabs** — the farm directory row collapses to three columns under 34rem, unchecked by eye. Per-tranche
browser checks are **not tracked here** (max, 2026-08-05): he runs a browser pass himself before
go-live.

The 2026-08-10 farm-card hierarchy pass was measured in Chrome (computed styles, no overflow at
390px) against **the components rendered on the real stylesheet, not `/admin/farms` itself** — admin
login and seeded farms were never exercised. A multi-stand farm, a removed farm, and a stand reading
"off the map with the farm" are unseen in that new styling.

**VIGA's call, not a code question:** whether Vashon Island Farmers Market belongs in the roster as
a farm at all — it is the market itself, not a stand with a farmer to onboard.

## Traps worth not rediscovering

- **`VIGA Map Stands.csv` has unquoted multi-line descriptions.** Reassemble records from a `POINT`
  in column one; ordinary CSV parsing produced 275 phantom farms instead of 31.
- **`drizzle-kit generate` omits CHECKs/partial indexes and may drop columns absent from `schema.ts`.**
  Generate first for metadata, append constraints, inspect every SQL statement, and prove constraints
  by effect; hand-writing SQL strands the next migration.
- **A migration can exit 0 without applying.** Verify schema effect, correct a journal `when` that
  predates the last migration (0033 is future-dated), then run `migration-ordering.test.ts`.
- **`printf %s`, never `echo`, for Secret Manager salts;** a newline makes hashes silently fail.
- **Next expands `$NAME` in `.env` values.** Set `ADMIN_PASSWORD_HASH` as a real environment value
  via `./scripts/dev-setup.sh`; a missing admin or live login-throttle bucket looks identical.
- **Measure production data, not parsers.** `farms.description` holds malformed input including
  `/22/2026 Update:`, so leading-month patterns miss real records.
