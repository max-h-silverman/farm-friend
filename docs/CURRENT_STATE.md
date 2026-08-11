# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Durable contracts live in
> the architecture docs; session history lives in [SESSION_LOG.md](SESSION_LOG.md).

## Release state

- Farm Friend is **pre-go-live**. `main` release `e2ca05f` adds B-050 broad-inquiry paging and F-105
  stand details; this wrap promotes that release. It has no schema change.
- Neon `neondb` has 38 applied migrations (`0000`–`0037`).

## Verification

- `main`: 1,795 unit tests, 847 local integration tests, typecheck, lint, and the web production build
  pass. The build retains the tracked Next configuration/lint warnings (B-008).
- Stub evals pass critical 11/11, advisory 4/4, adversarial 29/29. The real DeepInfra model passes
  containment 4/4, closure 7/7, quality 10/10, and recall 5/5, including broad first-page intent.

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

- Finish physical-handset checks: farmer onboarding, consent, vCard, paged SMS, and administrator/settings
  journeys; verify VIGA’s Squarespace embeds and the `?hidden=true` behavior.
- F-065: attribute every listing change to its actor; F-084: decide participant attribution during onboarding.
- B-008, B-034, B-036, F-101, and B-048 remain planned.
- VIGA must decide whether the Vashon Island Farmers Market belongs in the farmer roster.

## Traps worth not rediscovering

- Reassemble `VIGA Map Stands.csv` records from a `POINT` in column one; ordinary CSV parsing creates
  phantom farms.
- `drizzle-kit generate` omits CHECKs and partial indexes; inspect SQL and prove constraints by effect.
- Verify migrations by schema effect. The migration ledger is `drizzle.__drizzle_migrations`, not `public`.
- Use `printf %s`, never `echo`, for Secret Manager salts; Next expands `$NAME` in `.env` values.
