/**
 * Re-hash every phone-derived key under a new `PHONE_HASH_SALT`.
 *
 *   npm run db:rehash-phones -- --dry-run
 *   npm run db:rehash-phones -- --confirm
 *
 * ## Why this exists, when the rule is "never rotate the salt"
 *
 * That rule is shorthand for "there is no way back": the hash is one-way, so a new salt
 * normally orphans every phone-keyed row with no way to reconnect it to a person. It holds
 * whenever the raw numbers are gone — which is the steady state, since `contacts.phone_e164`
 * is the ONLY place a raw number lives and the retention purge eventually clears everything
 * else.
 *
 * It does NOT hold while the raw numbers are still present. `contacts.phone_e164` is exactly
 * the input `hashPhone` needs, so every hash can be recomputed deterministically and every
 * referencing row updated in one transaction. That is this script.
 *
 * The situation it was written for: the production salt was set in Vercel, marked Sensitive,
 * and therefore write-only — `vercel env ls` shows "Encrypted" and `vercel env pull` returns
 * `[SENSITIVE]`. The value existed in exactly one unreadable place and was lost. The database
 * held 2 contacts from live SMS testing, both with raw numbers intact, so a re-hash was cheap.
 * It will not stay cheap: once real farmers and customers text in and their bodies age out,
 * the raw numbers are all that stand between a lost salt and unrecoverable data.
 *
 * **Record the salt in a password manager at the moment you set it.** This script is the
 * recovery path for losing it, and it only works while the raw numbers survive.
 *
 * ## Safety
 *
 * - Refuses to run without `--confirm`; `--dry-run` reports what would change.
 * - FINGERPRINTS the target first and prints it, so a mistyped connection string is visible
 *   before anything is written rather than after.
 * - One transaction. Either every table moves to the new salt or none does — a partial
 *   re-hash would leave rows keyed under two different salts, which is worse than either.
 * - Verifies afterwards that no row still carries an old hash, inside the same transaction,
 *   and rolls back if any does.
 * - Never prints a raw phone number or a full hash.
 */

import postgres from "postgres";
import { hashPhone } from "@farm-friend/core";

/** Every column that stores a PHONE-derived hash. */
const HASH_COLUMNS: readonly { table: string; column: string }[] = [
  { table: "sms_consents", column: "recipient_hash" },
  { table: "sms_messages", column: "sender_hash" },
  { table: "outbox_work", column: "recipient_hash" },
  { table: "sender_states", column: "sender_hash" },
  { table: "provider_inbox_events", column: "sender_hash" },
  { table: "consent_transition_watermarks", column: "recipient_hash" },
  { table: "flags", column: "contact_hash" },
  { table: "inventory_publication_proposals", column: "sender_hash" },
  { table: "audit_events", column: "actor_contact_hash" },
  // `contacts.phone_hash` is updated LAST and separately: it is the source of truth every
  // other table's value is derived from, so moving it first would destroy the join key the
  // other updates need.
];

// Deliberately NOT in the list: `admin_sessions.token_hash` and `.magic_nonce_hash`. Those
// hash session tokens and link nonces, not phone numbers, and are unrelated to this salt.
// Including them would corrupt every active admin session for no reason.

function arg(name: string): boolean {
  return process.argv.includes(name);
}

async function main(): Promise<void> {
  const dryRun = arg("--dry-run");
  const confirmed = arg("--confirm");

  if (!dryRun && !confirmed) {
    console.error(
      "Refusing to run. Pass --dry-run to preview, or --confirm to apply.\n" +
        "This rewrites the lookup key for every phone in the database.",
    );
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  const oldSalt = process.env.OLD_PHONE_HASH_SALT ?? "";
  const newSalt = process.env.NEW_PHONE_HASH_SALT;

  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!newSalt) throw new Error("NEW_PHONE_HASH_SALT is required");
  if (newSalt === oldSalt) throw new Error("the new salt is identical to the old one");

  const sql = postgres(databaseUrl, { max: 1 });

  try {
    // ---------------------------------------------------------------------
    // Fingerprint the target BEFORE touching it.
    // ---------------------------------------------------------------------
    // A mistyped connection string must fail visibly here, not silently rewrite the wrong
    // database. The precedent is a reset script written for a database assumed empty that in
    // fact held real community data; only its row-count guard prevented the loss.
    const [fingerprint] = await sql`
      select current_database() as database,
             (select count(*) from contacts) as contacts,
             (select count(*) from sms_messages) as messages,
             (select count(*) from sales_locations) as stands
    `;
    console.log("Target database");
    console.log(`  name:     ${fingerprint!.database}`);
    console.log(`  contacts: ${fingerprint!.contacts}`);
    console.log(`  messages: ${fingerprint!.messages}`);
    console.log(`  stands:   ${fingerprint!.stands}`);
    console.log("");

    const contacts = await sql<{ phone_e164: string; phone_hash: string }[]>`
      select phone_e164, phone_hash from contacts
      where phone_e164 is not null and phone_hash is not null
    `;

    if (contacts.length === 0) {
      console.log("No contacts with a raw number. Nothing to re-hash.");
      return;
    }

    // The whole reason this is possible: the raw number regenerates the hash.
    const mapping = contacts.map((row) => ({
      lastFour: row.phone_e164.slice(-4),
      oldHash: row.phone_hash,
      newHash: hashPhone(row.phone_e164, newSalt),
    }));

    // A contact whose stored hash does not match the OLD salt means the old salt supplied is
    // wrong — or rows are already keyed under a third salt. Either way, stop: rewriting from
    // a wrong starting point produces a database keyed under two salts at once.
    if (oldSalt !== "") {
      const mismatched = contacts.filter(
        (row) => hashPhone(row.phone_e164, oldSalt) !== row.phone_hash,
      );
      if (mismatched.length > 0) {
        throw new Error(
          `${mismatched.length} contact(s) do not hash to their stored value under ` +
            "OLD_PHONE_HASH_SALT. The old salt is wrong; refusing to proceed.",
        );
      }
      console.log("Old salt verified against every stored hash.");
    } else {
      console.log(
        "No OLD_PHONE_HASH_SALT supplied — proceeding by JOIN on the stored hash.\n" +
          "  (Correct when the old salt is lost; the raw number is the source of truth.)",
      );
    }
    console.log("");

    console.log(`Re-hashing ${mapping.length} contact(s):`);
    for (const m of mapping) {
      console.log(
        `  (•••) •••-${m.lastFour}: ${m.oldHash.slice(0, 8)}… → ${m.newHash.slice(0, 8)}…`,
      );
    }
    console.log("");

    // Count what each table would change, for the dry run and the record.
    for (const { table, column } of HASH_COLUMNS) {
      const [row] = await sql`
        select count(*)::int as n from ${sql(table)}
        where ${sql(column)} = any(${mapping.map((m) => m.oldHash)})
      `;
      if ((row!.n as number) > 0) console.log(`  ${table}.${column}: ${row!.n} row(s)`);
    }

    if (dryRun) {
      console.log("\nDRY RUN — nothing was written.");
      return;
    }

    // ---------------------------------------------------------------------
    // One transaction: all tables or none.
    // ---------------------------------------------------------------------
    await sql.begin(async (tx) => {
      // INSERT the new parent, repoint the children, THEN delete the old parent.
      //
      // Two simpler approaches were tried against a real database and both failed, which is
      // why this one looks roundabout:
      //
      //   1. "children first, contacts last" — the children immediately point at a parent
      //      hash that does not exist yet, violating
      //      `sms_consents_recipient_hash_contacts_phone_hash_fk`.
      //   2. `set constraints all deferred` — has no effect here. All eleven foreign keys
      //      onto `contacts.phone_hash` were created NOT DEFERRABLE, so deferral is not
      //      available to ask for at runtime.
      //
      // The way through is to make BOTH parent rows exist while the children move. At no
      // point does any child reference a missing parent, so nothing has to be deferred and
      // no constraint is weakened to accommodate this script.
      //
      // Both failures rolled back cleanly with the data untouched, which is the transaction
      // doing its job — but they are recorded here because the next person to read this will
      // reasonably wonder why it is not a simple UPDATE.
      for (const m of mapping) {
        await tx`
          insert into contacts (phone_e164, phone_hash)
          select phone_e164, ${m.newHash} from contacts where phone_hash = ${m.oldHash}
          on conflict (phone_hash) do nothing
        `;
      }

      for (const { table, column } of HASH_COLUMNS) {
        for (const m of mapping) {
          await tx`
            update ${tx(table)} set ${tx(column)} = ${m.newHash}
            where ${tx(column)} = ${m.oldHash}
          `;
        }
      }

      // The old parents are now unreferenced, so they can go.
      for (const m of mapping) {
        await tx`delete from contacts where phone_hash = ${m.oldHash}`;
      }

      // Verify INSIDE the transaction, so a miss rolls everything back rather than leaving
      // the database keyed under two salts.
      const oldHashes = mapping.map((m) => m.oldHash);
      for (const { table, column } of [
        { table: "contacts", column: "phone_hash" },
        ...HASH_COLUMNS,
      ]) {
        const [row] = await tx`
          select count(*)::int as n from ${tx(table)}
          where ${tx(column)} = any(${oldHashes})
        `;
        if ((row!.n as number) > 0) {
          throw new Error(
            `${table}.${column} still holds ${row!.n} old hash(es) after the update — ` +
              "rolling back.",
          );
        }
      }
    });

    console.log("Re-hash committed. Every phone-derived key now uses the new salt.");
    console.log("Set PHONE_HASH_SALT to the new value everywhere before the app next runs.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
