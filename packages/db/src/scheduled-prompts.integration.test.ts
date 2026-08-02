import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "@farm-friend/core";
import { createDb, type Db } from "./index";
import { setInventoryPromptPreference } from "./scheduled-prompts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required; a skipped integration run is not green");

const NOW = new Date("2026-03-07T18:00:00.000Z");

describe("scheduled inventory prompt preferences (integration)", () => {
  let admin: ReturnType<typeof postgres> | undefined;
  let db: Db | undefined;
  let databaseName = "";
  let testDatabaseUrl = "";
  const ids = { contact: "", farm: "", location: "", authorization: "" };
  const senderHash = "f".repeat(64);

  beforeAll(async () => {
    databaseName = `farm_friend_scheduled_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(databaseUrl, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(databaseUrl);
    url.pathname = `/${databaseName}`;
    testDatabaseUrl = url.toString();
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), {
      migrationsFolder: resolve(process.cwd(), "packages/db/drizzle"),
    });
    await migrationClient.end({ timeout: 5 });
    db = createDb(url.toString());

    const contact = await db.sql`
      insert into contacts (phone_e164, phone_hash)
      values ('+12065550191', ${senderHash}) returning id
    `;
    ids.contact = contact[0]?.id as string;
    const farm = await db.sql`insert into farms (name) values ('Schedule Farm') returning id`;
    ids.farm = farm[0]?.id as string;
    const location = await db.sql`
      insert into sales_locations (
        owner_farm_id, kind, name, timezone, public_address, public_latitude,
        public_longitude, farm_bucks_accepted, farm_bucks_eligible
      ) values (
        ${ids.farm}, 'farm_stand', 'Schedule Stand', 'America/Los_Angeles',
        '1 Schedule Way', 47.45, -122.46, false, true
      ) returning id
    `;
    ids.location = location[0]?.id as string;
    const authorization = await db.sql`
      insert into farmer_authorizations (
        farm_id, contact_id, phone_verified_at, authorized_at
      ) values (${ids.farm}, ${ids.contact}, ${NOW}, ${NOW}) returning id
    `;
    ids.authorization = authorization[0]?.id as string;
  });

  afterAll(async () => {
    if (db) await db.close();
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  });

  function handle(): Db {
    if (!db) throw new Error("database unavailable");
    return db;
  }

  it("stores each cadence with an exact designated authorization and no consent mutation", async () => {
    for (const cadence of ["every_2_days", "weekly", "every_2_weeks", "paused"] as const) {
      const result = await setInventoryPromptPreference(handle(), {
        senderHash,
        authorizationId: ids.authorization!,
        salesLocationId: ids.location!,
        cadence,
        clock: new FixedClock(NOW),
      });
      expect(result.status).toBe("saved");
    }

    const rows = await handle().sql`
      select designated_authorization_id, cadence, version, next_due_at
      from inventory_prompt_preferences where sales_location_id = ${ids.location}
    `;
    expect(rows).toMatchObject([{
      designated_authorization_id: ids.authorization,
      cadence: "paused",
      version: 4,
      next_due_at: null,
    }]);
    const consent = await handle().sql`
      select count(*)::integer as count from sms_consents where recipient_hash = ${senderHash}
    `;
    expect(consent[0]?.count).toBe(0);
  });

  it("keeps an old durable subject while its proposal and preference versions advance", async () => {
    const preference = await setInventoryPromptPreference(handle(), {
      senderHash,
      authorizationId: ids.authorization!,
      salesLocationId: ids.location!,
      cadence: "weekly",
      clock: new FixedClock(NOW),
    });
    if (preference.status !== "saved") throw new Error("expected preference save");

    const proposal = await handle().sql`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, payload, schema_version, proposal_version,
        yes_token, no_token, has_inventory, has_closure,
        base_revision_id, base_is_first_publication
      ) values (
        ${senderHash}, ${ids.location}, ${handle().sql.json({ items: [] })}, '1', 1,
        'YES-OLD', 'NO-OLD', true, false, null, true
      ) returning id
    `;
    const outbox = await handle().sql`
      insert into outbox_work (
        logical_key, recipient_hash, message_category, body, body_expires_at, available_at
      ) values (
        ${`scheduled:${randomUUID()}`}, ${senderHash}, 'inventory_prompt', 'Old prompt',
        ${new Date("2027-01-01T00:00:00.000Z")}, ${NOW}
      ) returning id
    `;
    await handle().sql`
      insert into scheduled_inventory_prompt_subjects (
        proposal_id, proposal_version, preference_id, preference_version,
        authorization_id, owner_farm_id, sales_location_id,
        closure_base_is_first_instruction, due_slot_at, outbox_work_id,
        offers_same, created_at
      ) values (
        ${proposal[0]?.id as string}, 1, ${preference.preferenceId}, ${preference.version},
        ${ids.authorization}, ${ids.farm}, ${ids.location}, true,
        ${new Date(NOW.getTime() + 7 * 86_400_000)}, ${outbox[0]?.id as string},
        false, ${NOW}
      )
    `;

    await handle().sql`
      update inventory_publication_proposals
      set proposal_version = 2, yes_token = 'YES-NEW', no_token = 'NO-NEW'
      where id = ${proposal[0]?.id as string}
    `;
    await handle().sql`
      update inventory_prompt_preferences
      set version = version + 1, updated_at = ${new Date(NOW.getTime() + 1_000)}
      where id = ${preference.preferenceId}
    `;

    expect(await handle().sql`
      select proposal_version, preference_version
      from scheduled_inventory_prompt_subjects
      where proposal_id = ${proposal[0]?.id as string}
    `).toEqual([{
      proposal_version: 1,
      preference_version: preference.version,
    }]);
    expect(await handle().sql`
      select proposal_version from inventory_publication_proposals
      where id = ${proposal[0]?.id as string}
    `).toEqual([{ proposal_version: 2 }]);
    expect(await handle().sql`
      select version from inventory_prompt_preferences where id = ${preference.preferenceId}
    `).toEqual([{ version: preference.version + 1 }]);
    await handle().sql`
      update inventory_publication_proposals
      set state = 'invalidated', closed_at = ${new Date(NOW.getTime() + 2_000)}
      where id = ${proposal[0]?.id as string}
    `;
  });

  it("rejects every decisive invalid NULL or half-populated schedule shape", async () => {
    const preference = await handle().sql`
      select id from inventory_prompt_preferences where sales_location_id = ${ids.location}
    `;
    const preferenceId = preference[0]?.id as string;

    await expect(handle().sql`
      update inventory_prompt_preferences set cadence = 'weekly', next_due_at = null
      where id = ${preferenceId}
    `).rejects.toThrow(/inventory_prompt_preferences_due_state_coherent/);
    await expect(handle().sql`
      update inventory_prompt_preferences set cadence = 'paused', next_due_at = ${NOW}
      where id = ${preferenceId}
    `).rejects.toThrow(/inventory_prompt_preferences_due_state_coherent/);
    await expect(handle().sql`
      update inventory_prompt_preferences set version = 0 where id = ${preferenceId}
    `).rejects.toThrow(/inventory_prompt_preferences_positive_version/);
    await expect(handle().sql`
      update inventory_prompt_preferences
      set cadence = 'weekly', last_due_slot_at = ${NOW}, next_due_at = ${NOW}
      where id = ${preferenceId}
    `).rejects.toThrow(/inventory_prompt_preferences_due_slots_ordered/);

    const proposal = await handle().sql`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, payload, schema_version, proposal_version,
        yes_token, no_token, has_inventory, has_closure,
        base_revision_id, base_is_first_publication
      ) values (
        ${senderHash}, ${ids.location}, ${handle().sql.json({ items: [] })}, '1', 1,
        'YES-NULL', 'NO-NULL', true, false, null, true
      ) returning id
    `;
    const outbox = await handle().sql`
      insert into outbox_work (
        logical_key, recipient_hash, message_category, body, body_expires_at, available_at
      ) values (
        ${`scheduled-null:${randomUUID()}`}, ${senderHash}, 'inventory_prompt', 'Null probe',
        ${new Date("2027-01-01T00:00:00.000Z")}, ${NOW}
      ) returning id
    `;
    await expect(handle().sql`
      insert into scheduled_inventory_prompt_subjects (
        proposal_id, proposal_version, preference_id, preference_version,
        authorization_id, owner_farm_id, sales_location_id,
        closure_base_is_first_instruction, due_slot_at, outbox_work_id,
        offers_same, created_at
      ) values (
        ${proposal[0]?.id as string}, 0, ${preferenceId}, 1,
        ${ids.authorization}, ${ids.farm}, ${ids.location}, true,
        ${new Date(NOW.getTime() + 14 * 86_400_000)}, ${outbox[0]?.id as string},
        false, ${NOW}
      )
    `).rejects.toThrow(/scheduled_prompt_subjects_positive_versions/);
    await expect(handle().sql`
      insert into scheduled_inventory_prompt_subjects (
        proposal_id, proposal_version, preference_id, preference_version,
        authorization_id, owner_farm_id, sales_location_id,
        closure_base_is_first_instruction, due_slot_at, outbox_work_id,
        offers_same, created_at
      ) values (
        ${proposal[0]?.id as string}, 1, ${preferenceId}, 0,
        ${ids.authorization}, ${ids.farm}, ${ids.location}, true,
        ${new Date(NOW.getTime() + 14 * 86_400_000)}, ${outbox[0]?.id as string},
        false, ${NOW}
      )
    `).rejects.toThrow(/scheduled_prompt_subjects_positive_versions/);
    await expect(handle().sql`
      insert into scheduled_inventory_prompt_subjects (
        proposal_id, proposal_version, preference_id, preference_version,
        authorization_id, owner_farm_id, sales_location_id,
        closure_base_is_first_instruction, due_slot_at, outbox_work_id,
        offers_same, created_at
      ) values (
        ${proposal[0]?.id as string}, 1, ${preferenceId}, 1,
        ${ids.authorization}, ${ids.farm}, ${ids.location}, false,
        ${new Date(NOW.getTime() + 14 * 86_400_000)}, ${outbox[0]?.id as string},
        false, ${NOW}
      )
    `).rejects.toThrow(/scheduled_prompt_subjects_closure_base_coherent/);
    await expect(handle().sql`
      insert into scheduled_inventory_prompt_subjects (
        proposal_id, proposal_version, preference_id, preference_version,
        authorization_id, owner_farm_id, sales_location_id,
        inventory_base_revision_id, closure_base_is_first_instruction,
        due_slot_at, outbox_work_id, offers_same, created_at
      ) values (
        ${proposal[0]?.id as string}, 1, ${preferenceId}, 1,
        ${ids.authorization}, ${ids.farm}, ${ids.location}, null, true,
        ${new Date(NOW.getTime() + 14 * 86_400_000)}, ${outbox[0]?.id as string},
        true, ${NOW}
      )
    `).rejects.toThrow(/scheduled_prompt_subjects_visible_snapshot_for_same/);
  });

  it("uses the preference-slot unique index to arbitrate a genuinely contended insert", async () => {
    const preference = await setInventoryPromptPreference(handle(), {
      senderHash,
      authorizationId: ids.authorization!,
      salesLocationId: ids.location!,
      cadence: "weekly",
      clock: new FixedClock(NOW),
    });
    if (preference.status !== "saved") throw new Error("contention preference setup failed");
    const dueSlot = new Date("2027-03-07T18:00:00.000Z");
    const proposals = [] as string[];
    const outboxes = [] as string[];
    for (const label of ["winner", "claimant"]) {
      const proposal = await handle().sql`
        insert into inventory_publication_proposals (
          sender_hash, sales_location_id, payload, schema_version, proposal_version,
          yes_token, no_token, has_inventory, has_closure,
          base_revision_id, base_is_first_publication, state, closed_at
        ) values (
          ${senderHash}, ${ids.location}, ${handle().sql.json({ entries: [] })}, '1', 1,
          ${`YES-${label}-${randomUUID()}`}, ${`NO-${label}-${randomUUID()}`},
          true, false, null, true, 'invalidated', ${NOW}
        ) returning id
      `;
      const outbox = await handle().sql`
        insert into outbox_work (
          logical_key, recipient_hash, message_category, body, body_expires_at, available_at
        ) values (
          ${`slot-contention-${label}-${randomUUID()}`}, ${senderHash}, 'inventory_prompt',
          ${label}, ${new Date("2028-01-01T00:00:00.000Z")}, ${NOW}
        ) returning id
      `;
      proposals.push(proposal[0]?.id as string);
      outboxes.push(outbox[0]?.id as string);
    }

    const winner = postgres(testDatabaseUrl, { max: 1 });
    const claimant = postgres(testDatabaseUrl, { max: 1 });
    let releaseWinner = () => {};
    let markInserted = () => {};
    const releasePromise = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    const inserted = new Promise<void>((resolve) => {
      markInserted = resolve;
    });
    const winningTransaction = winner.begin(async (tx) => {
      await tx`
        insert into scheduled_inventory_prompt_subjects (
          proposal_id, proposal_version, preference_id, preference_version,
          authorization_id, owner_farm_id, sales_location_id,
          closure_base_is_first_instruction, due_slot_at, outbox_work_id,
          offers_same, created_at
        ) values (
          ${proposals[0]!}, 1, ${preference.preferenceId}, ${preference.version},
          ${ids.authorization}, ${ids.farm}, ${ids.location}, true,
          ${dueSlot}, ${outboxes[0]!}, false, ${NOW}
        )
      `;
      markInserted();
      await releasePromise;
    });
    let queued = 0;
    try {
      await inserted;
      const losingOutcome = (async () => claimant`
          insert into scheduled_inventory_prompt_subjects (
            proposal_id, proposal_version, preference_id, preference_version,
            authorization_id, owner_farm_id, sales_location_id,
            closure_base_is_first_instruction, due_slot_at, outbox_work_id,
            offers_same, created_at
          ) values (
            ${proposals[1]!}, 1, ${preference.preferenceId}, ${preference.version},
            ${ids.authorization}, ${ids.farm}, ${ids.location}, true,
            ${dueSlot}, ${outboxes[1]!}, false, ${NOW}
          )
        `)().then(
          () => ({ status: "fulfilled" as const, code: null }),
          (error: unknown) => ({
            status: "rejected" as const,
            code: (error as { code?: unknown }).code,
          }),
        );

      for (let attempt = 0; attempt < 100 && queued < 1; attempt += 1) {
        const rows = await handle().sql`
          select count(*)::integer as count from pg_stat_activity
          where datname = current_database()
            and wait_event_type = 'Lock'
            and query like '%insert into scheduled_inventory_prompt_subjects%'
        `;
        queued = rows[0]?.count as number;
        if (queued < 1) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      releaseWinner();
      await winningTransaction;
      expect(await losingOutcome).toEqual({ status: "rejected", code: "23505" });
      expect(queued, "claimant must queue behind the uncommitted preference-slot index entry").toBe(1);
      expect(await handle().sql`
        select proposal_id from scheduled_inventory_prompt_subjects
        where preference_id = ${preference.preferenceId} and due_slot_at = ${dueSlot}
      `).toEqual([{ proposal_id: proposals[0] }]);
    } finally {
      releaseWinner();
      await Promise.allSettled([winningTransaction]);
      await winner.end({ timeout: 5 });
      await claimant.end({ timeout: 5 });
    }
  });
});
