import { createDb } from "../src/index";

// Bootstrap the first administrator(s) (F-025a).
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
//   DATABASE_URL=… npx tsx packages/db/scripts/bootstrap-administrator.ts you@example.org
//
// Afterwards, administrators are managed in the database. Idempotent: an address that is
// already a live administrator is reported and left alone, so a re-run is safe.

async function main(): Promise<number> {
  const emails = process.argv.slice(2).map((value) => value.trim().toLowerCase());
  if (emails.length === 0) {
    process.stderr.write(
      "usage: bootstrap-administrator.ts <email> [email…]\n",
    );
    return 2;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === "") {
    process.stderr.write("DATABASE_URL is required\n");
    return 2;
  }

  // The database's own check constraint is the real guard; validating here turns a constraint
  // violation into a legible message before anything is written.
  const invalid = emails.filter(
    (email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
  );
  if (invalid.length > 0) {
    process.stderr.write(`not an email address: ${invalid.join(", ")}\n`);
    return 2;
  }

  const db = createDb(databaseUrl);
  try {
    for (const email of emails) {
      const existing = await db.sql`
        select id from administrators where email = ${email} and revoked_at is null
      `;
      if (existing.length > 0) {
        process.stdout.write(`already an administrator: ${email}\n`);
        continue;
      }
      await db.sql`
        insert into administrators (email, authorized_at) values (${email}, now())
      `;
      process.stdout.write(`authorized: ${email}\n`);
    }
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
