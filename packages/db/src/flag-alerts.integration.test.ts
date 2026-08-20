import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type { Sql } from "./sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimFlagsToAlert,
  createDb,
  markFlagAlerted,
  releaseFlagAlertClaim,
  type Db,
} from "./index";

/*
  F-123 — VIGA is emailed when a FLAG or an issue report arrives.

  The queue is otherwise only visible to someone who opens the console and looks, so a safety
  flag could sit unread indefinitely.

  What these tests insist on, and why each is its own property:

    1. **Claiming is the once-only guarantee.** The claim is an `update … where alerted_at is
       null returning …`, so two concurrent passes cannot both take one flag — a preceding read
       plus a later write is exactly the race that sends two emails. Tested with genuine
       contention, not `Promise.all` over two branches of one connection.
    2. **A claim is provisional until the send is accepted.** `alerted_at` is written only after
       the mail server takes it, so a failed send releases the flag and the next pass retries.
       An alert that vanishes because a mail server hiccuped is the failure this exists to
       prevent.
    3. **No raw phone material leaves the data layer** (Golden Rule #5). The projection carries
       the MASK and nothing else identifying — no `contact_hash`, no number.
    4. **Only NEW flags are claimed**: an already-alerted flag is never re-sent.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("flag alert claiming (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let db: Db | undefined;
  let databaseName = "";
  const ids: Record<string, string> = {};

  // Clock-derived, never a date literal (B-003 tripwire).
  const now = new Date(Date.now() - 60 * 60 * 1000);
  const sql = () => client as Sql;
  const database = () => db as Db;

  async function insertFlag(reason: string, phoneSuffix: string): Promise<string> {
    const phone = `+1206555${phoneSuffix}`;
    const hash = `${phoneSuffix}`.padStart(64, "a");
    await sql()`
      insert into contacts (phone_e164, phone_hash) values (${phone}, ${hash})
      on conflict do nothing
    `;
    // A `message_received` event must name its message and its sender —
    // `provider_inbox_events_minimal_projection_per_event_type` enforces exactly the columns
    // each event type may carry, which is the privacy discipline stated as a constraint.
    const messages = await sql()`
      insert into sms_messages (provider_message_id, sender_hash, received_at)
      values (${randomUUID()}, ${hash}, ${now})
      returning id
    `;
    const events = await sql()`
      insert into provider_inbox_events (provider_event_id, event_type, message_id, sender_hash,
        occurred_at)
      values (${randomUUID()}, 'message_received', ${messages[0]?.id as string}, ${hash}, ${now})
      returning id
    `;
    const rows = await sql()`
      insert into flags (contact_hash, inbox_event_id, reason_code, status, created_at)
      values (${hash}, ${events[0]?.id as string}, ${reason}, 'open', ${now})
      returning id
    `;
    return rows[0]?.id as string;
  }

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    databaseName = `ff_flag_alerts_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(base, { max: 1 });
    await adminClient.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    // Several connections, because the contention test below needs real ones.
    client = postgres(url.toString(), { max: 6 });
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    db = createDb(url.toString());

    ids.flagged = await insertFlag("sender_flagged", "0101");
    ids.issue = await insertFlag("issue_reported", "0102");
  }, 30_000);

  afterAll(async () => {
    if (db) await db.close();
    if (client) await client.end({ timeout: 5 });
    if (adminClient && databaseName) {
      await adminClient.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminClient.end({ timeout: 5 });
    }
  }, 30_000);

  it("claims both a FLAG and an issue report, carrying no phone material", async () => {
    const claimed = await claimFlagsToAlert(database(), { limit: 10 });

    expect(claimed.map((row) => row.flagId).sort()).toEqual(
      [ids.flagged, ids.issue].sort(),
    );
    expect(claimed.map((row) => row.reasonCode).sort()).toEqual([
      "issue_reported",
      "sender_flagged",
    ]);

    // Golden Rule #5, asserted on the VALUE rather than on the field's name: a mask is four
    // digits, and nothing on this row may be a number or a hash.
    const serialized = JSON.stringify(claimed);
    expect(serialized, "no E.164 may reach the alert").not.toMatch(/\+1\d{10}/);
    expect(serialized, "no phone hash may reach the alert").not.toMatch(/[0-9a-f]{64}/);
    for (const row of claimed) {
      expect(row.senderMask).toMatch(/\d{4}$/);
    }
  });

  it("does not claim a flag a second time", async () => {
    // The claim already happened above and is still provisional — `markFlagAlerted` has not
    // run — so this proves the CLAIM itself excludes, not merely the mark.
    const again = await claimFlagsToAlert(database(), { limit: 10 });
    expect(again, "a claimed flag is not offered to the next pass").toEqual([]);
  });

  it("releases a flag whose send failed, so the next pass retries it", async () => {
    // The property that makes a provisional claim honest. Without it, one mail-server hiccup
    // silently drops a safety alert forever.
    //
    // Through the real writer, not a hand-written update: `releaseFlagAlertClaim` is what the
    // pass calls on a failed send, so testing the column directly would leave it unexercised.
    await releaseFlagAlertClaim(database(), { flagId: ids.flagged as string });

    const retried = await claimFlagsToAlert(database(), { limit: 10 });
    expect(retried.map((row) => row.flagId)).toEqual([ids.flagged]);
  });

  it("marks a flag alerted only when the send was accepted", async () => {
    await markFlagAlerted(database(), {
      flagId: ids.flagged as string,
      occurredAt: new Date(),
    });

    const rows = await sql()`select alerted_at from flags where id = ${ids.flagged as string}`;
    expect(rows[0]?.alerted_at).not.toBeNull();

    const after = await claimFlagsToAlert(database(), { limit: 10 });
    expect(after).toEqual([]);
  });

  it("gives one flag to exactly one of several simultaneous passes", async () => {
    // GENUINE CONTENTION, not `Promise.all` over two branches of one connection: six separate
    // claims race for one flag. `update … where alerted_at is null returning …` is the arbiter —
    // a read followed by a write would let several passes all observe "unalerted" and each send.
    const contended = await insertFlag("sender_flagged", "0103");

    const winners = await Promise.all(
      Array.from({ length: 6 }, () => claimFlagsToAlert(database(), { limit: 10 })),
    );
    const claims = winners.flat().filter((row) => row.flagId === contended);

    expect(
      claims,
      "one flag must produce exactly one email however many passes race for it",
    ).toHaveLength(1);
  });
});
