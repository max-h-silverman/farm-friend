# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Durable contracts live in
> the architecture docs; session history lives in [SESSION_LOG.md](SESSION_LOG.md).

## Release state

- Farm Friend is **pre-go-live**. Production serves application commit `2e1014d` (2026-08-10);
  `main` head is `9587702`, which adds this release documentation only.
- Cloud Run web `farm-friend-web-00059-c7j` and worker `farm-friend-worker-00054-xv6` serve the same
  immutable digest: `sha256:60117339775a9a813fb7575552e1ff9e9a96e0694ab2abfda4a85268ad990da7`.
- Neon `neondb` has 38 applied migrations (`0000`–`0037`); this release has no schema change.
- The four outstanding VIGA-record questions were resolved with source-backed notes; no farmer listing
  was changed. Peak Moon and Sweet Alyssum already have live map points.

## Verification

- `main`: 1,794 unit tests, 878 local integration tests, typecheck, lint, and the web production build
  all pass. The build retains the tracked Next configuration/lint warnings (B-008).
- Deployment assertions passed: both services run revisions newer than every mounted secret. The served
  contact card has the expected telephone, CRLF formatting, and seven required properties.
- Any model/projection, schema, or output-contract change requires the relevant live eval run; none changed
  in this release.

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

## Open before go-live

- Finish physical-handset checks: farmer onboarding, consent, vCard, paged SMS, and administrator/settings
  journeys; verify VIGA’s Squarespace embeds and the `?hidden=true` behavior.
- F-065: attribute every listing change to its actor; F-084: decide participant attribution during onboarding.
- B-050: broad customer inquiries fail because selection asks the model to rank every candidate instead of
  selecting the first page; narrow inquiries work. B-008, B-034, B-036, F-101, and B-048 remain planned.
- VIGA must decide whether the Vashon Island Farmers Market belongs in the farmer roster.

## Traps worth not rediscovering

- Reassemble `VIGA Map Stands.csv` records from a `POINT` in column one; ordinary CSV parsing creates
  phantom farms.
- `drizzle-kit generate` omits CHECKs and partial indexes; inspect SQL and prove constraints by effect.
- Verify migrations by schema effect. The migration ledger is `drizzle.__drizzle_migrations`, not `public`.
- Use `printf %s`, never `echo`, for Secret Manager salts; Next expands `$NAME` in `.env` values.
