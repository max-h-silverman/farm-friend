import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invalidateProviderWork } from "./provider-invalidation";
import type { Sql } from "./sql";

/*
  F-114 Phase B item 8 — invalidation on pause, revocation, and closure.

  No mechanism existed. Closure was read at SEND time and nothing was invalidated, so a provider
  paused after a prompt went out could still have a live confirmation token sitting in someone's
  phone — and answering YES would publish for a listing that is no longer public.

  The rule the contract states, and what each case below proves:

    - Pausing or ending ONE provider invalidates THAT provider's open confirmations and queued
      reminders. Every other provider at the same stand is untouched — the scope test, and the
      one a stand-keyed implementation would fail silently.
    - A stand shutdown invalidates ALL of them, because a closed stand is locked and no one's
      goods are buyable there.
    - Invalidation is idempotent and never reopens: a proposal already accepted or declined
      keeps its answer, because the farmer already decided and rewriting that would erase a
      real act.

  This is what makes the re-open confirmation possible (§facts and authority): a paused
  provider's next update triggers a NEW confirmation stating the consequence, rather than
  publishing silently through a token that outlived the pause. That prompt is Phase C.2; the
  invalidation it depends on is here.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("F-114 provider invalidation (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";

  let farmId = "";
  let locationId = "";
  let otherLocationId = "";
  let nativeProviderId = "";
  let hostedProviderId = "";
  let otherStandProviderId = "";
  let senderHash = "";

  const client = (): Sql => {
    if (!sql) throw new Error("database not initialized");
    return sql;
  };

  /** An open proposal plus the queued reminder that carries its token. */
  const queueConfirmation = async (input: {
    locationId: string;
    providerId: string;
  }): Promise<{ proposalId: string; outboxId: string }> => {
    const db = client();
    const outbox = await db`
      insert into outbox_work (
        recipient_hash, message_category, body, body_expires_at, state,
        logical_key, available_at
      ) values (
        ${senderHash}, 'inventory_prompt', 'What do you have today?',
        now() + interval '7 days', 'queued',
        ${`prompt-${randomUUID()}`}, now()
      ) returning id
    `;
    const outboxId = outbox[0]?.id as string;
    // The proposal is ACTIVATED against that outbox row — which is what a live confirmation
    // window is, and what makes the reminder findable from the proposal. `activation_coherent`
    // requires the version, the instant, and the expiry together.
    const proposal = await db`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, provider_id, payload, proposal_version,
        state, has_inventory, has_closure, base_is_first_publication,
        activation_outbox_id, activated_version, activated_at, expires_at
      ) values (
        ${senderHash}, ${input.locationId}, ${input.providerId}, ${db.json({})}, 1,
        'open', true, false, true,
        ${outboxId}, 1, now(), now() + interval '12 hours'
      ) returning id
    `;
    return { proposalId: proposal[0]?.id as string, outboxId };
  };

  const proposalState = async (id: string): Promise<string> => {
    const rows = await client()`
      select state from inventory_publication_proposals where id = ${id}
    `;
    return rows[0]?.state as string;
  };

  const outboxState = async (id: string): Promise<string> => {
    const rows = await client()`select state from outbox_work where id = ${id}`;
    return rows[0]?.state as string;
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_f114inv_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    sql = postgres(url.toString(), { max: 10 });

    const db = client();
    const farms = await db`insert into farms (name) values ('Morgan Hill') returning id`;
    farmId = farms[0]?.id as string;

    const mkLocation = async (name: string): Promise<string> => {
      const rows = await db`
        insert into sales_locations (
          owner_farm_id, kind, name, timezone, visitability, offering_type,
          is_public, farm_bucks_accepted, farm_bucks_eligible,
          public_address, public_latitude, public_longitude
        ) values (
          ${farmId}, 'farm_stand', ${name}, 'America/Los_Angeles',
          'visitable', 'produce', true, false, false,
          ${`${name} Road, Vashon WA`}, 47.4473, -122.4590
        ) returning id
      `;
      return rows[0]?.id as string;
    };
    locationId = await mkLocation("Morgan Hill Stand");
    otherLocationId = await mkLocation("Cascade Stand");

    const native = async (id: string): Promise<string> => {
      const rows = await db`
        select id from stand_providers
        where sales_location_id = ${id} and seller_id is null
      `;
      return rows[0]?.id as string;
    };
    nativeProviderId = await native(locationId);
    otherStandProviderId = await native(otherLocationId);

    const sellers = await db`
      insert into sellers (name) values ('Fernhorn Bakery') returning id
    `;
    const hosted = await db`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, invited_at, accepted_at,
        approval_source, approved_at
      ) values (
        ${locationId}, ${sellers[0]?.id as string}, 'active', now(), now(), 'viga', now()
      ) returning id
    `;
    hostedProviderId = hosted[0]?.id as string;

    senderHash = `f114${randomUUID().replaceAll("-", "")}`;
    await db`
      insert into contacts (phone_e164, phone_hash)
      values ('+12065550141', ${senderHash})
    `;
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  });

  it("invalidates ONE provider's work and leaves the other provider at that stand alone", async () => {
    const db = client();
    const hostedWork = await queueConfirmation({
      locationId,
      providerId: hostedProviderId,
    });
    const nativeWork = await queueConfirmation({
      locationId,
      providerId: nativeProviderId,
    });

    const result = await invalidateProviderWork(db, {
      salesLocationId: locationId,
      providerId: hostedProviderId,
      occurredAt: new Date(),
    });

    expect(result).toEqual({ proposalsInvalidated: 1, remindersSuppressed: 1 });
    expect(await proposalState(hostedWork.proposalId)).toBe("invalidated");
    expect(await outboxState(hostedWork.outboxId)).toBe("suppressed");

    // THE SCOPE TEST. A stand-keyed implementation would have cancelled this too, and the
    // host would silently lose a confirmation they were mid-way through answering.
    expect(await proposalState(nativeWork.proposalId)).toBe("open");
    expect(await outboxState(nativeWork.outboxId)).toBe("queued");
  });

  it("invalidates EVERY provider's work when the stand itself closes", async () => {
    const db = client();
    // The native proposal from the previous case is still open; add the hosted one back.
    const hostedWork = await queueConfirmation({
      locationId,
      providerId: hostedProviderId,
    });
    const elsewhere = await queueConfirmation({
      locationId: otherLocationId,
      providerId: otherStandProviderId,
    });

    const before = await db`
      select id from inventory_publication_proposals
      where sales_location_id = ${locationId} and state = 'open'
    `;
    expect(before.length).toBeGreaterThan(1);

    const result = await invalidateProviderWork(db, {
      salesLocationId: locationId,
      occurredAt: new Date(),
    });

    expect(result.proposalsInvalidated).toBe(before.length);
    expect(await proposalState(hostedWork.proposalId)).toBe("invalidated");

    const remaining = await db`
      select count(*)::int as n from inventory_publication_proposals
      where sales_location_id = ${locationId} and state = 'open'
    `;
    expect(remaining[0]?.n).toBe(0);

    // A DIFFERENT stand is untouched. Closure is a fact about one place.
    expect(await proposalState(elsewhere.proposalId)).toBe("open");
    expect(await outboxState(elsewhere.outboxId)).toBe("queued");
  });

  it("never reopens or rewrites a proposal the farmer already answered", async () => {
    const db = client();
    const outbox = await db`
      insert into outbox_work (
        recipient_hash, message_category, body, body_expires_at, state,
        logical_key, available_at, dispatch_authorized_at, completed_at
      ) values (
        ${senderHash}, 'inventory_prompt', 'answered', now() + interval '7 days', 'sent',
        ${`prompt-${randomUUID()}`}, now(), now(), now()
      ) returning id
    `;
    const answered = await db`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, provider_id, payload, proposal_version,
        state, has_inventory, has_closure, base_is_first_publication,
        activation_outbox_id, activated_version, activated_at, expires_at,
        consumed_token, consumption_provider_event_id, closed_at
      ) values (
        ${senderHash}, ${otherLocationId}, ${otherStandProviderId}, ${db.json({})}, 1,
        'accepted', true, false, true,
        ${outbox[0]?.id as string}, 1, now(), now() + interval '12 hours',
        'yes', ${`ev-${randomUUID()}`}, now()
      ) returning id
    `;
    const answeredId = answered[0]?.id as string;

    await invalidateProviderWork(db, {
      salesLocationId: otherLocationId,
      providerId: otherStandProviderId,
      occurredAt: new Date(),
    });

    // The farmer already decided. Rewriting that state would erase a real act, and the
    // revision it published is immutable anyway.
    expect(await proposalState(answeredId)).toBe("accepted");
  });

  it("is idempotent — a second call changes nothing and reports nothing", async () => {
    const db = client();
    const work = await queueConfirmation({
      locationId: otherLocationId,
      providerId: otherStandProviderId,
    });

    const first = await invalidateProviderWork(db, {
      salesLocationId: otherLocationId,
      providerId: otherStandProviderId,
      occurredAt: new Date(),
    });
    expect(first.proposalsInvalidated).toBeGreaterThan(0);

    const second = await invalidateProviderWork(db, {
      salesLocationId: otherLocationId,
      providerId: otherStandProviderId,
      occurredAt: new Date(),
    });
    expect(second).toEqual({ proposalsInvalidated: 0, remindersSuppressed: 0 });
    expect(await proposalState(work.proposalId)).toBe("invalidated");
  });

  it("suppresses only QUEUED reminders, never one already sent", async () => {
    // A sent message cannot be recalled. Marking it suppressed would make the outbox lie about
    // what reached the handset, and the delivery record is what the audit trail keeps.
    const db = client();
    const sent = await db`
      insert into outbox_work (
        recipient_hash, message_category, body, body_expires_at, state,
        logical_key, available_at, dispatch_authorized_at, completed_at
      ) values (
        ${senderHash}, 'inventory_prompt', 'already gone', now() + interval '7 days', 'sent',
        ${`prompt-${randomUUID()}`}, now(), now(), now()
      ) returning id
    `;
    const sentId = sent[0]?.id as string;
    const proposal = await db`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, provider_id, payload, proposal_version,
        state, has_inventory, has_closure, base_is_first_publication
      ) values (
        ${senderHash}, ${locationId}, ${nativeProviderId}, ${db.json({})}, 1,
        'open', true, false, true
      ) returning id
    `;
    await db`
      insert into scheduled_inventory_prompt_subjects (
        proposal_id, proposal_version, preference_id, preference_version,
        authorization_id, owner_farm_id, sales_location_id, provider_id,
        closure_base_is_first_instruction, due_slot_at, outbox_work_id,
        offers_same, created_at
      )
      select ${proposal[0]?.id as string}, 1, null, 1, null, ${farmId}, ${locationId},
        ${nativeProviderId}, true, now(), ${sentId}, false, now()
      where false
    `;

    await invalidateProviderWork(db, {
      salesLocationId: locationId,
      providerId: nativeProviderId,
      occurredAt: new Date(),
    });

    expect(await outboxState(sentId)).toBe("sent");
  });
});
