# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Durable contracts live in
> the architecture docs; session history lives in [SESSION_LOG.md](SESSION_LOG.md).

## Release state

- Farm Friend is **pre-go-live**. Production serves SMS stock-out reporting, broad-inquiry paging
  and stand details.
- **F-104 is closed, verified by effect in production 2026-08-11.** A handset owning no stand
  reported a stock-out at Pinecone Gardens: one `stock_out_reports` row against that stand with its
  provider event id as `report_key`, one `stock_out_alert` delivered to the stand's farmer, and the
  reporter is not the recipient. Golden Rule #1 holds end to end on the live path.
- **Shipped 2026-08-11**: F-106's two-tier stand matching (punctuation/case folding, then
  distinctive-word scoring — a misspelled name still asks); the map search box finds stands by farm
  and stand name; the stock-out reply names its consequence; the alert no longer agrees a verb with
  the item's grammatical number. No schema change — `0038` remains the newest migration.
- Cloud Run web `farm-friend-web-00065-wzj` and worker `farm-friend-worker-00060-g4p` serve immutable
  digest `sha256:1ab56e17873533e0e51cac7ba62f7550181dc4c9a606c2ad859cb04e0b3476a9`, built from `main`
  `710afb7` and deployed 2026-08-11. Plan assertions 60/60; deploy and served-card assertions pass.
  Verified by effect on the live `/api/public/stands`: 35 stands served.
- Neon `neondb` has **39 applied migrations (`0000`–`0038`)**. `0038` was applied 2026-08-11 and
  verified by schema effect — `report_key` is `text`, nullable (the NULL matters: NULLs stay distinct
  under the unique index), with `stock_out_reports_report_key_unique` present. Farm and contact counts
  were unchanged across the migration.

## Verification

- `main`: 1,824 unit tests, 902 local integration tests, typecheck, and lint pass (2026-08-11). The
  web production build retains the tracked Next configuration/lint warnings (B-008).
- Branch `b-057-name-usual-offerings`: 1,824 unit, **908** local integration (six new), typecheck,
  lint, and stub evals pass. Four deliberate sabotages — an unbound `stand_items` query, the removed
  precedence dedup, a stand-item rendered as `unlisted`, and the queue reader's coalesce — were each
  caught by the intended test. B-057's new live fixture passed 7/7 runs.
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
- B-057 is **built and locally verified, not deployed** (`5ce3630`, branch
  `b-057-name-usual-offerings`). Migration `0039` is applied **locally only** — production is still
  at 39 migrations and still sends "sold out of something".
- B-058 (planned): the live fixture "the same message with the stand named removes nothing either"
  fails in ~2 of 7 runs on unmodified `main`. Real verdicts, not the labelled provider-error case,
  so a single live run cannot tell a regression from this noise.
- B-059, B-060 (planned): B-057's follow-ups. Its live fixture measures five clean candidates, not
  the corpus's near-duplicates and multi-item strings; and `stand_items.display_name` now enters a
  model seam and an outbound SMS body with no sabotage-proven test that hostile content stays inert.
  Both are quality risks — a wrong pick names the wrong item and the farmer can see it, and nothing
  published moves either way.

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
- **A regex backslash inside a JS template literal never reaches Postgres.** `'\s+'` in a tagged
  template arrives as `s+` and silently strips the letter "s"; it must be written `'\\s+'`. It read
  as a matching bug, and was found only by probing Postgres directly.
- **Production stand names carry typographic punctuation** — "Bart’s Cart" uses a curly apostrophe
  (U+2019) no phone keyboard produces. Test data written with a straight apostrophe misses it.
- Reassemble `VIGA Map Stands.csv` records from a `POINT` in column one; ordinary CSV parsing creates
  phantom farms.
- `drizzle-kit generate` omits CHECKs and partial indexes; inspect SQL and prove constraints by effect.
- **`drizzle-kit generate` stamps the new journal entry with the WALL CLOCK, and this repo's entries
  are future-dated** — so a freshly generated migration lands *earlier* than its predecessor and the
  migrator skips it while printing "migrations applied". Hit on `0039`. Fix the `when` to follow the
  previous entry, then confirm the column/constraint exists rather than trusting the message.
- **It also emits a composite FK before the unique constraint the FK requires.** `0039` referenced
  `stand_items (id, sales_location_id)` above the `ADD CONSTRAINT … UNIQUE` that makes it
  referenceable; the generated order fails on a clean database. Read the generated SQL top to bottom.
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
