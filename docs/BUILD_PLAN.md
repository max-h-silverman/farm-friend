# Farm Friend Build Plan

## Phase 0 - Architecture And Repo Spine

Status: done.

Deliverables:

- Hard reset old proof of concept from `/Users/max/farm-friend`.
- Move PM registry to `/Users/max/farm-friend`.
- Clear outdated PM backlog.
- Establish clean-room product and architecture docs.

## Phase 1 - Scaffold And Test Harness

Status: in progress. F-001 scaffold is implemented and in review; auth foundation and admin flag-review UI remain launch blockers for later Phase 1/admin work.

Deliverables:

- TypeScript monorepo scaffold.
- `packages/core` with first pure tests.
- `packages/db` with Drizzle schema and migration harness.
- `apps/web` Next.js App Router shell with thin API/webhook route pattern.
- `apps/mobile` Expo shell.
- SMS simulator transport.
- Evals harness with stub provider.
- Email magic-link auth foundation for web/admin/farmer/staff sessions. Not in F-001.
- Admin flag review skeleton sufficient to inspect and resolve paused SMS threads before launch. Not in F-001.

First tests:

- Compliance keywords bypass model.
- Phone normalization/hash redaction.
- Inventory recency and farmer cadence policy.
- Gleaning signup/waitlist count invariant.

## Phase 2 - Farm Stand Inventory Core

Deliverables:

- Farm/farm stand schema.
- Farmer verification and role checks.
- Farmer invite/onboarding path for VIGA staff/admin-managed farm setup.
- Inventory snapshot publication.
- SMS inventory extraction draft -> confirmation -> publish.
- Web/native inventory editor backed by the same API.
- Public inventory query with `updated at` recency.

Key tests:

- SMS publish requires confirmation.
- Approximate quantities are preserved.
- Inventory answers include recency and do not hide older inventory by default.
- Customer answer cannot cite missing inventory.

## Phase 3 - Farm Stand Customer Experience

Deliverables:

- SMS customer item/farm lookup.
- Public web inventory search.
- Native customer browse/search.
- Grounded recipe answer seam.

Key evals:

- No invented availability.
- Recipe uses retrieved inventory where possible and states recency for availability claims.
- No-listing answer is honest and useful.
- Recipe seam avoids medical, preservation/canning, foraging, and food-safety advice beyond conservative high-level disclaimers.

## Phase 4 - Gleaning Coordination Core

Deliverables:

- Staff role and gleaning opportunity schema.
- Staff SMS draft -> confirmation -> broadcast.
- Volunteer opt-in.
- `YES`/`NO` signup flow.
- Live organizer tally.
- Waitlist behavior when opportunities are full.
- Reminder scheduler.

Key tests:

- Unverified staff cannot broadcast.
- Unknown/unsubscribed volunteer `YES` does not sign up.
- Confirmed count cannot exceed max; overflow becomes waitlisted when appropriate.
- Dropout updates tally and frees spot.

## Phase 5 - Admin And Partner Operations

Deliverables:

- Admin dashboard for inventory health, farms, subscriptions, gleaning events, flags.
- Staff organizer view.
- Thread viewer and manual send.
- Food Bank visibility/export remains explicitly deferred unless VIGA pulls it in later.

## PM Seed

After the PM reset, seed only clean-room items:

- F-001: Scaffold TypeScript monorepo and test harness.
- F-002: Farm stand inventory publish core.
- F-003: Farm stand customer query and grounded recipe answers.
- F-004: Gleaning opportunity and volunteer signup core.
- F-005: Admin/staff operations console.
