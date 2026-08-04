# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Record only verified facts.
> Architecture docs own enduring contracts; dated reasoning and deployment proof live in the
> session log.

## Release state

Farm Friend is **pre-go-live**. Production runs one image across Cloud Run web revision
`farm-friend-web-00023-frt` and worker revision `farm-friend-worker-00024-mzv`, both at digest
`sha256:0e98f195d7947735b426254118d769e9ffa9dc49c35c4801920f34ff9ddbb698`. Production Postgres
is `neondb` with all 17 migrations applied (`0000`–`0017`, through journal timestamp
`1786500000000`).

Branch `map-slide-to-stand` is the next release candidate. On top of the `map-desktop-density`
work below it adds:

- **wide-screen map/list coupling.** A card tap slides the map panel down to the selected card
  (`apps/web/lib/map-follow.ts`, top-aligned, clamped to both the column and the visible area). A
  marker tap instead hoists the card to the top of the directory (`hoistStand`), demotes the list
  preamble beneath it so the card sits level with the map, and scrolls the layout into view. The
  map column's `position: sticky` was removed — it cannot engage inside a content-sized iframe and
  cannot coexist with the transform;
- the stand website moved out of every collapsed directory row into the expanded detail, and a
  shorter collapsed card (`min-height` 4.75rem → 3.6rem, tighter row gap and padding);
- **admin write origin is configured, not derived.** `isTrustedAdminMutationSource` now compares
  `Origin` against `PUBLIC_BASE_URL` rather than `new URL(req.url).origin`. Behind Cloud Run's
  proxy the latter reports `localhost:8080`, which refused every admin write in production while
  passing a test that hand-built the URL. **The check fails closed**: if `PUBLIC_BASE_URL` is
  unset or unparseable on the deployed service, every admin write is refused;
- a local-only seeding script for long-list testing (`packages/db/scripts/seed-map-test-stands.ts`),
  which refuses any non-loopback database and prefixes every row it creates.

Branch `map-desktop-density` is the release candidate beneath it. It includes:

- a rebuilt, compact public-map finder with button filters, grouped spacing, Farm Bucks and
  flower-only filtering, a Season-column clear action, and no selected-filter chips;
- a denser shared map/list hierarchy, compact phone map key and detail sheet, market-specific
  presentation, a visible loading state, and the reviewed May-through-September market schedule;
- a work-first volunteer desk and quieter administrator/farmer surfaces with inline confirmation
  for destructive actions;
- seller-name editing moved from the daily availability form into stand settings, bound to the
  selected stand;
- a separate customer welcome after a successful first-time `JOIN` or restoring `START`, plus
  clearer farmer authorization and invitation copy.

No schema migration is included. The market schedule source edit needs a guarded production content
update because the original public-description backfill is intentionally null-only.

## Verification

- Release candidate: 99 unit-test files / 954 tests, typecheck, and lint pass.
- Real-Postgres integration: 41 of 41 files / 564 of 564 tests pass on a complete run — this
  clears the rerun previously owed by `map-desktop-density`.
- `mapFollowOffset` and `hoistStand` are sabotage-verified: removing each clamp, reversing the
  top alignment, and leaking the hoist onto card taps each fail a distinct named test.
- The wide-screen map/list behavior was exercised in a real browser at 1500x900 and its geometry
  measured, because jsdom reports every element as zero-sized and cannot see any of it. Before the
  layout scroll, a marker tap at `scrollY` 880 left the map at top −580 and the card at −564 —
  correctly aligned and entirely off screen; after, the map sits at 0 and the card at 16, both
  fully visible. **The unit tests around this assert that the map was repositioned, not where it
  landed.**
- **Not verified inside VIGA's iframe.** The card-tap path measures the viewport, and the embed's
  height handshake sizes the frame to its own content, so there is no smaller viewport to clamp
  against and that path degrades to column-only positioning. The marker-tap path is layout-only
  and should survive, but its `scrollIntoView` will scroll VIGA's page to the top of the embed.
  Neither has been exercised in a real frame.
- Public map was exercised in a real browser at 390x844 and 1440x1000: no horizontal overflow,
  filters are binary buttons, selected-filter chips are absent, and Clear all sits inside Season.
  The document is intentionally light-only; no alternate dark palette exists.
- Production build warnings remain unchanged: Next does not recognize `outputFileTracingRoot`, and
  the Next ESLint plugin is not installed. B-008 owns the lint configuration gap.

## What is live

- **Public discovery:** model-free map/list, offering filters, honest recency, closures, participant
  names, transient browser proximity, destination links, and code-bound stock-out reporting.
- **Farmer workflows:** deterministic `SIGNUP`, `LINK`, `STAND`, `SETTINGS`, and `SAME`; one exact
  stand per credential; SMS/web proposal and confirmation; closures, participants, and reminders.
- **Customer SMS:** model interpretation over typed retrieval, identifier validation, and
  code-rendered grounded answers. `MAP`, compliance commands, and confirmation routing are
  deterministic and run before any model.
- **Administration:** fixed-account password sign-in and server-rendered farm approval, farmer
  access, flag, stock-report, and stand-data workflows. Phones are masked at the query boundary.
- **Scheduled work:** Cloud Tasks handles immediate sender work; one Cloud Scheduler route runs
  recovery, prompts, delivery, callbacks, and retention.

## Open before go-live

- **F-029:** finish live carrier/JOIN launch verification.
- **F-056:** finish protected-page, logout, copied-cookie, throttle, expiry/revocation, mobile,
  keyboard/focus, and recovery-copy browser proof.
- **B-024:** encode the no-public-address source instruction before any reseed. Production remains
  hidden under the approved interim correction.
- **B-008:** replace the incomplete deployed-build lint gate.
- **B-034:** upgrade affected production dependencies and assess advisory reachability.
- **F-044:** verify public-map and authenticated-admin embeds on VIGA's actual Squarespace pages.
- Physical-handset vCard and paged-SMS checks remain owed.
- Exercise the full farmer onboarding/update, administrator, settings, customer inquiry, and farmer
  SMS journeys against production and verify database effects rather than screen messages.
