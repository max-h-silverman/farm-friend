# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Record only verified facts.
> Architecture docs own enduring contracts; dated reasoning and deployment proof live in the
> session log.

## Release state

Farm Friend is **pre-go-live**. Production runs one image across Cloud Run web revision
`farm-friend-web-00027-5ng` and worker revision `farm-friend-worker-00028-67c`, both at digest
`sha256:2f089d8b4a0482a78cea6754b5dfa914800c7e5c021fb2dc9845ee455eab797a` (`main` at `4a8bca7`).
Production Postgres is `neondb` with all 17 migrations applied (`0000`–`0017`, through journal
timestamp `1786500000000`).

The wide-screen map/list coupling, the desktop density pass, and the indicator-color correction are
all merged to `main`. The most recent tranche is a **public-map selection and key polish**:

- **one selected state, said once.** A selected directory row paints the same fill as hover (the
  `--row-hover` token), so it no longer shifts color under the pointer; its ring is 3px, matching
  the selected pin's weight. Pin outlines are a uniform thin 2px and carry **no** selection state —
  the halo is the only selection mark on the map;
- **the selected pin is drawn last.** SVG has no `z-index`, so `hoistStand` took a
  `"front" | "end"` parameter: the directory hoists the selection to the front, the pin layer to
  the end. One mechanism, two ends — not two helpers;
- **the directory key never wraps.** Type and gap both scale in `cqi` against `.list-column`, which
  is now a container. Below roughly a 340px column the three labels cannot share a line at any
  legible size, so the type stops at a readable floor and the row scrolls rather than clipping;
- **the "Has a stand to visit" filter is gone end-to-end** — option, active count, `StandFilters`
  field, predicate, and test.

Two defects were fixed that no test could see: `.stand:focus-within` painted a dark border beside
the amber selection ring on every click, and on wide screens `.stand:hover { box-shadow: none }`
outranked `.stand-selected` and erased the ring whenever the pointer rested on the selected row.

No schema migration is included. The market schedule source edit needs a guarded production content
update because the original public-description backfill is intentionally null-only.

## Verification

- Current `main`: 99 unit-test files / 959 tests, typecheck, lint, and the production web build pass.
- Real-Postgres integration: 41 of 41 files / 564 of 564 tests pass on a complete run. **Not rerun
  in the 2026-08-04 pass** — that tranche touched only public-map client rendering, with no DB,
  server, model-seam, SMS, or privacy surface in the diff, so no integration run or eval was owed.
- `mapFollowOffset` and `hoistStand` are sabotage-verified: removing each clamp, reversing the
  top alignment, leaking the hoist onto card taps, and reverting the end-hoist branch each fail a
  distinct named test.
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
- The selection and key polish was verified at 1440x1000 and in 390px and 320px frames by reading
  **computed styles**, not screenshots — jsdom sizes every element at zero and can see none of it.
  Confirmed: the selected row's ring resolves to `rgb(233,174,27) 0 0 0 3px` while hovered, the
  key holds one line with no clipping from a 360px column upward, and the page never overflows
  horizontally. At a 320px column the key scrolls within itself by design.
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
