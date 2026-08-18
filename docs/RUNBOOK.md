# Farm Friend — Runbook (operate)

Install, run, migrate, seed, evaluate, rotate, and deploy. Recipes for *adding* to the system are in
[EXTENDING.md](EXTENDING.md). Build/deployment status lives only in
[CURRENT_STATE.md](CURRENT_STATE.md).

## Prerequisites

- **Node:** version in `.nvmrc` (`nvm use`).
- **Postgres:** local or disposable CI instance. `DATABASE_URL` must let the test role create and drop
  a throwaway database; the integration suite fails when it is absent.
- **This Mac:** Homebrew `postgresql@16` is installed but not on `PATH`:

  ```bash
  export PATH=/opt/homebrew/opt/postgresql@16/bin:$PATH
  export DATABASE_URL="postgres://$(whoami)@localhost:5432/postgres"
  npm run test:integration 2>&1 | tee /tmp/itest.log
  ```

- Unit tests and stub evals require no network.

## Local dev

**From nothing, use the script:** `./scripts/dev-setup.sh --run` creates the local database, writes
`apps/web/.env.local`, migrates, bootstraps the administrator row, and starts the server with a working
sign-in. `--reset` drops the database first. It refuses to run if a non-local `DATABASE_URL` is in the
environment, and verifies the migration by schema effect rather than by its exit status.

```bash
npm install                 # install all workspaces
npm run db:migrate:local    # apply the schema to apps/web/.env.local
npm run dev --workspace @farm-friend/web
npm run typecheck           # all workspaces, including apps/web
npm run lint                # lint across workspaces
npm test                    # unit tests; no DB/SMS/LLM
npm run test:integration:local # real Postgres constraints and workflows
npm run evals               # deterministic stub; critical fixtures must be 100%
```

`apps/web/.env.local` is the file the web app reads — a `.env` at the repo root is **not** loaded by
`next dev`, and the app starts without complaint lacking every value in it. Everything in that file is
a throwaway local value; **the geocoding key is not written there**, because it is live and billed.
`dev-setup.sh` fetches it from Secret Manager per run. Without it the address lookup reports itself
unavailable, which is the same supported state as a deployment with no key. The root migration command
reads the shell's `DATABASE_URL`: use `db:migrate:local` for the local app, and `db:migrate` only after
explicitly setting the intended target.

`next dev` writes to `apps/web/.next-dev`; `next build` and `next start` use `apps/web/.next`. After
changing this setting, restart any running dev server once.

The integration suite creates its own disposable databases and **refuses to run against a non-local
database host**: every test there creates and drops databases, and the repo's own `.env` has held the
production connection string, so `packages/db/src/integration-database-guard.ts` fails the run before
any DDL unless the host is local or `ALLOW_INTEGRATION_TESTS_AGAINST_REMOTE_DB=1` is set deliberately.

### The admin verifier must NOT go in a .env file

**Next expands `$NAME` inside .env values, and an Argon2id verifier is a run of `$`-delimited
segments.** `ADMIN_PASSWORD_HASH` written into `apps/web/.env.local` therefore reaches the server
**shorter than it was written** — 95 or 65 characters instead of 97. Quoting does not prevent it.

The failure is silent and mimics the wrong bug: every sign-in refuses with the *same generic message a
wrong password gets*, so regenerating the hash, resetting the password, and checking the administrator
row all leave it broken. Pass it as a real environment variable instead:

```bash
ADMIN_PASSWORD_HASH="$(npx tsx scripts/dev-admin-hash.ts localdevpassword)" \
  npm run dev --workspace @farm-friend/web
```

Confirm what the *running server* holds rather than what the file says — the gap between them is the
whole defect. A temporary route echoing `process.env.ADMIN_PASSWORD_HASH?.length` settles it; 97 is
correct.

**Two other silent sign-in refusals**, same generic message, neither a password problem:

- **No administrator row.** Authority is data, not configuration. Run
  `DATABASE_URL=… npx tsx packages/db/scripts/bootstrap-administrator.ts` (idempotent).
- **A live throttle bucket** from earlier failed attempts, which outlives the server process:
  `psql "$DATABASE_URL" -c "delete from admin_login_failures;"`.

### Walking the farmer verification flow locally

`apps/web/.env.local` is a fully siloed sandbox: local Postgres, `SMS_PROVIDER=simulator` (no texts, no
Telnyx spend), `LLM_PROVIDER=stub` (no model spend), throwaway salts, and `EMAIL_PROVIDER=simulator`.
Nothing leaves the machine and no deployment is required.

Email is the one channel that needs a stand-in to be walkable: with mail unconfigured the verification
route returns the same uniform `{"status":"sent"}` it returns on success — correct, since a distinct
error would reveal how the deployment is configured — so the six-digit code exists nowhere a developer
can read it. The simulator writes the message to a file instead:

```bash
npm run dev --workspace @farm-friend/web
# walk to /farmer/start/<FARMER_START_SECRET>, pick a farm, enter an address on file
ls -t .mail | head -1          # newest captured message
grep -h Subject .mail/*.txt    # the code is in the subject line, as in the real mail
```

A farm only appears verifiable if it has a row in `farm_emails` whose `email_hash` was computed with
the **same `EMAIL_HASH_SALT`** the app is running with; otherwise every address silently fails to
match. `.mail/` holds live codes and real addresses and is git-ignored. The simulator cannot reach a
deployment: it refuses to construct under `NODE_ENV=production`, and refuses to start if `SMTP_*` is
also configured.

### What "across workspaces" means (GL-005)

`npm run typecheck` fails if either half fails:

| Script | Covers | How |
| --- | --- | --- |
| `typecheck:packages` | `packages/core`, `db`, `sms`, `ai` | `tsc -b` over the root project references |
| `typecheck:web` | `apps/web` | `tsc -p tsconfig.json --noEmit` in the web workspace |

The web config is not a composite project, so its own script is the second half.
`packages/core/src/typecheck-coverage.test.ts` prevents coverage drift. Also run the production build,
because the two checks cover different risks: `npm run typecheck` covers **test files**, which `next
build` never compiles; `npm run build --workspace @farm-friend/web` covers **route and manifest
conventions** and the real bundle graph, which `tsc -p` does not model. **A green typecheck is not a
green build, or vice versa.**

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
| `PUBLIC_BASE_URL` | Required absolute origin. HTTPS except localhost; never derived from request headers. In production it is the custom domain `https://farmfriend.vigavashon.org`, set from `public_host` in **tracked** `infra/production.tfvars` — an apply that omits it falls back to `*.run.app` AND destroys the domain mapping, reverting F-113 while reporting success. Every texted farmer link is built from this value |
| `PUBLIC_MAP_URL` | Required canonical map page. HTTPS except localhost; returned unchanged for the deterministic `MAP` SMS command. **Must equal `PUBLIC_MAP_URL` in `packages/core/src/inquiry/answer.ts`** (the value customer copy embeds) or a non-local deployment refuses to start — changing the link means changing both, and the `#map` anchor is part of it (F-110). Local dev is exempt |
| `SMS_PROVIDER` | Required `simulator` or `telnyx`; no default |
| `TELNYX_API_KEY`, `TELNYX_MESSAGING_PROFILE_ID`, `TELNYX_FROM_NUMBER`, `TELNYX_PUBLIC_KEY` | All required with Telnyx; the public key verifies webhook signatures |
| `LLM_PROVIDER` | Required `stub` or `deepinfra`; no default or environment exception |
| `DEEPINFRA_API_KEY`, `DEEPINFRA_MODEL` | Required with DeepInfra; `anthropic/` and `google/` models are refused because their terms are not attested |
| `GEOCODING_API_KEY` | **Required to create any stand** (F-077/F-088). Google Geocoding key for onboarding address lookup. **Secret Manager only** — never write it to `apps/web/.env.local`; `dev-setup.sh` reads it per run and passes it as an environment variable, the same way it handles `ADMIN_PASSWORD_HASH`. Absent or blank disables lookup, and the form tells the farmer to contact VIGA. **Billed per call** — server-side only, behind the invitation token and its own throttle bucket. Restrict the key to the Geocoding API in the GCP console |
| `GMAIL_SENDER_ADDRESS`, `GMAIL_SENDER_NAME`, `GMAIL_OAUTH_CLIENT_ID` | **Required with `EMAIL_PROVIDER=gmail`, `web` only** (B-045). Gmail HTTPS delivery sends from VIGA's existing board mailbox over port 443; its sender remains configuration, never a code default |
| `GMAIL_OAUTH_CLIENT_SECRET`, `GMAIL_OAUTH_REFRESH_TOKEN` | **Required with `EMAIL_PROVIDER=gmail`, `web` only.** Secret Manager only. The OAuth grant is bound to `board@vigavashon.org` and requests `gmail.send` only |
| `SMTP_*` | Legacy local SMTP path only. Production must select Gmail because Cloud Run cannot open the Workspace SMTP connection |
| `FARMER_START_SECRET` | **Optional, `web` role only** (F-079). The secret path segment gating `/farmer/start/<secret>`. **Minimum 32 characters**, enforced in the resolver. Absent, blank, or too short means the door does not exist and every request under `/farmer/start` 404s. **This is OBSCURITY, not authentication** — what proves a farmer may publish is the emailed code |
| `EMAIL_HASH_SALT` | **Required for email verification** (F-079). **Must match the salt the roster ingest used**, or every farmer's address silently fails to match and nobody can verify. Deliberately NOT `PHONE_HASH_SALT`: separate hash spaces mean one leaked salt does not compromise the other |
| `VERIFICATION_CODE_SALT` | **Required for email verification.** Rotating it invalidates every code in flight, which is the intended effect — codes live 30 minutes |
| `EMAIL_PROVIDER` | `gmail` in production; `simulator` is local-only. A selected provider beside any `SMTP_*` setting is a startup error, never a silent precedence rule |
| `SIMULATED_MAIL_DIR` | **Optional, local only.** Absolute path for captured mail. The default `.mail/` is relative to the process working directory, which differs between `next dev` and the test suites |

There is no `CRON_SECRET`; Cloud Scheduler uses OIDC and IAM.

**Mail is optional and web-only.** B-045 sends verification through Gmail's HTTPS API using VIGA's own
board mailbox, with no third-party email vendor or DNS change. With Gmail OAuth absent the seam is
unconfigured and email verification is unavailable while every other deployment surface runs.

**To authorize Gmail HTTPS delivery (B-045):**

1. Create a Google OAuth client in the Farm Friend Cloud project and enable the Gmail API.
2. Sign in as `board@vigavashon.org` once and grant only
   `https://www.googleapis.com/auth/gmail.send` — it sends mail but cannot read the mailbox.
3. Add the client secret and resulting refresh token to the two empty Secret Manager containers.
4. Set `gmail_sender_address`, `gmail_sender_name`, `gmail_oauth_client_id`, then flip
   `mount_gmail_delivery = true`; review the plan before applying.
5. Deploy only after approval, then request a real code and verify Neon plus the
   `farmer_verification_send` logs record `outcome: "accepted"`.

## Migrations

`npm run test:integration` creates a unique empty database through `DATABASE_URL`, applies every file
in `packages/db/drizzle/` twice (the second run must be a no-op), exercises the constraints, then drops
only that database. Inspect and fingerprint any manual migration target first.

### Writing a new migration — always GENERATE, never hand-write

Edit `packages/db/src/schema.ts` first, then generate:

```bash
cd packages/db && npx drizzle-kit generate --name <short_name>
```

It prompts per added column ("created or renamed from another column?"). The prompt needs a real TTY —
piping input does not answer it. Drive it with `expect` if you are not at a terminal.

**Hand-writing the `.sql` looks like it works and does not.** Generation produces the schema snapshot
in `packages/db/drizzle/meta/`, and generation diffs the database against `schema.ts` — never against
the journal. Skipping it leaves the next author's `generate` comparing to a stale schema, which is
where unsafe create/rename questions come from, and **a wrong answer can recreate existing tables or
rename production data**. `migration-metadata.test.ts` enforces that the pair lands together; commit
both. Never edit an applied `.sql`.

Four generator traps, each of which has bitten:

- **It does not emit `check()` constraints.** Append them to the generated file by hand — every CHECK
  in `packages/db/drizzle/` got there that way.
- **A column missing from `schema.ts` will be DROPPED by the next generate.** Read the generated `.sql`
  line by line, and treat any `DROP COLUMN` you did not ask for as a schema-file omission rather than a
  drizzle bug.
- **It stamps the new journal entry with the WALL CLOCK, and this repo's entries are future-dated** —
  so a freshly generated migration can land *earlier* than its predecessor and be skipped while the
  runner prints "migrations applied". Fix the `when` to follow the previous entry.
- **It can emit a composite FK before the unique constraint that FK requires**, which fails on a clean
  database. Read the generated SQL top to bottom.
- **It emits `ADD COLUMN … NOT NULL` with no default and no backfill — which passes on an empty
  database and fails on a real one.** Against any table that already holds a row that is an instant
  23502, and the integration suite (which migrates from empty) will not catch it. A migration adding
  a required column must add it **nullable**, backfill it, then `SET NOT NULL`, so the constraint is
  proved by the data rather than asserted ahead of it. Test it against a **populated** copy of the
  previous schema — `packages/db/src/multi-seller-migration.integration.test.ts` is the pattern:
  apply every migration *except* the new one, insert the awkward rows a real corpus has, then apply
  the new one alone and assert exact row effects. **Write the fixture in the vocabulary of the
  schema it populates, not the one the repo is on** — a rename sweep will otherwise drag it forward
  and prove the migration against its own output instead of against the corpus it must survive.
- **A table may carry a trigger that refuses your backfill.** `inventory_revisions` is guarded by
  `guard_inventory_revision_history`, which permits exactly one transition — superseding a current
  revision — and raises on every other UPDATE. Disable the trigger for the single backfill statement,
  re-enable it immediately, and widen the guard to cover any column you added. Do not weaken it.

### Applying — "migrations applied" is not proof

```bash
npm run db:migrate:local
```

**This command prints `migrations applied` when it applied nothing.** Two ways it silently skips: the
journal entry is missing (a hand-written `.sql` with no `_journal.json` entry is invisible to the
runner), or the journal timestamp is not newer than `drizzle.__drizzle_migrations`. The migration
ledger is `drizzle.__drizzle_migrations`, not `public`.

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

Then prove each new constraint refuses what it should by inserting rows that violate it — a constraint
that exists is not a constraint that works.

## Bootstrap the fixed administrator

Run once per environment, against a database you intend to change:

```bash
DATABASE_URL=… npx tsx packages/db/scripts/bootstrap-administrator.ts
```

Idempotent, and can create only `board@vigavashon.org`. The row confers authority; the configured
password proves access to that one account. There is no add-administrator path.

To provision or rotate the password itself, run `npm run admin:provision-password --workspace
@farm-friend/web` from a private terminal. It reads the password twice without echo, hashes it locally,
and streams only the verifier to Secret Manager over stdin — neither plaintext nor verifier reaches
output or command arguments.

Properties to preserve on this path:

- Every refusal is byte-identical: wrong email, wrong password, malformed input, missing config,
  revoked authority, and exhausted throttle.
- Failed attempts reserve durable account-wide and coarse-client budgets before verification.
- The browser receives the raw session token only in the secure cookie; Postgres stores its hash.
- Administrator and session revocation take effect on the next protected request.

## Seeding initial listing data

This is a **greenfield build**: existing VIGA map content is **reference input, not a schema
contract**, and there is no non-destructive migration requirement or provenance axis.

A **one-time seed utility** validates and atomically loads farms, sales locations, and the reviewed
usual-offering artifact. `db:seed` **writes no current inventory** — a stand it creates renders the
honest "no current listing" until something confirms it. It also seeds **no phone numbers**:
`farmer_authorizations` requires captured SMS consent, so phones arrive through onboarding, never a
bulk roster load.

**Inventory is seeded by a separate script, and only from a farmer's own dated statement** (F-062).
`db:seed-weekly` reads VIGA's weekly stock form — a Google Form farmers have filled in for years — and
writes each farm's latest submission as an `inventory_revisions` row carrying **`source = 'viga'`** and
none of the three keys asserting a handset sent it (F-063). That is not a fabricated confirmation: it
is a real, dated statement a farmer made, honestly labelled, and the staleness machinery ages it with
no special handling. **A farmer's own SMS always wins** — the writer refuses to overwrite anything
newer, whatever its source.

**It takes both exports plus the reviewed offering artifact.** Neither export can seed a visitable
location alone: the form has the current details and **no coordinates at all**, while the map export
has the coordinates and the farms that submitted no form.

```bash
npm run db:seed -- --form "<form.csv>" --map "<map.csv>" \
  --offerings maps/offerings-proposals.json --dry-run                # report only, writes nothing
npm run db:seed -- --form "<form.csv>" --map "<map.csv>" \
  --offerings maps/offerings-proposals.json                          # apply atomically

# The weekly stock form, as dated `source = 'viga'` confirmations. --form is optional and lets a
# farmer's STATED rename resolve their old name to their current stand.
npm run db:seed-weekly -- --weekly "<weekly.csv>" --form "<form.csv>" --season 2026 --dry-run
npm run db:seed-weekly -- --weekly "<weekly.csv>" --form "<form.csv>" --season 2026
```

**Always pass `--expect-database` for a non-local write** (F-064). Both seed scripts accept it, and it
aborts before writing a single row unless the connection really lands on that database. Naming the
target is not enough on its own — printing `host/neondb` confirms the string an operator typed, not the
database it reaches. The guard reports what is *actually* there (database name, migrations applied,
farms, locations, revisions) and refuses anything unexpected.

The batch is transactional and idempotent by stand name: re-running never overwrites a farmer's later
correction. It refuses invalid coordinates rather than coercing them.

**An existing stand's empty SIDE TABLES are backfilled** (GL-015) — `farm_links`,
`sales_location_payment_methods`, and `sales_location_participants`. The stand's own listing — address,
coordinates, season, hours, stocking, description — is never rewritten. Every backfill write is `on
conflict do nothing`, so it fills gaps and never overwrites, reorders, or removes.

**A farm whose farmer holds a live authorization is refused outright**, reported as `refused N (farmer
owns the listing)`. Once a farmer owns their listing (Golden Rule #1), VIGA's older spreadsheet must
not add to it behind their back — a payment method or host they deliberately removed would otherwise
reappear on the next run.

**Hosted participants** (`Hosting: Kareli Farm` in the map prose) are written with `source = 'viga'`
and no confirming authorization, the same split F-063 made for inventory. A farmer takes ownership by
editing the list on their own settings page, which writes `source = 'sms'`.

Both scripts **report everything they did not do** — refused rows, unknown farms, and any farm name
that resolved to a stand under a *different* name. A submission landing on the wrong farm's card is the
failure the name matching exists to prevent, so non-exact matches stay visible rather than being
resolved quietly.

Corpus-specific operating facts:

- The form export owns current details; the map export owns coordinates and map-only farms. Their names
  join through the exact normalized key in `match-stands.ts`, never fuzzy similarity.
- **The map CSV is malformed:** records are anchored to `POINT (` by `stand-csv.ts`. Ordinary CSV
  parsing creates phantom farms — do not substitute a standard reader.
- **Production stand names carry typographic punctuation** — a curly apostrophe (U+2019) no phone
  keyboard produces. Test data written with a straight apostrophe misses it.
- **Weekday patterns are read into `open_days`** (B-039). VIGA asks "Open Hours & Days" as one question
  and farmers answer both axes, so `parseOpenDays` and `parseOpenHours` each read their own axis from
  the same answer. It refuses rather than guesses: a time-only answer, `See below`, and a seasonally
  split answer all store no days.
- The loader structures hours/season/specialties, drops dated inventory, strips direct phone/email, and
  retains public websites/social handles.
- Unresolvable coordinates become operator refusals, never fabricated points. **The seeder does no
  geocoding.** Only the onboarding form's address lookup produces a coordinate.
- `offering_type` and visitability are independent, and classification uses the farmer's words, not the
  farm name.

> **Manual guard — Handpicked Homestead (B-024):** keep it non-public and non-visitable. Its form says
> not to publish the home address, but the seeder does not consult `extraNotes` for visibility; a
> re-seed can republish it. Check this row until that defect is fixed.

**Offerings — proposed by the model, committed only after review (F-024/F-036).** Proposal and review
remain separate so no model output reaches the database without a human between:

```bash
DEEPINFRA_MODEL="<model-id>" npm run offerings:propose -- "<path-to-csv>" maps/offerings-proposals.json
# max reviews/edits the file. For an already-seeded database, then:
npm run db:seed-offerings -- maps/offerings-proposals.json --dry-run
npm run db:seed-offerings -- maps/offerings-proposals.json
```

The next full `db:seed` run consumes the same reviewed artifact automatically and commits stands plus
usual offerings in one transaction; omitting `--offerings` is a refusal, not a stand-only rebuild. The
proposal step strips contacts, passes the same provider privacy gate as production, and records each
tag beside its source text. Both commit paths are idempotent on `(location, item)` and write
specialties only — never inventory. `offerings:propose` reads only the map export; form-only farms are
absent rather than reported as rejected.

### Backfills and cleanups

If the database was seeded before public source descriptions and Farm Bucks facts were wired, use the
guarded null-only backfill against the reviewed public listing artifact:

```bash
node --env-file=.env --import tsx packages/db/scripts/backfill-public-listing-details.ts \
  maps/offerings-proposals.json --payment-facts maps/reviewed-payment-facts.json          # dry-run
node --env-file=.env --import tsx packages/db/scripts/backfill-public-listing-details.ts \
  maps/offerings-proposals.json --payment-facts maps/reviewed-payment-facts.json --apply  # null fields only
```

It matches by the same normalized stand key, strips direct contact details, reports unmatched source
entries, and never overwrites a description or reviewed payment fact.

`buildStandDescription` (F-061/B-044) strips prose that restates a structured fact — hours, season,
stocking, links, payments, dated updates, and reviewed usual items. For mixed text it removes only a
leading structured sentence and preserves the prose after it. Run the cleanup whenever the rule or
structured facts change:

```bash
DATABASE_URL="<neondb>" npx tsx scripts/clean-farm-descriptions.ts            # dry run, prints every diff
DATABASE_URL="<neondb>" npx tsx scripts/clean-farm-descriptions.ts --apply    # prompts for a typed confirmation
```

**Dry run is the default and no single flag writes.** It fingerprints the target and asserts the
database name before reading a row, writes a JSON backup of every prior value before opening the
transaction (there is no `farms.description` history table, so **that file is the rollback**), writes in
one transaction, and then **verifies by effect** — reading the rows back and comparing them to what was
intended rather than trusting the absence of an error. It is idempotent. Read the diff before
approving: a farm whose every line is structured is left with **no** description, which is correct, but
should be a decision rather than a surprise.

## Scheduled work (the worker trigger)

Inbound work has two triggers over the same Postgres-backed passes:

| Trigger | Route | Role |
|---|---|---|
| Cloud Tasks | `POST /api/internal/kick` | Immediate inbound/outbound passes for one sender |
| Cloud Scheduler | `POST /api/internal/cron` | Every-minute recovery: inbound → scheduled prompts → outbound → delivery → retention |

The webhook commits first, then awaits one bounded Cloud Task creation before returning 200.
`enqueueSenderWork` never throws and does not retry; a queue outage loses only latency because the
scheduled pass recovers the committed event. Deterministic task names make duplicate enqueue a success.
Postgres row locks and claims make task retries and concurrent scheduled work safe.

The scheduled passes are bounded and enumerate their own work:

- **Inbound:** deterministic routing and state transitions.
- **Scheduled prompts:** at most one due prompt per sender in deterministic stand order, using the
  per-stand cadence (seeded `weekly` at farmer setup, F-081) and the 10:00 AM stand-local slot. It
  advances delayed schedules without catch-up bursts and queues no work while paused or actively closed.
- **Outbound:** dispatch claim, provider send, and result.
- **Delivery:** applies stored carrier callbacks; provider acceptance alone is not delivery.
- **Retention:** clears expired bodies, preserving rows, minimized projections, attempts, flags, and
  audit. Open flagged threads are exempt; unresolved outbound work is never cleared; output is counts
  only.

Cloud Run's internal-only worker ingress plus IAM `run.invoker` is the primary authorization.
`DEPLOYMENT_ROLE=worker` is a second guard checked before application context; the public service
returns 404 for internal routes.

```bash
DEPLOYMENT_ROLE=worker npm run dev -w apps/web
curl -X POST http://localhost:3000/api/internal/cron
```

**Verify the schedule by database effect, not its dashboard:** expire an unflagged body, trigger or
wait for the schedule, and confirm the body and `body_expires_at` become `NULL` while the row survives.
For inventory prompts, make one preference due, trigger the same route, then verify the preference's
due-slot advance, the open proposal, typed scheduled subject, and queued outbox row. Verify suppression
by changing one dispatch basis before claim and observing both the outbox row and proposal become
terminal without a provider send. Add future scheduled work inside `runScheduledWork`; never create a
second cron surface.

## Telnyx webhook config

Point the Telnyx number's inbound webhook at `apps/web`'s webhook route
(`apps/web/app/api/sms/webhook/route.ts`). Requirements that must hold before live SMS:

- Read the **exact raw request bytes** and verify the webhook signature before parsing
  (<https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks>).
- After verification, commit only the minimized inbox projection with a unique provider event ID; do
  not retain the raw provider envelope or duplicate the raw E.164. **Acknowledge only after that
  commit**, within Telnyx's response window.
- Claim at most one ordinary stateful event per sender under a short Postgres row-lock transaction.
  Release before any model or SMS call, then re-lock and verify the claim/state before finalizing.
  Reject stale state transitions by provider occurrence order; order STOP/START on their separate
  consent watermark, with STOP winning an exact timestamp tie.
- Inbound messages enter the deterministic routing in [ARCHITECTURE.md](ARCHITECTURE.md) **before any
  model call**.
- Unconfirmed inventory lives only in the one pending proposal record. `YES` creates the immutable
  published revision in the confirmation transaction; `NO` and expiry create no revision.

Carrier keyword and confirmation requirements center on opt-in, opt-out, and help
(<https://support.telnyx.com/en/articles/10645338-10dlc-keywords-and-confirmation-messages>). **FLAG is
a Farm Friend product safety feature and must not be represented as a carrier-mandated keyword.**
Adding an outbound message type means adding a `message_category` enum value and deciding its consent
meaning in `packages/core/src/sms/consent.ts` — never adding a second consent state or enrollment. A
new category defaults to nothing: the predicate must be extended deliberately.

Built public routes (F-019): `GET /api/public/stands` (model-free, uncapped), `GET
/viga-farm-friend` (F-039 — model-free and database-free, uncapped; the legacy
`/api/public/contact-card` still serves the same handler for already-texted links, B-052; rendered from
`TELNYX_FROM_NUMBER`, never a literal, so it cannot drift from the sending number; saving a contact is
**not** `JOIN` and the copy must not imply it is), and `POST /api/public/stock-out` (throttled; body
carries the QR-bound `salesLocationId` UUID and `taskText`). The throttle budget is set in the
composition root — 5 model calls per client per 60s, deliberately generous so a real reporter never
meets it. **Adding any new public model-backed handler means routing it through
`context.publicActionThrottle`**; adding one that is model-free means leaving it out. Do not add a
public route that accepts a free-text *question* — inquiry is SMS-only.

## How to extend

Recipes live in **[EXTENDING.md](EXTENDING.md)**: add a future program, add an admin route or surface,
add a surface behind a farmer's standing link, add a model seam, or swap a provider. Open the one you
need — each states the invariants that addition must not break.

## Deploy (only when asked)

**Google Cloud Run** (two services from one image) against Neon Postgres. **Never deploy without
explicit approval.**

The shape, and why:

- **One image, two services, one digest.** `farm-friend-web` (public ingress) and `farm-friend-worker`
  (internal ingress + IAM) run the *same* artifact, distinguished only by `DEPLOYMENT_ROLE`. Both are
  pinned to the same digest, so the two can never drift apart — a tag could be repointed between
  applies and put different code in front of one database.
- **Terraform owns infrastructure; it never owns secret values or the image.** Values go in out of band
  (`gcloud secrets versions add`) because anything passed through Terraform lands in state, and state
  gets copied to buckets and pulled to laptops.

### Mount flags live in `infra/production.tfvars`, not in your shell history

Every `mount_*` variable defaults to **false**, because a secret's container must exist before its
value does. That default is right exactly once — the apply that creates the container — and wrong for
every apply afterwards. `GEOCODING_API_KEY` was live on web revision 00034 and stripped at 00035 by an
apply that passed only `mount_smtp_password=true`; it was absent through 00038, which since F-077 meant
production could not create a visitable stand at all, and every apply reported success.

So: **pass `-var-file=production.tfvars` on every plan and apply**, and when you add a mount flag, add
it to that file in the same change. `plan-assertions.py` fails by name on any plan that would unmount a
secret currently live on a service.

**`infra/terraform.tfvars` is gitignored**, so `rotation_applied_at` lives on one machine. A plan from
any other checkout moves it backward and silently rolls containers onto the pre-rotation secret while
reporting success.

`public_map_url` lives in that same file and is the same trap with a different ending: a checkout
without the current value deploys a URL disagreeing with the constant customer copy embeds, and the
container **refuses to start** (F-110) instead of quietly sending a stale link. Loud, but it is still
a value no repository holds.

**Run `infra/plan-assertions.py` before trusting it.** It was a SyntaxError under Python 3.10 for
several commits; a safety gate that fails to start looks identical to one nobody invoked.

### Secrets that need a container before a value

Geocoding, SMTP, and F-079's email verification each follow the same three-step gate, for the same
platform reason — `version = "latest"` resolves at container start, and a versionless secret makes
Cloud Run refuse the revision:

1. Apply with the feature's `mount_*` still `false`. This creates the empty containers and their IAM
   grants and changes nothing about what the services run.
2. Add the values over stdin. **`printf %s`, never `echo`**: a trailing newline in a salt produces
   hashes that look right in every listing and match nothing at runtime.

   ```bash
   printf %s "<value>" | gcloud secrets versions add farm-friend-<name> \
     --project farm-friend-vashon --data-file=-
   ```

3. Apply any migration the new code reads **before** deploying that code, then flip the `mount_*` flag
   in `production.tfvars` and apply.

For email verification specifically: **run F-078's roster ingest first** — it decides
`EMAIL_HASH_SALT`, and whatever salt it used is the value that must be stored.

```bash
# Dry run first. Writes NOTHING; reports what it would insert, which farm names match no farm, and
# which farms have no address on file. Then re-run with the SAME salt plus --commit.
EMAIL_HASH_SALT="$(openssl rand -hex 32)" \
FARM_STAND_RESPONSES_CSV=/path/to/2026-farm-stand-responses.csv \
DATABASE_URL="<neondb>" npx tsx scripts/ingest-farm-emails.ts
```

The script **pins an expected farm count** and refuses anything else, so a mistyped connection string
fails loudly instead of writing a roster somewhere else. Production holds 35 farms, so it needs
`EXPECTED_FARMS=35`; the default is deliberately left at its original 36 rather than re-pinned, because
**a guard edited to match whatever the database currently holds has stopped being a guard.**

**`EMAIL_HASH_SALT` can never be rotated** without re-ingesting the roster, and a mismatch between it
and the ingest is this feature's quietest failure: every farmer's correct address fails to match,
nothing errors, and the door verifies nobody.

### The deploy sequence

**Preflight is live evidence, never the release snapshot.** Before choosing a source baseline or
planning, fetch `origin/main`, inspect the serving revisions and their immutable digests, identify the
Cloud Build `SHORT_SHA`, and query Neon's migration ledger plus the schema effects the image expects.
If any of those contradict `CURRENT_STATE.md`, stop and correct the record first — never reconstruct a
hotfix from the commit the snapshot claims is live.

**Order matters.** A migration adding columns the new code writes must land *before* that code deploys,
or every affected write fails in the gap.

```bash
# 1. Migration FIRST. Use the DIRECT (non-pooled) Neon string for DDL.
DATABASE_URL='<direct production Neon URL>' npm run db:migrate

# 2. Build and publish. SHORT_SHA is required; without it the image reference is invalid.
gcloud builds submit --config cloudbuild.yaml --project farm-friend-vashon \
  --substitutions=SHORT_SHA=$(git rev-parse --short HEAD)

# 3. Resolve the immutable digest; never deploy a tag.
DIGEST=$(gcloud artifacts docker images describe \
  "us-west1-docker.pkg.dev/farm-friend-vashon/farm-friend/farm-friend:$(git rev-parse --short HEAD)" \
  --format='value(image_summary.digest)' --project farm-friend-vashon)

# 4. Plan and assert. `-var-file=production.tfvars` IS NOT OPTIONAL — see above.
cd infra
tofu plan -var-file=production.tfvars -var="image_digest=$DIGEST" -out=/tmp/tf.plan
tofu show -json /tmp/tf.plan | python3 plan-assertions.py

# 5. Apply only with approval.
tofu apply /tmp/tf.plan

# 6. Verify serving revisions are newer than every secret version they consume.
python3 deploy_assertions.py

# 7. Verify the served vCard's wire bytes, including CRLF delimiters.
python3 served_card_assertions.py
```

Review the plan for the intended delta as well as the safety assertions. Any unrelated change —
including a rotation marker moving backward — stops the deploy even when all assertions pass. **Delete
the plan file when you are done** (`rm /tmp/tf.plan`).

The migration command can exit 0 after silently skipping a migration whose journal timestamp is not
newer. Verify the intended schema effect, not the message:

```sql
select count(*) from drizzle.__drizzle_migrations;
select column_name, is_nullable from information_schema.columns
  where table_name = '<table>' and column_name in ('<new columns>');
select conname from pg_constraint where conname = '<new constraint>';
```

For a new environment, inspect `information_schema.tables` first. The initial migration's `CREATE TABLE
IF NOT EXISTS` can skip incompatible existing tables and leave a half-applied schema.

Fire a scheduled run rather than waiting:
`gcloud scheduler jobs run farm-friend-recovery --location=us-west1 --project farm-friend-vashon`

**Then verify by effect — a 200 from the scheduler is not proof the passes did anything.** Only F-026's
purge, which runs on this trigger alone, proves that:

```sql
-- Make one body eligible. Excludes threads under open flag review, so the exemption is not what is
-- being tested. Note the id it returns.
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

-- After a run: body AND body_expires_at must both be NULL (they clear as a pair), and the ROW must
-- still exist — the minimized projection survives, only the content goes.
```

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
fail with `ack=401`; otherwise the proof is vacuous. After restoring, the throwaway signature must fail
and the webhook must return 401 — not 500/503. The script does not clean up; remove only its reserved
`+1206555` rows under a guard that refuses any other contact.

### Carrier checks for a new live environment

Do not point the carrier at the app until the app can honor `STOP`.

1. Confirm the 10DLC campaign is **approved** and the number's campaign provisioning status is
   **Active**; attachment to the messaging profile alone is insufficient.
2. Point the messaging-profile webhook to `https://<deployment>/api/sms/webhook`. Leave Telnyx's three
   profile auto-response message fields empty so Farm Friend does not double-reply.
3. POST unsigned input first. Expected diagnostics:

   | Status | Meaning |
   |---|---|
   | 401 `missing_signature` | Telnyx configuration resolved |
   | 503 `webhook_not_configured` | `SMS_PROVIDER` is not `telnyx` |
   | 500 | a required Telnyx variable is missing/blank |

4. Verify a bad signature returns 401 before sending a real message.
5. Send real `STOP` first and verify durable consent, then `JOIN`/`START` as appropriate and `HELP`.
6. Prove the scheduler by retention effect; fast replies prove only Cloud Tasks.

## Credential rotation

Production secrets live in GCP Secret Manager (`farm-friend-*`); local commands also use `.env`. Never
expose a value in command arguments, output, transcripts, docs, commits, or issues. Add Secret Manager
versions through stdin and record replacements in the password manager when created.

### The rules that constrain every step

- **`PHONE_HASH_SALT` MUST NOT be rotated — ever.** It is the input to the only lookup key for every
  phone. Rotation orphans consent, contacts, flags, and reports. A suspected compromise requires a new,
  explicitly approved data-migration design; there is no generic recovery command.
- Rotate in place against the existing production providers and database. Fingerprint the target before
  changing it.
- Verify the new value before storing it; verify the deployed effect after a new revision; verify the
  old value is dead.
- **A new Secret Manager version does not update a running container.** Cloud Run resolves `version =
  "latest"` at container START, so only a revision that started *after* the secret version serves it —
  a release deployed minutes later can still run the old value. Bump `rotation_applied_at` in
  `infra/terraform.tfvars` and redeploy both services; `deploy_assertions.py` is the only check that
  catches this.

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

### Order

1. Create and verify the replacement against the intended provider/target.
2. Add it to Secret Manager over stdin; for the administrator password, use the provisioning command.
   Update local `.env` only where the table requires it.
3. Bump `rotation_applied_at` in `infra/terraform.tfvars` (`date -u +%Y-%m-%dT%H-%M`).
4. Run the normal plan, assertions, and approved apply.
5. Run `python3 infra/deploy_assertions.py`. A green apply is not a restart.
6. Verify the new value by effect and the old value by rejection. For an administrator password
   rotation, revoke every existing session immediately after the new revision is proven
   (fingerprint the target first):

   ```sql
   update admin_sessions
   set revoked_at = greatest(issued_at, now())
   where revoked_at is null
   returning id;
   ```

### Proof by effect

Run only after `deploy_assertions.py` confirms both services picked up the new versions.

| Credential | Proof it works | Proof the old value is dead |
|---|---|---|
| `DATABASE_URL` | a cold container opens a new connection and produces a known database effect | a connection attempt with it is refused (`password authentication failed`) |
| `TELNYX_API_KEY` | a real send returns a provider message ID; or a signed inbound webhook returns 401→200 end to end | a request to the Telnyx API returns **401** |
| `ADMIN_PASSWORD_HASH` | the fixed account signs in and a durable session-hash row appears | login returns the exact generic refusal; every pre-rotation cookie is refused after session revocation |
| `DEEPINFRA_API_KEY` | with paid-call approval, local `evals:live` proves `.env`; a deployed model-backed path proves Secret Manager | a request with it returns **401** |
| Telnyx configuration | unsigned webhook POST returns 401, not 500/503; a real send returns a provider ID | — |

Do not substitute a warm pooled database request, an old scheduler result, or local `evals:live` for
deployed proof. Each can pass while production still uses the old secret.

## Failure triage

- **Unit test needs a DB/SMS/model** → a seam isn't injected; pure logic must take the provider and
  `Clock` as arguments.
- **`tsc` fails on a model call or send** → you're bypassing the task-specific constructor or redactor;
  go through it (that's the static provenance barrier working).
- **Integration tests "pass" instantly** → `DATABASE_URL` is unset and they skipped. That is not a green
  data layer.
- **A hostile workflow test/eval exposes unavailable private data or forces a commit** → runtime
  projection, validation, or deterministic consequence handling has a bug; fix the code, not the prompt
  (Golden Rule #6). The failing eval detected the bug; it was not the production guard.
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

  `provider_error_detail` is phone-masked and capped at 500 chars, so it is safe to read and paste.

- **The provider accepted it but the farmer says it never arrived** → the dispatch attempt is the wrong
  place to look; read the *carrier's* verdict, which the delivery pass records (B-012):

  ```sql
  select delivery_status, delivery_occurred_at, dispatch_authorized_at, message_category
  from outbox_work
  where delivery_status is distinct from 'delivered'
    and dispatch_authorized_at is not null
  order by dispatch_authorized_at desc limit 20;
  ```

  `delivery_status` NULL with an authorized dispatch means **no callback has been applied yet** — either
  the carrier has not reported, or the delivery pass is not running (check that a scheduled run returns
  200; a 401 looks identical to success in any scheduler's UI). `delivery_failed` is the carrier
  rejecting it after Telnyx accepted it, which is the B-011 block shape. Watch for
  `provider_inbox_events` rows of type `message_sent`/`message_finalized` sitting `pending`: that is
  B-012's signature and means nothing is consuming them.

- **Production Neon IS reachable from a dev machine** — `gcloud secrets versions access latest
  --secret=farm-friend-database-url`. `apps/web/.env.local` points at local `farmfriend_dev`, so
  checking only the working tree makes production look inaccessible. Measure the real data before
  arguing about it.
- **A regex backslash inside a JS template literal never reaches Postgres.** `'\s+'` in a tagged
  template arrives as `s+` and silently strips the letter "s"; it must be written `'\\s+'`.
