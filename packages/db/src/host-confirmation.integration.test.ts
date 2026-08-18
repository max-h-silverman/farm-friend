import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { answerHostConfirmation, openHostConfirmation } from "./index";
import type { Db } from "./index";
import type { Sql } from "./sql";

/*
  F-117 — THE HOST IS ASKED, AND MAY DENY.

  ## Why the host is asked at all

  A seller self-selecting a stand with no way for the owner to object would let anyone list goods
  at any stand on the island, with the owner unable to remove them. That inverts the rule F-116
  settled — either side may always walk away — so the host must be able to end it.

  ## The rule these cases enforce: LAST MESSAGE IN THE THREAD

  max settled (2026-08-17) that the question is answerable only while it is the last message in
  the thread. Any other traffic in either direction — the host texting us anything, or the system
  sending them anything — closes it.

  This is Golden Rule #2's requirement met by CONVERSATION STATE rather than by a clock:
  context-bound rather than global, committing exactly once, and expiring. A bare `YES` can never
  be misread against a stale question, because a stale question is no longer open.

  **Both directions are asserted, and the SYSTEM-SENT one is the case a weaker implementation
  forgets**: it is easy to check whether the host said something since, and easy to forget that a
  scheduled inventory prompt we sent also closed the question.

  ## What a NO does

  It ends the arrangement through `setProviderParticipation` — the same seam and the same
  authority rule as every other ending. A host ENDING is exactly what F-116 already permits, so
  this introduces no new authority. That is asserted by EFFECT here (the row ends) and proved to
  route through the seam by the caller's own suite.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("F-117 the host's confirmation (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";

  let hostSellerId = "";
  let hostStandId = "";
  let hostHash = "";
  let guestSellerId = "";
  let providerId = "";

  const T0 = new Date("2026-06-01T17:00:00.000Z");
  const T1 = new Date("2026-06-01T18:00:00.000Z");
  const T2 = new Date("2026-06-01T19:00:00.000Z");

  const handle = (): Db => {
    if (!sql) throw new Error("database not initialized");
    return { sql, orm: undefined as never, close: async () => {} };
  };
  const client = (): Sql => {
    if (!sql) throw new Error("database not initialized");
    return sql;
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_hostconfirm_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    sql = postgres(url.toString(), { max: 5 });
  }, 60_000);

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  }, 30_000);

  beforeEach(async () => {
    await client()`truncate contacts, sellers, sales_locations restart identity cascade`;

    const hosts = await client()`insert into sellers (name) values ('Kelseys Farm') returning id`;
    hostSellerId = hosts[0]?.id as string;
    hostHash = `h${randomUUID().replaceAll("-", "")}`;
    const hostContacts = await client()`
      insert into contacts (phone_e164, phone_hash, created_at)
      values ('+12065550111', ${hostHash}, ${T0}) returning id
    `;
    await client()`
      insert into farmer_authorizations (seller_id, contact_id, phone_verified_at, authorized_at)
      values (${hostSellerId}, ${hostContacts[0]?.id as string}, ${T0}, ${T0})
    `;
    const stands = await client()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        is_public, farm_bucks_accepted, farm_bucks_eligible,
        public_address, public_latitude, public_longitude
      ) values (
        ${hostSellerId}, 'farm_stand', 'Kelseys Stand', 'America/Los_Angeles',
        'visitable', 'produce', true, false, false,
        '1 Kelsey Road', 47.4473, -122.4590
      ) returning id
    `;
    hostStandId = stands[0]?.id as string;

    const guests = await client()`insert into sellers (name) values ('Gracies Greens') returning id`;
    guestSellerId = guests[0]?.id as string;
    const providers = await client()`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state,
        invited_at, accepted_at, approval_source, approved_at
      ) values (
        ${hostStandId}, ${guestSellerId}, 'active',
        ${T0}, ${T0}, 'seller', ${T0}
      ) returning id
    `;
    providerId = providers[0]?.id as string;
  });

  /** Something the HOST texted us, after the question. */
  async function hostSaidSomething(at: Date): Promise<void> {
    await client()`
      insert into sms_messages (provider_message_id, sender_hash, received_at)
      values (${`m-${randomUUID()}`}, ${hostHash}, ${at})
    `;
  }

  /** Something the SYSTEM sent the host, after the question. */
  async function systemSentSomething(at: Date): Promise<void> {
    await client()`
      insert into outbox_work (
        logical_key, recipient_hash, message_category, body, body_expires_at,
        available_at, created_at
      ) values (
        ${`k-${randomUUID()}`}, ${hostHash}, 'inventory_prompt', 'What do you have?',
        ${T2}, ${at}, ${at}
      )
    `;
  }

  async function ended(): Promise<boolean> {
    const rows = await client()`
      select ended_at from stand_providers where id = ${providerId}
    `;
    return rows[0]?.ended_at !== null;
  }

  it("confirms on YES while the question is still the last message", async () => {
    await openHostConfirmation(handle(), {
      hostHash,
      standProviderId: providerId,
      askedAt: T0,
    });

    const answer = await answerHostConfirmation(handle(), {
      hostHash,
      token: "YES",
      occurredAt: T1,
    });
    expect(answer.status).toBe("confirmed");
    expect(await ended()).toBe(false);

    // Consumed EXACTLY ONCE: a second YES has nothing to answer.
    const again = await answerHostConfirmation(handle(), {
      hostHash,
      token: "YES",
      occurredAt: T1,
    });
    expect(again.status).toBe("no_open_question");
  });

  it("ends the arrangement on NO, through the participation seam", async () => {
    await openHostConfirmation(handle(), {
      hostHash,
      standProviderId: providerId,
      askedAt: T0,
    });

    const answer = await answerHostConfirmation(handle(), {
      hostHash,
      token: "NO",
      occurredAt: T1,
    });
    expect(answer.status).toBe("denied");
    expect(await ended()).toBe(true);
    // And it is consumed, so a second NO cannot end something else.
    expect(
      (await answerHostConfirmation(handle(), { hostHash, token: "NO", occurredAt: T1 })).status,
    ).toBe("no_open_question");
  });

  it("is closed by anything the HOST said since", async () => {
    await openHostConfirmation(handle(), {
      hostHash,
      standProviderId: providerId,
      askedAt: T0,
    });
    await hostSaidSomething(T1);

    const answer = await answerHostConfirmation(handle(), {
      hostHash,
      token: "NO",
      occurredAt: T2,
    });
    expect(answer.status).toBe("no_open_question");
    // A stale question decides NOTHING — the arrangement is untouched.
    expect(await ended()).toBe(false);
  });

  it("is closed by anything the SYSTEM sent since", async () => {
    /*
      THE CASE A WEAKER IMPLEMENTATION FORGETS. It is easy to check whether the host has spoken
      since; it is easy to forget that a scheduled inventory prompt WE sent also closed the
      question. max accepted this consequence explicitly — the window can be short, and the
      host's settings screen carries Remove either way.
    */
    await openHostConfirmation(handle(), {
      hostHash,
      standProviderId: providerId,
      askedAt: T0,
    });
    await systemSentSomething(T1);

    const answer = await answerHostConfirmation(handle(), {
      hostHash,
      token: "NO",
      occurredAt: T2,
    });
    expect(answer.status).toBe("no_open_question");
    expect(await ended()).toBe(false);
  });

  it("holds ONE open question per host, the newest replacing the older", async () => {
    // A second self-selecting seller must not leave two rows for a bare YES to choose between.
    const second = await client()`
      insert into sellers (name) values ('Fernhorn Bakery') returning id
    `;
    const secondProvider = await client()`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state,
        invited_at, accepted_at, approval_source, approved_at
      ) values (
        ${hostStandId}, ${second[0]?.id as string}, 'active',
        ${T0}, ${T0}, 'seller', ${T0}
      ) returning id
    `;

    await openHostConfirmation(handle(), {
      hostHash,
      standProviderId: providerId,
      askedAt: T0,
    });
    await openHostConfirmation(handle(), {
      hostHash,
      standProviderId: secondProvider[0]?.id as string,
      askedAt: T1,
    });

    expect(await client()`select id from pending_host_confirmations`).toHaveLength(1);

    // The answer acts on the NEWEST question, and never on the one it replaced.
    const answer = await answerHostConfirmation(handle(), {
      hostHash,
      token: "NO",
      occurredAt: T2,
    });
    expect(answer.status).toBe("denied");
    expect(await ended()).toBe(false);
    const secondRow = await client()`
      select ended_at from stand_providers where id = ${secondProvider[0]?.id as string}
    `;
    expect(secondRow[0]?.ended_at).not.toBeNull();
  });

  it("never lets one host's answer touch another host's arrangement", async () => {
    /*
      The criterion's last clause: a closed or absent question must never apply to a DIFFERENT
      arrangement. Two hosts, two sellers, two questions — and the answer is scoped by hash, so
      the second host's `NO` can only reach the row that was asked of them.

      Asserted with BOTH questions open at once, because a reader that took "the oldest open
      question" or "any open question" would pass a single-host test and end the wrong listing
      here.
    */
    const otherHostSellers = await client()`
      insert into sellers (name) values ('Fernhorn Farm') returning id
    `;
    const otherHostHash = `h${randomUUID().replaceAll("-", "")}`;
    const otherContacts = await client()`
      insert into contacts (phone_e164, phone_hash, created_at)
      values ('+12065550133', ${otherHostHash}, ${T0}) returning id
    `;
    await client()`
      insert into farmer_authorizations (seller_id, contact_id, phone_verified_at, authorized_at)
      values (${otherHostSellers[0]?.id as string}, ${otherContacts[0]?.id as string}, ${T0}, ${T0})
    `;
    const otherStands = await client()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        is_public, farm_bucks_accepted, farm_bucks_eligible,
        public_address, public_latitude, public_longitude
      ) values (
        ${otherHostSellers[0]?.id as string}, 'farm_stand', 'Fernhorn Stand',
        'America/Los_Angeles', 'visitable', 'produce', true, false, false,
        '2 Fernhorn Road', 47.4480, -122.4595
      ) returning id
    `;
    const otherProviders = await client()`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state,
        invited_at, accepted_at, approval_source, approved_at
      ) values (
        ${otherStands[0]?.id as string}, ${guestSellerId}, 'active',
        ${T0}, ${T0}, 'seller', ${T0}
      ) returning id
    `;

    await openHostConfirmation(handle(), {
      hostHash,
      standProviderId: providerId,
      askedAt: T0,
    });
    await openHostConfirmation(handle(), {
      hostHash: otherHostHash,
      standProviderId: otherProviders[0]?.id as string,
      askedAt: T0,
    });

    const answer = await answerHostConfirmation(handle(), {
      hostHash: otherHostHash,
      token: "NO",
      occurredAt: T1,
    });
    expect(answer.status).toBe("denied");

    // THEIR arrangement ended; the first host's did not, and their question is still open.
    const otherRow = await client()`
      select ended_at from stand_providers where id = ${otherProviders[0]?.id as string}
    `;
    expect(otherRow[0]?.ended_at).not.toBeNull();
    expect(await ended()).toBe(false);
    expect(await client()`
      select id from pending_host_confirmations where host_hash = ${hostHash}
    `).toHaveLength(1);
  });

  it("answers nothing for a host with no open question at all", async () => {
    const answer = await answerHostConfirmation(handle(), {
      hostHash,
      token: "YES",
      occurredAt: T1,
    });
    expect(answer.status).toBe("no_open_question");
  });
});
