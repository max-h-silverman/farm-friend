# Farm Friend — Runbook (operate & extend)

Cold-start and extension guide: install, run, migrate, seed, evaluate, rotate, and deploy.
Build/deployment status lives only in [CURRENT_STATE.md](CURRENT_STATE.md).

## Prerequisites

- **Node:** version in `.nvmrc` (`nvm use`).
- **Postgres:** local or disposable CI instance. `DATABASE_URL` must let the test role create and
  drop a throwaway database; the integration suite fails when it is absent.
- **This Mac:** Homebrew `postgresql@16` is installed but not on `PATH`:

  ```bash
  export PATH=/opt/homebrew/opt/postgresql@16/bin:$PATH
  export DATABASE_URL="postgres://$(whoami)@localhost:5432/postgres"
  npm run test:integration 2>&1 | tee /tmp/itest.log
  ```

  Confirm with `brew services list | grep postgres` or the full-path `pg_isready`.
- Unit tests and stub evals require no network.

## Local dev — required commands

```bash
npm install                 # install all workspaces
npm run typecheck           # all workspaces, including apps/web
npm run lint                # lint across workspaces
npm test                    # unit tests; no DB/SMS/LLM
npm run test:integration    # real Postgres constraints and workflows
npm run evals               # deterministic stub; critical fixtures must be 100%
```

Typecheck enforces the static model-context and outbound-message provenance barrier; workflow tests
and hostile evals cover runtime behavior. See [AI_ARCHITECTURE.md](AI_ARCHITECTURE.md) §safety
boundary.

### What "across workspaces" means, and the three layers (GL-005)

`npm run typecheck` fails if either half fails:

| Script | Covers | How |
| --- | --- | --- |
| `typecheck:packages` | `packages/core`, `db`, `sms`, `ai` | `tsc -b` over the root `tsconfig.json` project references |
| `typecheck:web` | `apps/web` | `tsc -p tsconfig.json --noEmit` in the web workspace |

The web config is not a composite project, so its own script is the second half.
`packages/core/src/typecheck-coverage.test.ts` prevents coverage drift. Also run the production
build because the two checks cover different risks:

- `npm run typecheck` covers **test files**, which `next build` never compiles.
- `npm run build --workspace @farm-friend/web` covers **route and manifest conventions** and the
  real bundle graph, which `tsc -p` does not model.

A green typecheck is not a green build, or vice versa.

## Environment

Copy `.env.example` to the gitignored `.env`. Configuration is validated in
`apps/web/lib/composition.ts` and fails closed:

| Variable | Contract |
|---|---|
| `DATABASE_URL` | Postgres/Neon connection |
| `PHONE_HASH_SALT` | Required lookup-key input; **never rotate** |
| `DEPLOYMENT_ROLE` | `web` (default) or `worker`; invalid values fail startup. The web role refuses `/api/internal/*` |
| `CLOUD_TASKS_*` | Five variables, all or none. Omit all for local scheduled-pass-only operation |
| `MAGIC_LINK_SECRET` | Required; no default |
| `PUBLIC_BASE_URL` | Required absolute origin. HTTPS except localhost; never derived from request headers |
| `SMS_PROVIDER` | Required `simulator` or `telnyx`; no default |
| `TELNYX_API_KEY`, `TELNYX_MESSAGING_PROFILE_ID`, `TELNYX_FROM_NUMBER`, `TELNYX_PUBLIC_KEY` | All required with Telnyx; the public key verifies webhook signatures |
| `LLM_PROVIDER` | Required `stub` or `deepinfra`; no default or environment exception |
| `DEEPINFRA_API_KEY`, `DEEPINFRA_MODEL` | Required with DeepInfra; `anthropic/` and `google/` models are refused because their terms are not attested |

Mail remains deliberately unconfigured (F-031): requesting a link returns the enumeration-safe 202
but the mail seam throws internally and sends nothing. There is no `CRON_SECRET`; Cloud Scheduler
uses OIDC and IAM.

## Migrations

`npm run test:integration` creates a unique empty database through `DATABASE_URL`, applies every
file in `packages/db/drizzle/` twice (the second run must be a no-op), exercises the constraints,
then drops only that database. Inspect and fingerprint any manual migration target first.

### Writing a new migration — the snapshot must land with it

Every migration needs the executable `.sql` and matching schema snapshot in
`packages/db/drizzle/meta/`. Generation diffs against the newest snapshot, not the migration
journal; a stale snapshot produces unsafe create/rename questions such as:

```
Is message_category column in outbox_work table created or renamed from another column?
```

A wrong answer can recreate existing tables or rename production data. Commit both artifacts;
`migration-metadata.test.ts` enforces the pair. Never edit an applied `.sql`.

## Bootstrap the first administrator

Run once per environment, against a database you intend to change:

```bash
DATABASE_URL=… npx tsx packages/db/scripts/bootstrap-administrator.ts you@example.org
```

The command is idempotent. It creates the first durable, auditable authority row; afterwards,
administrators are managed in the database. The row—not possession of a signed link—confers
authority. See [ADMIN_OPERATIONS.md](ADMIN_OPERATIONS.md) §administrator authority.

### Bootstrap, then sign in

1. Run the bootstrap script above once per environment, against that environment's database.
2. The operator opens `/admin/login` and enters that address.
3. `POST /api/auth/request-link` mints a 15-minute, one-use link and hands it to the mail seam.
4. Opening the link hits `/api/auth/callback`, which re-checks the administrator row, mints the
   durable session, and **consumes the link**.

Mail delivery is not configured (F-031); mint with `issueMagicToken` and deliver out of band.

Properties to preserve:

- The session insert atomically records the link nonce; simultaneous/replayed use gets the same 401
  as a forged link. Revocation is checked first, so a refused link is not consumed.
- Minting writes nothing. The public request response is byte-identical for valid, unknown,
  malformed, and mail-failure cases.
- The token appears only in the rendered mail and mailbox—never a response or log.
- Rate limiting uses a separate per-client budget from the stock-out form, never a per-email budget.

## Seeding initial listing data

This is a **greenfield build**: existing VIGA map content is **reference input, not a schema
contract**, and there is no non-destructive migration requirement or provenance axis.

A **one-time seed utility** validates and loads farms, sales locations, and approval state.
**It does not seed inventory** (decided 2026-07-26, B-002): a seeded listing fact would fabricate a
confirmation no farmer made, and the honor-system product's core promise is showing *when* inventory
was last confirmed. Stands seed empty and render the honest "no current listing" until a farmer texts.
It also seeds **no phone numbers** — `farmer_authorizations` requires captured SMS consent, so phones
arrive through onboarding, never a bulk roster load.

**It takes BOTH exports**, because neither can seed a visitable location alone: the form has the
2026-current details and **no coordinates at all**, the map export has the coordinates and the farms
that submitted no form.

```bash
npm run db:seed -- --form "<form.csv>" --map "<map.csv>" --dry-run   # report only, writes nothing
npm run db:seed -- --form "<form.csv>" --map "<map.csv>"             # apply
```

The batch is transactional, idempotent by stand name, and skip-only: re-running never overwrites a
farmer's later correction. It refuses invalid coordinates rather than coercing them.

Corpus-specific operating facts:

- The form export owns current details; the map export owns coordinates and map-only farms. Their
  names join through the exact normalized key in `match-stands.ts`, never fuzzy similarity.
- The map CSV is malformed: records are anchored to `POINT (` by `stand-csv.ts`; do not substitute
  a standard CSV reader.
- The loader structures hours/season/specialties, drops dated inventory, strips direct phone/email,
  and retains public websites/social handles.
- It seeds neither inventory nor phone authorization. Inventory requires farmer confirmation;
  phones require captured consent.
- Unresolvable coordinates become operator refusals, never fabricated points. Geocoding is
  seed-time only; the running product has no geocoder.
- `offering_type` and visitability are independent and classification uses the farmer's words, not
  the farm name.

> **Manual guard—Handpicked Homestead (B-024):** keep it non-public and non-visitable. Its form says
> not to publish the home address, but the current seeder does not consult `extraNotes` for
> visibility; a re-seed can republish it. Check this row until that defect is fixed.

**Offerings — proposed by the model, committed only after review (F-024/F-036).** Two steps,
deliberately separated so no model output reaches the database without a human between:

```bash
DEEPINFRA_MODEL="<model-id>" npm run offerings:propose -- "<path-to-csv>" maps/offerings-proposals.json
# max reviews/edits the file, then:
npm run db:seed-offerings -- maps/offerings-proposals.json --dry-run
npm run db:seed-offerings -- maps/offerings-proposals.json
```

The proposal step strips contacts, passes the same provider privacy gate as production, and records
each tag beside its source text. The reviewed seed is idempotent on `(location, item)` and writes
specialties only—never inventory. Its database-backed dry run resolves the approved map-export name
through `matchStandName`, reports unknown/already-present tags, and refuses an ambiguous match.

`offerings:propose` reads only the map export; form-only farms are absent rather than reported as
rejected. Check the other export when a farm is missing.

## Start the web app

```
npm run dev -w apps/web     # Next.js App Router
```

## Scheduled work (the worker trigger)

Inbound work has two triggers over the same Postgres-backed passes:

| Trigger | Route | Role |
|---|---|---|
| Cloud Tasks | `POST /api/internal/kick` | Immediate inbound/outbound passes for one sender |
| Cloud Scheduler | `POST /api/internal/cron` | Every-minute recovery: inbound → scheduled prompts → outbound → delivery → retention |

The webhook commits first, then awaits one bounded Cloud Task creation before returning 200.
`enqueueSenderWork` never throws and does not retry; a queue outage loses only latency because the
scheduled pass recovers the committed event. Deterministic task names make duplicate enqueue a
success. Postgres row locks and claims make task retries and concurrent scheduled work safe.

The scheduled passes are bounded and enumerate their own work:

- **Inbound:** deterministic routing and state transitions.
- **Scheduled prompts:** creates at most one due prompt per sender in deterministic stand order,
  using the farmer's explicit per-stand cadence and 10:00 AM stand-local slot. It advances delayed
  schedules without catch-up bursts and queues no work while paused or actively closed.
- **Outbound:** dispatch claim, provider send, and result.
- **Delivery:** applies stored carrier callbacks; provider acceptance alone is not delivery.
- **Retention:** clears expired bodies, preserving rows, minimized projections, attempts, flags,
  and audit. Open flagged threads are exempt; unresolved outbound work is never cleared; output is
  counts only.

Cloud Run's internal-only worker ingress plus IAM `run.invoker` is the primary authorization.
`DEPLOYMENT_ROLE=worker` is a second guard checked before application context; the public service
returns 404 for internal routes. There is no shared `CRON_SECRET`.

Local worker-role invocation:

```bash
DEPLOYMENT_ROLE=worker npm run dev -w apps/web
curl -X POST http://localhost:3000/api/internal/cron
```

Verify the schedule by database effect, not its dashboard: expire an unflagged body, trigger or
wait for the schedule, and confirm the body and `body_expires_at` become `NULL` while the row
survives. For inventory prompts, make one preference due, trigger the same route, then verify the
preference's due-slot advance, the open proposal, typed scheduled subject, and queued outbox row.
Verify suppression by changing one dispatch basis before claim and observing both the outbox row and
proposal become terminal without a provider send. Add future scheduled work inside
`runScheduledWork`; never create a second cron surface.

## Telnyx webhook config

Point the Telnyx number's inbound webhook at `apps/web`'s webhook route
(`apps/web/app/api/sms/webhook/route.ts`). Requirements that must hold before live SMS:

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

Built public routes (F-019): `GET /api/public/stands` (model-free, uncapped),
`GET /api/public/contact-card` (F-039 — model-free and database-free, uncapped; a `text/vcard` card
rendered from `TELNYX_FROM_NUMBER`, never a literal, so it cannot drift from the sending number.
Saving a contact is **not** `JOIN` and the copy must not imply it is), and
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

### Add a surface behind a farmer's standing link (F-040)

A third auth shape, and it is neither of the two above: no session, no password, and a credential
that **does not expire**. The rules follow from that last fact.

1. **Resolve the token per request, through `resolveStandFromToken`.** Never cache the result into
   a cookie, a session, or the page. Revocation is the only safety net a standing link has, so
   anything that remembers the answer is a way around it.
2. **Take every identifier from the token's row, never from the request** — the sales location, the
   sender hash, all of it. The moment a caller can name what they are acting on, the blast radius
   stops being "one stand".
3. **Keep the projection minimal, and assert its exact shape.** `resolveFarmerLink` returns four
   fields; the test asserts `Object.keys(...)` equals exactly those. A projection that grows a farm
   list or a contact is how a leaked link becomes a way to read someone else's data.
4. **Publication goes through `confirmInventoryPublication`, always.** No surface function may write
   `inventory_revisions`, and no argument may skip the proposal step. This is Golden Rule #1 and #3
   and it is the whole reason the web path is safe to expose at all.
5. **Put the token in the request BODY, not the URL.** A path segment is unavoidable on the
   bookmarkable page itself; everywhere else it would land in proxy logs, analytics, and history.
6. **Test-first in `apps/web/lib/farmer-stand.integration.test.ts`**, one test per blast-radius
   bound, and **sabotage each one**. Six of these assertions were written wrong the first time and
   only sabotage found them — including one that was satisfiable by the exact attack it forbade.
   Where two independent defenses cover the same property, assert each **in isolation**, or one of
   them will eventually be deleted as dead code.

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
questions. A seam that a measured deterministic path would have covered does not earn its
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

**Google Cloud Run** (two services from one image) against Neon Postgres. Never deploy without
explicit approval.

The shape, and why:

- **One image, two services, one digest.** `farm-friend-web` (public ingress) and
  `farm-friend-worker` (internal ingress + IAM) run the *same* artifact, distinguished only by
  `DEPLOYMENT_ROLE`. Both are pinned to the same digest, so the two can never drift apart — a tag
  could be repointed between applies and put different code in front of one database.
- **Terraform owns infrastructure; it never owns secret values or the image.** Values go in out of
  band (`gcloud secrets versions add`) because anything passed through Terraform lands in state,
  and state gets copied to buckets and pulled to laptops.

```bash
# 1. Build and publish. SHORT_SHA is required; without it the image reference is invalid.
gcloud builds submit --config cloudbuild.yaml --project farm-friend-vashon \
  --substitutions=SHORT_SHA=$(git rev-parse --short HEAD)

# 2. Resolve the immutable digest; never deploy a tag.
DIGEST=$(gcloud artifacts docker images describe \
  "us-west1-docker.pkg.dev/farm-friend-vashon/farm-friend/farm-friend:$(git rev-parse --short HEAD)" \
  --format='value(image_summary.digest)' --project farm-friend-vashon)

# 3. Plan and assert the planned resources.
cd infra
tofu plan -var="image_digest=$DIGEST" -out=/tmp/tf.plan
tofu show -json /tmp/tf.plan | python3 plan-assertions.py

# 4. Apply only with approval.
tofu apply /tmp/tf.plan

# 5. Verify serving revisions are newer than every secret version they consume.
python3 deploy_assertions.py

# 6. Verify the served vCard's wire bytes, including CRLF delimiters.
python3 served_card_assertions.py
```

**Delete the plan file when you are done** (`rm /tmp/tf.plan`). A plan is not as sensitive as
state, but it describes the whole deployment and there is no reason to leave it in `/tmp`.

Run migrations **before** promoting code, using Neon's direct (non-pooled) URL:

```bash
DATABASE_URL='<direct production Neon URL>' npm run db:migrate
```

The command can exit 0 after silently skipping a migration whose journal timestamp is not newer.
Verify the intended schema effect, not the message:

```sql
select count(*) from drizzle.__drizzle_migrations;
select column_name, is_nullable from information_schema.columns
  where table_name = '<table>' and column_name in ('<new columns>');
select conname from pg_constraint where conname = '<new constraint>';
```

For a new environment, inspect `information_schema.tables` first. The initial migration's
`CREATE TABLE IF NOT EXISTS` can skip incompatible existing tables and leave a half-applied schema.

### Proving post-response work actually runs (the B-009 class)

After any runtime, queue, or scheduler change, `scripts/prove-post-response-work.ts` verifies by
database effect that acknowledged work is processed. It needs a signed request, so temporarily set
`telnyx_public_key` in `infra/terraform.tfvars` to a throwaway keypair, apply, run, then restore.
**Genuine inbound SMS is rejected while the throwaway key is live.**

```bash
PROOF_BASE_URL=https://farm-friend-web-p5mfxfp5za-uw.a.run.app \
PROOF_PRIVATE_KEY='<base64 pkcs8 ed25519 private key>' \
DATABASE_URL='<production Neon URL>' \
PHONE_HASH_SALT='<the deployed salt>' \
npx tsx scripts/prove-post-response-work.ts
```

Use the **deployed** `PHONE_HASH_SALT`. First run against the real public key and confirm checks 1–2
fail with `ack=401`; otherwise the proof is vacuous. After restoring, the throwaway signature must
fail and the webhook must return 401—not 500/503. The script does not clean up; remove only its
reserved `+1206555` rows under a guard that refuses any other contact, then re-check the target.

## Credential rotation

Production secrets live in GCP Secret Manager (`farm-friend-*`); local commands also use `.env`.
Never expose a value in command arguments, output, transcripts, docs, commits, or issues. Add Secret
Manager versions through stdin and record replacements in the password manager when created.

### The rules that constrain every step

- **`PHONE_HASH_SALT` MUST NOT be rotated — ever.** It is the input to the only lookup key for every
  phone. Rotation orphans consent, contacts, flags, and reports. A suspected compromise requires a
  designed re-hash migration.
- Rotate in place against the existing production providers and database. Fingerprint the target
  before changing it.
- Verify the new value before storing it; verify the deployed effect after a new revision; verify
  the old value is dead.
- A new Secret Manager version does not update a running container. Bump
  `rotation_applied_at` in `infra/terraform.tfvars` and redeploy both services.

### Scope — what is actually exposed, and where it lives

| Credential | Consumers | Rotate |
|---|---|---|
| `DATABASE_URL` | Secret Manager `farm-friend-database-url`; local `.env` | Reset `neondb_owner` in Neon; update both |
| `DEEPINFRA_API_KEY` | Secret Manager `farm-friend-deepinfra-api-key`; local `.env` | DeepInfra console; update both |
| `MAGIC_LINK_SECRET` | Secret Manager `farm-friend-magic-link-secret` | Generate a new random value; invalidates outstanding links and sessions |
| `TELNYX_API_KEY` | Secret Manager `farm-friend-telnyx-api-key` | Telnyx console |
| `PHONE_HASH_SALT` | Secret Manager `farm-friend-phone-hash-salt` | **Never rotate** |

`TELNYX_MESSAGING_PROFILE_ID`, `TELNYX_FROM_NUMBER`, `TELNYX_PUBLIC_KEY`, `PUBLIC_BASE_URL`, and
`SMS_PROVIDER` are identifiers/public verification material, not secrets. `CRON_SECRET` does not
exist.

### Order

1. Create and verify the replacement against the intended provider/target.
2. Add it to Secret Manager with `gcloud secrets versions add <name> --data-file=-`; update local
   `.env` where the table requires it. Any scripted `.env` edit must assert exactly one match.
3. Bump `rotation_applied_at` in `infra/terraform.tfvars`
   (`date -u +%Y-%m-%dT%H-%M`).
4. Run the normal plan, assertions, and approved apply.
5. Run `python3 infra/deploy_assertions.py`. A green apply is not a restart; every serving revision
   must be newer than every secret version it consumes.
6. Verify the new value by effect and the old value by rejection.

### Proof by effect

Run only after `deploy_assertions.py` confirms both services picked up the new versions.

| Credential | Proof it works |
|---|---|
| `DATABASE_URL` | a cold container opens a new database connection and produces a known database effect |
| `TELNYX_API_KEY` | a real send returns a provider message ID; or a signed inbound webhook returns **401→200** path end to end |
| `MAGIC_LINK_SECRET` | a freshly minted link signs in |
| `DEEPINFRA_API_KEY` | with paid-call approval, local `evals:live` proves `.env`; a deployed model-backed path proves Secret Manager |
| Telnyx configuration | unsigned webhook POST returns 401, not 500/503; a real send returns a provider ID |

| Old value | Proof it is dead |
|---|---|
| old `DATABASE_URL` | a connection attempt with it is refused (`password authentication failed`) |
| old `TELNYX_API_KEY` | a request to the Telnyx API with it returns **401** |
| old `MAGIC_LINK_SECRET` | a link minted under the old secret is refused at the callback |
| old `DEEPINFRA_API_KEY` | a request with it returns **401** |

Do not substitute a warm pooled database request, an old scheduler result, or local `evals:live`
for deployed proof. Each can pass while production still uses the old secret.

### The production deploy sequence

**Order matters.** A migration adding columns the new code writes must land *before* that code
deploys, or every affected write fails in the gap. 0004 (B-010) was exactly this case.

```bash
# 1. Migration FIRST. Use the DIRECT (non-pooled) Neon string for DDL.
DATABASE_URL='<production Neon URL>' npm run db:migrate

# 2. Build, plan, assert, apply — the four steps in §Deploy above. Never a tag, always a digest.
```

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

Confirm the selected body clears while the row and unrelated bodies survive.

### Carrier checks for a new live environment

Do not point the carrier at the app until the app can honor `STOP`.

1. Confirm the 10DLC campaign is **approved** and the number's campaign provisioning status is
   **Active**; attachment to the messaging profile alone is insufficient.
2. Point the messaging-profile webhook to `https://<deployment>/api/sms/webhook`. Leave Telnyx's
   three profile auto-response message fields empty so Farm Friend does not double-reply.
3. POST unsigned input first. Expected diagnostics:

   | Status | Meaning |
   |---|---|
   | 401 `missing_signature` | Telnyx configuration resolved |
   | 503 `webhook_not_configured` | `SMS_PROVIDER` is not `telnyx` |
   | 500 | a required Telnyx variable is missing/blank |

4. Verify a bad signature returns 401 before sending a real message.
5. Send real `STOP` first and verify durable consent, then `JOIN`/`START` as appropriate and `HELP`.
6. Prove the scheduler by retention effect; fast replies prove only Cloud Tasks.

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
  `provider_error_detail` are the ones that identify the cause** (B-010). Known values:

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
