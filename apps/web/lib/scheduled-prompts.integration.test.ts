import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "@farm-friend/core";
import {
  authorizeDispatch,
  createDb,
  recordDispatchResult,
  setInventoryPromptPreference,
  type Db,
} from "@farm-friend/db";
import { runScheduledPromptPass } from "./scheduled-prompts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required; a skipped integration run is not green");

const BASE = new Date("2026-03-01T18:00:00.000Z");
const DUE = new Date("2026-03-14T17:00:00.000Z");

describe("scheduled inventory prompt pass (integration)", () => {
  let admin: ReturnType<typeof postgres> | undefined;
  let db: Db | undefined;
  let databaseName = "";
  const ids: Record<string, string> = {};
  const senderHash = "7".repeat(64);

  beforeAll(async () => {
    databaseName = `farm_friend_prompt_pass_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(databaseUrl, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(databaseUrl);
    url.pathname = `/${databaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), {
      migrationsFolder: resolve(process.cwd(), "packages/db/drizzle"),
    });
    await migrationClient.end({ timeout: 5 });
    db = createDb(url.toString());

    const contacts = await handle().sql`
      insert into contacts (phone_e164, phone_hash, created_at) values
        ('+12065550201', ${senderHash}, ${BASE}),
        ('+12065550202', ${"8".repeat(64)}, ${BASE})
      returning id, phone_hash
    `;
    const contactId = contacts.find((row) => row.phone_hash === senderHash)?.id as string;
    const adminContactId = contacts.find((row) => row.phone_hash !== senderHash)?.id as string;
    const administrators = await handle().sql`
      insert into administrators (email, contact_id, authorized_at)
      values ('prompt-admin@viga.example', ${adminContactId}, ${BASE}) returning id
    `;
    const farms = await handle().sql`insert into farms (name) values ('Prompt Farm') returning id`;
    ids.farm = farms[0]?.id as string;
    const locations = await handle().sql`
      insert into sales_locations (
        owner_farm_id, kind, name, timezone, public_address, public_latitude,
        public_longitude, farm_bucks_accepted, farm_bucks_eligible
      ) values (
        ${ids.farm}, 'farm_stand', 'Prompt Stand', 'America/Los_Angeles',
        '1 Prompt Way', 47.45, -122.46, false, true
      ) returning id
    `;
    ids.location = locations[0]?.id as string;
    const authorizations = await handle().sql`
      insert into farmer_authorizations (
        farm_id, contact_id, phone_verified_at, authorized_at
      ) values (${ids.farm}, ${contactId}, ${BASE}, ${BASE}) returning id
    `;
    ids.authorization = authorizations[0]?.id as string;
    const approvals = await handle().sql`
      insert into farm_approvals (farm_id, administrator_id, approved_at)
      values (${ids.farm}, ${administrators[0]?.id as string}, ${BASE}) returning id
    `;
    ids.approval = approvals[0]?.id as string;
    await handle().sql`
      insert into sms_consents (
        recipient_hash, state, capture_source, captured_at, capture_evidence_ref, updated_at
      ) values (
        ${senderHash}, 'active', 'farmer_onboarding', ${BASE},
        'prompt-pass-fixture', ${BASE}
      )
    `;

    const baselineProposal = await handle().sql`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, payload, schema_version, proposal_version,
        yes_token, no_token, has_inventory, has_closure,
        base_revision_id, base_is_first_publication, state, closed_at
      ) values (
        ${senderHash}, ${ids.location}, ${{ entries: [] }}, '1', 1,
        'YES-BASE', 'NO-BASE', true, false, null, true, 'invalidated', ${BASE}
      ) returning id
    `;
    const revisions = await handle().sql`
      insert into inventory_revisions (
        farm_id, sales_location_id, proposal_id, published_by_authorization_id,
        farm_approval_id, published_at
      ) values (
        ${ids.farm}, ${ids.location}, ${baselineProposal[0]?.id as string},
        ${ids.authorization}, ${ids.approval}, ${BASE}
      ) returning id
    `;
    ids.revision = revisions[0]?.id as string;
    await handle().sql`
      insert into inventory_entries (
        inventory_revision_id, sales_location_id, item_name, quantity, unit, sort_order
      ) values
        (${ids.revision}, ${ids.location}, 'Eggs', 6, 'dozen', 0),
        (${ids.revision}, ${ids.location}, 'Kale', null, null, 1)
    `;
    const preference = await setInventoryPromptPreference(handle(), {
      senderHash,
      authorizationId: ids.authorization!,
      salesLocationId: ids.location!,
      cadence: "weekly",
      clock: new FixedClock(BASE),
    });
    if (preference.status !== "saved") throw new Error("preference setup failed");
    ids.preference = preference.preferenceId;
    await handle().sql`
      update inventory_prompt_preferences set next_due_at = ${DUE}
      where id = ${ids.preference}
    `;
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

  it("creates one exact full-snapshot prompt and advances the preference once", async () => {
    expect(await runScheduledPromptPass({ db: handle(), clock: new FixedClock(DUE) })).toEqual({
      scheduled: 1,
      deferred: 0,
    });

    const rows = await handle().sql`
      select subject.proposal_version, subject.preference_version,
             subject.inventory_base_revision_id, subject.due_slot_at,
             subject.offers_same, subject.outbox_work_id,
             work.body, work.message_category, work.state,
             proposal.payload, proposal.activation_outbox_id, proposal.state as proposal_state
      from scheduled_inventory_prompt_subjects subject
      join outbox_work work on work.id = subject.outbox_work_id
      join inventory_publication_proposals proposal on proposal.id = subject.proposal_id
      where subject.preference_id = ${ids.preference}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      proposal_version: 1,
      preference_version: 1,
      inventory_base_revision_id: ids.revision,
      due_slot_at: DUE,
      offers_same: true,
      message_category: "inventory_prompt",
      state: "queued",
      proposal_state: "open",
    });
    expect(rows[0]?.outbox_work_id).toBeTruthy();
    expect(rows[0]?.activation_outbox_id).toBeNull();
    expect(rows[0]?.body).toContain("For Prompt Stand:");
    expect(rows[0]?.body).toContain("- Eggs (6 dozen)");
    expect(rows[0]?.body).toContain("- Kale");
    expect(rows[0]?.body).toContain("Reply SAME");
    expect(rows[0]?.payload).toEqual({
      entries: [
        { entryId: expect.any(String), itemName: "Eggs", quantity: 6, unit: "dozen" },
        { entryId: expect.any(String), itemName: "Kale" },
      ],
    });

    const preference = await handle().sql`
      select last_due_slot_at, next_due_at from inventory_prompt_preferences
      where id = ${ids.preference}
    `;
    expect(preference[0]?.last_due_slot_at).toEqual(DUE);
    expect((preference[0]?.next_due_at as Date).getTime()).toBeGreaterThan(DUE.getTime());

    expect(await runScheduledPromptPass({ db: handle(), clock: new FixedClock(DUE) })).toEqual({
      scheduled: 0,
      deferred: 0,
    });
    expect(await handle().sql`
      select id from outbox_work where message_category = 'inventory_prompt'
    `).toHaveLength(1);
  });

  it("activates the exact scheduled proposal version when its typed outbox subject is accepted", async () => {
    const subject = await handle().sql`
      select proposal_id, outbox_work_id from scheduled_inventory_prompt_subjects
      where preference_id = ${ids.preference}
    `;
    const outboxWorkId = subject[0]?.outbox_work_id as string;
    const claim = await authorizeDispatch(handle(), { outboxWorkId, now: DUE });
    expect(claim.status).toBe("authorized");
    if (claim.status !== "authorized") return;
    await recordDispatchResult(handle(), {
      dispatchAttemptId: claim.dispatchAttemptId,
      outcome: "accepted",
      providerMessageId: "provider-scheduled-1",
      now: new Date(DUE.getTime() + 1_000),
    });

    expect(await handle().sql`
      select state, proposal_version, activated_version, activation_outbox_id,
             activated_at, expires_at
      from inventory_publication_proposals where id = ${subject[0]?.proposal_id as string}
    `).toEqual([expect.objectContaining({
      state: "open",
      proposal_version: 1,
      activated_version: 1,
      activation_outbox_id: outboxWorkId,
      activated_at: new Date(DUE.getTime() + 1_000),
    })]);
  });

  it("leaves an accepted scheduled outbox inert after its stored proposal version goes stale", async () => {
    const old = await handle().sql`
      select proposal_id from scheduled_inventory_prompt_subjects
      where preference_id = ${ids.preference} order by due_slot_at asc limit 1
    `;
    await handle().sql`
      update inventory_publication_proposals
      set state = 'invalidated', closed_at = ${new Date(DUE.getTime() + 2_000)}
      where id = ${old[0]?.proposal_id as string}
    `;
    const preference = await handle().sql`
      select next_due_at from inventory_prompt_preferences where id = ${ids.preference}
    `;
    const nextDue = preference[0]?.next_due_at as Date;
    expect(await runScheduledPromptPass({ db: handle(), clock: new FixedClock(nextDue) })).toEqual({
      scheduled: 1,
      deferred: 0,
    });
    const subject = await handle().sql`
      select proposal_id, outbox_work_id from scheduled_inventory_prompt_subjects
      where preference_id = ${ids.preference} order by due_slot_at desc limit 1
    `;
    await handle().sql`
      update inventory_publication_proposals set proposal_version = 2
      where id = ${subject[0]?.proposal_id as string}
    `;
    const outboxWorkId = subject[0]?.outbox_work_id as string;
    const claim = await authorizeDispatch(handle(), { outboxWorkId, now: nextDue });
    expect(claim.status).toBe("authorized");
    if (claim.status !== "authorized") return;
    await recordDispatchResult(handle(), {
      dispatchAttemptId: claim.dispatchAttemptId,
      outcome: "accepted",
      providerMessageId: "provider-scheduled-stale",
      now: new Date(nextDue.getTime() + 1_000),
    });
    expect(await handle().sql`
      select activation_outbox_id, activated_version, activated_at, expires_at
      from inventory_publication_proposals where id = ${subject[0]?.proposal_id as string}
    `).toEqual([{
      activation_outbox_id: null,
      activated_version: null,
      activated_at: null,
      expires_at: null,
    }]);
  });
});
