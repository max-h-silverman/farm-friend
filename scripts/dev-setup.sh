#!/usr/bin/env bash
#
# Stand up a complete local admin console from nothing, and print how to run it.
#
# ## Why this script exists
#
# Every step below is discoverable from RUNBOOK.md, but three of them fail SILENTLY and cost
# an afternoon each:
#
#   - `.env.local` belongs in `apps/web/`, not the repo root. A root file is simply not read,
#     and the app starts fine without the values it needed.
#   - Next expands `$NAME` inside .env values. An Argon2id verifier is full of `$` segments,
#     so `ADMIN_PASSWORD_HASH` in a .env file arrives at the server SHORTER than it was
#     written and every sign-in refuses with the same generic message it gives a wrong
#     password. This script passes it as a real environment variable instead, which is the
#     only reliable fix — quoting does not help.
#   - Sign-in also refuses when no administrator ROW exists, which looks identical again.
#
# Safe to re-run: the database is created only if absent, migrations are idempotent, and the
# administrator bootstrap leaves an existing row alone. It refuses to touch anything remote.
#
# Usage:
#   ./scripts/dev-setup.sh              # set up, then print the run command
#   ./scripts/dev-setup.sh --run        # set up and start the dev server
#   ./scripts/dev-setup.sh --reset      # drop the local database first, then set up

set -euo pipefail

DB_NAME="farmfriend_dev"
ADMIN_EMAIL="board@vigavashon.org"
DEV_PASSWORD="localdevpassword"
ENV_FILE="apps/web/.env.local"

RUN_SERVER=false
RESET_DB=false
for argument in "$@"; do
  case "$argument" in
    --run) RUN_SERVER=true ;;
    --reset) RESET_DB=true ;;
    *) echo "usage: dev-setup.sh [--run] [--reset]" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."

# Homebrew's postgres is installed but not linked on this Mac (RUNBOOK §Prerequisites).
for version in 16 18; do
  candidate="/opt/homebrew/opt/postgresql@${version}/bin"
  if [ -x "${candidate}/psql" ]; then PATH="${candidate}:${PATH}"; break; fi
done
export PATH

if ! command -v psql >/dev/null 2>&1; then
  echo "psql not found. Install Postgres, or add its bin directory to PATH." >&2
  exit 1
fi
if ! pg_isready -q; then
  echo "Postgres is not accepting connections. Start it (brew services start postgresql@16)." >&2
  exit 1
fi

DB_USER="$(whoami)"
DB_URL="postgres://${DB_USER}@localhost:5432/${DB_NAME}"

# The database is local by construction here, but assert it anyway: this script drops and
# migrates, and a DATABASE_URL inherited from the shell has pointed at production before.
if [ -n "${DATABASE_URL:-}" ] && ! echo "${DATABASE_URL}" | grep -qE 'localhost|127\.0\.0\.1'; then
  echo "Refusing to run with a non-local DATABASE_URL in the environment:" >&2
  echo "  ${DATABASE_URL}" >&2
  echo "Unset it and re-run; this script builds its own local connection string." >&2
  exit 1
fi

if [ "${RESET_DB}" = true ]; then
  echo "==> Dropping ${DB_NAME}"
  dropdb --if-exists "${DB_NAME}"
fi

if psql -lqt | cut -d'|' -f1 | grep -qw "${DB_NAME}"; then
  echo "==> Database ${DB_NAME} already exists"
else
  echo "==> Creating ${DB_NAME}"
  createdb "${DB_NAME}"
fi

echo "==> Writing ${ENV_FILE}"
# Deliberately WITHOUT ADMIN_PASSWORD_HASH — see the header. Everything here is a throwaway
# local value: stub model (no spend), simulator SMS (no texts), a salt that matches nothing.
cat > "${ENV_FILE}" <<EOF
DATABASE_URL=${DB_URL}
PHONE_HASH_SALT=local-dev-only-not-a-real-salt-000000
PUBLIC_BASE_URL=http://localhost:3000
PUBLIC_MAP_URL=http://localhost:3000
LLM_PROVIDER=stub
SMS_PROVIDER=simulator
EMAIL_PROVIDER=simulator
SIMULATED_MAIL_DIR=.mail
EOF

echo "==> Applying migrations"
DATABASE_URL="${DB_URL}" npm run db:migrate --silent

# Verify by EFFECT, never by the words "migrations applied": a migration command can exit 0
# having skipped a migration whose journal timestamp is not newer than the last applied one.
applied_tables="$(psql "${DB_URL}" -tAc \
  "select count(*) from information_schema.tables where table_schema='public' and table_name in ('farms','sales_locations','administrators');")"
if [ "${applied_tables}" -ne 3 ]; then
  echo "Migrations did not produce the expected schema (found ${applied_tables}/3 core tables)." >&2
  exit 1
fi

echo "==> Bootstrapping the administrator row"
DATABASE_URL="${DB_URL}" npx tsx packages/db/scripts/bootstrap-administrator.ts

admin_rows="$(psql "${DB_URL}" -tAc \
  "select count(*) from administrators where email='${ADMIN_EMAIL}' and revoked_at is null;")"
if [ "${admin_rows}" -lt 1 ]; then
  echo "No live administrator row exists; sign-in would refuse with no explanation." >&2
  exit 1
fi

# Any failed attempts from an earlier session outlive the process and refuse a CORRECT
# password with the same generic message.
psql "${DB_URL}" -qc "delete from admin_login_failures;" >/dev/null

echo "==> Generating a throwaway admin verifier"
ADMIN_PASSWORD_HASH="$(npx tsx scripts/dev-admin-hash.ts "${DEV_PASSWORD}")"
export ADMIN_PASSWORD_HASH

# THE GEOCODING KEY IS READ FROM SECRET MANAGER, NEVER WRITTEN TO ${ENV_FILE}.
#
# It is the one real, billed credential local dev touches, and unlike everything else in that
# file it is not a throwaway. Writing it to disk puts a live key in a file that only .gitignore
# keeps out of the repository; fetching it per run keeps GCP the single place it lives.
#
# Optional by design: without it the form degrades exactly as a deployment with no key does —
# the lookup returns `not_configured` and tells the farmer to contact VIGA. That is a supported
# state, so a developer with no gcloud login still gets a working console.
if command -v gcloud >/dev/null 2>&1; then
  echo "==> Fetching the geocoding key from Secret Manager"
  # `|| true` so a missing login, a revoked grant, or no network leaves the key empty rather
  # than aborting a setup whose other twelve steps have nothing to do with geocoding.
  GEOCODING_API_KEY="$(gcloud secrets versions access latest \
    --secret=farm-friend-geocoding-api-key \
    --project farm-friend-vashon 2>/dev/null || true)"
  export GEOCODING_API_KEY
  if [ -z "${GEOCODING_API_KEY}" ]; then
    echo "    No key available — address lookup will report itself unavailable."
  fi
fi

cat <<EOF

Local admin console is ready.

  URL       http://localhost:3000/admin
  Email     ${ADMIN_EMAIL}
  Password  ${DEV_PASSWORD}

The verifier is passed as an environment variable, NOT written to ${ENV_FILE} —
Next expands \$NAME inside .env values and would silently truncate it.

Start the server with:

  ADMIN_PASSWORD_HASH="\$(npx tsx scripts/dev-admin-hash.ts ${DEV_PASSWORD})" \\
  GEOCODING_API_KEY="\$(gcloud secrets versions access latest \\
    --secret=farm-friend-geocoding-api-key --project farm-friend-vashon)" \\
    npm run dev --workspace @farm-friend/web

or re-run this script with --run.

The geocoding key is NOT in ${ENV_FILE} — it is a live billed credential and GCP
Secret Manager is the only place it lives. Omit it and address lookup reports
itself unavailable, which is a supported state.

There are no farms yet: the real seeder needs VIGA's CSV exports (RUNBOOK §Seeding).
Add a farm from the console itself, or insert fixtures by hand.

If sign-in refuses a password you know is right, clear the throttle:
  psql "${DB_URL}" -c "delete from admin_login_failures;"

EOF

if [ "${RUN_SERVER}" = true ]; then
  echo "==> Starting the dev server"
  exec npm run dev --workspace @farm-friend/web
fi
