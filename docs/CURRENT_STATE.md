# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Durable contracts live in
> the architecture docs; session history lives in [SESSION_LOG.md](SESSION_LOG.md).

## Release state

- Farm Friend is **pre-go-live**. Production serves F-104 SMS stock-out reporting on top of B-050
  broad-inquiry paging and F-105 stand details, built from `main` `96ce18e` (F-104 plus its B-053
  follow-up). The `0038` schema change shipped with F-104, applied before that image was promoted.
- **B-054, B-055 and B-056 shipped 2026-08-10**: the stand card no longer claims "In stock" over a
  confirmation past four weeks; code drops an inventory removal whose item the farmer's message
  never named; a stock-out report naming an unlisted item parses instead of returning `unclear`;
  and VIGA Farm Bucks is no longer stored as a payment method. No schema change — `0038` remains
  the newest migration.
- Cloud Run web `farm-friend-web-00063-lbw` and worker `farm-friend-worker-00058-znw` serve immutable
  digest `sha256:dd365d88e93df8251adadbc2d421f8dea9d0a37288f8e71613ea9cf5882a1dce`.
- Neon `neondb` has **39 applied migrations (`0000`–`0038`)**. `0038` was applied 2026-08-11 and
  verified by schema effect — `report_key` is `text`, nullable (the NULL matters: NULLs stay distinct
  under the unique index), with `stock_out_reports_report_key_unique` present. Farm and contact counts
  were unchanged across the migration.

## Verification

- `main`: 1,820 unit tests, 895 local integration tests, typecheck, and lint pass. The web
  production build retains the tracked Next configuration/lint warnings (B-008).
- Stub evals pass critical 11/11, advisory 4/4, adversarial 29/29. The real DeepInfra model passes
  **33/33** — 28 prior fixtures plus five added 2026-08-10: two proving code strips an unauthorized
  removal (B-056) and three covering the stock-out item parser, which had none.
- **Live evals are nondeterministic** and one run in roughly three shows a provider error. That
  case is labelled `[provider error, not a verdict — rerun]` and scored as a FAILURE on purpose:
  the seam returns the same `clarification` shape for "unreachable model" and "model declined", so
  accepting any clarification let an unreachable model read as correct behaviour.
- Deployment assertions confirm both revisions are newer than every mounted secret; the served contact card
  has the expected E.164 suffix, 153 bytes, CRLF-only lines, and all seven required properties.

- `DEEPINFRA_API_KEY` runs on **VIGA's own account** (Secret Manager v3, 2026-08-11). Proven by
  effect in production; the old personal-account key is revoked and returns 401.

## Standing facts a cold start needs

- Farmer onboarding sends the farmer to text **VIGA** from their stated handset; `START` remains the
  carrier recovery fallback. Telnyx sends the opt-in receipt; Farm Friend sends only the listing-live link.
- Onboarding validates on submit, returns the farmer to the earliest incomplete step, and shows only that
  step's missing fields. The address action is **Save**; unresolved addresses are refused, never approximated.
- VIGA Farm Bucks is a farmer-owned acceptance claim, stored apart from the payment-method list. `LINK`,
  `STAND`, and `SETTINGS` retain their existing farmer update behavior.
- A dated stock claim has exactly one provenance: `sms`, `web`, or `viga`. Onboarding inventory waits for
  verified handset redemption before publication.
- `visitability` controls the map invitation. A contact-only farm may be placed, but gets no directions link.
- Broad availability inquiries expose only the first three selection candidates to the model; code keeps the
  validated remainder in deterministic order for `MORE`.

## Open before go-live

- Finish physical-handset checks: farmer onboarding, consent, vCard, paged SMS, administrator/settings,
  and F-105’s stand-detail sheet at phone width in both appearances; verify VIGA’s Squarespace embeds and
  the `?hidden=true` behavior.
- F-065: attribute every listing change to its actor; F-084: decide participant attribution during onboarding.
- B-008, B-034, B-036, F-101, and B-048 remain planned.
- **VIGA's call, not a code question:** whether the Vashon Island Farmers Market belongs in the
  roster as a farm at all — it is the market itself, not a stand with a farmer to onboard.
- **F-104's report path still has not run end to end in production.** Two attempts on 2026-08-10
  fell short (an owning handset routes as a farmer update; a non-owner handset hit the parser bug
  fixed this session). Owed, after the deploy: one text from a handset owning no stand, then check
  Neon for a `stock_out_reports` row and an alert addressed to the stand's farmer, not the reporter.
- F-106 (planned): a partial or misspelled *stand* name ("kale out at barts") does not resolve. The
  item half is fixed; the stand half needs a customer-side confirmation token that does not exist.

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

## Traps worth not rediscovering

- **Production Neon IS reachable from a dev machine** — `gcloud secrets versions access latest
  --secret=farm-friend-database-url`. `apps/web/.env.local` points at local `farmfriend_dev`, so
  checking only the working tree makes production look inaccessible. Measure the real data before
  arguing about it.
- Reassemble `VIGA Map Stands.csv` records from a `POINT` in column one; ordinary CSV parsing creates
  phantom farms.
- `drizzle-kit generate` omits CHECKs and partial indexes; inspect SQL and prove constraints by effect.
- Verify migrations by schema effect. The migration ledger is `drizzle.__drizzle_migrations`, not `public`.
- Use `printf %s`, never `echo`, for Secret Manager salts; Next expands `$NAME` in `.env` values.
- **A deploy does not pick up a rotated secret.** Cloud Run resolves `version = "latest"` at container
  START, so only a revision that started *after* the secret version serves it — a release deployed
  minutes later can still run the old value. `deploy_assertions.py` is the only check that catches it.
- **`infra/terraform.tfvars` is gitignored**, so `rotation_applied_at` lives on one machine. A plan
  from any other checkout moves it backward and silently rolls containers onto the pre-rotation
  secret while reporting success.
- **Run `infra/plan-assertions.py` before trusting it.** It was a SyntaxError under Python 3.10 from
  `2b3312a` to `640791a`; a safety gate that fails to start looks identical to one nobody invoked.
