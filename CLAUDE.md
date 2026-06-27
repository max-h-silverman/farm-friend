# Farm Friend

Farm Friend is a clean-room rebuild for VIGA. The product is a dual-channel local food coordination system: SMS for users who resist apps, and web/native app surfaces for users who prefer richer UI.

## Current Status

Architecture setup only. No clean-room feature code has landed yet.

The old Firebase/Python proof of concept was removed from this working tree. It remains only in git history and should not be treated as inherited architecture.

## Read First

Read these docs before writing code:

- `docs/PRODUCT_BRIEF.md` - product scope and MVP boundaries.
- `docs/ARCHITECTURE.md` - system architecture, repo layout, tool choice.
- `docs/DATA_ARCHITECTURE.md` - entities, invariants, freshness rules.
- `docs/AI_ARCHITECTURE.md` - LLM seams, validation, evals.
- `docs/SMS_COMPLIANCE.md` - SMS keyword and compliance rules.
- `docs/BUILD_PLAN.md` - implementation phases.

The live backlog is in `~/pm/farm-friend/` via the `pm` skill.

## MVP Scope

Build exactly two MVP tracks:

1. Farm stand availability
   - Farmers update current stand inventory by SMS, web, or native app.
   - Customers query availability by SMS, web, or native app without requiring signup for basic lookup.
   - Queries can include item search, farm-specific lookup, and recipe help grounded in retrieved inventory with clear recency.

2. Gleaning volunteer coordination
   - VIGA staff create Food Bank gleaning opportunities.
   - Volunteers self-opt in, reply `YES` or `NO`, receive confirmations and reminders.
   - VIGA staff see live counts and receive organizer updates.

Do not include for-profit farm volunteer flow in the MVP. It may be designed later as a separate program.

## Architecture Rules

1. SMS compliance comes first. Deterministic command parsing runs before any LLM call for `STOP`, `START`, `JOIN`, `HELP`, `INFO`, `YES`, `NO`, `FLAG`, and other compliance or commitment tokens.
2. The LLM never commits state. It proposes structured data. Code validates, asks for missing information, and persists only after explicit confirmation when the action affects people or public inventory.
3. Source-of-truth data lives in Postgres. SMS, web, and native app all read and write through the same backend contracts.
4. Core business logic is framework-agnostic. Keep it out of route handlers, UI components, and provider SDK adapters.
5. Provider boundaries are explicit. SMS, LLM, auth, maps, and notification providers sit behind narrow interfaces.
6. Privacy and consent are database-level concerns, not UI assumptions. Phone numbers are normalized and hashed for lookup/logging. Raw message retention is bounded.
7. Farm stand freshness must be explicit. Inventory may be approximate, but answers must show `updated at` recency and farmer cadence context instead of silently hiding older listings by default.
8. Every model seam has evals. Recipe and availability answers must be grounded in retrieved inventory rows and must not invent availability.

## TDD Discipline

Development is test-first:

- Write the failing test for behavior before implementation.
- Prefer pure unit tests for core logic: command parsing, inventory freshness, gleaning tallies, signup state, dispatch decisions, query grounding.
- Use integration tests for database invariants and SMS/web/API contracts.
- Use evals for model extraction, inventory queries, and recipe grounding.

Expected suites once scaffolded:

- `npm test` - pure unit tests.
- `npm run test:integration` - database/API integration tests.
- `npm run typecheck` - TypeScript compile checks.
- `npm run lint` - lint and formatting.
- `npm run evals` - model behavior gates.

## Working Rules

- Do not work on `main` for feature implementation; branch first once code work begins.
- Do not commit, push, deploy, or modify production services unless Max asks.
- Keep docs updated when architecture decisions change.
- Do not port old proof-of-concept code by default. Reuse lessons and tests only when they still match the new architecture.
- Never log raw phone numbers, raw provider payloads with PII, or full LLM prompts containing community data.

## Stack Direction

The settled direction is TypeScript-first:

- Backend/API: Next.js App Router first, with thin route handlers calling shared core. Add a dedicated TypeScript API app only if runtime pressure justifies it.
- Core logic: shared TypeScript packages.
- Database: Postgres with Drizzle.
- Web: React/Next.
- Native: Expo/React Native.
- SMS: Telnyx or equivalent behind an `SmsTransport`.
- Auth: email magic links for web/admin/farmer/staff sessions, plus phone identity for SMS users.
- LLM: swappable provider interface. Open-weight models are preferred long term, but MVP can use the most reliable provider/model that passes evals.
