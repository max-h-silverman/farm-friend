# Farm Friend — Runbook (operate & extend)

Cold-start guide: with only [../CLAUDE.md](../CLAUDE.md) and this file, a developer can install,
run the suites, and start the web app. Also the **how-to-extend** guide (referenced from CLAUDE.md,
not inlined there).

> This is the **operate-and-extend** guide: how to run, migrate, seed, evaluate, rotate, and deploy.
> It carries no build status — what is actually built, deployed, and open lives in
> [../CLAUDE.md](../CLAUDE.md) "Current State & Open Items". Check there before trusting that a step
> below has a working counterpart in the deployment.

## Prerequisites

- **Node** per `.nvmrc` (`nvm use`). npm workspaces (ESM).
- **Postgres** for integration tests and migrations: local Postgres or a disposable CI instance.
  Set `DATABASE_URL` (see `.env.example`) to a database whose test role may create and drop a
  throwaway database. The integration suite fails explicitly when the variable is absent.

  **On this Mac it is already installed, and it is NOT on `PATH`.** Homebrew's `postgresql@16` runs
  as a launch agent; `psql`, `pg_isready` and friends live in `/opt/homebrew/opt/postgresql@16/bin`,
  so a bare `which psql` reports nothing and looks exactly like "no database available". A whole
  session was once written off on that false negative. To run the suite:

  ```bash
  export PATH=/opt/homebrew/opt/postgresql@16/bin:$PATH
  export DATABASE_URL="postgres://$(whoami)@localhost:5432/postgres"
  npm run test:integration 2>&1 | tee /tmp/itest.log
  ```

  Confirm it is up with `brew services list | grep postgres` or `pg_isready` (full path).
- No network is required for unit tests or evals (the model stub is offline and deterministic).

## Local dev — the five commands

```
npm install                 # install all workspaces
npm run typecheck           # tsc across ALL workspaces incl. apps/web — proves the provenance barrier
npm run lint                # lint across workspaces
npm test                    # vitest unit — pure core logic, no DB/SMS/LLM (seams injected)
npm run test:integration    # vitest against Postgres — data invariants (requires DATABASE_URL)
npm run evals               # evals (stub provider); critical fixtures must be 100%
```

`npm run typecheck` is part of the safety story: bypassing the task-specific model-context
constructors or outbound guard in ordinary code **fails `tsc`** (the branded safe-context /
redacted-outbound types). This proves provenance, not runtime content safety; workflow tests and
hostile evals verify the runtime barrier but are not themselves enforcement. See
[AI_ARCHITECTURE.md](AI_ARCHITECTURE.md) §safety boundary.

### What "across workspaces" means, and the three layers (GL-005)

`npm run typecheck` runs **two** halves and fails if either does:

| Script | Covers | How |
| --- | --- | --- |
| `typecheck:packages` | `packages/core`, `db`, `sms`, `ai` | `tsc -b` over the root `tsconfig.json` project references |
| `typecheck:web` | `apps/web` | `tsc -p tsconfig.json --noEmit` in the web workspace |

Two halves rather than one because `apps/web/tsconfig.json` sets `composite: false` (Next.js owns
that config), and `tsc -b` can only reference **composite** projects. Making web composite to force
it into the reference graph would mean fighting the framework's generated config on every upgrade;
delegating to the workspace's own script is the smaller, more durable seam.

**This was untrue until GL-005.** The root script was a bare `tsc -b`, and the root `tsconfig.json`
references only the four packages — so `apps/web` was never typechecked at all, and held **57 real
type errors** while this document said "across workspaces". Nothing reported it, because the command
that was supposed to report it exited 0. `packages/core/src/typecheck-coverage.test.ts` now asserts
the wiring against the manifests, so the claim and the command cannot drift apart again.

**`next build` remains a SEPARATE layer, deliberately.** The two check different things and neither
subsumes the other:

- `npm run typecheck` covers **test files**, which `next build` never compiles.
- `npm run build --workspace @farm-friend/web` covers **route and manifest conventions** and the
  real bundle graph, which `tsc -p` does not model.

Run both. A green typecheck is not a green build, and a green build is not a green typecheck.

## Environment

Copy `.env.example` → `.env` and fill:
- `DATABASE_URL` — Postgres/Neon connection (integration tests + migrations).
- `PHONE_HASH_SALT` — required; the phone hash is the only lookup/log key.
- `DEPLOYMENT_ROLE` — `web` or `worker`. Absent means `web`, which is the surface that REFUSES
  `/api/internal/*`; a misspelled value is a startup error. (There is no `CRON_SECRET` any more —
  see "Scheduled work" below.)
- `CLOUD_TASKS_*` — five variables, **all or none**. A partial set is a startup error: it would
  look configured, construct without complaint, and fail every enqueue at runtime. Absent entirely
  is the legitimate "no queue here" case that local development uses.
- `MAGIC_LINK_SECRET` — signs admin sign-in links. **Required, no default**: the callback returns
  503 rather than verifying signatures against a guessable value, because that would be an open
  door to the farm-approval surface.
- `PUBLIC_BASE_URL` — the public origin sign-in links are built against, e.g.
  `https://farmfriend.example`. **Required, no default, and validated**: it must be an absolute
  URL, and `http` is refused outside localhost because a sign-in link is a bearer credential that
  must not travel in cleartext. It is configuration rather than a value derived from the request,
  because a `Host:` header an attacker controls would otherwise let the link-request endpoint mail
  a real operator a working-looking link pointing at the attacker's origin.
- **Mail provider** — not yet configured. F-032 built the sign-in request path against a
  `MailSender` seam whose only implementation today **fails closed**: an attempted send throws
  `MailNotConfiguredError` rather than quietly succeeding. Choosing a provider, recording its
  attested data handling, and implementing the adapter is **F-031**. Until then an administrator
  requesting a link gets the same 202 as everyone else and no mail is delivered.
- `SMS_PROVIDER` — `simulator` or `telnyx`. There is **no default**; an unset or unknown value is a
  configuration error rather than a silent fallback.
- With `SMS_PROVIDER=telnyx`, all four are required: `TELNYX_API_KEY`,
  `TELNYX_MESSAGING_PROFILE_ID`, `TELNYX_FROM_NUMBER`, and `TELNYX_PUBLIC_KEY` — the ed25519
  webhook verification key, without which inbound webhooks cannot be verified at all.
- `LLM_PROVIDER` — `stub` or `deepinfra`. **Required, no default (GL-019).** Set it to `stub` for
  ordinary local work: the stub is still the right choice there, it simply has to be asked for.
  Absent, blank, or unknown is a configuration error — production had no `LLM_PROVIDER` and
  therefore ran the test double against real traffic, entirely silently, because the code supplied
  the default. There is deliberately no environment-dependent relaxation.
- With `LLM_PROVIDER=deepinfra`: `DEEPINFRA_API_KEY` and `DEEPINFRA_MODEL` are required, and an
  `anthropic/`- or `google/`-namespaced model is refused (their terms were never attested).

Runtime configuration is parsed and validated in the **single composition root**
(`apps/web/lib/composition.ts`); there is no `config` package. It **fails closed**: selecting live
Telnyx without the verification key or delivery credentials throws at startup, and the simulator
never inherits live secrets. `.env` is gitignored; only `.env.example` is committed.

## Migrations

The launch schema is a **clean initial migration** containing only the minimum durable records in
[DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md), with the constraints listed there enforced at the
database level.

`npm run test:integration` creates a uniquely named empty database through `DATABASE_URL`, applies
every file in `packages/db/drizzle/`, runs the migration set again to prove the Drizzle journal is
a no-op, exercises the launch constraints, and drops the test database. This is destructive only
to the uniquely named database created by the harness; never point manual migration commands at a
database whose contents you intend to preserve.

### Writing a new migration — the snapshot must land with it

Each migration has two artifacts: the `.sql` file that actually runs, and a **snapshot** in
`packages/db/drizzle/meta/` — a JSON picture of the whole schema at that point, which is never
executed. `drizzle-kit generate` writes the next migration by diffing your schema against the
**newest snapshot on disk** (`snapshots[snapshots.length - 1]`; drizzle-kit 0.22.8 reads that one
alone, from the directory listing rather than the journal).

So a missing snapshot does not break *applying* anything — it breaks *generating* the next one. With
a stale newest snapshot the tool sees tables and columns it has no record of and asks whether each
was created or renamed:

```
Is message_category column in outbox_work table created or renamed from another column?
```

The hazard is not the prompt. It is that a wrong answer writes a plausible-looking migration that
re-creates existing tables or renames a column out from under production data. **Commit the
generated snapshot alongside the `.sql` file**, always. `packages/core/src/migration-metadata.test.ts`
fails if the newest migration has no matching snapshot (GL-006, which repaired a five-migration
drift). Never edit an already-applied `.sql` file — production has run it.

## Bootstrap the first administrator

Authorization has a chicken-and-egg problem: only an administrator can grant authority, so the first
one comes from outside the application. Run once per environment, against a database you intend to
change:

```
DATABASE_URL=… npx tsx packages/db/scripts/bootstrap-administrator.ts you@example.org
```

Idempotent — an address that is already a live administrator is reported and left alone. Afterwards
administrators are managed in the database.

**Why a script and not the alternatives** (decided 2026-07-26, F-025a): *first-user-wins* on a public
login URL is an open door to every farm's published state, and an *env-var allowlist* puts
authorization in configuration, where the audit trail cannot record who granted it or when. A row has
an `authorized_at` and the same revocation path as every other grant.

Sign-in itself is a magic link signed with `MAGIC_LINK_SECRET`; verifying it proves control of an
email address, and the administrator lookup — not the link — is what confers authority. See
[ADMIN_OPERATIONS.md](ADMIN_OPERATIONS.md) §the administrator role.

### Bootstrap, then sign in

1. Run the bootstrap script above once per environment, against that environment's database.
2. The operator opens `/admin/login` and enters that address.
3. `POST /api/auth/request-link` mints a 15-minute link and hands it to the mail seam.
4. Opening the link hits `/api/auth/callback`, which re-checks the administrator row, mints the
   durable session, and **consumes the link**.

**Step 3 does not deliver mail yet** — the seam fails closed pending F-031. Until a provider is
configured, mint a link out of band with `issueMagicToken` and give it to the operator directly.

**A link is ONE-USE (GL-004).** Every link carries a random `nonce` covered by its signature, and
step 4 records that nonce's SHA-256 in `admin_sessions.magic_nonce_hash` — in the *same insert*
that creates the session, under a UNIQUE index. So the session row **is** the record that the link
was spent; there is no second table to keep in step and no window between consuming and minting. A
second use, including a simultaneous one, loses the `on conflict … do nothing returning id` race
and gets the same 401 as a forged link. Consequences worth knowing when operating this:

- A link that fails because the administrator was revoked is **not** burned — authority is
  re-checked before the link is spent, so a stranger cannot destroy links by replaying them.
- A refused replay never disturbs the session the first use created. Someone with a copied link
  cannot sign an operator out.
- Expiry is unchanged and still independent: an unused link past 15 minutes is dead.
- Minting still writes **nothing**. The row appears only when a link is opened, which is what keeps
  the public request endpoint free of a per-address write (see the oracle note below).

Two properties of the request endpoint to preserve when changing it, both proven by tests in
`apps/web/lib/request-link.test.ts`:

- **The response is byte-identical for every address** — same status, headers, and body whether or
  not the address is an administrator, whether it is malformed, and whether the mail seam threw.
  The endpoint is public, so any observable difference enumerates who VIGA's operators are. Note
  the third case especially: letting a mail failure become a 500 recreates the oracle through the
  error path, because mail is only ever attempted for a real administrator.
- **The token reaches exactly two places** — the rendered message and the operator's mailbox. It is
  never in a response body and never in a log. The handler therefore contains **no `console` call
  at all**, asserted against its source, because a vendor SDK routinely attaches the request payload
  (containing the live link) to the error it throws.

Rate limiting is the shared `createPublicActionThrottle`, on its **own budget** rather than the QR
stock-out form's: sharing one would let anonymous stock-out traffic from a shared NAT exhaust a real
operator's ability to sign in. The budget is per client, never per email address — a per-address
budget is itself an oracle, since an attacker learns which addresses send mail by watching which
ones start refusing.

## Seeding initial listing data

This is a **greenfield build**: existing VIGA map content is **reference input, not a schema
contract**, and there is no non-destructive migration requirement or provenance axis.

A **one-time seed utility** validates and loads farms, sales locations, and approval state.
**It does not seed inventory** (decided 2026-07-26, B-002): a seeded listing fact would fabricate a
confirmation no farmer made, and the honor-system product's core promise is showing *when* inventory
was last confirmed. Stands seed empty and render the honest "no current listing" until a farmer texts.
It also seeds **no phone numbers** — `farmer_authorizations` requires captured SMS consent, so phones
arrive through onboarding, never a bulk roster load.

Run it with:

```bash
npm run db:seed -- "<path-to-csv>" --dry-run   # report only, writes nothing
npm run db:seed -- "<path-to-csv>"             # apply
```

It is **idempotent** (keyed on stand name; a second run skips what exists and never updates it, so a
farmer's own later correction is not reverted to the CSV) and **refuses rather than coerces** — the
whole batch is one transaction, and an out-of-range coordinate aborts it instead of being clamped.

Against VIGA's map export: **28 of 31 stands seeded, 3 flags raised**. The 3 not seeded — Vashon
Island Farmers Market, Breathing Meadows Farm, Open Gate Lamb and Grazing — stated **no street
address**, and inventing one is the fabrication F-017 forbids, so they were reported as operator
tasks.

**All three are now resolved, and the seed SOURCE has changed (2026-07-29).** Farmers Market has an
address from max (17519 Vashon Hwy SW); Breathing Meadows and Open Gate Lamb are **`contact_only`**
under F-038 and need none — neither is a visitable location. `public_address` is **no longer
NOT NULL** (migration 0007): it is required for a `visitable` location and forbidden for a
`contact_only` one, enforced by `sales_locations_coherent_visitability`.

The primary source is now the **2026 form responses** export
(`packages/core/src/seed/form-responses.ts`) — well-formed, one row per farm, with hours, season,
and stocking as separate columns. **It carries no coordinates**, so the map export remains required
input for those and for farms that did not submit a 2026 form. The seed join over both is not yet
built; the loader still reads the map export alone.

**The export is malformed CSV and no standard parser reads it.** Each `description` is unquoted and
spans raw newlines until the next `"POINT (` line, so a conventional reader returns **285 rows for
31 stands** and attaches every address and `Open:` line to the *following* farm — silently.
`packages/core/src/seed/stand-csv.ts` anchors records to the `"POINT (` literal instead.

The free-form map text is still **not** data to carry forward wholesale — it is the unfilterable
content Farm Friend replaces. The seeder **structures** it (season, days, hours, cadence,
specialties) and **discards** the dated update lines, which are stale inventory: Green Ears' most
recent note reads "Closed" and Peak Moon's reads "Thank you for a great season". Seeding either
would publish a year-old claim as current. The export also carries **22 email addresses and 4 phone
numbers** (measured; an earlier "23 + 2" undercounted the phones), which are stripped — no contact
data enters without captured consent. Websites and `@handles` are deliberately **kept**: the product
contract publishes farmer-selected web and social links, and only direct phone/email are private.

**Offerings — proposed by the model, committed only after review (F-024/F-036).** Two steps,
deliberately separated so no model output reaches the database without a human between:

```bash
DEEPINFRA_MODEL="<model-id>" npm run offerings:propose -- "<path-to-csv>" maps/offerings-proposals.json
# max reviews/edits the file, then:
npm run db:seed-offerings -- maps/offerings-proposals.json --dry-run
npm run db:seed-offerings -- maps/offerings-proposals.json
```

The propose step strips contact details before any text reaches the model, passes the same
privacy gate as the composition root (`assertDeepInfraSelectionApproved`), and writes tags
beside the source text they came from. The seed step is idempotent on (location, item), never
rewrites an existing tag, skips entries without an `items` array, and reports unknown stand
names (the address-refused stands exist in the CSV but not the database). It writes
`sales_location_offerings` only — specialties, never inventory.

Geocoding happens **once, during seeding** — it is not a permanent runtime provider seam,
and a location that cannot be resolved is an **operator task**, never a fabricated coordinate.
With the export's coordinates in hand, no lookup is needed for these 31 stands.
Optional public-web browser geolocation is transient and used only for approximate proximity to
those validated coordinates; it is not persisted or sent to the model. Destination-only Google
Maps links delegate origin resolution and routing. SMS does not resolve arbitrary customer origins.

## Start the web app

```
npm run dev -w apps/web     # Next.js App Router
```

## Scheduled work (the worker trigger)

Inbound work has **two triggers, one mechanism**. The webhook only ever **persists** an inbound
event before acknowledging; routing and delivery happen in the workers, and both triggers call the
same passes:

- **The kick (B-004) — the low-latency path.** After the webhook acknowledges Telnyx, it starts the
  inbound and outbound passes *for that one sender*. This is what makes a reply arrive in
  milliseconds instead of up to a minute. It is **registered with `waitUntil` and deliberately not
  awaited**, so it can neither delay nor fail the 200, and it owns **no guarantee**: every failure is
  swallowed and the work is left for the recovery net. It is scoped to one sender and budgeted, so a
  wedged pass is abandoned rather than running until the invocation is killed.

  **`waitUntil` is load-bearing (B-009), not decoration.** Started with a bare `void`, the kick is
  work the runtime knows nothing about: Vercel suspends the invocation the moment the handler
  returns, and the pass never runs. In production that dropped *every* inbound message — committed,
  acknowledged 200, then silently abandoned with `provider_inbox_events.claimed_at` NULL. Nothing in
  the local suites can see it, because vitest runs in Node where a floating promise resolves
  normally; `apps/web/lib/kick-survival.test.ts` asserts the registration against the route source
  for exactly that reason. (`after()` from `next/server` is the modern equivalent and requires
  Next 15.1+; this app is on Next 14.)
- **Cron — the durable recovery net.** The authenticated route below still runs the full unscoped
  passes, recovering anything a kick missed because an invocation crashed, a claim lapsed, or the
  process died mid-pass. It remains the **only** trigger for F-026's retention purge, which is never
  latency-sensitive and must not run on every inbound message.

Suppressing the kick entirely loses nothing — cron still carries the message to a dispatched reply.
That is proven directly in `apps/web/lib/latency.integration.test.ts`, which also measures the end
to end reply and proves a kick racing a concurrent cron pass cannot double-process or double-send.
Exclusion is the existing per-sender row lock in `claimNextInboundEvent`; the kick adds no new
concurrency control, it just arrives at the same lock from a second direction.

**One** internal route runs every scheduled pass, reachable only on the worker service:

```
POST /api/internal/cron          Cloud Scheduler OIDC + IAM run.invoker; worker role only
```

It runs four bounded passes in order: the inbound pass (deterministic routing →
consent/confirmation/free-text), the outbound pass (dispatch claim → provider → result), the
**delivery pass** (B-012), and the **retention purge** (F-026). Each pass **enumerates its own
work** — pending sender hashes, due outbox rows, pending delivery callbacks, expired bodies — so the
trigger passes no IDs and needs no knowledge of state.

**The delivery pass** applies the `message.sent` / `message.finalized` callbacks the webhook stored,
advancing `outbox_work.delivery_status`. Without it `sent` means only "the provider accepted it",
never "the carrier delivered it" — which is what you read when a farmer reports never receiving a
prompt. It runs after the outbound pass, so a send dispatched in *this* pass has its callback applied
in the next. Delivery callbacks are deliberately **not** per-sender conversational work: they carry
no sender and never touch conversation state.

**The retention purge** clears raw message context whose `body_expires_at` has passed: the body text
in `sms_messages` and `outbox_work`, and nothing else. The `sms_messages` row, its
`provider_inbox_events` projection, dispatch attempts, flags, and audit events all survive —
retention is selective, and the record that a message existed is what keeps the system auditable.

Three properties are worth knowing when operating it:

- **Flagged threads are exempt.** A body whose inbox event carries an **open** flag is retained;
  flag review needs a readable thread. The exemption ends when the flag is resolved or dismissed at
  `/admin/flags` (F-030) — either disposition, with no grace period, so the next pass clears it.
  The exemption fails safe: a body is purged only where the absence of an open flag can be shown.
- **It never touches outbound work the dispatcher is still using.** Only `sent`/`failed`/
  `ambiguous`/`suppressed` rows are cleared, so a purge can never race the dispatcher into sending
  an empty SMS.
- **It reports counts only.** The response carries `messageBodiesPurged`, `outboxBodiesPurged`, and
  `exempted` — never a body, an identifier, or a phone. A purge that logged what it deleted would
  defeat its own purpose.

It is idempotent and safe to run concurrently with live traffic and with itself (`for update skip
locked`), and bounded per pass, so a large backlog drains over several runs rather than in one long
transaction.

Run it locally by hand:

```
curl -X POST http://localhost:3000/api/internal/cron
```

**On Cloud Run it is scheduled by Cloud Scheduler** (`infra/work.tf`,
`google_cloud_scheduler_job.recovery`), which POSTs to the worker every minute with an OIDC
token. There is no shared secret: the worker service has internal-only ingress and requires
IAM `run.invoker`, so authentication is enforced by Google before a request reaches the
container. `DEPLOYMENT_ROLE=worker` is a second door — the public service answers 404 on
`/api/internal/*`, checked before any application context is constructed.

`CRON_SECRET` is **gone**, deliberately rather than incidentally. It was one credential living
in two places that had to match — the platform env var and a GitHub repository secret — where a
mismatch returned 401, and *a 401 looks identical to success in any scheduler's UI*. Keeping it
alongside IAM would have preserved that failure mode while protecting against nothing, since a
caller who cannot satisfy IAM never reaches the code to present a token.

**This is the durable guarantee and the only trigger for F-026's retention purge.** It replaced
two mechanisms that each failed differently:

- **`apps/web/vercel.json`** — a one-minute cron the Hobby plan rejects outright, so every
  production deploy stripped the `crons` block from the working tree by hand. The deployed
  system therefore ran **no scheduled pass at all**.
- **`.github/workflows/scheduled-worker.yml`** — the external net added to cover that gap. Its
  `*/5` schedule was observed firing roughly **hourly**, because GitHub drops most slots.

Both are deleted. Do not reintroduce either; two schedules racing the same
`for update skip locked` work buys nothing.

Choose the interval as a **recovery** budget, not a reply-latency one: since B-004 the fast path
front-runs this route for live traffic, so the interval decides only how long work the queue
*missed* waits.

**Verify a schedule by its EFFECT, never by a dashboard.** A green entry proves an invocation was
attempted, not that the pass did its work. The one unambiguous signal is F-026's purge, which
runs on this trigger *alone*: set a body's `body_expires_at` in the past, wait, and confirm it is
`NULL`. If it clears, the trigger is authenticated and the passes are running.

**Authentication fails closed, outside this process.** Cloud Run's internal-only ingress plus IAM
`run.invoker` is the primary control; the in-process `DEPLOYMENT_ROLE` guard is a second door that
answers **404** (never 403 — 403 confirms the route exists) and runs *before* any application
context is constructed, so the public service never builds a database pool for a route it does not
serve. There is deliberately **no** environment-conditional bypass —
`apps/web/lib/cron-auth.test.ts` reads both route sources and fails if one appears, or if a
shared-secret comparison returns. An unauthenticated worker trigger would be a remote way to drive
consent changes and real outbound SMS.

**The fast path is a separate route.** `POST /api/internal/kick` is what Cloud Tasks calls after
the webhook enqueues a task; it runs the same two passes scoped to one sender. It carries the same
role guard and the same IAM requirement, and owns no guarantee — the scheduled pass above recovers
anything it misses.

**Adding a scheduled job** means adding its call inside `runScheduledWork` in that one route —
never a second cron surface. F-026's retention purge is the worked example.

## Telnyx webhook config

Point the Telnyx number's inbound webhook at `apps/web`'s webhook route
(`apps/web/app/api/sms/webhook/route.ts`). The signature, minimized-persistence, sender-claiming,
ordering, consent, dispatch, and delivery-monotonicity requirements below are **implemented and
proven by real-Postgres tests** as of F-014; the customer-inquiry retrieval step is not. Requirements
that must hold before live SMS:

- Read the **exact raw request bytes** and verify the webhook signature before parsing. Telnyx's
  receiving guidance requires it:
  <https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks>
- After verification, commit only the minimized inbox projection with a unique provider event ID;
  do not retain the raw provider envelope or duplicate the raw E.164. **Acknowledge only after that
  commit**, within Telnyx's response window.
- Claim at most one ordinary stateful event per sender under a short Postgres row-lock transaction.
  Release before any model or SMS call, then re-lock and verify the claim/state before finalizing.
  Reject stale state transitions by provider occurrence order; order STOP/START on their separate
  consent watermark, with STOP winning an exact timestamp tie.
- Inbound messages enter the deterministic routing in [ARCHITECTURE.md](ARCHITECTURE.md) **before
  any model call**.
- For customer inquiry, deterministic routing is followed by model interpretation, code retrieval,
  grounded model selection from the retrieved IDs, then code validation/rendering/outbox.
- Unconfirmed inventory lives only in the one pending proposal record. `YES` creates the immutable
  published revision in the confirmation transaction; `NO` and expiry create no revision.

Carrier keyword and confirmation requirements center on opt-in, opt-out, and help:
<https://support.telnyx.com/en/articles/10645338-10dlc-keywords-and-confirmation-messages> and
<https://support.telnyx.com/en/articles/9940291-10dlc-campaign-compliance-requirements>. **FLAG is a
Farm Friend product safety feature and must not be represented as a carrier-mandated keyword.**
Launch is one registered operational SMS program: `JOIN`, `START`, and documented farmer onboarding
establish its consent; universal STOP applies across all Farm Friend messaging; a customer inquiry
permits only its relevant direct reply and creates no passive follow-up subscription or `MUTE` path.
Adding an outbound message type means adding a `message_category` enum value and deciding its
consent meaning in `packages/core/src/sms/consent.ts` — never adding a second consent state or
enrollment. A new category defaults to nothing: the predicate must be extended deliberately.

Use the in-memory simulator to exercise flows without live Telnyx.

Natural-language customer inquiry is SMS-only at launch. Ordinary public map/listing/filter lookup
is model-free and uncapped. The public QR stock-out form remains model-backed and must use the
abuse/cost throttle.

Built public routes (F-019): `GET /api/public/stands` (model-free, uncapped) and
`POST /api/public/stock-out` (throttled; body carries the QR-bound `salesLocationId` UUID and
`taskText`). The throttle budget is set in the composition root — 5 model calls per client per 60s,
deliberately generous so a real reporter never meets it. Adding **any** new public model-backed
handler means routing it through `context.publicModelThrottle`; adding one that is model-free means
leaving it out. Do not add a public route that accepts a free-text *question* — inquiry is SMS-only.

## How to extend

### Add a future program

Gleaning, volunteer coordination, and Farm Bucks transactions are **plausible future programs**,
deliberately unbuilt. When one arrives:
1. Define and externally disclose its **separate enrollment**. Extend the deterministic keyword
   grammar only then; launch `JOIN`/`START` refer only to the launch operational program. Universal
   STOP continues across all Farm Friend messaging.
2. Add only the program-specific consent state and UI the approved workflow actually consumes.
3. Add its branch to the deterministic routing — **before** any model call.
4. If it needs confirmation, make it a **consumer of the existing confirmation mechanism** by
   parameterizing it — do not fork it.
5. Test-first: keyword and confirmation bypass, consent gating, the commit path.

Do **not** pre-create a general program-enrollment platform or a future program's tables, states,
command arguments, packages, or UI.

### Add an admin route or surface

1. Guard it with the shared `requireAdministrator` from `apps/web/lib/admin-guard.ts`. Do not write
   a second guard — one mechanism, several consumers, so an authorization check has one place to
   drift rather than four.
2. Take the acting administrator from the **session**, never the request body. A caller who names
   someone else must not be able to act as them.
3. Re-read the administrator's authority **inside the transaction that writes**, and commit the
   audit event in that same transaction. `packages/db/src/review.ts` and `admin.ts` are the pattern.
4. Project the minimum: no phone material unless the surface genuinely needs it, and mask it at the
   **query** (`right(phone_e164, 4)`) rather than in the renderer, so the raw number never leaves
   the database.
5. Test-first, in `apps/web/lib/admin-routes.integration.test.ts`: add the refusal assertion for
   **every method** on the new route to the unauthorized-caller block, and grep the whole serialized
   response for an E.164 and for any 64-hex run.

**A PUBLIC auth route is the exception, and inverts most of this.** `/api/auth/request-link` and
`/api/auth/callback` are deliberately unauthenticated — they are how someone becomes authenticated,
so `requireAdministrator` cannot apply. What replaces it:

- **Answer identically for every input.** Not "return 200 in both cases" — identical status,
  headers, and body, asserted by comparing whole serialized responses. Include the failure paths:
  a malformed address, and an internal error on work only a real administrator triggers.
- **Front it with `createPublicActionThrottle` on its own budget**, and consult the throttle
  *before* any database lookup, so a refused request performs no read and cannot be timed.
- **Bucket by client, never by the identifier being probed.** A per-address budget tells an
  attacker which addresses are real by which ones start refusing.
- **Build outbound URLs from configured values**, never from `Host` or `X-Forwarded-Host`.

### Add a model seam

1. Add the seam to the catalog in [AI_ARCHITECTURE.md](AI_ARCHITECTURE.md) and define its schema.
2. Define the seam's explicit minimal input projection. It may contain only the current task text,
   required public facts, and opaque identifiers; never pass a raw record, transcript, other
   actor's text, contact/auth/consent/admin/audit data, internal note, or secret.
3. Add a task-specific context constructor and keep the low-level branded provider call internal to
   `packages/ai`; do not give the adapter a repository, database client, or provider-managed thread.
4. Validate the output against **schema and evidence**, one repair retry, then clarify or flag.
   Structural validity is not grounding.
5. Code-render every consequential or cross-actor message. Model-authored prose may return only to
   the same actor whose current task text supplied its private context.
6. Add a hostile full-workflow fixture that captures the provider context and resulting outbox row
   (advisory; **critical** if safety-relevant), then run the evals.

**Copy the worked example.** `inventory-extraction` is the built seam and the pattern to follow:
`projectInventoryExtraction` in `packages/ai/src/projections.ts` (step 2–3, note it copies each
permitted field explicitly rather than spreading a caller's object),
`packages/ai/src/inventory-seam.ts` (step 4, and note every schema member is `.strict()` so a
smuggled consequential field is a visible refusal, not a silent strip),
`apps/web/lib/interpretation.ts` (step 5, plus snapshot-membership validation the schema cannot
do), and `evals/hostile.ts` with the hostile group in `apps/web/lib/interpretation.integration.test.ts`
(step 6). Add the new projection's own bypass assertions to
`packages/ai/src/safety-boundary.type-test.ts`.

**For a smaller worked example, read `offering-extraction`** (F-035): `projectOfferingExtraction`
plus `packages/ai/src/offering-seam.ts` is the whole seam in ~90 lines, and its four fixtures in
`evals/hostile.ts` show the minimum a new seam owes — refusing a smuggled consequential field,
withholding everything but the task text under injection, keeping provider failure distinguishable
from an empty answer, and failing closed on a raw phone in its input.

**Before writing a seam, check a deterministic version against real data first.** F-035's
availability parsing needed no model once "not stated" was separated from "unparsed"; offerings did,
because a regex could not tell an offering from a farming-practice clause. The corpus settled both
questions in minutes. A seam that a measured deterministic path would have covered does not earn its
place (CLAUDE.md, "Simplicity and elegance").

### Swap a provider

- **Model version, same approved provider contract:** implement/select it by config; the branded
  context boundary remains unchanged and the full suite must pass at parity or better.
- **Model provider:** before selection, re-verify that it does not train on Farm Friend
  requests/responses, calls are stateless, request/response logging is disabled where supported,
  and unavoidable retention has an approved documented maximum. A provider swap is not exempt from
  this privacy gate. **Declare the terms in code**: add the provider's `ProviderDataHandling` to
  `resolveModelConfig` in `apps/web/lib/composition.ts`. `assertProviderApproved` runs at startup
  and **throws** on any violation, so a provider that cannot meet the terms never constructs. Note
  what this is: an operator-attested, version-controlled declaration checked in code — not a
  network audit of the vendor's actual practice.

  **Which provider is configured.** `LLM_PROVIDER` selects it: `stub` (the deterministic test/dev
  double, no network call) or `deepinfra`. **It is required and has no default (GL-019)** — absent
  or blank is a `ConfigurationError`, as is an unknown value, because a typo or an omission must
  never silently run the test double against real farmers. That is not hypothetical: production ran
  the stub for its entire life because nobody set the variable and the code defaulted to it.
  Deliberately **not** "required only in production" — a rule that relaxes off-production behaves
  one way everywhere it is tested and another way where it matters, which is exactly how the defect
  survived. DeepInfra additionally needs `DEEPINFRA_API_KEY` and `DEEPINFRA_MODEL`.

  **DeepInfra is attested (F-024, reviewed 2026-07-28, directed by max).**
  `DEEPINFRA_ATTESTED_DATA_HANDLING` in `packages/ai/src/deepinfra.ts` — beside the adapter it
  gates, so scripts and evals that construct the provider outside the composition root approve
  the same declaration via `assertDeepInfraSelectionApproved` — records the terms transcribed
  verbatim from
  <https://docs.deepinfra.com/account/data-privacy>: no training on API data, stateless inference
  (inputs in memory only, outputs deleted once returned), content logging off by default (metadata
  only), zero stated retention — with the known caveat, recorded at the binding, that DeepInfra
  reserves an unbounded discretionary right to log "a small portion of requests" for
  debugging/security. The terms are the *inference host's*, not the model author's licence.
  **The attestation's carve-out is enforced in code**: DeepInfra's no-training clause excludes
  Google and Anthropic models (routed to those vendors' endpoints), so an `anthropic/` or `google/`
  `DEEPINFRA_MODEL` is a startup `ConfigurationError`. Source tests pin the four values *and their
  citation* — changing either alone fails. If DeepInfra's terms change, re-read them and move the
  binding, citation date, and pinned test together. After attesting, run `npm run evals` against
  the real model: critical and adversarial must stay at 100%, and a failing adversarial fixture
  **stops and reports** rather than being edited to go green.
- **SMS:** implement the transport (send + **signature verification**); the redaction guard
  continues to normalize avoidable Unicode and block raw phones. After the provider accepts a send,
  record encoding, character count, and estimated billable segments — **by recipient hash, never
  with message text**. Preserve the outbox dispatch-authorization boundary: retry a definitive
  retryable rejection only under the bounded policy, and quarantine a possibly accepted result
  rather than automatically sending it again.

## Deploy (only when asked)

**Google Cloud Run** (two services from one image) against Neon Postgres. Never deploy unless
explicitly asked (CLAUDE.md "Do not"). *Vercel was the deployment target until 2026-07-29; the
migration is in progress — see "Current State" in CLAUDE.md for exactly how far it got.*

The shape, and why:

- **One image, two services, one digest.** `farm-friend-web` (public ingress) and
  `farm-friend-worker` (internal ingress + IAM) run the *same* artifact, distinguished only by
  `DEPLOYMENT_ROLE`. Both are pinned to the same digest, so the two can never drift apart — a tag
  could be repointed between applies and put different code in front of one database.
- **Terraform owns infrastructure; it never owns secret values or the image.** Values go in out of
  band (`gcloud secrets versions add`) because anything passed through Terraform lands in state,
  and state gets copied to buckets and pulled to laptops.

```bash
# 1. Build and publish. This is also the isolated install that catches packaging defects
#    (B-005..B-008's whole class) — npm workspaces hoists locally, so nothing else does.
gcloud builds submit --config cloudbuild.yaml --project farm-friend-vashon \
  --substitutions=SHORT_SHA=$(git rev-parse --short HEAD)

# 2. Take the digest it prints — a full sha256, never a tag. Terraform's variable validation
#    refuses anything else.
DIGEST=$(gcloud artifacts docker images describe \
  "us-west1-docker.pkg.dev/farm-friend-vashon/farm-friend/farm-friend:$(git rev-parse --short HEAD)" \
  --format='value(image_summary.digest)' --project farm-friend-vashon)

# 3. Plan, and ASSERT the plan before applying. `validate` only proves the config parses; these
#    assertions prove the worker is internal-only, nothing is held warm, no credential
#    reached state, and both services carry the rotation marker. Each one is sabotage-verified.
cd infra
tofu plan -var="image_digest=$DIGEST" -out=/tmp/tf.plan
tofu show -json /tmp/tf.plan | python3 plan-assertions.py

# 4. Apply (provisions; needs approval).
tofu apply /tmp/tf.plan

# 5. ASSERT BY EFFECT that every serving container is newer than every secret it consumes.
#    Reads only metadata (revision and version creation times) — never a secret value.
#    Step 4 passing does NOT imply this: an apply that leaves the revision template
#    unchanged creates no revision, and that is exactly how B-021 happened.
python3 deploy_assertions.py
```

**Delete the plan file when you are done** (`rm /tmp/tf.plan`). A plan is not as sensitive as
state, but it describes the whole deployment and there is no reason to leave it in `/tmp`.

Migrations are still `npm run db:migrate` with `DATABASE_URL` pointed at the target, run
**before** promoting a build so production never runs code ahead of its schema.

### Proving post-response work actually runs (the B-009 class)

`scripts/prove-post-response-work.ts` proves, **by effect on the database**, that a message which
has been acknowledged is actually processed — the property that belongs to the platform rather than
the code, and therefore the one no vitest suite can establish. It was run at the 2026-07-29 cutover
and all three checks passed. Re-run it after **any change to the runtime, the queue, or the
scheduler** — not after ordinary application changes.

It needs a signed request, and Telnyx's private key is not ours, so running it means temporarily
pointing `telnyx_public_key` (plain config in `infra/terraform.tfvars`, never a secret) at a
throwaway keypair and applying, then restoring. **While that revision is live the number rejects
genuine inbound SMS**, so do it in a quiet window and restore immediately.

```bash
PROOF_BASE_URL=https://farm-friend-web-p5mfxfp5za-uw.a.run.app \
PROOF_PRIVATE_KEY='<base64 pkcs8 ed25519 private key>' \
DATABASE_URL='<production Neon URL>' \
PHONE_HASH_SALT='<the deployed salt>' \
npx tsx scripts/prove-post-response-work.ts
```

Two things that make it trustworthy, both of which cost a real defect to learn:

- **Sabotage it first.** Run it against the deployment still carrying Telnyx's real key: checks 1
  and 2 must FAIL with `ack=401`. A proof that cannot fail proves nothing, and this one is easy to
  make vacuous.
- **`PHONE_HASH_SALT` must be the DEPLOYED salt.** Check 3 inserts an inbox row directly, and the
  scheduled pass only acts on a hash the deployment would itself have produced. A test salt yields a
  row nothing ever claims — indistinguishable from the failure the check exists to detect.

Verify the restore **behaviourally**, never by reading the value back: the throwaway key must return
`signature_mismatch`, and the webhook must answer **401** rather than 500/503.

The script cleans up nothing by itself. Remove its rows afterwards under a guard that refuses if any
contact outside the reserved `+1206555` fictional range exists, and re-check the fingerprint.

> **⛔ Before a GO-LIVE deploy: rotate credentials first (F-034 / GL-001).** Credentials were
> exposed in 2026-07-27 validation transcripts and rotation was deliberately deferred to go-live so
> it happens once. The full scope, order, and behavioural proofs are §"Credential rotation" below.
> This does **not** apply to ordinary validation deploys against the throwaway project.

## Credential rotation

The go-live procedure for F-034 / GL-001. Rotation is **not** an isolated maintenance task: the
credentials in play belong to the **throwaway Hobby validation project**, so rotating them in place
is only worth doing if that project survives. Settle the teardown question first (§"Which project
are you rotating into?"), because a fresh project issues fresh credentials for free and makes most
of this section moot.

### The rules that constrain every step

- **`PHONE_HASH_SALT` MUST NOT be rotated — ever.** It is the input to the only lookup key for every
  phone in the system. Rotating it orphans every existing hash: consent records, contacts, flags,
  and stock-out reports all stop resolving to their people, and the raw numbers are deliberately not
  stored in a recoverable relationship to the old hashes. If it is ever believed compromised the
  answer is a **designed re-hash migration under a new salt**, not a rotation. Record it; never
  rotate it.
> **This rule was violated and it cost a session (2026-07-29).** `PHONE_HASH_SALT` was set in Vercel
> marked "Sensitive" — write-only, unreadable by anyone — and recorded nowhere else. The value was
> lost. It was recoverable only because `contacts.phone_e164` still held the raw numbers, which is
> what `npm run db:rehash-phones` uses; that window closes as soon as contacts are purged. **Storing
> a secret somewhere unreadable is the same as not recording it.** The same trap then applied to all
> four Telnyx values, which is why they had to be re-fetched from the Telnyx console.
>
> Note the legacy `TELNYX_API_KEY` secret in `farm-friend-vashon` is **stale** — tested against the
> live Telnyx API on 2026-07-29 and it returns **401**. The GCP migration plan's claim that the
> legacy secrets hold the current credentials is **wrong**; do not copy from them.

- **Record every new value in a password manager at the moment it is set.** Vercel values are
  write-only — the UI does not reveal them and `vercel env pull` returns `[SENSITIVE]`. An
  unrecorded secret is unrecoverable.
- **Never display a secret.** Do not echo one, do not paste one into a transcript, a commit, an
  issue, or documentation. Set values through interactive prompts or piped stdin, not as literal
  command arguments (a literal lands in shell history).
- **Verify behaviourally, never from a dashboard.** `vercel env ls`'s timestamp column is *not* a
  last-updated field, and trusting it produced a confidently wrong conclusion mid-diagnosis on
  2026-07-27. Every credential below has a proof-by-effect.
- **Env changes do not take effect until a redeploy.** Rotating a Vercel variable and then testing
  the running deployment tests the *old* value. Redeploy, then verify.

### Which project are you rotating into? — settled

**Rotate in place** (max, 2026-07-28). The Neon database that began as the throwaway Hobby
validation deployment's **is** production, so every secret below gets a genuine reset rather than
dying with a discarded project.

**The Vercel side of this is now moot (2026-07-29).** The Vercel project and its environment
variables are deleted, so there is no second place holding any of these values and nothing to keep
in sync; both stale branches are deleted too. Rotation is now entirely a Secret Manager operation:
`gcloud secrets versions add <name> --data-file=-`, then redeploy so the revision picks up the new
version. What remains in scope is **`DATABASE_URL`** and **`DEEPINFRA_API_KEY`**.

**Superseded by the GCP migration (2026-07-29).** The plan question that sat here — Hobby rejecting
the one-minute cron — is gone with Vercel: Cloud Scheduler runs a real minute schedule and neither
`vercel.json` nor the GitHub workflow exists any more. Secrets now live in **GCP Secret Manager**
(`farm-friend-*`), which unlike Vercel lets a value be **read back**, so the write-only trap below
does not apply there.

### Scope — what is actually exposed, and where it lives

Verified against the live environment on 2026-07-28 rather than from the earlier notes, which
overstated the scope in one place and understated it in another.

**ROTATION WAS PERFORMED 2026-07-29 (F-034 / GL-001 closed).** The table below is the current
state, not a to-do list. Every "Vercel env" in the earlier revision is obsolete — that project is
deleted, so Secret Manager plus local `.env` is now the whole surface.

| Credential | Where it is consumed | Rotate where | State |
|---|---|---|---|
| `DATABASE_URL` | Secret Manager `farm-friend-database-url`; local `.env` for migrate/seed/evals | Neon console (reset the `neondb_owner` password), then both places | **ROTATED 2026-07-29.** Old password confirmed dead by effect (`password authentication failed`). Production host is the **direct**, non-pooled one |
| `DEEPINFRA_API_KEY` | Secret Manager `farm-friend-deepinfra-api-key` **and** local `.env` | DeepInfra console, then **both** places | **ROTATED 2026-07-29.** Old key confirmed dead by effect (401). See the two-places note below |
| `MAGIC_LINK_SECRET` | Secret Manager `farm-friend-magic-link-secret` | generate a new random value | **ROTATED 2026-07-29** (`openssl rand -base64 48`). Invalidates every outstanding sign-in link and session — harmless pre-launch |
| `TELNYX_API_KEY` | Secret Manager `farm-friend-telnyx-api-key` | Telnyx console | Already re-fetched from the console during the migration; the stale legacy copies were deleted in the teardown |
| `CRON_SECRET` | **GONE** — no longer exists | nothing to rotate | Replaced by Cloud Scheduler OIDC + IAM; it was one credential in two places that had to match, where a mismatch 401s and a 401 looks like success in any scheduler UI |
| `PHONE_HASH_SALT` | Secret Manager `farm-friend-phone-hash-salt` | **NEVER** | Untouched, deliberately. It is the input to the only lookup key for every phone; rotating it orphans every hash with no way back |

**Secret Manager uses `version = "latest"`, but a running container does NOT pick that up.** Cloud
Run reads secrets **at container start**, so `version = "latest"` binds at startup and a running
container never re-reads it. `gcloud secrets versions add` alone changes nothing already serving.

**⛔ A green `tofu apply` is NOT a restart — this broke production on 2026-07-29 (B-021).** An apply
that does not alter the revision template creates **no new revision**, so the containers keep the
old secret. It happened exactly this way: secret version 2 landed at 16:35:29 while the newest
revision dated from 16:09:26, and every database call failed `28P01 password authentication failed`
against a Neon password that had already been reset. The apply reported "2 to change" and looked
entirely successful.

**The check that actually settles it — compare timestamps, not endpoints:**

```bash
gcloud run revisions describe <svc>-<rev> --region us-west1 --project farm-friend-vashon \
  --format='value(metadata.creationTimestamp)'
gcloud secrets versions describe <n> --secret=<secret> --project farm-friend-vashon \
  --format='value(createTime)'
```

**If the revision is OLDER than the secret version, nothing has picked the value up** — whatever any
endpoint returns. Force a new revision with
`gcloud run services update <svc> --region us-west1 --update-env-vars=ROTATION_APPLIED_AT=<stamp>`.

**Verify by effect against a container you know started AFTERWARDS, on a path that opens a NEW
connection.** Three checks that looked like proof on 2026-07-29 and were not:

- `/api/public/stands` → `{"stands":[]}` came from a **warm container** whose pooled connections
  predated the reset. A warm connection keeps working after the password behind it changes; only a
  new connection re-authenticates. An empty array is also indistinguishable from an empty table.
- A scheduler **200** that was read from *before* the rotation apply and carried forward as current.
- `npm run evals:live` passing 6/6 — it runs **locally against local `.env`** and never touches the
  deployment.

The honest check is a **forced scheduled run whose effect appears in the database**, on a revision
newer than the secret. For the model key, `evals:live` does prove the key itself — but note a
*containment* pass alone is not evidence, because a refused call counts as contained: that run went
`live-quality: 0/6` with `provider_error` before the key was right, then 6/6 after.

**A quiet no-op nearly shipped a revoked key.** The first `.env` edit used a regex requiring
`KEY="value"`, but `DEEPINFRA_API_KEY` is written **unquoted** in that file, so the substitution
matched nothing, reported success, and left the old key in place — caught only because the live
evals then failed against the real provider. Any scripted edit to `.env` must assert its match count
(`if n != 1: refuse`) rather than trusting that a replacement happened.

**`DEEPINFRA_API_KEY` is consumed in two places, and an earlier revision of this table said one.**
It was once local-only, because the deployment had no `LLM_PROVIDER` at all and silently ran the
deterministic stub. That is no longer true: production selects a live provider, so the key now
authorizes **spend on real traffic** as well as the local `.env` used by `npm run evals:live` and
`npm run offerings:propose`. Rotate it in the DeepInfra console and then update **both** the Vercel
environment and local `.env` — updating one leaves the other authenticating with a dead key.
**Confirm which places actually carry it before rotating**, rather than trusting this table: read the
value back from Vercel where the variable is not marked Sensitive, and otherwise verify by effect.

`TELNYX_MESSAGING_PROFILE_ID`, `TELNYX_FROM_NUMBER`, `TELNYX_PUBLIC_KEY`, `PUBLIC_BASE_URL`, and
`SMS_PROVIDER` are **identifiers and public keys, not secrets**. They need no rotation. The ed25519
public key is verification material; disclosing it grants nothing.

**The repository itself is clean.** `git grep` over the tracked tree finds no real connection
string, API key, or Neon host — every secret-shaped literal is a test fixture
(`postgres://user:pass@localhost`). `.env` is gitignored and has never been committed. Exposure was
confined to working transcripts, so **no history rewrite is required**.

### Order

This is the order actually used on 2026-07-29; repeat it if a future rotation is needed.

1. **Get the new values first, and verify each one BEFORE storing it.** A new Neon password and a
   new DeepInfra key both require a browser; neither can be reset with an API key we hold. Connect
   with the new database URL and fingerprint it (`neondb`, expected migration count) and call the
   **production model** with the new key. Storing an unverified value means diagnosing a broken
   deployment instead of a bad credential.
2. **`DATABASE_URL`** — reset in Neon, then `gcloud secrets versions add farm-friend-database-url`,
   then local `.env`. Do this before the others so later verification runs against the intended
   database.
3. **`MAGIC_LINK_SECRET`** — `openssl rand -base64 48` into
   `gcloud secrets versions add farm-friend-magic-link-secret`.
4. **`DEEPINFRA_API_KEY`** — rotate in the DeepInfra console, then **both** Secret Manager and local
   `.env`. Updating one leaves the other authenticating with a dead key.
5. **Bump `rotation_applied_at` in `infra/terraform.tfvars`** — `date -u +%Y-%m-%dT%H-%M`. Do this
   in the *same* change as the version add. This is the step whose absence caused **B-021**:
   Cloud Run resolves `version = "latest"` at container start, so an apply that leaves the revision
   template byte-identical creates **no new revision**, and every running container keeps the value
   it read at boot. The apply still reports changes and still succeeds — on 2026-07-29 it said
   "2 to change" and applied cleanly while both services kept the pre-rotation `DATABASE_URL`
   against an already-reset Neon password. Changing this value changes the template, which forces
   the revision, which re-reads every secret.
6. **Redeploy** — `tofu plan` / assertions / `apply`. Without this the running containers still hold
   the old values, and after a Neon reset that means production is serving on a **revoked**
   password. Keep the gap short.
7. **Run `python3 infra/deploy_assertions.py`** — it fails unless every serving revision is newer
   than every secret version it consumes. This is the check that would have caught B-021 in seconds:
   the stale revision was created 16:09:26 and the secret version 16:35:29, 26 minutes later.
   **A green apply is not a restart.** Compare the revision's creation time against the secret
   version's and treat an older revision as "not applied", whatever any endpoint returns.
8. **Verify by effect**, then confirm the old values no longer authenticate (both below).

### Proof by effect — required before GL-001 is marked complete

Run after the redeploy. Each proves the *new* value works; the second table proves the *old* one
does not.

**Before reading any row below, run `python3 infra/deploy_assertions.py`.** If a serving revision
predates a secret version, every proof in this table is meaningless — the container under test is
still running the old credential, and several of these checks will happily pass anyway.

| Credential | Proof it works |
|---|---|
| `DATABASE_URL` | a **cold** container serves a request that opens a NEW connection. `GET /api/public/stands` alone is **not** proof — see the trap below |
| `TELNYX_API_KEY` | a real send returns a provider message ID; or a signed inbound webhook returns **401→200** path end to end |
| `MAGIC_LINK_SECRET` | a freshly minted link signs in |
| `DEEPINFRA_API_KEY` | `npm run evals:live` completes (costs a few cents — needs explicit approval). Note it runs **locally** against `.env` and proves nothing about the deployment |
| every Telnyx var | an unsigned POST to `/api/sms/webhook` returns **401**, not 500 — under the three-way diagnostic, 401 proves configuration still resolves |

| Old value | Proof it is dead |
|---|---|
| old `DATABASE_URL` | a connection attempt with it is refused (`password authentication failed`) |
| old `TELNYX_API_KEY` | a request to the Telnyx API with it returns **401** |
| old `MAGIC_LINK_SECRET` | a link minted under the old secret is refused at the callback |
| old `DEEPINFRA_API_KEY` | a request with it returns **401** |

`CRON_SECRET` is deliberately absent from both tables: it no longer exists. Cloud Scheduler
authenticates with OIDC against IAM, so there is no shared credential to rotate.

#### Three checks that looked like proof and were not (B-021)

All three were run on 2026-07-29, all three passed, and production was broken the whole time.

- **`GET /api/public/stands` returning `{"stands":[]}`.** Served by a **warm** container whose
  pooled connections predated the Neon reset. *A warm connection survives a password change* —
  only a NEW connection re-authenticates. An empty array is also indistinguishable from a
  genuinely empty table, which production's is.
- **A scheduler run returning 200.** That reading was taken *before* the rotation apply and
  carried forward as if current. Re-read it after, or it is not evidence.
- **`npm run evals:live` passing 6/6.** It runs **locally**, against local `.env`, and never
  touches the deployment.

The general rule: **verify against a container you know started after the rotation, on a path that
opens a new connection.** `deploy_assertions.py` is that check, mechanised.

If a path was "provision fresh, then tear down", the old-value proofs are satisfied by the teardown
itself — but **verify the teardown actually happened**, and record which proof each row rests on.

### The production deploy sequence

**Order matters.** A migration adding columns the new code writes must land *before* that code
deploys, or every affected write fails in the gap. 0004 (B-010) was exactly this case.

```bash
# 1. Migration FIRST. Use the DIRECT (non-pooled) Neon string for DDL.
DATABASE_URL='<production Neon URL>' npm run db:migrate

# 2. Build, plan, assert, apply — the four steps in §Deploy above. Never a tag, always a digest.
```

**Cloud Scheduler (`farm-friend-recovery`, every minute) is the scheduled trigger**, and Cloud
Tasks is the per-message fast path. Neither `vercel.json`'s `crons` block nor the GitHub
`scheduled-worker.yml` workflow exists any more — both were deleted in the migration, and
reintroducing either is the defect `cron-schedule.test.ts` guards against. `CRON_SECRET` is gone
too: the worker is reached by OIDC against internal ingress with IAM `run.invoker`.

Fire a scheduled run rather than waiting:
`gcloud scheduler jobs run farm-friend-recovery --location=us-west1 --project farm-friend-vashon`

**Then verify by effect — a 200 from the scheduler is not proof the passes did anything.** Only
F-026's purge, which runs on this trigger alone, proves that:

```sql
-- Make one body eligible. Excludes threads under open flag review, so the exemption is not
-- what is being tested. Note the id it returns.
update sms_messages set body_expires_at = now() - interval '1 hour'
where id = (
  select m.id from sms_messages m
  where m.body is not null
    and not exists (
      select 1 from provider_inbox_events e join flags f on f.inbox_event_id = e.id
      where e.message_id = m.id and f.status = 'open'
    )
  limit 1
) returning id;

-- After a run: body AND body_expires_at must both be NULL (they clear as a pair), and the
-- ROW must still exist — the minimized projection survives, only the content goes.
-- select id, body is null, body_expires_at is null from sms_messages where id = '<id>';
```

Confirmed working 2026-07-27: exactly 1 of 21 bodies cleared, all 21 rows intact. Check the blast
radius too — a purge that over-reached would be worse than one that never ran.

**Migrations are a separate operator step, not part of the build** (B-006 — this section claimed
otherwise while no such step existed):

```
DATABASE_URL=… npm run db:migrate
```

Idempotent, so re-running is the normal way to check state. It prints the target's host and database
name but **never** the connection string's password.

**Migrate against an empty database, and check first.** `0000_clean_launch.sql` uses
`CREATE TABLE IF NOT EXISTS`, so a table that already exists under a *different* schema is silently
skipped — and a later `ALTER TABLE … ADD CONSTRAINT` then fails on a column that was never created.
The result is a half-applied schema where **every retry fails identically**, and the error names a
missing column rather than the real cause. This happened on the first deploy (2026-07-27) against a
database still holding the older Farm Friend's tables. Inspect
`information_schema.tables` before migrating into anything you did not create empty.

On **Neon**, use the **direct** connection string (the hostname *without* `-pooler`) for migrations;
the pooled one is for the running app. This was not the cause of the failure above, but it is Neon's
documented guidance for DDL. It is deliberately **not** wired into the Vercel
build: a build hook would migrate on every preview deploy and every rollback, pointing whatever
`DATABASE_URL` that environment carries at a schema change — including production, from a branch
build.

**First run 2026-07-27**, as a throwaway Hobby-tier validation (https://farm-friend-web.vercel.app),
not the F-029 go-live. Steps 1–5 are now **proven**; steps 6–10 (Telnyx) remain unrun.

Two things that cost real time and are not obvious:

- **Deploy with `npx vercel --prod` from a local checkout.** The Git integration built the same
  pre-fix commit three times regardless of what was pushed. The CLI uploads what is on disk.
- **A monorepo deploy installs `apps/web` alone**, so anything the build needs must be declared
  there — not merely at the workspace root. Five defects of exactly this shape shipped undetected
  because npm hoisting hides them locally (B-005/B-006/B-007);
  `packages/core/src/workspace-manifests.test.ts` is what now catches them.

The order is the safety property: **do not point the carrier at the app before the app can honor
`STOP`.**

1. **Confirm the 10DLC campaign is _approved_**, not merely submitted. Carrier approval is queue
   time outside our control.
2. **Provision Neon Postgres**, then `DATABASE_URL=… npm run db:migrate` against it from empty.
3. **Create the Vercel project** with **root directory `apps/web`** (this is a workspace monorepo;
   `apps/web/vercel.json` carries the cron schedule). Set every variable below — configuration
   **fails closed**, so a missing one is a startup error rather than a degraded mode:

   | Variable | Notes |
   |---|---|
   | `DATABASE_URL` | the Neon connection string |
   | `PHONE_HASH_SALT` | a real generated secret — **never** the `.env.example` placeholder |
   | `CRON_SECRET` | a real generated secret; Vercel Cron sends it as the bearer token |
   | `MAGIC_LINK_SECRET` | a real generated secret (F-025a) |
   | `PUBLIC_BASE_URL` | the deployment's `https://` origin (F-032) |
   | `SMS_PROVIDER` | `telnyx` |
   | `LLM_PROVIDER` | **required, no default (GL-019)** — `deepinfra` for a real deployment. Omitting it is now a startup error, not a silent fall back to the stub |
   | `DEEPINFRA_API_KEY` · `DEEPINFRA_MODEL` | required when `LLM_PROVIDER=deepinfra`. An `anthropic/` or `google/` model is refused — those route to a vendor whose terms were never attested |
   | `TELNYX_API_KEY` · `TELNYX_MESSAGING_PROFILE_ID` · `TELNYX_FROM_NUMBER` | delivery credentials |
   | `TELNYX_PUBLIC_KEY` | the **ed25519 webhook verification key**; without it inbound webhooks cannot be verified at all |

   > **GL-019 changed the failure mode here.** Until 2026-07-28 `LLM_PROVIDER` defaulted to `stub`,
   > and production had never set it — so the live deployment ran the deterministic test double
   > against real traffic while every health check, the webhook, and every suite stayed green. There
   > is now no default and no environment sniffing: the variable is required exactly like
   > `PHONE_HASH_SALT`. **A deployment that omits it will fail to start**, which is the point. Local
   > development and tests keep the stub by stating `LLM_PROVIDER=stub`.

4. **Verify configuration fails closed** in the deployed environment. Env vars do not take effect
   until a **redeploy**. POST an unsigned request to the live webhook and read the status — the
   diagnostic is **three-way**, because `route.ts` calls `appContext()` *before* the provider check
   and `resolveConfig` **throws** on a missing Telnyx var:

   | Status | Meaning |
   |---|---|
   | **401** `missing_signature` | config resolved — proceed |
   | **503** `webhook_not_configured` | `SMS_PROVIDER` is not `telnyx` (execution reached the provider check, so the other vars resolved) |
   | **500** | `SMS_PROVIDER=telnyx` but a Telnyx credential is **missing or blank** |

   A missing credential is **500, never 503** — an earlier version of this section said otherwise and
   sent a real debugging session after the wrong var. `vercel env pull` cannot verify values;
   encrypted vars return `[SENSITIVE]`. `vercel env ls` timestamps are a useful tell for which vars
   were actually edited.

   **On Hobby, `npx vercel --prod` refuses to deploy at all** — `vercel.json`'s one-minute cron
   exceeds the plan's daily cap. Strip the `crons` block from the working tree **uncommitted**,
   deploy (the CLI uploads from disk), and restore it immediately; `cron-schedule.test.ts` failing is
   the tripwire for a forgotten restore. Do **not** deploy `throwaway/hobby-deploy-test` — it carries
   no source difference, only doc drift, and is never-merge.
5. **Run the administrator bootstrap once** against the production database (§"Bootstrap the first
   administrator"). Note that **no sign-in link is delivered until F-031**, so mint one out of band
   with `issueMagicToken`.
6. **Point the Telnyx messaging profile's webhook** at `https://<deployment>/api/sms/webhook`, and
   confirm +1 206-864-5326 is attached to that profile.

   Leave the profile's three **auto-response message fields empty** (Keywords tab). Farm Friend sends
   the registered copy itself; text here would double-reply. The STOP/START/HELP keyword *labels* are
   fixed and non-editable — that is expected.

   **Attaching the number to the profile is not the same as provisioning it on the approved
   campaign — check both.** Messaging → Campaigns → your campaign → the number's **Provisioning
   Status** must read **Active**, not **Pending**.

   This cost a whole session on 2026-07-27. The campaign was approved and the number showed Active
   *on the profile*, but it had never been provisioned *on the campaign*. Real `STOP` and `HELP`
   produced no reply, no webhook delivery, and **no Telnyx message record at all** — an unprovisioned
   number has no carrier route for inbound 10DLC traffic, so the messages died upstream of Telnyx
   entirely. Nothing in the profile view hints at this. `HELP` failing identically to `STOP` is what
   ruled out carrier keyword absorption and pointed upstream.

   Provisioning is carrier-side and clears on its own, typically minutes to hours.
7. **Verify signature rejection first:** an unsigned or wrongly signed POST to the live webhook must
   return 401 *before* any real message is sent.
8. **Send a real `STOP` before a real `JOIN`.** `STOP` is the compliance-critical path and the one a
   carrier audits. Verify the durable consent state changed, then `JOIN`, then `HELP`.
9. **Confirm the scheduled pass is actually firing** in the deployment (Vercel's cron log, plus its
   effects — an expired body cleared by F-026's purge). The B-004 kick masks a dead cron by keeping
   replies fast, so "replies work" is *not* evidence the schedule runs.
10. Record the verified result and the console state here.

## Failure triage

- **Unit test needs a DB/SMS/model** → a seam isn't injected; pure logic must take the provider and
  `Clock` as arguments.
- **`tsc` fails on a model call or send** → you're bypassing the task-specific constructor or
  redactor; go through it (that's the static provenance barrier working).
- **Integration tests "pass" instantly** → `DATABASE_URL` is unset and they skipped. That is not a
  green data layer.
- **A hostile workflow test/eval exposes unavailable private data or forces a commit** → runtime
  projection, validation, or deterministic consequence handling has a bug; fix the code, not the
  prompt (Golden Rule #6). The failing eval detected the bug; it was not the production guard.
- **An SMS is not arriving** → read the failed attempt, do not reproduce the call by hand:

  ```sql
  select state, error_code, provider_code, provider_error_detail, started_at
  from outbox_dispatch_attempts
  where state in ('definitive_rejection', 'ambiguous')
  order by started_at desc limit 20;
  ```

  `error_code` is the HTTP status and names only a category. **`provider_code` and
  `provider_error_detail` are the ones that identify the cause** (B-010) — before they existed, two
  separate 2026-07-27 investigations each burned hours recovering by curl a sentence the provider
  had already sent us. Known values:

  | provider_code | Meaning | Action |
  |---|---|---|
  | `40001`-class, "source phone number … deemed invalid" | `TELNYX_FROM_NUMBER` is not exact E.164 | Fix the env var; a leading `+` is required |
  | `40300`, "Blocked due to STOP message" | Telnyx's carrier block rule is active for that recipient | See B-011 — `START` lifts it, `JOIN` does **not** |

  `provider_error_detail` is phone-masked (`[redacted]`) and capped at 500 chars, so it is safe to
  read and paste. Both columns are best-effort: a provider returning an unparseable body records the
  status alone rather than failing the write.

- **The provider accepted it but the farmer says it never arrived** → the dispatch attempt is the
  wrong place to look; read the *carrier's* verdict, which the delivery pass records (B-012):

  ```sql
  select delivery_status, delivery_occurred_at, dispatch_authorized_at, message_category
  from outbox_work
  where delivery_status is distinct from 'delivered'
    and dispatch_authorized_at is not null
  order by dispatch_authorized_at desc limit 20;
  ```

  `delivery_status` NULL with an authorized dispatch means **no callback has been applied yet** —
  either the carrier has not reported, or the delivery pass is not running (check that a scheduled
  run returns 200; a 401 looks identical to success in any scheduler's UI). `delivery_failed` is the
  carrier rejecting it after Telnyx accepted it, which is the B-011 block shape. Watch for
  `provider_inbox_events` rows of type `message_sent`/`message_finalized` sitting `pending`: that is
  B-012's exact signature and means nothing is consuming them.
