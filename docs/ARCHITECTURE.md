# Farm Friend Architecture

## Settled Direction

Use a TypeScript-first monorepo with a shared domain core, Postgres source of truth, SMS transport, Next.js web/API app, Expo native app, and swappable LLM layer.

This fits the product better than the old Firebase/Python proof of concept because:

- The product needs web, native, SMS, and admin surfaces sharing one behavior layer.
- Gleaning signups and farm stand inventory need relational integrity, freshness queries, counts, and audit trails.
- TypeScript can be shared across Next.js, Expo, core logic, API contracts, tests, and eval fixtures.
- Postgres handles inventory search, volunteer signups, uniqueness, and reporting cleanly.

## Proposed Repo Layout

```text
apps/
  web/                 Next.js App Router app: public inventory, API routes, admin, staff/farmer/customer UI
  mobile/              Expo app: native farmer/customer/volunteer experience
  api/                 Deferred; add only if Next route handlers become too constrained
packages/
  core/                Framework-agnostic domain logic
  db/                  Drizzle schema, migrations, query helpers
  sms/                 SmsTransport interface, Telnyx adapter, simulator
  ai/                  LLMProvider interface, schemas, prompts, eval-facing seams
  config/              Shared environment parsing
  ui/                  Shared UI primitives when useful
evals/                 Model and grounding evals
docs/                  Product and architecture source of truth
```

Initial deployment should use the Next.js app as both web surface and API/webhook host. Route handlers stay thin and call `packages/core`; add a dedicated API app only if deployment, scaling, or routing pressure justifies it.

## Runtime Surfaces

### SMS

Single phone number branded as Farm Friend. The inbound webhook normalizes the sender, verifies the provider signature, persists the inbound message, runs deterministic keyword parsing, routes by active conversation/program, and invokes AI only for free-form text that needs extraction or answer generation.

### Web

Public customers can search farm stand availability without signup. Farmers, VIGA staff, and admins authenticate for inventory editing, farm map/profile management, gleaning setup, and moderation.

Use email magic links for web/admin/farmer/staff auth in MVP. SMS identity remains first-class for SMS users, but SMS login should not be the only auth path because admin and cross-device workflows need stable web/native sessions.

### Native App

Expo app shares API contracts and core types. It should support:

- Farmer inventory updates.
- Customer search and saved preferences.
- Volunteer signup/status/reminders.
- Staff/admin operational views where mobile use is realistic.

Native should be built in parallel with the web/API foundation, not postponed. It must not fork business logic; it calls the same API as web and shares domain/API types where practical.

## Backend

The backend owns:

- Auth and role enforcement.
- SMS webhook verification.
- Conversation state.
- Inventory publication.
- Gleaning opportunity lifecycle.
- Scheduled reminders and freshness prompts.
- LLM invocation through typed seams.
- Audit logs and admin review queues.

Use Postgres as the source of truth. Use Drizzle for schema, migrations, and typed query helpers. Use database constraints for uniqueness and integrity wherever possible.

Assume Vercel for the initial Next.js runtime and Neon Postgres for the initial hosted database unless a concrete deployment constraint says otherwise. Keep all provider boundaries narrow enough to move later.

## Program Routing

One SMS number supports multiple programs. Program routing is stateful and deterministic:

1. Compliance keywords always win.
2. `FLAG` pauses automation and creates an admin review item.
3. A live pending confirmation wins over generic program routing where safe, except `STOP`, `HELP`, and `FLAG`.
4. Active conversation state routes replies to the correct flow.
5. Role and subscription state decide eligible programs. One person may have multiple roles on one phone number.
6. Free-form unmatched messages can be classified by an LLM seam, but only after deterministic checks.

`YES` and `NO` are context-bound commitment tokens. They can confirm, sign up, cancel, or decline only when pending confirmation or opportunity state proves the target; otherwise they should receive a non-committal clarification or no-op response.

MVP programs:

- `farmstand`
- `gleaning`

Explicitly deferred:

- `farm_volunteer`
- `restaurant_matchmaking`
- `farmstand_credits`

## Key Flows

### Farmer Inventory Update

1. Farmer texts current inventory or edits it in app.
2. SMS path persists raw inbound and extracts proposed inventory lines.
3. Code validates item names, quantities, farm identity, and freshness policy.
4. System echoes a concise publish summary.
5. Farmer confirms.
6. Inventory snapshot and item rows publish atomically.
7. Customer query surfaces update immediately.

### Customer Inventory Query

1. Customer asks by SMS, web, or app.
2. Code retrieves inventory candidates and recency metadata.
3. LLM may generate natural-language answer or recipe idea using retrieved inventory.
4. Answer must cite availability only from retrieved records.
5. If no inventory supports the request, the answer says so. Older records may be shown only with clear `updated at` language.

### Gleaning Opportunity Creation

1. VIGA staff texts or enters gleaning need.
2. System extracts crop, farm/place, address, date, time, volunteer min/max, organizer, and notes.
3. Missing fields trigger clarification.
4. Complete draft is echoed back for confirmation.
5. Staff confirms.
6. Broadcast goes to gleaning subscribers.
7. Signup and waitlist counts update as volunteers reply.

### Volunteer Signup

1. Volunteer receives broadcast or sees opportunity in app.
2. `YES` creates or confirms signup if capacity rules allow, or creates a waitlist entry when full.
3. Volunteer gets confirmation and cancellation instructions.
4. Organizer gets live tally update.
5. Morning reminder goes to confirmed volunteers and organizer.

## Scheduled Work

- Inventory freshness prompts to farmers.
- Inventory recency labeling and farmer cadence prompts.
- Gleaning morning reminders.
- Gleaning organizer tally summaries.
- Message TTL cleanup.
- Evals/manual smoke probes before model/provider changes.

## Provider Interfaces

- `SmsTransport`: send message, receive provider metadata, verify webhook.
- `LLMProvider`: structured JSON generation with schema validation.
- `Clock`: injectable time for tests.
- `Notifier`: future push/email abstraction.
- `MapProvider`: future geocoding/maps links if needed.

## Non-Negotiable Invariants

- LLM never commits state.
- Deterministic compliance keywords bypass the LLM.
- All public inventory answers are grounded in inventory rows with explicit `updated at` recency.
- Gleaning signup counts are computed from persisted signup state, not message text.
- Phone numbers are never logged raw.
- Admin flag review UI is required before public SMS launch.
- All role checks happen server-side.
- Tests define behavior before implementation.
