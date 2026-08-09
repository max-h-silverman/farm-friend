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
npm run db:migrate:local    # apply the schema to apps/web/.env.local
npm run dev --workspace @farm-friend/web
npm run typecheck           # all workspaces, including apps/web
npm run lint                # lint across workspaces
npm test                    # unit tests; no DB/SMS/LLM
npm run test:integration:local # real Postgres constraints and workflows, using apps/web/.env.local
npm run evals               # deterministic stub; critical fixtures must be 100%
```

`next dev` writes to `apps/web/.next-dev`; `next build` and `next start` use `apps/web/.next`.
After updating this setting, stop any existing dev server once and start it again so it picks up
the separate development directory.

The web app loads `apps/web/.env.local`, while the root migration command reads the shell's
`DATABASE_URL`. Keep those targets distinct: use `db:migrate:local` for the local app, and use
`db:migrate` only after explicitly setting the intended target. The integration suite creates its
own disposable databases from the configured Postgres connection; it does not use the app's
working database for test rows. It also **refuses to run against a non-local database host**:
every test there creates and drops databases, and the repo's own `.env` has held the production
connection string, so `packages/db/src/integration-database-guard.ts` fails the run before any DDL
unless the host is local or `ALLOW_INTEGRATION_TESTS_AGAINST_REMOTE_DB=1` is set deliberately.

### Walking the farmer verification flow locally

`apps/web/.env.local` is a fully siloed sandbox: local Postgres, `SMS_PROVIDER=simulator` (no
texts, no Telnyx spend), `LLM_PROVIDER=stub` (no model spend), throwaway salts, and
`EMAIL_PROVIDER=simulator`. Nothing leaves the machine and no deployment is required.

Email is the one channel that needs a stand-in to be walkable at all: with mail unconfigured the
verification route returns the same uniform `{"status":"sent"}` it returns on success — the correct
behavior, since a distinct error would reveal how the deployment is configured — so the six-digit
code exists nowhere a developer can read it. The simulator writes the message to a file instead:

```bash
npm run dev --workspace @farm-friend/web
# walk to /farmer/start/<FARMER_START_SECRET>, pick a farm, enter an address on file
ls -t .mail | head -1          # newest captured message
grep -h Subject .mail/*.txt    # the code is in the subject line, as in the real mail
```

A farm only appears verifiable if it has a row in `farm_emails` whose `email_hash` was computed
with the **same `EMAIL_HASH_SALT`** the app is running with; otherwise every address silently fails
to match. `.mail/` holds live codes and real addresses and is git-ignored — delete it freely.

The simulator cannot reach a deployment: it refuses to construct under `NODE_ENV=production`, and
refuses to start if `SMTP_*` is also configured.

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
| `ADMIN_PASSWORD_HASH` | Required Argon2id verifier on the `web` role only; never log or pass as a command argument |
| `PUBLIC_BASE_URL` | Required absolute origin. HTTPS except localhost; never derived from request headers |
| `PUBLIC_MAP_URL` | Required canonical map page. HTTPS except localhost; returned unchanged for the deterministic `MAP` SMS command |
| `SMS_PROVIDER` | Required `simulator` or `telnyx`; no default |
| `TELNYX_API_KEY`, `TELNYX_MESSAGING_PROFILE_ID`, `TELNYX_FROM_NUMBER`, `TELNYX_PUBLIC_KEY` | All required with Telnyx; the public key verifies webhook signatures |
| `LLM_PROVIDER` | Required `stub` or `deepinfra`; no default or environment exception |
| `DEEPINFRA_API_KEY`, `DEEPINFRA_MODEL` | Required with DeepInfra; `anthropic/` and `google/` models are refused because their terms are not attested |
| `GEOCODING_API_KEY` | **Optional.** Google Geocoding key for the onboarding draft pin (F-069). Absent or blank disables lookup and the form asks the farmer to tap the map, which is fully supported. **Billed per call** — server-side only, behind the invitation token and its own throttle bucket. Restrict the key to the Geocoding API in the GCP console |
| `GMAIL_SENDER_ADDRESS`, `GMAIL_SENDER_NAME`, `GMAIL_OAUTH_CLIENT_ID` | **Required with `EMAIL_PROVIDER=gmail`, `web` only** (B-045). Gmail HTTPS delivery sends from VIGA's existing board mailbox over port 443; its sender remains configuration, never a code default |
| `GMAIL_OAUTH_CLIENT_SECRET`, `GMAIL_OAUTH_REFRESH_TOKEN` | **Required with `EMAIL_PROVIDER=gmail`, `web` only.** Secret Manager only. The OAuth grant is bound to `board@vigavashon.org` and requests `gmail.send` only: it sends mail but cannot read the mailbox |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_FROM_ADDRESS`, `SMTP_FROM_NAME`, `SMTP_PASSWORD` | Legacy local SMTP path only. Production must select Gmail because Cloud Run cannot open the Workspace SMTP connection |
| `FARMER_START_SECRET` | **Optional, `web` role only** (F-079). The secret path segment gating the migration door at `/farmer/start/<secret>`. **Minimum 32 characters**, enforced in the resolver — a shorter value is treated as absent. Absent, blank, or too short means the door does not exist and every request under `/farmer/start` 404s, which is a fully supported deployment. **This is OBSCURITY, not authentication**: it travels in browser history, `Referer` headers and access logs, and is neither one-use nor revocable. What actually proves a farmer may publish is the emailed code |
| `EMAIL_HASH_SALT` | **Required for email verification** (F-079). The lookup-key salt for farmer email addresses. **Must match the salt the roster ingest used**, or every farmer's address silently fails to match and nobody can verify. Deliberately NOT `PHONE_HASH_SALT`: separate hash spaces mean one leaked salt does not compromise the other, and a shared one would let its holder correlate a farmer's address with their phone |
| `VERIFICATION_CODE_SALT` | **Required for email verification** (F-079). Salt for the stored code hash. Rotating it invalidates every code currently in flight, which is the intended effect — codes live 30 minutes |
| `EMAIL_PROVIDER` | `gmail` in production; `simulator` is local-only and writes each message under `SIMULATED_MAIL_DIR`. A selected provider beside any `SMTP_*` setting is a startup error, never a silent precedence rule |
| `SIMULATED_MAIL_DIR` | **Optional, local development only.** Absolute path for captured mail. The default `.mail/` is relative to the process working directory, which differs between `next dev` (`apps/web`) and the test suites (repo root) |

There is no `CRON_SECRET`; Cloud Scheduler uses OIDC and IAM.

**Mail is optional and web-only.** B-045 sends verification through Gmail's HTTPS API using VIGA's
own board mailbox, with no third-party email vendor or DNS change. With Gmail OAuth absent the seam
is unconfigured and email verification is unavailable while every other deployment surface runs.

### B-045 — authorize Gmail HTTPS delivery

1. Create an internal Google OAuth client in the Farm Friend Cloud project and enable Gmail API.
2. Sign in as `board@vigavashon.org` once and grant only `https://www.googleapis.com/auth/gmail.send`.
3. Add the client secret and resulting refresh token to the two empty Secret Manager containers.
4. Set `gmail_sender_address`, `gmail_sender_name`, `gmail_oauth_client_id`, then flip `mount_gmail_delivery = true`; review the plan before applying.
5. Deploy only after approval, then request a real code and verify Neon plus `farmer_verification_send` logs record `outcome: "accepted"`.

## Migrations

`npm run test:integration` creates a unique empty database through `DATABASE_URL`, applies every
file in `packages/db/drizzle/` twice (the second run must be a no-op), exercises the constraints,
then drops only that database. Inspect and fingerprint any manual migration target first.

### Writing a new migration — always GENERATE, never hand-write

Edit `packages/db/src/schema.ts` first, then generate:

```bash
cd packages/db && npx drizzle-kit generate --name <short_name>
```

It prompts per added column ("created or renamed from another column?"). The prompt needs a real
TTY — piping input does not answer it. Drive it with `expect` if you are not at a terminal.

**Hand-writing the `.sql` looks like it works and does not.** Generation is what produces the
schema snapshot in `packages/db/drizzle/meta/`, and generation diffs the database against
`schema.ts` — never against the journal. Skipping it leaves the next author's `generate`
comparing to a stale schema, which is where unsafe create/rename questions come from:

```
Is message_category column in outbox_work table created or renamed from another column?
```

A wrong answer can recreate existing tables or rename production data. `migration-metadata.test.ts`
enforces that the pair lands together; commit both. Never edit an applied `.sql`.

**`drizzle-kit generate` does not emit `check()` constraints.** Append them to the generated file
by hand — every CHECK in `packages/db/drizzle/` got there that way.

**A column missing from `schema.ts` will be DROPPED by the next generate.** This has already
happened: `farmer_invitations.pending_stock` was added by a hand-written `0031` and never mirrored
into `schema.ts`, so an unrelated migration two weeks later proposed dropping a live column
(F-090's held stock). Read the generated `.sql` line by line before applying it, and treat any
`DROP COLUMN` you did not ask for as a schema-file omission rather than a drizzle bug.

### Applying locally — "migrations applied" is not proof

```bash
npm run db:migrate:local
```

**This command prints `migrations applied` when it applied nothing.** Two ways it silently skips:

- **The journal entry is missing.** A hand-written `.sql` with no `packages/db/drizzle/meta/_journal.json`
  entry is invisible to the runner.
- **The journal timestamp is not newer than `drizzle.__drizzle_migrations`.** Entries in this repo
  carry future-dated `when` values, so a freshly generated migration can be stamped *earlier* than
  the newest applied record and be treated as already run. This is the same failure the deploy
  section below warns about for `npm run db:migrate` against production — it bites locally too.

Verify by effect against `information_schema`, never by the exit code or the message:

```bash
node --env-file=apps/web/.env.local --import tsx -e "
import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
console.log(await sql\`select column_name from information_schema.columns
  where table_name = 'your_table' order by column_name\`);
console.log(await sql\`select conname from pg_constraint
  where conrelid = 'your_table'::regclass\`);
await sql.end();
"
```

Then prove each new constraint refuses what it should by inserting rows that violate it — a
constraint that exists is not a constraint that works.

## Bootstrap the fixed administrator

Run once per environment, against a database you intend to change:

```bash
DATABASE_URL=… npx tsx packages/db/scripts/bootstrap-administrator.ts
```

The command is idempotent and can create only `board@vigavashon.org`. The row confers authority;
the configured password proves access to that one account. There is no add-administrator path.

### Provision, bootstrap, then sign in

1. First make and inspect a bootstrap plan with the current immutable image digest; do not apply it
   yet. The four exclusions keep the retired secret, both services, and the runtime-read IAM block
   out of this apply while allowing Terraform to record all four survivor address moves:

   ```bash
   cd infra
   tofu plan \
     -exclude='google_secret_manager_secret.app["magic-link-secret"]' \
     -exclude='google_cloud_run_v2_service.web' \
     -exclude='google_cloud_run_v2_service.worker' \
     -exclude='google_secret_manager_secret_iam_member.runtime_reads' \
     -var="image_digest=$DIGEST" -out=/tmp/f056-password-secret.tfplan
   tofu show -json /tmp/f056-password-secret.tfplan | python3 bootstrap-secret-plan-assertions.py
   ```

   The assertion requires the four survivor address moves to be no-ops and the password-secret
   container to be the only non-no-op action: `1 add, 0 change, 0 destroy`. Only after explicit
   approval limited to that reviewed plan, apply `/tmp/f056-password-secret.tfplan`. It creates
   only the empty password container: no Cloud Run revision, no magic-link-secret deletion, and no
   survivor replacement.
2. From a private terminal, run `npm run admin:provision-password --workspace @farm-friend/web`.
   It reads the password twice without echo, hashes it locally, and streams only the verifier to
   Secret Manager over stdin.
3. With separate approval, run the production migration and bootstrap script above against the
   fingerprinted intended database.
4. Build the reviewed new image, then review a full plan. It must mount `ADMIN_PASSWORD_HASH` on
   web only, remove `MAGIC_LINK_SECRET` from both services, preserve the four survivor containers
   by address move, and destroy only the retired magic-link container. Obtain explicit approval for
   that secret destruction and the deploy before applying.
5. Open `/admin/login`, leave the fixed email unchanged, enter the password, and verify `/admin`.

Properties to preserve:

- Every refusal is byte-identical: wrong email, wrong password, malformed input, missing config,
  revoked authority, and exhausted throttle.
- Failed attempts reserve durable account-wide and coarse-client budgets before verification.
- The browser receives the raw session token only in the secure cookie; Postgres stores its hash.
- Administrator and session revocation take effect on the next protected request.

## Seeding initial listing data

This is a **greenfield build**: existing VIGA map content is **reference input, not a schema
contract**, and there is no non-destructive migration requirement or provenance axis.

A **one-time seed utility** validates and atomically loads farms, sales locations, and the reviewed
usual-offering artifact. `db:seed` still **writes no current inventory** — a stand it creates
renders the honest "no current listing" until something confirms it. It also seeds **no phone
numbers**: `farmer_authorizations` requires captured SMS consent, so phones arrive through
onboarding, never a bulk roster load.

**Inventory is seeded by a separate script, and only from a farmer's own dated statement**
(F-062, superseding the 2026-07-26 B-002 position that nothing may seed inventory). `db:seed-weekly`
reads VIGA's weekly stock form — a Google Form farmers have filled in for years — and writes each
farm's latest submission as an `inventory_revisions` row carrying **`source = 'viga'`** and none of
the three keys asserting a handset sent it (F-063). That is not a fabricated confirmation: it is a
real, dated statement a farmer made, honestly labelled, and the staleness machinery ages it with no
special handling. **A farmer's own SMS always wins** — the writer refuses to overwrite anything
newer, whatever its source.

**It takes both exports plus the reviewed offering artifact.** Neither export can seed a visitable
location alone: the form has the 2026-current details and **no coordinates at all**, while the map
export has the coordinates and the farms that submitted no form. The artifact owns the structured
usual items; the prose is not reparsed during a restore.

```bash
npm run db:seed -- --form "<form.csv>" --map "<map.csv>" \
  --offerings maps/offerings-proposals.json --dry-run                # report only, writes nothing
npm run db:seed -- --form "<form.csv>" --map "<map.csv>" \
  --offerings maps/offerings-proposals.json                          # apply atomically

# The weekly stock form, as dated `source = 'viga'` confirmations. --form is optional and lets a
# farmer's STATED rename resolve their old name ("Formerly Maggie's Farm") to their current stand.
npm run db:seed-weekly -- --weekly "<weekly.csv>" --form "<form.csv>" --season 2026 --dry-run
npm run db:seed-weekly -- --weekly "<weekly.csv>" --form "<form.csv>" --season 2026
```

**Always pass `--expect-database` for a non-local write** (F-064). Both seed scripts accept it, and
it aborts before writing a single row unless the connection really lands on that database:

```bash
npm run db:seed -- --form … --map … --offerings maps/offerings-proposals.json \
  --expect-database neondb
```

Naming the target is not enough on its own — printing `host/neondb` confirms the string an operator
typed, not the database it reaches. The guard reports what is *actually* there (database name,
migrations applied, farms, locations, revisions) and refuses anything unexpected.

The batch is transactional and idempotent by stand name: re-running never overwrites a farmer's
later correction. It refuses invalid coordinates rather than coercing them.

**An existing stand's empty SIDE TABLES are backfilled** (GL-015, 2026-08-08) — `farm_links`,
`sales_location_payment_methods`, and `sales_location_participants`. Until this existed the loader
could only create a stand or skip it entirely, and running the launch ingest against production
found the cost: all 35 stands already existed, so the batch wrote nothing and those three tables
stayed empty with no way to fill them. The stand's own listing — address, coordinates, season,
hours, stocking, description — is still never rewritten. Every backfill write is
`on conflict do nothing`, so it fills gaps and never overwrites, reorders, or removes.

**A farm whose farmer holds a live authorization is refused outright**, reported as
`refused N (farmer owns the listing)`. Once a farmer owns their listing (golden rule #1), VIGA's
older spreadsheet must not add to it behind their back — a payment method or host they deliberately
removed would otherwise reappear on the next run.

**Hosted participants** (`Hosting: Kareli Farm` in the map prose) are written with
`source = 'viga'` and no confirming authorization, the same split F-063 made for inventory and
enforced by the same shape of CHECK. A farmer takes ownership by editing the list on their own
settings page, which writes `source = 'sms'`.

**Weekday patterns are read into `open_days`** (B-039). VIGA asks "Open Hours & Days" as one
question and farmers answer both axes — `10-6, Wednesday & Saturday` is a clock range *and* a day
set — so `parseOpenDays` and `parseOpenHours` each read their own axis from the same answer. It
refuses rather than guesses: a time-only answer, `See below`, and a seasonally split answer
(`Spring: Fri- Sun, Summer: everyday`) all store no days.

Both scripts **report everything they did not do** — refused rows, unknown farms, and any farm name
that resolved to a stand under a *different* name. A submission landing on the wrong farm's card is
the failure the name matching exists to prevent, so non-exact matches stay visible rather than being
resolved quietly.

If the database was seeded before public source descriptions and Farm Bucks facts were wired, use
the guarded null-only backfill against the reviewed public listing artifact:

```bash
node --env-file=.env --import tsx packages/db/scripts/backfill-public-listing-details.ts \
  maps/offerings-proposals.json \
  --payment-facts maps/reviewed-payment-facts.json      # dry-run
node --env-file=.env --import tsx packages/db/scripts/backfill-public-listing-details.ts \
  maps/offerings-proposals.json \
  --payment-facts maps/reviewed-payment-facts.json --apply # fill null/unreviewed fields only
```

The backfill matches by the same normalized stand key, strips direct contact details, reports
unmatched source entries, and never overwrites a description or reviewed payment fact.

Corpus-specific operating facts:

- The form export owns current details; the map export owns coordinates and map-only farms. Their
  names join through the exact normalized key in `match-stands.ts`, never fuzzy similarity.
- The map CSV is malformed: records are anchored to `POINT (` by `stand-csv.ts`; do not substitute
  a standard CSV reader.
- The loader structures hours/season/specialties, drops dated inventory, strips direct phone/email,
  and retains public websites/social handles.
- It seeds neither inventory nor phone authorization. Inventory requires farmer confirmation;
  phones require captured consent.
- Unresolvable coordinates become operator refusals, never fabricated points. **The seeder does no
  geocoding.** The onboarding form looks the typed address up (`GEOCODING_API_KEY`), and since F-077
  that lookup is the **only** source of a coordinate — there is no pin picker and no fallback. Every
  failure, including an off-island result, **refuses** and asks the farmer to correct the address;
  editing the address afterwards discards the coordinate it resolved to. Nothing else geocodes.
- `offering_type` and visitability are independent and classification uses the farmer's words, not
  the farm name.

> **Manual guard—Handpicked Homestead (B-024):** keep it non-public and non-visitable. Its form says
> not to publish the home address, but the current seeder does not consult `extraNotes` for
> visibility; a re-seed can republish it. Check this row until that defect is fixed.

**Offerings — proposed by the model, committed only after review (F-024/F-036).** Proposal and
review remain separate so no model output reaches the database without a human between:

```bash
DEEPINFRA_MODEL="<model-id>" npm run offerings:propose -- "<path-to-csv>" maps/offerings-proposals.json
# max reviews/edits the file. For an already-seeded database, then:
npm run db:seed-offerings -- maps/offerings-proposals.json --dry-run
npm run db:seed-offerings -- maps/offerings-proposals.json
```

The next full `db:seed` run consumes the same reviewed artifact automatically and commits stands plus
usual offerings in one transaction; omitting `--offerings` is a refusal, not a stand-only rebuild.
The proposal step strips contacts, passes the same provider privacy gate as production, and records
each tag beside its source text. Both commit paths are idempotent on `(location, item)` and write
specialties only—never inventory. The database-backed dry run resolves the approved map-export name
through `matchStandName`, reports unknown/already-present tags, and refuses an ambiguous match.

`offerings:propose` reads only the map export; form-only farms are absent rather than reported as
rejected. Check the other export when a farm is missing.

### Cleaning stored descriptions

`buildStandDescription` (F-061) strips from a farm's prose every line that restates a fact holding a
structured column of its own — hours, season, stocking, links, payments, dated updates. It has been
deployed since it was written and **has never run against the data**, because F-064's ingest never
happened, so `farms.description` still holds raw prose that the public card renders verbatim.

This applies the shipped rule to the stored text. It needs no re-ingest and no CSVs, and touches no
other column:

```bash
DATABASE_URL="<neondb>" npx tsx scripts/clean-farm-descriptions.ts            # dry run, prints every diff
DATABASE_URL="<neondb>" npx tsx scripts/clean-farm-descriptions.ts --apply    # prompts for a typed confirmation
```

**Dry run is the default and no single flag writes** — `--apply` additionally requires typing an
exact confirmation phrase. It fingerprints the target and asserts the database name before reading a
row, writes a JSON backup of every prior value before opening the transaction (there is no
`farms.description` history table, so **that file is the rollback**), writes in one transaction, and
then **verifies by effect** — reading the rows back and comparing them to what was intended rather
than trusting the absence of an error. It is idempotent: the cleanup is a pure function, so a second
run changes nothing.

Read the diff before approving. A farm whose every line is structured is left with **no**
description, which is correct — the card still carries those facts from their own columns — but it
should be a decision, not a surprise.

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
  using the stand's per-stand cadence (seeded `weekly` at farmer setup, F-081; farmer-changeable)
  and the 10:00 AM stand-local slot. It advances delayed
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
handler means routing it through `context.publicActionThrottle`; adding one that is model-free means
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

1. Load queue data in the server-rendered page after resolving the administrator. Do not add a
   duplicate queue GET API. For a browser action or the flag-thread fetch, guard the route with the
   shared `requireAdministrator` from `apps/web/lib/admin-guard.ts`.
2. Take the acting administrator from the **session**, never the request body. A caller who names
   someone else must not be able to act as them.
3. Re-read the administrator's authority **inside the transaction that writes**, and commit the
   audit event in that same transaction. `packages/db/src/review.ts` and `admin.ts` are the pattern.
4. Project the minimum: no phone material unless the surface genuinely needs it, and mask it at the
   **query** (`right(phone_e164, 4)`) rather than in the renderer, so the raw number never leaves
   the database.
5. Test-first: assert an unauthorized caller is refused for every exported method. For a reader,
   test the server page or the real browser-consumed GET and grep the whole projection for an E.164
   and any 64-hex run.

**The public password-login route is the exception.** `POST /api/auth/login` is deliberately
unauthenticated, so `requireAdministrator` cannot apply. What replaces it:

- **Answer identically for every input.** Not "return 200 in both cases" — identical status,
  headers, and body, asserted by comparing whole serialized responses. Include the failure paths:
  malformed input, missing configuration, revoked authority, and internal failure.
- **Reserve both durable budgets before verification:** account-wide first, then coarse client.
  The stable lock order prevents deadlocks and the aggregate prevents distributed guessing.
- **Run the maintained Argon2id verifier for every syntactically valid email**, then re-read the
  fixed authority row before comparing the email. Neither timing nor response reveals membership.
- **Return the raw session token only in the secure cookie.** Store only its hash.

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

### Mount flags live in `infra/production.tfvars`, not in your shell history

Every `mount_*` variable defaults to **false**, because a secret's container must exist before
its value does. That default is right exactly once — the apply that creates the container — and
wrong for every apply afterwards.

Nothing used to record which flags production was running with, so each apply reverted whatever
the previous one had turned on. **`GEOCODING_API_KEY` was live on web revision 00034 and was
stripped at 00035** by the SMTP apply, which passed `mount_smtp_password=true` and nothing else.
It was absent from 00035 through 00038. Since F-077 made the typed address the only source of a
coordinate, production could not create a visitable stand at all during that window, and every
apply reported success.

So: **pass `-var-file=production.tfvars` on every plan and apply**, and when you add a mount
flag, add it to that file in the same change. `plan-assertions.py` fails by name on any plan
that would unmount a secret currently live on a service, which is the guard rather than the
reminder.

### Turning on F-079's email verification

The same three-step gate as geocoding and SMTP, for the same platform reason — `version =
"latest"` resolves at container start, and a versionless secret makes Cloud Run refuse the
revision.

1. Apply with `mount_email_verification = false` (its committed value). This creates the three
   empty containers and their IAM grants and changes nothing about what the services run.
2. **Run F-078's roster ingest first** (max, 2026-08-07) — it decides `EMAIL_HASH_SALT`, and
   whatever salt it used is the value that must be stored.

   ```bash
   # Dry run first. Writes NOTHING; reports what it would insert, which farm names match no
   # farm, and which farms have no address on file.
   EMAIL_HASH_SALT="$(openssl rand -hex 32)" \
   FARM_STAND_RESPONSES_CSV=/path/to/2026-farm-stand-responses.csv \
   DATABASE_URL="<neondb>" npx tsx scripts/ingest-farm-emails.ts

   # Same salt, then --commit. Insert-only and idempotent: a re-run writes zero.
   ```

   The script **pins the expected farm count at 36** (VIGA's 35 real farms plus a `Test Farm` that
   existed at the time) and refuses anything else, so a mistyped connection string fails loudly
   instead of writing a roster somewhere else. If the count legitimately changes, pass
   `EXPECTED_FARMS=<n>`; it failing then is the guard working.

   **Production now holds 35 farms, so this needs `EXPECTED_FARMS=35`** — the 2026-08-08 rebuild
   dropped `Test Farm`. The default is deliberately left at 36 rather than re-pinned: a guard that
   is edited to match whatever the database currently holds has stopped being a guard.

   **Use the same salt for both runs and keep it.** Then add all three versions:

   ```bash
   printf %s "<the salt the ingest used>" | gcloud secrets versions add farm-friend-email-hash-salt \
     --project farm-friend-vashon --data-file=-
   printf %s "$(openssl rand -hex 32)" | gcloud secrets versions add farm-friend-verification-code-salt \
     --project farm-friend-vashon --data-file=-
   printf %s "$(openssl rand -hex 24)" | gcloud secrets versions add farm-friend-farmer-start-secret \
     --project farm-friend-vashon --data-file=-
   ```

   `printf %s`, never `echo`: a trailing newline in a salt produces hashes that look right in
   every listing and match nothing at runtime.
3. Apply migration `0025` **before** deploying the image that reads it, then flip
   `mount_email_verification = true` in `production.tfvars` and apply.

**`EMAIL_HASH_SALT` can never be rotated** without re-ingesting the roster, and a mismatch
between it and the ingest is this feature's quietest failure: every farmer's correct address
fails to match, nothing errors, and the door verifies nobody.

**Preflight is live evidence, never the release snapshot.** Before choosing a source baseline or
planning, fetch `origin/main`, inspect the serving revisions and their immutable digests, identify
the Cloud Build `SHORT_SHA`, and query Neon's migration ledger plus the schema effects the image
expects. If any of those contradict `CURRENT_STATE.md`, stop and correct the record first — never
reconstruct a hotfix from the commit the snapshot claims is live.

Review the plan for the intended delta as well as the safety assertions. Any unrelated change —
including a rotation marker moving backward — stops the deploy even when all assertions pass.

```bash
# 1. Build and publish. SHORT_SHA is required; without it the image reference is invalid.
gcloud builds submit --config cloudbuild.yaml --project farm-friend-vashon \
  --substitutions=SHORT_SHA=$(git rev-parse --short HEAD)

# 2. Resolve the immutable digest; never deploy a tag.
DIGEST=$(gcloud artifacts docker images describe \
  "us-west1-docker.pkg.dev/farm-friend-vashon/farm-friend/farm-friend:$(git rev-parse --short HEAD)" \
  --format='value(image_summary.digest)' --project farm-friend-vashon)

# 3. Plan and assert the planned resources.
#
# `-var-file=production.tfvars` IS NOT OPTIONAL. Every mount flag defaults to false, so a plan
# without it silently UNMOUNTS whatever the last apply enabled. That is not hypothetical:
# omitting it stripped GEOCODING_API_KEY from web revision 00035 and it stayed gone through
# 00038, which since F-077 meant no visitable stand could be created at all. The apply reported
# success. `plan-assertions.py` now fails by name if a plan would unmount a live secret.
cd infra
tofu plan -var-file=production.tfvars -var="image_digest=$DIGEST" -out=/tmp/tf.plan
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
  new, explicitly approved data-migration design; there is no generic recovery command.
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
| `ADMIN_PASSWORD_HASH` | Secret Manager `farm-friend-admin-password-hash`; web only | Use the private-terminal provisioning command; never handle the verifier directly |
| `TELNYX_API_KEY` | Secret Manager `farm-friend-telnyx-api-key` | Telnyx console |
| `PHONE_HASH_SALT` | Secret Manager `farm-friend-phone-hash-salt` | **Never rotate** |

`TELNYX_MESSAGING_PROFILE_ID`, `TELNYX_FROM_NUMBER`, `TELNYX_PUBLIC_KEY`, `PUBLIC_BASE_URL`,
`PUBLIC_MAP_URL`, and `SMS_PROVIDER` are identifiers/public verification material, not secrets.
`CRON_SECRET` does not exist.

### Order

1. Create and verify the replacement against the intended provider/target.
2. Add it to Secret Manager over stdin; for the administrator password, use the provisioning
   command so neither plaintext nor verifier reaches output or command arguments. Update local
   `.env` only where the table requires it.
3. Bump `rotation_applied_at` in `infra/terraform.tfvars`
   (`date -u +%Y-%m-%dT%H-%M`).
4. Run the normal plan, assertions, and approved apply.
5. Run `python3 infra/deploy_assertions.py`. A green apply is not a restart; every serving revision
   must be newer than every secret version it consumes.
6. Verify the new value by effect and the old value by rejection. For an administrator password
   rotation, revoke every existing session immediately after the new revision is proven.

Administrator-password rotation revocation (fingerprint the target first):

```sql
update admin_sessions
set revoked_at = greatest(issued_at, now())
where revoked_at is null
returning id;
```

### Proof by effect

Run only after `deploy_assertions.py` confirms both services picked up the new versions.

| Credential | Proof it works |
|---|---|
| `DATABASE_URL` | a cold container opens a new database connection and produces a known database effect |
| `TELNYX_API_KEY` | a real send returns a provider message ID; or a signed inbound webhook returns **401→200** path end to end |
| `ADMIN_PASSWORD_HASH` | the fixed account signs in and a durable session-hash row appears |
| `DEEPINFRA_API_KEY` | with paid-call approval, local `evals:live` proves `.env`; a deployed model-backed path proves Secret Manager |
| Telnyx configuration | unsigned webhook POST returns 401, not 500/503; a real send returns a provider ID |

| Old value | Proof it is dead |
|---|---|
| old `DATABASE_URL` | a connection attempt with it is refused (`password authentication failed`) |
| old `TELNYX_API_KEY` | a request to the Telnyx API with it returns **401** |
| old administrator password | login returns the exact generic refusal; every pre-rotation cookie is refused after session revocation |
| old `DEEPINFRA_API_KEY` | a request with it returns **401** |

Do not substitute a warm pooled database request, an old scheduler result, or local `evals:live`
for deployed proof. Each can pass while production still uses the old secret.

### The production deploy sequence

**Order matters.** A migration adding columns the new code writes must land *before* that code
deploys, or every affected write fails in the gap. 0004 (B-010) was exactly this case.

For the password cutover, do not let a full apply mount Secret Manager `latest` from an empty new
container. First obtain explicit approval for the **bootstrap plan** in §Provision, bootstrap, then
sign in; confirm it records the four survivor address moves as no-ops, creates only
`farm-friend-admin-password-hash`, changes no Cloud Run service, and retains the old magic secret.
Provision its first verifier through the private-terminal command. Then, with
separate explicit approval, fingerprint and migrate the production database (0015 revokes every
pre-cutover session). Finally build the reviewed password-only image and review the full plan:
it must destroy only the retired magic-link secret, retain all four survivors by address move, mount
`ADMIN_PASSWORD_HASH` only on web, and remove `MAGIC_LINK_SECRET` from both services. Approval for
that cloud-secret deletion and deployment is separate from the targeted-container and migration
approvals. Never redeploy the old image without `MAGIC_LINK_SECRET`; never apply a plan that
destroys another secret or creates a replacement for a survivor.

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
