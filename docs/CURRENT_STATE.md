# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Durable contracts live in
> the architecture docs; session history lives in [SESSION_LOG.md](SESSION_LOG.md).

## Release state

- Farm Friend is **pre-go-live**. Production serves B-050 broad-inquiry paging and F-105 stand details,
  built from `main` `d6fc44c` (application release `e2ca05f`); this release has no schema change.
- Cloud Run web `farm-friend-web-00061-8jv` and worker `farm-friend-worker-00056-njf` serve immutable
  digest `sha256:059b4c12641c53bdde6d9943b86877b98dd3d88e5a32f2a0a0973c2be7be2411`. These revisions
  carry the SAME image as `00060-8wn`/`00055-h4b`; they exist only to restart the containers onto
  `DEEPINFRA_API_KEY` v3 (see the rotation entry below).
- Neon `neondb` has 38 applied migrations (`0000`–`0037`).

## Verification

- `main`: 1,804 unit tests, 887 local integration tests, typecheck, lint, and the web production build
  pass. The build retains the tracked Next configuration/lint warnings (B-008).
- Stub evals pass critical 11/11, advisory 4/4, adversarial 29/29. The real DeepInfra model passes
  containment 5/5, closure 7/7, quality 11/11, and recall 5/5 — 28 fixtures, including broad
  first-page intent and F-104's customer route signal.
- Deployment assertions confirm both revisions are newer than every mounted secret; the served contact card
  has the expected E.164 suffix, 153 bytes, CRLF-only lines, and all seven required properties.

### `DEEPINFRA_API_KEY` rotated to VIGA's own account — 2026-08-11

- Secret Manager `farm-friend-deepinfra-api-key` **v3** (32 chars, no trailing newline). Both services
  were redeployed on the unchanged image so their containers restart onto it: Cloud Run resolves
  `version = "latest"` at container START, so adding a version changes nothing already running — the
  revisions Codex deployed at 03:07 predated v3 and were still serving the old key.
- **Proven by effect in production**: a real SMS "who has eggs?" returned a grounded, code-rendered
  answer — 12 stands ranked, first 3 paged, "nobody has confirmed eggs recently" distinguishing
  confirmed stock from typical offerings. A dead key degrades to a clarification with no stands, so
  this is the deployed model-backed path, not a local proof.
- **Owed:** the OLD key on Max's personal DeepInfra account is still live and must be revoked, then
  proven dead (a request with it returns 401). Until then that account can still be billed.
- **`infra/terraform.tfvars` is gitignored**, so `rotation_applied_at = "2026-08-11T03-04"` exists only
  on Max's machine. A deploy planned from any other checkout reverts the marker and silently rolls the
  containers back onto whatever they had — this is a real trap, not a note.
- `infra/plan-assertions.py` was a **SyntaxError under Python 3.10** (an f-string reusing its outer
  quote, needing 3.12+) from commit `2b3312a` until `640791a` repaired it. The gate could not have run
  for any deploy in that window, including the 2026-08-10 B-050/F-105 release. Quoting only; 60/60 pass.

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
- VIGA must decide whether the Vashon Island Farmers Market belongs in the farmer roster.
- **Customer stock-out reporting works end to end over SMS** (F-104, 2026-08-11). A customer texts
  that something sold out; a new `customer-message-intent` seam routes report-vs-question; code
  resolves the stand from the customer's own words by unique exact-substring match, or asks "Which
  stand are you at?"; the report and the farmer's `stock_out_alert` commit in one transaction.
  **GL-007 is done and GL-008 is superseded** (SMS instead of a QR/web form — max, 2026-08-10).
  Migration **`0038`** adds `stock_out_reports.report_key` (unique, nullable) for reporting-event
  idempotency — **applied locally only, not yet in Neon**.
  - **Live evals ran green** against production's own model,
    `mistralai/Mistral-Small-24B-Instruct-2501`. Two fixtures are new — one containment (a classification cannot carry a stand of
    its own; the seam's `.strict()` schema is the barrier) and one quality (six real phrasings,
    all six split report from question correctly, sabotage-checked by inverting one expectation).

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

- Reassemble `VIGA Map Stands.csv` records from a `POINT` in column one; ordinary CSV parsing creates
  phantom farms.
- `drizzle-kit generate` omits CHECKs and partial indexes; inspect SQL and prove constraints by effect.
- Verify migrations by schema effect. The migration ledger is `drizzle.__drizzle_migrations`, not `public`.
- Use `printf %s`, never `echo`, for Secret Manager salts; Next expands `$NAME` in `.env` values.
