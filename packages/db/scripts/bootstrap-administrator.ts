import { createDb } from "../src/index";

// Bootstrap the one fixed administrator authority.
//
// Authorization has a chicken-and-egg problem: only an administrator can grant authority, so
// the first one has to come from outside the application. The three ways to do that are not
// equally good, and this is deliberately the third:
//
//   - **First-user-wins** — whoever reaches the login URL first becomes an operator. On a
//     public URL that is not a bootstrap, it is an open door to every farm's published state.
//   - **An env-var allowlist** — authorization would live in configuration, where the audit
//     trail cannot record who granted it or when, and a deploy setting silently becomes a
//     permission grant.
//   - **This script** — authorization lives in DATA, as a row someone deliberately created,
//     with an `authorized_at` and the same revocation path as every other grant.
//
// Run it once per environment against a database you intend to change:
//
//   DATABASE_URL=… npx tsx packages/db/scripts/bootstrap-administrator.ts
//
// Idempotent: the fixed live administrator is left alone on a re-run.

const FIXED_ADMIN_EMAIL = "board@vigavashon.org";

async function main(): Promise<number> {
  if (process.argv.length > 2) {
    process.stderr.write("usage: bootstrap-administrator.ts\n");
    return 2;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === "") {
    process.stderr.write("DATABASE_URL is required\n");
    return 2;
  }

  const db = createDb(databaseUrl);
  try {
    const existing = await db.sql`
      select id from administrators
      where email = ${FIXED_ADMIN_EMAIL} and revoked_at is null
    `;
    if (existing.length > 0) {
      process.stdout.write("fixed administrator already authorized\n");
      return 0;
    }
    await db.sql`
      insert into administrators (email, authorized_at) values (${FIXED_ADMIN_EMAIL}, now())
    `;
    process.stdout.write("fixed administrator authorized\n");
    return 0;
  } finally {
    await db.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
