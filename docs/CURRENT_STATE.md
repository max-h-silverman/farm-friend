# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Durable contracts live in
> the architecture docs; session history lives in [SESSION_LOG.md](SESSION_LOG.md).

## Release state

- Farm Friend is **pre-go-live**. Production serves SMS stock-out reporting, broad-inquiry paging
  and stand details. F-104's customer→farmer alert path is closed and proven on a real handset.
- Cloud Run web `farm-friend-web-00066-kq4` and worker `farm-friend-worker-00061-zpd` serve immutable
  digest `sha256:5a84dd8fbf95259abacdb2d69543913c7b8530448a786f47d9975a13bb8004b2`, built from `main`
  `067b1c6` and deployed 2026-08-11. Plan assertions 60/60; deploy and served-card assertions pass.
  Verified by effect on the live `/api/public/stands`: 35 stands served.
- Neon `neondb` has **40 applied migrations (`0000`–`0039`)**. `0039` was applied 2026-08-11 ahead of
  the image that reads it and verified by schema effect: `referenced_stand_item_id` present and
  nullable, both new constraints present, and farm/stand/item/report counts unchanged across it.
- **B-057 is live but unproven on the live path.** A stock-out alert can now name one of the stand's
  usual offerings, not only its published inventory. No production report has named one yet — that
  needs a real inbound text, and it is what closes the item.

## Verification

- `main`: 1,824 unit tests, **908** local integration tests, typecheck, and lint pass (2026-08-11).
  The web production build retains the tracked Next configuration/lint warnings (B-008).
- Stub evals pass critical 11/11, advisory 4/4, adversarial 29/29. The real DeepInfra model scores
  containment 5/5, closure 7/7, recall 5/5, quality 17/17 (2026-08-11). Note the per-category counts
  exceed the fixture count — several fixtures score multiple cases. B-057 added one quality fixture,
  proving the stock-out seam picks a usual offering out of a mixed candidate list; it passed 7/7 runs.
- **Live evals are nondeterministic** in two distinct ways, and both must be held apart. Roughly one
  run in three shows a provider error, labelled `[provider error, not a verdict — rerun]` and scored
  as a FAILURE on purpose: the seam returns the same `clarification` shape for "unreachable model"
  and "model declined", so accepting any clarification let an unreachable model read as correct.
  Separately, one B-056 fixture returns real but wrong verdicts in ~2 of 7 runs (B-058) — so a
  single live run cannot distinguish a regression from that noise.
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
- **B-057 owes one live check:** text a stock-out for an item a stand carries as a usual offering
  but does not currently publish (Pinecone Gardens' eggs is the original case), then confirm the
  farmer's alert names it and the report stored `referenced_stand_item_id`. Until then the fix is
  proven only by test.
- B-058: one B-056 live fixture returns wrong verdicts in ~2 of 7 runs — fix or make it score
  `correct/total`, but do not loosen it until it always passes.
- B-059, B-060: B-057's follow-ups — measure the seam against the corpus's genuinely awkward lists
  (Tian Tian's "bok choy" vs "Baby bok choy"; Bart's Cart's overlapping plant items), and prove by
  sabotage that a hostile `stand_items.display_name` stays inert in the farmer's alert. Both are
  quality risks: a wrong pick names the wrong item, and nothing published moves either way.

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
