import { existsSync, readFileSync } from "node:fs";
import postgres from "postgres";

import { hashEmail, parseFarmEmails } from "@farm-friend/core";

// F-078 / F-079 — load VIGA's email roster, so a farmer can prove who they are.
//
// F-078 built `ingestFarmEmails` and its tests and shipped NO CALLER, so nothing could actually
// load the roster. This is that caller.
//
// ## THE SALT IS AN ARGUMENT, NOT A GENERATED VALUE, AND THAT IS THE POINT
//
// `EMAIL_HASH_SALT` is the input to the only lookup key for every address written here, and it
// **can never be rotated** — changing it orphans every stored hash with no way back short of
// re-ingesting. The application must later be configured with the SAME value, or the quietest
// failure in this feature follows: every farmer's correct address fails to match, nothing raises
// an error anywhere, and the door verifies nobody.
//
// So the salt is supplied explicitly and echoed back at the end for storing in Secret Manager. A
// script that generated one internally would decide an unrotatable production value and then
// discard it.
//
// ## Safety
//
// Insert-only and idempotent against `farm_emails_one_per_farm_address` — a re-run writes zero
// rows. The target is FINGERPRINTED before any write, because a database "assumed" to be the
// right one has held real user data more than once here. `--commit` is required; without it this
// is a dry run that rolls back and reports exactly what it would have done.

const salt = process.env.EMAIL_HASH_SALT?.trim();
if (salt === undefined || salt === "") {
  throw new Error(
    "EMAIL_HASH_SALT is required and is UNROTATABLE — supply the value you intend to store in " +
      "Secret Manager, not a fresh one",
  );
}
// Long enough that the hash is not attackable by guessing the salt. Enforced here rather than
// documented, because this value can never be changed once addresses are written under it.
if (salt.length < 32) {
  throw new Error(`EMAIL_HASH_SALT must be at least 32 characters; got ${salt.length}`);
}

const csvPath = process.env.FARM_STAND_RESPONSES_CSV;
if (csvPath === undefined || !existsSync(csvPath)) {
  throw new Error("FARM_STAND_RESPONSES_CSV must point at VIGA's farm-stand responses export");
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL required");

const commit = process.argv.includes("--commit");

/**
 * Minimal CSV reader for Google Sheets exports.
 *
 * Quote-aware, because a farm's address cell legitimately contains commas. The same reader the
 * corpus test uses, including the **BOM strip** — Google exports one, and without it the first
 * header cell is not findable by name and every row silently loses its farm name.
 */
function readCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Strip a UTF-8 BOM from the first header cell — Google Sheets exports one, and it would
  // otherwise make "Farm Name" unfindable, silently emptying every farm name. Written as an
  // escape rather than the literal character, which lint forbids as irregular whitespace.
  const header = rows.shift()!.map((h) => h.replace(/^\uFEFF/, ""));
  return rows
    .filter((r) => r.some((c) => c.trim() !== ""))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

const csvRows = readCsv(readFileSync(csvPath, "utf8"));

// Guards a VACUOUS RUN. Pointed at the map export instead of the responses form, every step
// below succeeds over zero usable rows — and "0 farms, 0 problems" reads exactly like success.
if (csvRows.length < 25) {
  throw new Error(`refusing: expected VIGA's responses export, found ${csvRows.length} rows`);
}
for (const column of ["Farm Name", "Email Address", "Email Address(es)"]) {
  if (!Object.keys(csvRows[0]!).includes(column)) {
    throw new Error(`refusing: the CSV has no "${column}" column — wrong export?`);
  }
}

const roster = parseFarmEmails(
  csvRows.map((r) => ({
    farmName: (r["Farm Name"] ?? "").trim(),
    primaryEmail: r["Email Address"] ?? "",
    listedEmails: r["Email Address(es)"] ?? "",
  })),
);

const withEmail = roster.filter((r) => r.emails.length > 0);
const withoutEmail = roster.filter((r) => r.emails.length === 0);
console.log(
  `parsed ${roster.length} farms: ${withEmail.length} with an address, ` +
    `${withoutEmail.length} without`,
);

const sql = postgres(databaseUrl, { max: 1 });

// FINGERPRINT BEFORE WRITING. A mistyped connection string must fail here rather than write a
// farmer roster into the wrong database.
const [fingerprint] = (await sql`
  select current_database() as db,
         (select count(*)::int from farms) as farms,
         (select count(*)::int from farm_emails) as emails
`) as unknown as [{ db: string; farms: number; emails: number }];
console.log("target:", JSON.stringify(fingerprint));

// PINNED, not a floor. Production holds 36 farm rows: VIGA's 35 real farms plus the one marked
// `Test Farm` (2026-08-06). A `< 25` style floor would happily accept a half-seeded database or
// the wrong one entirely and report "0 problems" over data nobody meant to touch.
//
// Override deliberately with EXPECTED_FARMS when the count legitimately changes — a farm joining
// VIGA is a real event, and this failing then is the guard doing its job, not a defect.
const expectedFarms = Number(process.env.EXPECTED_FARMS ?? 36);
if (fingerprint.farms !== expectedFarms) {
  throw new Error(
    `refusing: expected ${expectedFarms} farms, found ${fingerprint.farms} in ` +
      `${fingerprint.db}. Wrong database, or the roster changed — if the count is genuinely ` +
      `right, re-run with EXPECTED_FARMS=${fingerprint.farms}`,
  );
}

// Matching is by EXACT farm name, the same rule `resolveStandKey` uses. A wrong match here would
// attach one farmer's address to another farm and hand them control of the wrong listing.
const farmRows = (await sql`select id, name from farms`) as unknown as Array<{
  id: string;
  name: string;
}>;
const farmsByName = new Map(farmRows.map((f) => [f.name, f.id]));

let inserted = 0;
let skipped = 0;
const unmatched: string[] = [];

await sql
  .begin(async (tx) => {
    for (const farm of withEmail) {
      const farmId = farmsByName.get(farm.farmName);
      if (farmId === undefined) {
        // Reported, never dropped: an operator can only act on a name mismatch if told.
        unmatched.push(farm.farmName);
        continue;
      }
      for (const email of farm.emails) {
        // `on conflict do nothing` against the normalized unique index is the whole idempotency
        // story — a select-then-insert cannot serialize a row that does not exist yet.
        const written = (await tx`
          insert into farm_emails (farm_id, email, email_hash, added_at)
          values (${farmId}, ${email}, ${hashEmail(email, salt)}, now())
          on conflict do nothing
          returning id
        `) as unknown as Array<{ id: string }>;
        if (written.length > 0) inserted += 1;
        else skipped += 1;
      }
    }

    if (!commit) {
      // A dry run must leave nothing behind, and rolling back is the only way to report real
      // insert counts without writing them.
      throw new Error("__dry_run__");
    }
  })
  .catch((error: unknown) => {
    if (error instanceof Error && error.message === "__dry_run__") return;
    throw error;
  });

console.log(`${commit ? "INSERTED" : "would insert"}: ${inserted}`);
console.log(`already present: ${skipped}`);
if (unmatched.length > 0) {
  console.log(`UNMATCHED farm names (no address stored, farmer cannot verify): ${unmatched.join(", ")}`);
}
if (withoutEmail.length > 0) {
  console.log(
    `farms with NO address on file (must contact VIGA): ${withoutEmail.map((f) => f.farmName).join(", ")}`,
  );
}

// Verify BY EFFECT, from the rows, not from the counters above.
const [after] = (await sql`
  select count(*)::int as rows,
         count(distinct farm_id)::int as farms
  from farm_emails
`) as unknown as [{ rows: number; farms: number }];
console.log("farm_emails now:", JSON.stringify(after));

if (commit) {
  console.log(
    "\nSTORE THIS SALT — the application must be configured with the SAME value or no farmer " +
      "can verify:\n" +
      "  printf %s '<the EMAIL_HASH_SALT you just used>' | \\\n" +
      "    gcloud secrets versions add farm-friend-email-hash-salt " +
      "--project farm-friend-vashon --data-file=-",
  );
} else {
  console.log("\nDRY RUN — nothing was written. Re-run with --commit to write.");
}

await sql.end();
