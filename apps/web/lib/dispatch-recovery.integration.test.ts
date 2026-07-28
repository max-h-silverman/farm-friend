import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "@farm-friend/core";
import { DISPATCH_LEASE_MS, createDb, type Db } from "@farm-friend/db";
import type { AppContext } from "./composition";
import { runOutboundPass } from "./workers";

// GL-003 — a dispatch claim that is abandoned mid-flight is recovered, and never resent.
//
// `authorizeDispatch` commits `state = 'dispatching'` BEFORE the worker reads the body,
// redacts it, resolves a phone number, calls the provider, and records the outcome. Every
// one of those steps can throw, and the process can die outright. This suite covers both
// halves of the answer:
//
//   1. the pass survives a throw at each boundary after authorization, so ONE poisoned row
//      cannot stop the other work in the same pass;
//   2. whatever it leaves behind is recoverable by `recoverAbandonedDispatches`, and comes
//      back as `ambiguous` rather than `queued` — because the provider may already have
//      delivered the message to a real person's handset.
//
// Real Postgres, because the property under test is the durable state left behind by a
// failure, not the control flow that produced it.

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");
const databaseUrl = process.env.DATABASE_URL;

function requiredDatabaseUrl(): string {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required; a skipped integration run is not green");
  }
  return databaseUrl;
}

type OutboundContext = Pick<AppContext, "db" | "sendSms">;
const asContext = (context: OutboundContext): AppContext => context as AppContext;

const recipientHash = "7".repeat(64);

// Offsets from a clock-derived anchor, never a calendar literal (B-003).
const T0 = new Date(Date.now() - 24 * 60 * 60 * 1000);
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const BODY_EXPIRES_AT = at(48 * 60);

describe("abandoned dispatch recovery (integration)", () => {
  let adminClient: ReturnType<typeof postgres> | undefined;
  let sql: ReturnType<typeof postgres> | undefined;
  let db: Db | undefined;
  let testDatabaseName: string | undefined;

  const client = () => {
    if (!sql) throw new Error("suite database is not initialized");
    return sql;
  };
  const database = () => {
    if (!db) throw new Error("suite database is not initialized");
    return db;
  };

  beforeAll(async () => {
    const baseUrl = requiredDatabaseUrl();
    testDatabaseName = `farm_friend_gl003_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(baseUrl, { max: 1 });
    await adminClient.unsafe(`create database "${testDatabaseName}"`);

    const url = new URL(baseUrl);
    url.pathname = `/${testDatabaseName}`;

    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });

    sql = postgres(url.toString(), { max: 4 });
    db = createDb(url.toString());
  }, 60_000);

  afterAll(async () => {
    if (db) await db.close();
    if (sql) await sql.end({ timeout: 5 });
    if (adminClient && testDatabaseName) {
      await adminClient.unsafe(
        `drop database if exists "${testDatabaseName}" with (force)`,
      );
      await adminClient.end({ timeout: 5 });
    }
  });

  beforeEach(async () => {
    await client()`
      truncate table outbox_dispatch_attempts, outbox_work, sms_consents,
        consent_transition_watermarks, contacts restart identity cascade
    `;
    // Active consent, so the dispatch claim is permitted rather than suppressed.
    // The consent row references a real contact; the raw E.164 lives in that one column.
    await client()`
      insert into contacts (phone_e164, phone_hash)
      values ('+12065550701', ${recipientHash})
    `;
    // `sms_consents_coherent_capture` requires source, instant, and evidence together: an
    // active consent that cannot say where it came from is not a consent record.
    await client()`
      insert into sms_consents (
        recipient_hash, state, capture_source, captured_at, capture_evidence_ref, updated_at
      ) values (
        ${recipientHash}, 'active', 'join', ${T0}, 'gl003-fixture-consent', ${T0}
      )
    `;
  });

  async function queueWork(logicalKey: string): Promise<string> {
    const rows = await client()`
      insert into outbox_work (
        logical_key, recipient_hash, message_category, body, body_expires_at, available_at
      )
      values (
        ${logicalKey}, ${recipientHash}, 'inventory_prompt', 'hello',
        ${BODY_EXPIRES_AT}, ${T0}
      )
      returning id
    `;
    return rows[0]?.id as string;
  }

  const workState = async (id: string): Promise<string> => {
    const rows = await client()`select state from outbox_work where id = ${id}`;
    return rows[0]?.state as string;
  };

  /**
   * Each throw site AFTER `authorizeDispatch` has committed. These are the real boundaries
   * the worker crosses between claiming the row and resolving it — this is the interval the
   * whole item is about.
   */
  const throwSites = [
    {
      name: "the provider transport throws",
      context: (): OutboundContext => ({
        db: database(),
        sendSms: async () => {
          throw new Error("provider transport exploded");
        },
      }),
    },
    {
      name: "recipient resolution throws",
      context: (): OutboundContext => ({
        db: database(),
        sendSms: async () => {
          // What `createLastMileSender` does when the phone resolver itself fails.
          throw new Error("recipient could not be resolved");
        },
      }),
    },
  ] as const;

  for (const site of throwSites) {
    it(`leaves recoverable state when ${site.name}`, async () => {
      const workId = await queueWork(`gl003-throw-${site.name.replaceAll(" ", "-")}`);

      // The pass must not propagate the throw: one poisoned row cannot abort the pass.
      await expect(
        runOutboundPass({
          context: asContext(site.context()),
          clock: new FixedClock(at(1)),
        }),
      ).resolves.toBeDefined();

      // The row is stranded mid-flight, which is honest — we genuinely do not know whether
      // the provider saw it. What matters is that it is now RECOVERABLE.
      expect(await workState(workId)).toBe("dispatching");

      const recovered = await database().sql`
        select id from outbox_work
        where state = 'dispatching' and dispatch_authorized_at is not null
      `;
      expect(recovered).toHaveLength(1);
    });
  }

  it("does not abort the whole pass when one row throws", async () => {
    // The pass is a recovery net for every sender. A single failing row that aborted it
    // would let one poisoned message block everyone else's replies indefinitely.
    const poisoned = await queueWork("gl003-poison");
    const healthy = await queueWork("gl003-healthy");

    let calls = 0;
    const result = await runOutboundPass({
      context: asContext({
        db: database(),
        sendSms: async ({ idempotencyKey }) => {
          calls += 1;
          if (idempotencyKey === poisoned) throw new Error("boom");
          return { outcome: "accepted", providerMessageId: `prov-${idempotencyKey}` };
        },
      }),
      clock: new FixedClock(at(1)),
    });

    expect(calls).toBe(2);
    expect(result.sent).toBe(1);
    expect(await workState(healthy)).toBe("sent");
    expect(await workState(poisoned)).toBe("dispatching");
  });

  it("recovers the stranded row as ambiguous, and never sends it again", async () => {
    const workId = await queueWork("gl003-end-to-end");

    // 1. A pass dies mid-dispatch.
    await runOutboundPass({
      context: asContext({
        db: database(),
        sendSms: async () => {
          throw new Error("process died mid-dispatch");
        },
      }),
      clock: new FixedClock(at(1)),
    });
    expect(await workState(workId)).toBe("dispatching");

    // 2. A later pass, past the lease, recovers it. This is the scheduled pass doing it —
    //    not a hand call to the transaction — so the production wiring is what is proven.
    let sends = 0;
    await runOutboundPass({
      context: asContext({
        db: database(),
        sendSms: async ({ idempotencyKey }) => {
          sends += 1;
          return { outcome: "accepted", providerMessageId: `prov-${idempotencyKey}` };
        },
      }),
      clock: new FixedClock(new Date(at(1).getTime() + DISPATCH_LEASE_MS + 1)),
    });

    // 3. Quarantined, not resent. The farmer may already be holding this message.
    expect(await workState(workId)).toBe("ambiguous");
    expect(sends).toBe(0);

    const attempts = await client()`
      select count(*)::integer as count from outbox_dispatch_attempts
      where outbox_work_id = ${workId}
    `;
    expect(attempts[0]?.count).toBe(1);
  });

  it("does not quarantine a claim that is merely slow", async () => {
    // The guard on the lease: expiring an in-progress call would quarantine work that is
    // about to succeed, and could strand a reply the sender is waiting on.
    const workId = await queueWork("gl003-slow");

    await runOutboundPass({
      context: asContext({
        db: database(),
        sendSms: async () => {
          throw new Error("still working, from the recovery pass's point of view");
        },
      }),
      clock: new FixedClock(at(1)),
    });

    // One minute later — well inside the lease.
    await runOutboundPass({
      context: asContext({
        db: database(),
        sendSms: async () => ({ outcome: "accepted", providerMessageId: "prov-slow" }),
      }),
      clock: new FixedClock(at(2)),
    });

    expect(await workState(workId)).toBe("dispatching");
  });
});
