import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "@farm-friend/core";
import {
  confirmInventoryPublication,
  createDb,
  openOrReviseProposal,
  type Db,
  type Sql,
} from "@farm-friend/db";
import type { AppContext } from "./composition";
import { runOutboundPass } from "./workers";

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

const farmerHash = "6".repeat(64);
const secondFarmerHash = "7".repeat(64);
const T0 = new Date(Date.now() - 24 * 60 * 60 * 1000);
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const BODY_EXPIRES_AT = at(48 * 60);

describe("atomic dispatch acceptance and proposal activation (B-026)", () => {
  let adminClient: Sql | undefined;
  let sql: Sql | undefined;
  let db: Db | undefined;
  let testDatabaseName: string | undefined;
  let locationId: string;

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
    testDatabaseName = `farm_friend_b026_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(baseUrl, { max: 1 });
    await adminClient.unsafe(`create database "${testDatabaseName}"`);

    const url = new URL(baseUrl);
    url.pathname = `/${testDatabaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });

    sql = postgres(url.toString(), { max: 3 });
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
      truncate table
        provider_inbox_events, sms_messages, outbox_dispatch_attempts,
        inventory_entries, inventory_revisions, inventory_publication_proposals,
        outbox_work, consent_transition_watermarks, sms_consents, sender_states,
        audit_events, farm_approvals, farmer_authorizations, sales_locations,
        administrators, farms, contacts
      restart identity cascade
    `;

    const contacts = await client()`
      insert into contacts (phone_e164, phone_hash)
      values ('+12065550626', ${farmerHash}), ('+12065550627', ${secondFarmerHash})
      returning id, phone_hash
    `;
    const farmerContactId = contacts.find((row) => row.phone_hash === farmerHash)?.id as string;
    const secondFarmerContactId = contacts.find(
      (row) => row.phone_hash === secondFarmerHash,
    )?.id as string;
    const administrators = await client()`
      insert into administrators (email, authorized_at)
      values ('b026-admin@viga.example', ${T0}) returning id
    `;
    const farms = await client()`
      insert into farms (name) values ('B-026 Farm') returning id
    `;
    await client()`
      insert into farmer_authorizations (farm_id, contact_id, phone_verified_at, authorized_at)
      values (${farms[0]?.id as string}, ${farmerContactId}, ${T0}, ${T0}),
             (${farms[0]?.id as string}, ${secondFarmerContactId}, ${T0}, ${T0})
    `;
    await client()`
      insert into farm_approvals (farm_id, administrator_id, approved_at)
      values (${farms[0]?.id as string}, ${administrators[0]?.id as string}, ${T0})
    `;
    const locations = await client()`
      insert into sales_locations (
        owner_farm_id, kind, name, timezone, public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      ) values (
        ${farms[0]?.id as string}, 'farm_stand', 'B-026 Stand', 'America/Los_Angeles', '26 Atomic Way',
        47.45, -122.46, false, false
      ) returning id
    `;
    locationId = locations[0]?.id as string;
    await client()`
      insert into sms_consents (
        recipient_hash, state, capture_source, captured_at, capture_evidence_ref, updated_at
      ) values
        (${farmerHash}, 'active', 'farmer_onboarding', ${T0}, 'b026-consent-1', ${T0}),
        (${secondFarmerHash}, 'active', 'farmer_onboarding', ${T0}, 'b026-consent-2', ${T0})
    `;
  });

  async function queuePrompt(
    proposalId: string,
    proposalVersion: number,
    category: "inventory_confirmation" | "inventory_prompt" = "inventory_confirmation",
    recipientHash = farmerHash,
  ): Promise<string> {
    const rows = await client()`
      insert into outbox_work (
        logical_key, recipient_hash, message_category, body, body_expires_at, available_at
      ) values (
        ${`proposal-prompt-${proposalId}-${proposalVersion}`}, ${recipientHash},
        ${category}, 'Reply YES to publish this snapshot', ${BODY_EXPIRES_AT}, ${T0}
      ) returning id
    `;
    return rows[0]?.id as string;
  }

  async function dispatchAccepted(workId: string, providerMessageId: string) {
    return runOutboundPass(
      {
        context: asContext({
          db: database(),
          sendSms: async () => ({ outcome: "accepted", providerMessageId }),
        }),
        clock: new FixedClock(at(1)),
      },
      [workId],
    );
  }

  async function expectExactCurrentPromptBinding(
    workId: string,
    proposalId: string,
    proposalVersion: number,
  ): Promise<void> {
    const binding = await client()`
      select work.logical_key,
             concat('proposal-prompt-', proposal.id::text, '-',
                    proposal.proposal_version::text) as expected_key,
             work.logical_key = concat('proposal-prompt-', proposal.id::text, '-',
                                       proposal.proposal_version::text) as matches
      from outbox_work as work
      join inventory_publication_proposals as proposal
        on proposal.id = ${proposalId}
      where work.id = ${workId}
    `;
    expect(binding).toHaveLength(1);
    expect(binding[0]).toMatchObject({
      logical_key: `proposal-prompt-${proposalId}-${proposalVersion}`,
      expected_key: `proposal-prompt-${proposalId}-${proposalVersion}`,
      matches: true,
    });
  }

  it("rolls provider acceptance back when exact proposal activation fails", async () => {
    const proposal = await openOrReviseProposal(database(), {
      senderHash: farmerHash,
      salesLocationId: locationId,
      entries: [
        {
          entryId: "draft_b026_rollback_kale",
          itemName: "kale",
          quantity: 2,
          unit: "bunches",
        },
      ],
      now: T0,
      baseIsFirstPublication: true,
    });
    const workId = await queuePrompt(proposal.proposalId, proposal.proposalVersion);
    await expectExactCurrentPromptBinding(
      workId,
      proposal.proposalId,
      proposal.proposalVersion,
    );

    await client().unsafe(`
      create function b026_fail_activation() returns trigger language plpgsql as $$
      begin
        if new.activated_at is not null then
          raise exception 'b026 injected activation failure';
        end if;
        return new;
      end
      $$
    `);
    await client().unsafe(`
      create trigger b026_fail_activation
      before update on inventory_publication_proposals
      for each row execute function b026_fail_activation()
    `);

    let providerCalls = 0;
    try {
      const result = await runOutboundPass(
        {
          context: asContext({
            db: database(),
            sendSms: async () => {
              providerCalls += 1;
              return { outcome: "accepted", providerMessageId: "b026-provider-accepted" };
            },
          }),
          clock: new FixedClock(at(1)),
        },
        [workId],
      );
      expect(result.failed).toBe(1);
    } finally {
      await client().unsafe(
        "drop trigger if exists b026_fail_activation on inventory_publication_proposals",
      );
      await client().unsafe("drop function if exists b026_fail_activation()");
    }

    expect(providerCalls).toBe(1);
    const work = await client()`
      select state from outbox_work where id = ${workId}
    `;
    expect(work[0]?.state).toBe("dispatching");
    const attempts = await client()`
      select state, provider_message_id from outbox_dispatch_attempts
      where outbox_work_id = ${workId}
    `;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.state).toBe("authorized");
    expect(attempts[0]?.provider_message_id).toBeNull();
    const activation = await client()`
      select activation_outbox_id, activated_version, activated_at, expires_at
      from inventory_publication_proposals where id = ${proposal.proposalId}
    `;
    expect(activation[0]).toMatchObject({
      activation_outbox_id: null,
      activated_version: null,
      activated_at: null,
      expires_at: null,
    });
  });

  it("activates only the current version's confirmation prompt and publishes its exact snapshot", async () => {
    const v1 = await openOrReviseProposal(database(), {
      senderHash: farmerHash,
      salesLocationId: locationId,
      entries: [{ entryId: "draft_b026_v1_kale", itemName: "kale" }],
      now: T0,
      baseIsFirstPublication: true,
    });
    const staleV1Prompt = await queuePrompt(v1.proposalId, v1.proposalVersion);

    const v2 = await openOrReviseProposal(database(), {
      senderHash: farmerHash,
      salesLocationId: locationId,
      entries: [
        {
          entryId: "draft_b026_v2_eggs",
          itemName: "eggs",
          quantity: 3,
          unit: "dozen",
        },
      ],
      now: at(1),
      baseIsFirstPublication: true,
    });
    expect(v2.proposalId).toBe(v1.proposalId);
    expect(v2.proposalVersion).toBe(2);

    const otherProposal = await openOrReviseProposal(database(), {
      senderHash: secondFarmerHash,
      salesLocationId: locationId,
      entries: [{ entryId: "draft_b026_other_flowers", itemName: "flowers" }],
      now: at(1),
      baseIsFirstPublication: true,
    });
    const nonConfirmation = await queuePrompt(
      otherProposal.proposalId,
      otherProposal.proposalVersion,
      "inventory_prompt",
      secondFarmerHash,
    );
    const currentV2Prompt = await queuePrompt(v2.proposalId, v2.proposalVersion);
    await expectExactCurrentPromptBinding(
      currentV2Prompt,
      v2.proposalId,
      v2.proposalVersion,
    );

    await dispatchAccepted(staleV1Prompt, "b026-provider-v1");
    let proposal = await client()`
      select activation_outbox_id, activated_version, activated_at, expires_at
      from inventory_publication_proposals where id = ${v2.proposalId}
    `;
    expect(proposal[0]).toMatchObject({
      activation_outbox_id: null,
      activated_version: null,
      activated_at: null,
      expires_at: null,
    });
    expect(
      (await client()`select count(*)::integer as count from inventory_revisions`)[0]?.count,
    ).toBe(0);

    // Even an exact-looking logical key cannot make another message category into a
    // confirmation prompt. The category is a guard, not documentation.
    await dispatchAccepted(nonConfirmation, "b026-provider-non-confirmation");
    proposal = await client()`
      select activation_outbox_id, activated_version, activated_at, expires_at
      from inventory_publication_proposals where id = ${otherProposal.proposalId}
    `;
    expect(proposal[0]).toMatchObject({
      activation_outbox_id: null,
      activated_version: null,
      activated_at: null,
      expires_at: null,
    });

    const dispatched = await dispatchAccepted(currentV2Prompt, "b026-provider-v2");
    expect(dispatched.sent).toBe(1);
    const acceptedRows = await client()`
      select work.id, work.state, attempt.state as attempt_state,
             attempt.provider_message_id
      from outbox_work as work
      join outbox_dispatch_attempts as attempt on attempt.outbox_work_id = work.id
      where work.id = any(${[staleV1Prompt, nonConfirmation, currentV2Prompt]})
      order by work.id
    `;
    expect(acceptedRows).toHaveLength(3);
    expect(acceptedRows.every((row) => row.state === "sent")).toBe(true);
    expect(acceptedRows.every((row) => row.attempt_state === "accepted")).toBe(true);

    proposal = await client()`
      select activation_outbox_id, activated_version, activated_at, expires_at
      from inventory_publication_proposals where id = ${v2.proposalId}
    `;
    expect(proposal[0]?.activation_outbox_id).toBe(currentV2Prompt);
    expect(proposal[0]?.activated_version).toBe(2);
    expect(proposal[0]?.activated_at).toEqual(at(1));
    expect(proposal[0]?.expires_at).toEqual(at(12 * 60 + 1));

    const confirmation = await confirmInventoryPublication(database(), {
      proposalId: v2.proposalId,
      senderHash: farmerHash,
      token: "yes",
      occurredAt: at(2),
      providerEventId: "b026-confirm-v2",
      clock: new FixedClock(at(2)),
    });
    expect(confirmation.status).toBe("published");
    if (confirmation.status !== "published") {
      throw new Error(`expected publication, received ${confirmation.status}`);
    }

    const revisions = await client()`
      select revision.id, revision.is_current, entry.item_name, entry.quantity, entry.unit
      from inventory_revisions as revision
      join inventory_entries as entry on entry.inventory_revision_id = revision.id
      where revision.sales_location_id = ${locationId}
    `;
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      is_current: true,
      item_name: "eggs",
      quantity: 3,
      unit: "dozen",
    });
    const durableProposal = await client()`
      select state, consumed_token, consumption_provider_event_id
      from inventory_publication_proposals where id = ${v2.proposalId}
    `;
    expect(durableProposal[0]).toMatchObject({
      state: "accepted",
      consumed_token: "yes",
      consumption_provider_event_id: "b026-confirm-v2",
    });
    const receipt = await client()`
      select body, message_category from outbox_work
      where logical_key = ${`inventory-published-${confirmation.revisionId}`}
    `;
    expect(receipt).toHaveLength(1);
    expect(receipt[0]).toMatchObject({
      body: "B-026 Stand: your listing is updated. Thank you!",
      message_category: "inquiry_reply",
    });
  });
});
