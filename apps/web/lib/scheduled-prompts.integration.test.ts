import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FixedClock,
  renderClarificationRequest,
  renderScheduledInventoryUpdateRequest,
} from "@farm-friend/core";
import {
  authorizeDispatch,
  createDb,
  recordDispatchResult,
  setInventoryPromptPreference,
  type Db,
} from "@farm-friend/db";
import { runScheduledPromptPass } from "./scheduled-prompts";
import { handleScheduledSame } from "./scheduled-same";
import { handleFreeText } from "./free-text";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required; a skipped integration run is not green");

const BASE = new Date("2026-03-01T18:00:00.000Z");
const DUE = new Date("2026-03-14T17:00:00.000Z");

describe("scheduled inventory prompt pass (integration)", () => {
  let admin: ReturnType<typeof postgres> | undefined;
  let db: Db | undefined;
  let databaseName = "";
  let testDatabaseUrl = "";
  const ids = {
    administrator: "", farm: "", location: "", authorization: "",
    approval: "", revision: "", preference: "",
  };
  const senderHash = "7".repeat(64);

  beforeAll(async () => {
    databaseName = `farm_friend_prompt_pass_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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

    const contacts = await handle().sql`
      insert into contacts (phone_e164, phone_hash, created_at) values
        ('+12065550201', ${senderHash}, ${BASE}),
        ('+12065550202', ${"8".repeat(64)}, ${BASE})
      returning id, phone_hash
    `;
    const contactId = contacts.find((row) => row.phone_hash === senderHash)?.id as string;
    const administrators = await handle().sql`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', ${BASE}) returning id
    `;
    ids.administrator = administrators[0]?.id as string;
    const sellers = await handle().sql`insert into sellers (name) values ('Prompt Farm') returning id`;
    ids.farm = sellers[0]?.id as string;
    const locations = await handle().sql`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type, public_address, public_latitude,
        public_longitude, farm_bucks_accepted, farm_bucks_eligible
      ) values (
        ${ids.farm}, 'farm_stand', 'Prompt Stand', 'America/Los_Angeles', 'visitable', 'produce',
        '1 Prompt Way', 47.45, -122.46, false, true
      ) returning id
    `;
    ids.location = locations[0]?.id as string;
    const authorizations = await handle().sql`
      insert into farmer_authorizations (
        seller_id, contact_id, phone_verified_at, authorized_at
      ) values (${ids.farm}, ${contactId}, ${BASE}, ${BASE}) returning id
    `;
    ids.authorization = authorizations[0]?.id as string;
    const approvals = await handle().sql`
      insert into seller_approvals (seller_id, administrator_id, approved_at)
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
        sender_hash, sales_location_id, provider_id, payload, proposal_version,
        has_inventory, has_closure,
        base_revision_id, base_is_first_publication, state, closed_at
      ) values (
        ${senderHash}, ${ids.location},
          (select id from stand_providers
            where sales_location_id = ${ids.location} and seller_id = (select own_seller_id from sales_locations where id = ${ids.location})), ${handle().sql.json({ entries: [] })}, 1,
        true, false, null, true, 'invalidated', ${BASE}
      ) returning id
    `;
    const revisions = await handle().sql`
      insert into inventory_revisions (
        seller_id, sales_location_id, provider_id, proposal_id, published_by_authorization_id,
        farm_approval_id, source, published_at
      ) values (
        ${ids.farm}, ${ids.location},
        (select id from stand_providers
          where sales_location_id = ${ids.location} and seller_id = (select own_seller_id from sales_locations where id = ${ids.location})), ${baselineProposal[0]?.id as string},
        ${ids.authorization}, ${ids.approval}, 'sms', ${BASE}
      ) returning id
    `;
    ids.revision = revisions[0]?.id as string;
    await handle().sql`
      insert into inventory_entries (
        inventory_revision_id, sales_location_id, item_name, quantity, unit,
        price_text, approximation, sort_order
      ) values
        (${ids.revision}, ${ids.location}, 'Eggs', 6, 'dozen', '$8', 'plentiful', 0),
        (${ids.revision}, ${ids.location}, 'Kale', 4, 'bunches', '$5', 'limited', 1)
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

  let fixtureNumber = 0;
  async function createQueuedFixture(options?: {
    upcomingClosure?: boolean;
    unboundedClosure?: boolean;
    inventory?: "normal" | "none" | "oversized";
    autoSchedule?: boolean;
  }) {
    fixtureNumber += 1;
    const suffix = fixtureNumber.toString().padStart(2, "0");
    const fixtureSender = fixtureNumber.toString(16).padStart(64, "0");
    const alternateSender = (fixtureNumber + 100).toString(16).padStart(64, "0");
    const contacts = await handle().sql`
      insert into contacts (phone_e164, phone_hash, created_at) values
        (${`+12065551${suffix}`}, ${fixtureSender}, ${BASE}),
        (${`+12065552${suffix}`}, ${alternateSender}, ${BASE})
      returning id, phone_hash
    `;
    const contactId = contacts.find((row) => row.phone_hash === fixtureSender)?.id as string;
    const alternateContactId = contacts.find((row) => row.phone_hash === alternateSender)?.id as string;
    const farm = await handle().sql`
      insert into sellers (name) values (${`Dispatch Farm ${suffix}`}) returning id
    `;
    const farmId = farm[0]?.id as string;
    const location = await handle().sql`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type, public_address, public_latitude,
        public_longitude, farm_bucks_accepted, farm_bucks_eligible
      ) values (
        ${farmId}, 'farm_stand', ${`Dispatch Stand ${suffix}`}, 'America/Los_Angeles', 'visitable', 'produce',
        ${`${suffix} Dispatch Way`}, 47.45, -122.46, false, true
      ) returning id
    `;
    const salesLocationId = location[0]?.id as string;
    const authorizations = await handle().sql`
      insert into farmer_authorizations (
        seller_id, contact_id, phone_verified_at, authorized_at
      ) values
        (${farmId}, ${contactId}, ${BASE}, ${BASE}),
        (${farmId}, ${alternateContactId}, ${BASE}, ${BASE})
      returning id, contact_id
    `;
    const authorizationId = authorizations.find((row) => row.contact_id === contactId)?.id as string;
    const alternateAuthorizationId = authorizations.find(
      (row) => row.contact_id === alternateContactId,
    )?.id as string;
    const approval = await handle().sql`
      insert into seller_approvals (seller_id, administrator_id, approved_at)
      values (${farmId}, ${ids.administrator}, ${BASE}) returning id
    `;
    const approvalId = approval[0]?.id as string;
    await handle().sql`
      insert into sms_consents (
        recipient_hash, state, capture_source, captured_at, capture_evidence_ref, updated_at
      ) values (
        ${fixtureSender}, 'active', 'farmer_onboarding', ${BASE}, ${`fixture-${suffix}`}, ${BASE}
      )
    `;
    let inventoryRevisionId: string | null = null;
    if (options?.inventory !== "none") {
      const baselineProposal = await handle().sql`
        insert into inventory_publication_proposals (
          sender_hash, sales_location_id, provider_id, payload, proposal_version,
          has_inventory, has_closure,
          base_revision_id, base_is_first_publication, state, closed_at
        ) values (
          ${fixtureSender}, ${salesLocationId},
          (select id from stand_providers
            where sales_location_id = ${salesLocationId} and seller_id = (select own_seller_id from sales_locations where id = ${salesLocationId})), ${handle().sql.json({ entries: [] })}, 1,
          true, false, null, true, 'invalidated', ${BASE}
        ) returning id
      `;
      const revision = await handle().sql`
        insert into inventory_revisions (
          seller_id, sales_location_id, provider_id, proposal_id, published_by_authorization_id,
          farm_approval_id, source, published_at
        ) values (
          ${farmId}, ${salesLocationId},
        (select id from stand_providers
          where sales_location_id = ${salesLocationId} and seller_id = (select own_seller_id from sales_locations where id = ${salesLocationId})), ${baselineProposal[0]?.id as string},
          ${authorizationId}, ${approvalId}, 'sms', ${BASE}
        ) returning id
      `;
      inventoryRevisionId = revision[0]?.id as string;
      const itemName = options?.inventory === "oversized" ? "🥕".repeat(160) : "Carrots";
      await handle().sql`
        insert into inventory_entries (
          inventory_revision_id, sales_location_id, item_name, quantity, unit,
          price_text, approximation, sort_order
        ) values (
          ${inventoryRevisionId}, ${salesLocationId}, ${itemName}, 3, 'bunches',
          '$5', 'some', 0
        )
      `;
    }

    let closureRevisionId: string | null = null;
    if (options?.upcomingClosure || options?.unboundedClosure) {
      const closureProposal = await handle().sql`
        insert into inventory_publication_proposals (
          sender_hash, sales_location_id, provider_id, payload, proposal_version,
          has_inventory, has_closure,
          base_revision_id, base_is_first_publication,
          closure_base_revision_id, closure_base_is_first_instruction, state, closed_at
        ) values (
          ${fixtureSender}, ${salesLocationId},
          (select id from stand_providers
            where sales_location_id = ${salesLocationId} and seller_id = (select own_seller_id from sales_locations where id = ${salesLocationId})), ${handle().sql.json({ entries: [] })}, 1,
          false, true,
          null, null, null, true, 'invalidated', ${BASE}
        ) returning id
      `;
      const closure = await handle().sql`
        insert into closure_revisions (
          owner_seller_id, sales_location_id, proposal_id, owner_authorization_id,
          owner_approval_id, result, closure_kind, starts_on, closed_through, published_at
        ) values (
          ${farmId}, ${salesLocationId}, ${closureProposal[0]?.id as string},
          ${authorizationId}, ${approvalId}, 'close', 'temporary', '2026-03-15',
          ${options.unboundedClosure ? null : "2026-03-16"}, ${BASE}
        ) returning id
      `;
      closureRevisionId = closure[0]?.id as string;
    }

    const preference = await setInventoryPromptPreference(handle(), {
      senderHash: fixtureSender,
      authorizationId,
      salesLocationId,
      cadence: "weekly",
      clock: new FixedClock(BASE),
    });
    if (preference.status !== "saved") throw new Error("fixture preference failed");
    await handle().sql`
      update inventory_prompt_preferences set next_due_at = ${DUE}
      where id = ${preference.preferenceId}
    `;
    const pass = options?.autoSchedule === false
      ? { scheduled: 0, deferred: 0 }
      : await runScheduledPromptPass({ db: handle(), clock: new FixedClock(DUE) });
    const subject = await handle().sql`
      select proposal_id, outbox_work_id from scheduled_inventory_prompt_subjects
      where preference_id = ${preference.preferenceId}
    `;
    const fixtureState = subject.length === 0
      ? await handle().sql`
          select preference.next_due_at, preference.last_due_slot_at,
                 proposal.id as open_proposal_id, closure.starts_on
          from inventory_prompt_preferences as preference
          left join inventory_publication_proposals as proposal
            on proposal.sales_location_id = preference.sales_location_id and proposal.state = 'open'
          left join closure_revisions as closure
            on closure.sales_location_id = preference.sales_location_id and closure.is_current
          where preference.id = ${preference.preferenceId}
        `
      : [];
    if (options?.autoSchedule !== false) {
      expect(
        subject,
        `the isolated preference must queue its own typed subject: ${JSON.stringify({ pass, fixtureState })}`,
      ).toHaveLength(1);
    }
    return {
      senderHash: fixtureSender,
      farmId,
      salesLocationId,
      authorizationId,
      alternateAuthorizationId,
      approvalId,
      preferenceId: preference.preferenceId,
      inventoryRevisionId,
      closureRevisionId,
      proposalId: subject[0]?.proposal_id as string,
      outboxWorkId: subject[0]?.outbox_work_id as string,
    };
  }

  async function acceptFixture(fixture: Awaited<ReturnType<typeof createQueuedFixture>>) {
    const claim = await authorizeDispatch(handle(), { outboxWorkId: fixture.outboxWorkId, now: DUE });
    expect(claim.status).toBe("authorized");
    if (claim.status !== "authorized") throw new Error("scheduled fixture was not authorized");
    await recordDispatchResult(handle(), {
      dispatchAttemptId: claim.dispatchAttemptId,
      outcome: "accepted",
      providerMessageId: `provider-${fixture.proposalId}`,
      now: new Date(DUE.getTime() + 1_000),
    });
  }

  async function sameSideEffectCounts(
    fixture: Awaited<ReturnType<typeof createQueuedFixture>>,
  ) {
    const revisions = await handle().sql`
      select count(*)::integer as count from inventory_revisions
      where sales_location_id = ${fixture.salesLocationId}
    `;
    const receipts = await handle().sql`
      select count(*)::integer as count from outbox_work
      where recipient_hash = ${fixture.senderHash}
        and logical_key like 'inventory-published-%'
    `;
    return { revisions: revisions[0]?.count as number, receipts: receipts[0]?.count as number };
  }

  async function replaceInventoryBase(
    fixture: Awaited<ReturnType<typeof createQueuedFixture>>,
    changedAt: Date,
  ) {
    await handle().sql`
      update inventory_revisions set is_current = false, superseded_at = ${changedAt}
      where id = ${fixture.inventoryRevisionId}
    `;
    const proposal = await handle().sql`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, provider_id, payload, proposal_version,
        has_inventory, has_closure,
        base_revision_id, base_is_first_publication, state, closed_at
      ) values (
        ${fixture.senderHash}, ${fixture.salesLocationId},
          (select id from stand_providers
            where sales_location_id = ${fixture.salesLocationId} and seller_id = (select own_seller_id from sales_locations where id = ${fixture.salesLocationId})), ${handle().sql.json({ entries: [] })}, 1,
        true, false, ${fixture.inventoryRevisionId}, false, 'invalidated', ${changedAt}
      ) returning id
    `;
    await handle().sql`
      insert into inventory_revisions (
        seller_id, sales_location_id, provider_id, proposal_id, published_by_authorization_id,
        farm_approval_id, source, published_at
      ) values (
        ${fixture.farmId}, ${fixture.salesLocationId},
        (select id from stand_providers
          where sales_location_id = ${fixture.salesLocationId} and seller_id = (select own_seller_id from sales_locations where id = ${fixture.salesLocationId})), ${proposal[0]?.id as string},
        ${fixture.authorizationId}, ${fixture.approvalId}, 'sms', ${changedAt}
      )
    `;
  }

  async function addReopenClosure(
    fixture: Awaited<ReturnType<typeof createQueuedFixture>>,
    changedAt: Date,
  ) {
    const proposal = await handle().sql`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, provider_id, payload, proposal_version,
        has_inventory, has_closure,
        base_revision_id, base_is_first_publication,
        closure_base_revision_id, closure_base_is_first_instruction, state, closed_at
      ) values (
        ${fixture.senderHash}, ${fixture.salesLocationId},
          (select id from stand_providers
            where sales_location_id = ${fixture.salesLocationId} and seller_id = (select own_seller_id from sales_locations where id = ${fixture.salesLocationId})), ${handle().sql.json({ entries: [] })}, 1,
        false, true, null, null, null, true, 'invalidated', ${changedAt}
      ) returning id
    `;
    await handle().sql`
      insert into closure_revisions (
        owner_seller_id, sales_location_id, proposal_id, owner_authorization_id,
        owner_approval_id, result, published_at
      ) values (
        ${fixture.farmId}, ${fixture.salesLocationId}, ${proposal[0]?.id as string},
        ${fixture.authorizationId}, ${fixture.approvalId}, 'reopen', ${changedAt}
      )
    `;
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
    // The recency stamp comes from the revision's own `published_at`, so this asserts the
    // database value reached the copy rather than that the renderer can format a date.
    expect(rows[0]?.body).toContain("Items listed for Prompt Stand (updated ");
    expect(rows[0]?.body).toMatch(/\(updated (now|\d+[hd] ago)\):/);
    expect(rows[0]?.body).toContain("- Eggs (6 dozen, $8)");
    expect(rows[0]?.body).toContain("- Kale (4 bunches, $5)");
    expect(rows[0]?.body).toContain("Reply SAME");
    expect(rows[0]?.payload).toEqual({
      entries: [
        {
          entryId: expect.any(String), itemName: "Eggs", quantity: 6, unit: "dozen",
          priceText: "$8", approximation: "plentiful",
        },
        {
          entryId: expect.any(String), itemName: "Kale", quantity: 4, unit: "bunches",
          priceText: "$5", approximation: "limited",
        },
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

  it("SAME publishes an identical new revision and queues the ordinary named receipt", async () => {
    const scheduled = await handle().sql`
      select proposal_id from scheduled_inventory_prompt_subjects
      where preference_id = ${ids.preference} order by due_slot_at asc limit 1
    `;
    const scheduledProposalId = scheduled[0]?.proposal_id as string;
    const publishedAt = new Date(DUE.getTime() + 2_000);
    const result = await handleScheduledSame(
      { db: handle(), clock: new FixedClock(publishedAt) },
      {
        senderHash,
        occurredAt: publishedAt,
        providerEventId: "inbound-same-1",
      },
    );
    expect(result).toEqual({ replies: [], status: "published" });
    const revisions = await handle().sql`
      select revision.id, revision.proposal_id, revision.published_at,
             revision.is_current, revision.superseded_at,
             jsonb_agg(jsonb_build_object(
               'itemName', entry.item_name,
               'quantity', entry.quantity,
               'unit', entry.unit,
               'priceText', entry.price_text,
               'approximation', entry.approximation
             ) order by entry.sort_order) as entries
      from inventory_revisions as revision
      join inventory_entries as entry on entry.inventory_revision_id = revision.id
      where revision.sales_location_id = ${ids.location}
      group by revision.id, revision.proposal_id, revision.published_at,
               revision.is_current, revision.superseded_at
      order by revision.published_at asc
    `;
    const completeEntries = [
      {
        itemName: "Eggs", quantity: 6, unit: "dozen",
        priceText: "$8", approximation: "plentiful",
      },
      {
        itemName: "Kale", quantity: 4, unit: "bunches",
        priceText: "$5", approximation: "limited",
      },
    ];
    expect(revisions).toEqual([
      expect.objectContaining({
        id: ids.revision,
        is_current: false,
        superseded_at: publishedAt,
        entries: completeEntries,
      }),
      {
        id: expect.any(String),
        proposal_id: scheduledProposalId,
        published_at: publishedAt,
        is_current: true,
        superseded_at: null,
        entries: completeEntries,
      },
    ]);
    expect(revisions[1]?.id).not.toBe(ids.revision);
    expect(await handle().sql`
      select count(*)::integer as count from inventory_revisions
      where proposal_id = ${scheduledProposalId}
    `).toEqual([{ count: 1 }]);
    expect(await handle().sql`
      select body, state from outbox_work
      where logical_key like 'inventory-published-%'
    `).toEqual([{
      body: "Prompt Stand: your listing is updated. Thank you!",
      state: "queued",
    }]);
  });

  it("suppresses a scheduled outbox before provider I/O when its stored proposal version goes stale", async () => {
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
    expect(claim.status).toBe("suppressed");
    expect(await handle().sql`
      select state, activation_outbox_id, activated_version, activated_at, expires_at
      from inventory_publication_proposals where id = ${subject[0]?.proposal_id as string}
    `).toEqual([{
      state: "invalidated",
      activation_outbox_id: null,
      activated_version: null,
      activated_at: null,
      expires_at: null,
    }]);
    expect(await handle().sql`
      select state, dispatch_authorized_at from outbox_work where id = ${outboxWorkId}
    `).toEqual([{ state: "suppressed", dispatch_authorized_at: null }]);
  });

  it.each([
    "STOP consent",
    "missing consent",
    "revoked authorization",
    "revoked approval",
    "preference version",
    "paused cadence",
    "designated recipient",
    "due slot",
    "inventory base",
    "closure base",
    "active closure",
    "newer farmer activity",
  ])("suppresses before provider I/O after %s changes", async (reason) => {
    const fixture = await createQueuedFixture({ upcomingClosure: reason === "active closure" });
    const changedAt = new Date(DUE.getTime() + 1_000);
    if (reason === "STOP consent") {
      await handle().sql`
        update sms_consents set state = 'stopped', updated_at = ${changedAt}
        where recipient_hash = ${fixture.senderHash}
      `;
    } else if (reason === "missing consent") {
      await handle().sql`delete from sms_consents where recipient_hash = ${fixture.senderHash}`;
    } else if (reason === "revoked authorization") {
      await handle().sql`
        update farmer_authorizations set revoked_at = ${changedAt}
        where id = ${fixture.authorizationId}
      `;
    } else if (reason === "revoked approval") {
      await handle().sql`
        update seller_approvals set revoked_at = ${changedAt} where id = ${fixture.approvalId}
      `;
    } else if (reason === "preference version") {
      await handle().sql`
        update inventory_prompt_preferences set version = version + 1
        where id = ${fixture.preferenceId}
      `;
    } else if (reason === "paused cadence") {
      await handle().sql`
        update inventory_prompt_preferences set cadence = 'paused', next_due_at = null
        where id = ${fixture.preferenceId}
      `;
    } else if (reason === "designated recipient") {
      await handle().sql`
        update inventory_prompt_preferences
        set designated_authorization_id = ${fixture.alternateAuthorizationId}
        where id = ${fixture.preferenceId}
      `;
    } else if (reason === "due slot") {
      await handle().sql`
        update inventory_prompt_preferences set last_due_slot_at = ${changedAt}
        where id = ${fixture.preferenceId}
      `;
    } else if (reason === "inventory base") {
      await handle().sql`
        update inventory_revisions set is_current = false, superseded_at = ${changedAt}
        where id = ${fixture.inventoryRevisionId}
      `;
      const proposal = await handle().sql`
        insert into inventory_publication_proposals (
          sender_hash, sales_location_id, provider_id, payload, proposal_version,
          has_inventory, has_closure,
          base_revision_id, base_is_first_publication, state, closed_at
        ) values (
          ${fixture.senderHash}, ${fixture.salesLocationId},
          (select id from stand_providers
            where sales_location_id = ${fixture.salesLocationId} and seller_id = (select own_seller_id from sales_locations where id = ${fixture.salesLocationId})), ${handle().sql.json({ entries: [] })}, 1,
          true, false, ${fixture.inventoryRevisionId}, false, 'invalidated', ${changedAt}
        ) returning id
      `;
      await handle().sql`
        insert into inventory_revisions (
          seller_id, sales_location_id, provider_id, proposal_id, published_by_authorization_id,
          farm_approval_id, source, published_at
        ) values (
          ${fixture.farmId}, ${fixture.salesLocationId},
        (select id from stand_providers
          where sales_location_id = ${fixture.salesLocationId} and seller_id = (select own_seller_id from sales_locations where id = ${fixture.salesLocationId})), ${proposal[0]?.id as string},
          ${fixture.authorizationId}, ${fixture.approvalId}, 'sms', ${changedAt}
        )
      `;
    } else if (reason === "closure base") {
      const proposal = await handle().sql`
        insert into inventory_publication_proposals (
          sender_hash, sales_location_id, provider_id, payload, proposal_version,
          has_inventory, has_closure,
          base_revision_id, base_is_first_publication,
          closure_base_revision_id, closure_base_is_first_instruction, state, closed_at
        ) values (
          ${fixture.senderHash}, ${fixture.salesLocationId},
          (select id from stand_providers
            where sales_location_id = ${fixture.salesLocationId} and seller_id = (select own_seller_id from sales_locations where id = ${fixture.salesLocationId})), ${handle().sql.json({ entries: [] })}, 1,
          false, true, null, null, null, true, 'invalidated', ${changedAt}
        ) returning id
      `;
      await handle().sql`
        insert into closure_revisions (
          owner_seller_id, sales_location_id, proposal_id, owner_authorization_id,
          owner_approval_id, result, published_at
        ) values (
          ${fixture.farmId}, ${fixture.salesLocationId}, ${proposal[0]?.id as string},
          ${fixture.authorizationId}, ${fixture.approvalId}, 'reopen', ${changedAt}
        )
      `;
    } else if (reason === "newer farmer activity") {
      await handle().sql`
        update sender_states set conversation_occurred_at = ${changedAt},
          conversation_provider_event_id = 'newer-farmer-activity'
        where sender_hash = ${fixture.senderHash}
      `;
    }

    const dispatchAt = reason === "active closure"
      ? new Date("2026-03-15T17:00:00.000Z")
      : changedAt;
    expect(await authorizeDispatch(handle(), {
      outboxWorkId: fixture.outboxWorkId,
      now: dispatchAt,
    })).toEqual({ status: "suppressed" });
    expect(await handle().sql`
      select state, dispatch_authorized_at from outbox_work where id = ${fixture.outboxWorkId}
    `).toEqual([{ state: "suppressed", dispatch_authorized_at: null }]);
    expect(await handle().sql`
      select state, activation_outbox_id from inventory_publication_proposals
      where id = ${fixture.proposalId}
    `).toEqual([{ state: "invalidated", activation_outbox_id: null }]);
    expect(await handle().sql`
      select count(*)::integer as count from outbox_dispatch_attempts
      where outbox_work_id = ${fixture.outboxWorkId}
    `).toEqual([{ count: 0 }]);
  });

  it("refuses SAME when the same stored closure becomes active after dispatch", async () => {
    const fixture = await createQueuedFixture({ upcomingClosure: true });
    const claim = await authorizeDispatch(handle(), {
      outboxWorkId: fixture.outboxWorkId,
      now: DUE,
    });
    expect(claim.status).toBe("authorized");
    if (claim.status !== "authorized") return;
    await recordDispatchResult(handle(), {
      dispatchAttemptId: claim.dispatchAttemptId,
      outcome: "accepted",
      providerMessageId: `provider-closure-crossing-${fixture.proposalId}`,
      now: new Date(DUE.getTime() + 1_000),
    });

    const sameAt = new Date("2026-03-15T17:00:00.000Z");
    const result = await handleScheduledSame(
      { db: handle(), clock: new FixedClock(sameAt) },
      {
        senderHash: fixture.senderHash,
        occurredAt: sameAt,
        providerEventId: `same-closure-crossing-${fixture.proposalId}`,
      },
    );
    expect(result.status).toBe("base_conflict");
    expect(result.replies).toHaveLength(1);
    expect(await handle().sql`
      select state, consumption_provider_event_id
      from inventory_publication_proposals where id = ${fixture.proposalId}
    `).toEqual([{ state: "invalidated", consumption_provider_event_id: null }]);
    expect(await handle().sql`
      select count(*)::integer as count from inventory_revisions
      where sales_location_id = ${fixture.salesLocationId}
    `).toEqual([{ count: 1 }]);
  });

  it.each([
    ["expired window", "expired", "expired"],
    ["inventory base", "base_conflict", "invalidated"],
    ["closure base", "base_conflict", "invalidated"],
    ["preference version", "base_conflict", "invalidated"],
    ["paused cadence", "base_conflict", "invalidated"],
    ["STOP consent", "not_authorized", "invalidated"],
  ] as const)(
    "rejects SAME without a publication or receipt after %s changes",
    async (reason, expectedStatus, expectedState) => {
      const fixture = await createQueuedFixture();
      await acceptFixture(fixture);
      const changedAt = new Date(DUE.getTime() + 2_000);
      if (reason === "inventory base") {
        await replaceInventoryBase(fixture, changedAt);
      } else if (reason === "closure base") {
        await addReopenClosure(fixture, changedAt);
      } else if (reason === "preference version") {
        await handle().sql`
          update inventory_prompt_preferences set version = version + 1
          where id = ${fixture.preferenceId}
        `;
      } else if (reason === "paused cadence") {
        await handle().sql`
          update inventory_prompt_preferences set cadence = 'paused', next_due_at = null
          where id = ${fixture.preferenceId}
        `;
      } else if (reason === "STOP consent") {
        await handle().sql`
          update sms_consents set state = 'stopped', updated_at = ${changedAt}
          where recipient_hash = ${fixture.senderHash}
        `;
      }
      const occurredAt = reason === "expired window"
        ? ((await handle().sql`
            select expires_at from inventory_publication_proposals where id = ${fixture.proposalId}
          `)[0]?.expires_at as Date)
        : new Date(DUE.getTime() + 3_000);
      const before = await sameSideEffectCounts(fixture);
      const result = await handleScheduledSame(
        { db: handle(), clock: new FixedClock(occurredAt) },
        {
          senderHash: fixture.senderHash,
          occurredAt,
          providerEventId: `same-rejected-${reason}-${fixture.proposalId}`,
        },
      );
      expect(result.status).toBe(expectedStatus);
      expect(result.replies.map((reply) => reply.body)).toEqual([renderClarificationRequest()]);
      expect(await sameSideEffectCounts(fixture)).toEqual(before);
      expect(await handle().sql`
        select state, consumption_provider_event_id
        from inventory_publication_proposals where id = ${fixture.proposalId}
      `).toEqual([{ state: expectedState, consumption_provider_event_id: null }]);
    },
  );

  it.each(["unaccepted scheduled outbox", "different accepted outbox"])(
    "rejects SAME against an %s",
    async (kind) => {
      const fixture = await createQueuedFixture();
      if (kind === "different accepted outbox") {
        const other = await handle().sql`
          insert into outbox_work (
            logical_key, recipient_hash, message_category, body,
            body_expires_at, available_at, created_at
          ) values (
            ${`other-outbox-${fixture.proposalId}`}, ${fixture.senderHash},
            'inquiry_reply', 'Other message', ${new Date("2027-01-01T00:00:00.000Z")},
            ${DUE}, ${DUE}
          ) returning id
        `;
        const claim = await authorizeDispatch(handle(), {
          outboxWorkId: other[0]?.id as string,
          now: DUE,
        });
        expect(claim.status).toBe("authorized");
        if (claim.status !== "authorized") return;
        await recordDispatchResult(handle(), {
          dispatchAttemptId: claim.dispatchAttemptId,
          outcome: "accepted",
          providerMessageId: `provider-other-${fixture.proposalId}`,
          now: new Date(DUE.getTime() + 1_000),
        });
      }
      const before = await sameSideEffectCounts(fixture);
      const sameAt = new Date(DUE.getTime() + 2_000);
      const result = await handleScheduledSame(
        { db: handle(), clock: new FixedClock(sameAt) },
        {
          senderHash: fixture.senderHash,
          occurredAt: sameAt,
          providerEventId: `same-not-activated-${kind}-${fixture.proposalId}`,
        },
      );
      expect(result.status).toBe("not_activated");
      expect(result.replies.map((reply) => reply.body)).toEqual([renderClarificationRequest()]);
      expect(await sameSideEffectCounts(fixture)).toEqual(before);
      expect(await handle().sql`
        select state, activation_outbox_id from inventory_publication_proposals
        where id = ${fixture.proposalId}
      `).toEqual([{ state: "open", activation_outbox_id: null }]);
    },
  );

  it("makes a replayed SAME harmless after one exact publication and receipt", async () => {
    const fixture = await createQueuedFixture();
    await acceptFixture(fixture);
    const firstAt = new Date(DUE.getTime() + 2_000);
    expect(await handleScheduledSame(
      { db: handle(), clock: new FixedClock(firstAt) },
      {
        senderHash: fixture.senderHash,
        occurredAt: firstAt,
        providerEventId: `same-first-${fixture.proposalId}`,
      },
    )).toEqual({ replies: [], status: "published" });
    const afterFirst = await sameSideEffectCounts(fixture);
    expect(afterFirst).toEqual({ revisions: 2, receipts: 1 });

    const replayAt = new Date(DUE.getTime() + 3_000);
    expect(await handleScheduledSame(
      { db: handle(), clock: new FixedClock(replayAt) },
      {
        senderHash: fixture.senderHash,
        occurredAt: replayAt,
        providerEventId: `same-replay-${fixture.proposalId}`,
      },
    )).toEqual({ replies: [], status: "no_active_prompt" });
    expect(await sameSideEffectCounts(fixture)).toEqual(afterFirst);
  });

  it.each([
    ["no published inventory", "none"],
    ["an oversized full snapshot", "oversized"],
  ] as const)("never offers or activates SAME with %s", async (_reason, inventory) => {
    const fixture = await createQueuedFixture({ inventory });
    expect(await handle().sql`
      select subject.offers_same, work.body
      from scheduled_inventory_prompt_subjects as subject
      join outbox_work as work on work.id = subject.outbox_work_id
      where subject.proposal_id = ${fixture.proposalId}
    `).toEqual([{
      offers_same: false,
      // Through the renderer, not a second copy of its wording: it carries the opt-out
      // reminder since F-096, and a hand-written literal here would have to be edited in
      // lockstep forever to keep saying the same thing.
      body: renderScheduledInventoryUpdateRequest({
        locationName: `Dispatch Stand ${fixtureNumber.toString().padStart(2, "0")}`,
      }),
    }]);
    // The renderer is the expectation above, so its OUTPUT is checked here — otherwise an
    // empty or gutted body would match itself and the assertion would prove nothing.
    const sentBody = renderScheduledInventoryUpdateRequest({
      locationName: `Dispatch Stand ${fixtureNumber.toString().padStart(2, "0")}`,
    });
    expect(sentBody).toContain("text what is available now");
    expect(sentBody).toContain("STOP");
    const before = await sameSideEffectCounts(fixture);
    const claim = await authorizeDispatch(handle(), { outboxWorkId: fixture.outboxWorkId, now: DUE });
    expect(claim.status).toBe("authorized");
    if (claim.status !== "authorized") return;
    await recordDispatchResult(handle(), {
      dispatchAttemptId: claim.dispatchAttemptId,
      outcome: "accepted",
      providerMessageId: `provider-no-same-${fixture.proposalId}`,
      now: new Date(DUE.getTime() + 1_000),
    });
    expect(await handle().sql`
      select activation_outbox_id, activated_at from inventory_publication_proposals
      where id = ${fixture.proposalId}
    `).toEqual([{ activation_outbox_id: null, activated_at: null }]);
    expect(await handleScheduledSame(
      { db: handle(), clock: new FixedClock(new Date(DUE.getTime() + 2_000)) },
      {
        senderHash: fixture.senderHash,
        occurredAt: new Date(DUE.getTime() + 2_000),
        providerEventId: `same-unavailable-${fixture.proposalId}`,
      },
    )).toEqual({ replies: [], status: "no_active_prompt" });
    expect(await sameSideEffectCounts(fixture)).toEqual(before);
  });

  it("moves a due preference forward from a fresh publication without queueing", async () => {
    const fixture = await createQueuedFixture({ autoSchedule: false });
    const publishedAt = new Date(DUE.getTime() - 1_000);
    await replaceInventoryBase(fixture, publishedAt);
    await runScheduledPromptPass({ db: handle(), clock: new FixedClock(DUE) });
    expect(await handle().sql`
      select proposal_id from scheduled_inventory_prompt_subjects where preference_id = ${fixture.preferenceId}
    `).toHaveLength(0);
    expect(await handle().sql`
      select last_due_slot_at, next_due_at from inventory_prompt_preferences
      where id = ${fixture.preferenceId}
    `).toEqual([{ last_due_slot_at: null, next_due_at: expect.any(Date) }]);
    const preference = await handle().sql`
      select next_due_at from inventory_prompt_preferences where id = ${fixture.preferenceId}
    `;
    expect((preference[0]?.next_due_at as Date).getTime()).toBeGreaterThan(DUE.getTime());
  });

  it("keeps an active closure's due slot unconsumed, then queues at most once after expiry", async () => {
    const fixture = await createQueuedFixture({ upcomingClosure: true, autoSchedule: false });
    const activeAt = new Date("2026-03-15T17:00:00.000Z");
    await runScheduledPromptPass({ db: handle(), clock: new FixedClock(activeAt) });
    expect(await handle().sql`
      select last_due_slot_at, next_due_at from inventory_prompt_preferences
      where id = ${fixture.preferenceId}
    `).toEqual([{ last_due_slot_at: null, next_due_at: DUE }]);
    expect(await handle().sql`
      select proposal_id from scheduled_inventory_prompt_subjects where preference_id = ${fixture.preferenceId}
    `).toHaveLength(0);

    const afterExpiry = new Date("2026-03-17T17:00:00.000Z");
    await runScheduledPromptPass({ db: handle(), clock: new FixedClock(afterExpiry) });
    await runScheduledPromptPass({ db: handle(), clock: new FixedClock(afterExpiry) });
    expect(await handle().sql`
      select due_slot_at from scheduled_inventory_prompt_subjects where preference_id = ${fixture.preferenceId}
    `).toEqual([{ due_slot_at: DUE }]);
    expect(await handle().sql`
      select count(*)::integer as count from outbox_work
      where logical_key like ${`scheduled-prompt-${fixture.preferenceId}-%`}
    `).toEqual([{ count: 1 }]);
  });

  it("queues an unconsumed due slot exactly once after an explicit reopen", async () => {
    const fixture = await createQueuedFixture({ unboundedClosure: true, autoSchedule: false });
    const activeAt = new Date("2026-03-15T17:00:00.000Z");
    await runScheduledPromptPass({ db: handle(), clock: new FixedClock(activeAt) });
    expect(await handle().sql`
      select last_due_slot_at, next_due_at from inventory_prompt_preferences
      where id = ${fixture.preferenceId}
    `).toEqual([{ last_due_slot_at: null, next_due_at: DUE }]);

    const reopenedAt = new Date("2026-03-15T17:00:01.000Z");
    const reopenProposal = await handle().sql`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, provider_id, payload, proposal_version,
        has_inventory, has_closure,
        base_revision_id, base_is_first_publication,
        closure_base_revision_id, closure_base_is_first_instruction, state, closed_at
      ) values (
        ${fixture.senderHash}, ${fixture.salesLocationId},
          (select id from stand_providers
            where sales_location_id = ${fixture.salesLocationId} and seller_id = (select own_seller_id from sales_locations where id = ${fixture.salesLocationId})),
        ${handle().sql.json({ closure: { result: "reopen" } })}, 1,
        false, true, null, null, ${fixture.closureRevisionId}, false,
        'invalidated', ${reopenedAt}
      ) returning id
    `;
    await handle().sql`
      update closure_revisions set is_current = false, superseded_at = ${reopenedAt}
      where id = ${fixture.closureRevisionId}
    `;
    await handle().sql`
      insert into closure_revisions (
        owner_seller_id, sales_location_id, proposal_id, owner_authorization_id,
        owner_approval_id, result, published_at
      ) values (
        ${fixture.farmId}, ${fixture.salesLocationId}, ${reopenProposal[0]?.id as string},
        ${fixture.authorizationId}, ${fixture.approvalId}, 'reopen', ${reopenedAt}
      )
    `;

    const delayedAt = new Date("2026-04-30T17:00:00.000Z");
    await runScheduledPromptPass({ db: handle(), clock: new FixedClock(delayedAt) });
    await runScheduledPromptPass({ db: handle(), clock: new FixedClock(delayedAt) });
    expect(await handle().sql`
      select due_slot_at from scheduled_inventory_prompt_subjects where preference_id = ${fixture.preferenceId}
    `).toEqual([{ due_slot_at: DUE }]);
    expect(await handle().sql`
      select count(*)::integer as count from outbox_work
      where logical_key like ${`scheduled-prompt-${fixture.preferenceId}-%`}
    `).toEqual([{ count: 1 }]);
    const preference = await handle().sql`
      select last_due_slot_at, next_due_at from inventory_prompt_preferences
      where id = ${fixture.preferenceId}
    `;
    expect(preference[0]?.last_due_slot_at).toEqual(DUE);
    expect((preference[0]?.next_due_at as Date).getTime()).toBeGreaterThan(delayedAt.getTime());
  });

  it("queues one delayed slot and advances directly to one future slot", async () => {
    const fixture = await createQueuedFixture({ autoSchedule: false });
    const delayedAt = new Date("2026-04-30T17:00:00.000Z");
    await runScheduledPromptPass({ db: handle(), clock: new FixedClock(delayedAt) });
    await runScheduledPromptPass({ db: handle(), clock: new FixedClock(delayedAt) });
    expect(await handle().sql`
      select due_slot_at from scheduled_inventory_prompt_subjects where preference_id = ${fixture.preferenceId}
    `).toEqual([{ due_slot_at: DUE }]);
    const preference = await handle().sql`
      select last_due_slot_at, next_due_at from inventory_prompt_preferences
      where id = ${fixture.preferenceId}
    `;
    expect(preference[0]?.last_due_slot_at).toEqual(DUE);
    expect((preference[0]?.next_due_at as Date).getTime()).toBeGreaterThan(delayedAt.getTime());
  });

  it("chooses the deterministic first of two due locations for one sender", async () => {
    const fixture = await createQueuedFixture({ autoSchedule: false });
    const secondLocation = await handle().sql`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type, public_address, public_latitude,
        public_longitude, farm_bucks_accepted, farm_bucks_eligible
      ) values (
        ${fixture.farmId}, 'farm_stand', 'Second Due Stand', 'America/Los_Angeles', 'visitable', 'produce',
        '2 Due Way', 47.45, -122.46, false, true
      ) returning id
    `;
    const secondLocationId = secondLocation[0]?.id as string;
    const secondPreference = await setInventoryPromptPreference(handle(), {
      senderHash: fixture.senderHash,
      authorizationId: fixture.authorizationId,
      salesLocationId: secondLocationId,
      cadence: "weekly",
      clock: new FixedClock(BASE),
    });
    if (secondPreference.status !== "saved") throw new Error("second preference setup failed");
    await handle().sql`
      update inventory_prompt_preferences set next_due_at = ${DUE}
      where id = ${secondPreference.preferenceId}
    `;
    await runScheduledPromptPass({ db: handle(), clock: new FixedClock(DUE) });

    const expectedFirst = [fixture.salesLocationId, secondLocationId].sort()[0];
    expect(await handle().sql`
      select sales_location_id from scheduled_inventory_prompt_subjects
      where preference_id in (${fixture.preferenceId}, ${secondPreference.preferenceId})
    `).toEqual([{ sales_location_id: expectedFirst }]);
    const preferences = await handle().sql`
      select sales_location_id, last_due_slot_at, next_due_at
      from inventory_prompt_preferences
      where id in (${fixture.preferenceId}, ${secondPreference.preferenceId})
      order by sales_location_id asc
    `;
    expect(preferences).toHaveLength(2);
    expect(preferences.find((row) => row.sales_location_id === expectedFirst)?.last_due_slot_at)
      .toEqual(DUE);
    const other = preferences.find((row) => row.sales_location_id !== expectedFirst);
    expect(other).toMatchObject({ last_due_slot_at: null, next_due_at: DUE });
  });

  it("turns farmer change text into a new ordinary proposal after an active scheduled prompt", async () => {
    const fixture = await createQueuedFixture();
    await acceptFixture(fixture);
    let interpreterCalls = 0;
    const result = await handleFreeText(
      {
        db: handle(),
        clock: new FixedClock(new Date(DUE.getTime() + 2_000)),
        // One classifier for every sender (F-111). `inventory_report` is the category an
        // update and a report SHARE; that this farmer holds the stand is what sends it to the
        // publish path, and that is decided in code from `farmer_authorizations`.
        classifier: {
          async classify() { return { ok: true as const, kind: "inventory_report" as const }; },
        },
        stockOut: {
          async parseItem(): Promise<never> {
            throw new Error("the stock-out seam must not run on a farmer path");
          },
        },
        interpreter: {
          async interpret(request) {
            interpreterCalls += 1;
            expect(request.currentEntries).toEqual([{ entryId: expect.any(String), itemName: "Carrots" }]);
            return {
              kind: "edits" as const,
              additions: [{ itemName: "Beets" }],
              changes: [],
              removals: [],
            };
          },
        },
        catalogMatcher: {} as never,
      },
      {
        senderHash: fixture.senderHash,
        taskText: "also add beets",
        providerEventId: `farmer-change-${fixture.proposalId}`,
        inboxEventId: randomUUID(),
        occurredAt: new Date(DUE.getTime() + 2_000),
      },
    );
    expect(interpreterCalls).toBe(1);
    expect(result.handled).toBe("farmer");
    expect(result.replies).toEqual([expect.objectContaining({
      category: "inventory_confirmation",
      logicalKey: expect.stringMatching(/^proposal-prompt-[0-9a-f-]+-1$/),
      body: expect.stringContaining("Beets"),
    })]);
    expect(await handle().sql`
      select state from inventory_publication_proposals where id = ${fixture.proposalId}
    `).toEqual([{ state: "invalidated" }]);
    const ordinary = await handle().sql`
      select proposal.id, proposal.proposal_version, proposal.payload,
             subject.proposal_id as scheduled_subject
      from inventory_publication_proposals as proposal
      left join scheduled_inventory_prompt_subjects as subject on subject.proposal_id = proposal.id
      where proposal.sender_hash = ${fixture.senderHash} and proposal.state = 'open'
    `;
    expect(ordinary).toEqual([{
      id: expect.not.stringMatching(fixture.proposalId),
      proposal_version: 1,
      payload: {
        entries: [
          expect.objectContaining({ itemName: "Carrots" }),
          expect.objectContaining({ itemName: "Beets" }),
        ],
      },
      scheduled_subject: null,
    }]);
  });

  it("rechecks revocation after genuinely queuing behind the authorization row lock", async () => {
    const fixture = await createQueuedFixture();
    const blocker = postgres(testDatabaseUrl, { max: 1 });
    let release = () => {};
    let markLocked = () => {};
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const revokedAt = new Date(DUE.getTime() + 1_000);
    const holding = blocker.begin(async (tx) => {
      await tx`
        select id from farmer_authorizations where id = ${fixture.authorizationId} for update
      `;
      markLocked();
      await releasePromise;
      await tx`
        update farmer_authorizations set revoked_at = ${revokedAt}
        where id = ${fixture.authorizationId}
      `;
    });

    let queued = 0;
    try {
      await locked;
      const claiming = authorizeDispatch(handle(), {
        outboxWorkId: fixture.outboxWorkId,
        now: revokedAt,
      });
      for (let attempt = 0; attempt < 100 && queued < 1; attempt += 1) {
        const rows = await handle().sql`
          select count(*)::integer as count from pg_stat_activity
          where datname = current_database()
            and wait_event_type = 'Lock'
            and query like '%select auth.id, auth.seller_id, auth.revoked_at%'
        `;
        queued = rows[0]?.count as number;
        if (queued < 1) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      release();
      await holding;
      expect(await claiming).toEqual({ status: "suppressed" });
      expect(queued, "dispatch must queue behind the held authorization row").toBe(1);
      expect(await handle().sql`
        select work.state as outbox_state, proposal.state as proposal_state
        from outbox_work as work
        join scheduled_inventory_prompt_subjects as subject on subject.outbox_work_id = work.id
        join inventory_publication_proposals as proposal on proposal.id = subject.proposal_id
        where work.id = ${fixture.outboxWorkId}
      `).toEqual([{ outbox_state: "suppressed", proposal_state: "invalidated" }]);
    } finally {
      release();
      await Promise.allSettled([holding]);
      await blocker.end({ timeout: 5 });
    }
  });
});
