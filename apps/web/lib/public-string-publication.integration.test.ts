import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "@farm-friend/core";
import {
  activateWebProposal,
  answerHostConfirmation,
  approveFarm,
  authorizeFarmer,
  createDb,
  issueFarmerLink,
  readNativeProviderId,
  openFarmerOnboardingRequest,
  openOrReviseProposal,
  type Db,
  type ProposalEntryInput,
  type Sql,
} from "@farm-friend/db";
import { confirmFromLink } from "./farmer-stand";
import { listPublicStands } from "./public-listing";
import { routeInboundMessage, type RouteDeps } from "./routing";

// B-029 — MODEL-WRITABLE PUBLIC TEXT IS UNTRUSTED AT PUBLICATION.
//
// These cases deliberately enter through the stored proposal rather than trusting the
// inventory interpreter. The model and a farmer-web submission can both write that payload,
// so the one guarantee neither can bypass belongs at the shared publication transaction.
// Both real confirmation paths below reach that transaction: deterministic SMS `YES`, and
// `confirmFromLink` behind the farmer's standing web credential.

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");
const databaseUrl = process.env.DATABASE_URL;

function requiredDatabaseUrl(): string {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required; a skipped integration run is not green");
  }
  return databaseUrl;
}

function testDatabaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

const anchor = Date.now() - 24 * 60 * 60 * 1000;
const at = (minutes: number) => new Date(anchor + minutes * 60_000);

type PublicStringField = "itemName" | "unit" | "priceText";
type ProhibitedKind = "phone number" | "email address" | "web link" | "direct-contact instruction";

const unsafeValues: ReadonlyArray<{
  prohibited: ProhibitedKind;
  value: string;
}> = [
  { prohibited: "phone number", value: "call 206-555-0134" },
  { prohibited: "email address", value: "orders@example.com" },
  { prohibited: "web link", value: "https://example.com/order" },
  { prohibited: "direct-contact instruction", value: "call the farmer to order" },
];

const publicStringFields: readonly PublicStringField[] = ["itemName", "unit", "priceText"];

const unsafeCases = publicStringFields.flatMap((field) =>
  unsafeValues.map(({ prohibited, value }) => ({ field, prohibited, value })),
);

function proposedEntries(field: PublicStringField, value: string): ProposalEntryInput[] {
  const entry: ProposalEntryInput = {
    entryId: `draft_public_string_${field}`,
    itemName: "eggs",
    quantity: 2,
    unit: "dozen",
    priceText: "$8",
  };
  entry[field] = value;
  return [entry];
}

function expectedRefusal(prohibited: ProhibitedKind): string {
  const article = prohibited === "email address" ? "an" : "a";
  return `I couldn't publish that. Remove ${article} ${prohibited}, then send the update again.`;
}

describe("public-string safety at the shared publication boundary (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let db: Db | undefined;
  let testDatabaseName: string | undefined;
  let administratorId: string;
  let fixtureNumber = 0;

  function sql(): Sql {
    return client as Sql;
  }

  function database(): Db {
    return db as Db;
  }

  async function farmer(): Promise<{
    senderHash: string;
    salesLocationId: string;
    token: string;
  }> {
    fixtureNumber += 1;
    const suffix = String(1000 + fixtureNumber);
    const senderHash = fixtureNumber.toString(16).padStart(64, "a");
    const contact = await sql()`
      insert into contacts (phone_e164, phone_hash)
      values (${`+1206555${suffix}`}, ${senderHash})
      returning id
    `;
    const farm = await sql()`
      insert into sellers (name) values (${`Safety Farm ${randomUUID()}`}) returning id
    `;
    const farmId = farm[0]?.id as string;
    const location = await sql()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type, public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      )
      values (
        ${farmId}, 'farm_stand', ${`Safety Stand ${randomUUID()}`}, 'America/Los_Angeles', 'visitable', 'produce', '1 Test Road',
        47.44, -122.46, false, false
      )
      returning id
    `;
    /*
      F-121 — the farmer has ACTIVE consent, as every real authorized farmer does: onboarding
      completes with a bare `VIGA` from their stated handset, and that text is what establishes
      it. Without it the consent gate answers their `YES` with the join invitation instead of
      publishing, so these cases would measure the gate rather than publication.
    */
    await sql()`
      insert into sms_consents (
        recipient_hash, state, capture_source, captured_at, capture_evidence_ref, updated_at
      )
      values (
        ${senderHash}, 'active', 'start', ${at(0)}, ${`onboarding-${senderHash}`}, ${at(0)}
      )
    `;
    const opened = await openFarmerOnboardingRequest(database(), {
      contactHash: senderHash,
      occurredAt: at(0),
      publicBaseUrl: "https://farmfriend.test",
    });
    const authorized = await authorizeFarmer(database(), {
      farmId,
      requestId: opened.status === "opened" ? opened.requestId : "",
      administratorId,
      occurredAt: at(1),
      publicBaseUrl: "https://farmfriend.test",
    });
    expect(authorized.status).toBe("authorized");
    const authorizationId =
      authorized.status === "authorized" ? authorized.authorizationId : "";
    await approveFarm(database(), { farmId, administratorId, occurredAt: at(2) });
    const link = await issueFarmerLink(database(), {
      authorizationId,
      providerId: await readNativeProviderId(database(), {
        salesLocationId: location[0]?.id as string,
      }),
      occurredAt: at(3),
    });
    expect(link.status).toBe("issued");

    // The helper above resolves by hash; this assertion also proves the fixture's raw phone
    // is confined to contacts rather than copied into the proposal/public rows under test.
    expect(contact).toHaveLength(1);
    return {
      senderHash,
      salesLocationId: location[0]?.id as string,
      token: link.status === "issued" ? link.token : "",
    };
  }

  async function openProposal(input: {
    senderHash: string;
    salesLocationId: string;
    entries: ProposalEntryInput[];
    activateForSms: boolean;
  }): Promise<string> {
    const proposal = await openOrReviseProposal(database(), {
      senderHash: input.senderHash,
      salesLocationId: input.salesLocationId,
      entries: input.entries,
      now: at(4),
      baseRevisionId: null,
      baseIsFirstPublication: true,
    });
    if (input.activateForSms) {
      await proposal.activate({
        providerAcceptedAt: at(5),
      });
    }
    return proposal.proposalId;
  }

  async function expectNoPublication(input: {
    proposalId: string;
    salesLocationId: string;
  }): Promise<void> {
    const proposal = await sql()`
      select state, consumed_token, consumption_provider_event_id
      from inventory_publication_proposals where id = ${input.proposalId}
    `;
    expect(proposal).toHaveLength(1);
    expect(proposal[0]?.state).toBe("open");
    expect(proposal[0]?.consumed_token).toBeNull();
    expect(proposal[0]?.consumption_provider_event_id).toBeNull();

    const revisions = await sql()`
      select id, is_current from inventory_revisions
      where sales_location_id = ${input.salesLocationId}
    `;
    expect(revisions).toHaveLength(0);
    const entries = await sql()`
      select id from inventory_entries where sales_location_id = ${input.salesLocationId}
    `;
    expect(entries).toHaveLength(0);

    // Verified at the actual public reader: the stand remains visible, but the refused
    // proposal creates no current inventory and no model-authored string reaches customers.
    const publicStand = (await listPublicStands({
      db: database(),
      clock: new FixedClock(at(7)),
    })).find((stand) => stand.factId === input.salesLocationId);
    expect(publicStand).toBeDefined();
    expect(publicStand?.items).toEqual([]);
    expect(publicStand).not.toHaveProperty("asOf");
  }

  async function confirmBySms(input: {
    senderHash: string;
    proposalId: string;
  }) {
    const forbiddenFreeText: RouteDeps["freeText"] = async () => {
      throw new Error("model/free-text path reached for deterministic YES");
    };
    const forbiddenNextPage: RouteDeps["nextPage"] = async () => {
      throw new Error("pager reached for deterministic YES");
    };
    const forbiddenFarmerTarget: RouteDeps["farmerTarget"] = async () => {
      throw new Error("farmer target handler reached for deterministic YES");
    };
    const forbiddenStandSelection: RouteDeps["selectStand"] = async () => {
      throw new Error("stand selection reached for deterministic YES");
    };
    const forbiddenScheduledSame: RouteDeps["scheduledSame"] = async () => {
      throw new Error("scheduled SAME handler reached for deterministic YES");
    };
    /*
      F-117 — the REAL seam, not a stub. This suite drives a real database, and the host
      question is genuinely consulted before the inventory proposal on every YES. A stub would
      hide whether that ordering leaves this publication path working; the real reader answers
      `no_open_question` here because no host was ever asked, which is the honest fixture.
    */
    const hostConfirmation: RouteDeps["hostConfirmation"] = async (input) =>
      answerHostConfirmation(database(), {
        hostHash: input.senderHash,
        token: input.token,
        occurredAt: input.occurredAt,
      });
    return routeInboundMessage(
      {
        db: database(),
        clock: new FixedClock(at(7)),
        publicBaseUrl: "https://farmfriend.example",
        publicMapUrl: "https://www.vigavashon.org/farm-stand-map#map",
        freeText: forbiddenFreeText,
        nextPage: forbiddenNextPage,
        farmerTarget: forbiddenFarmerTarget,
        hostConfirmation,
        selectStand: forbiddenStandSelection,
        scheduledSame: forbiddenScheduledSame,
      },
      {
        senderHash: input.senderHash,
        body: "YES",
        occurredAt: at(6),
        providerEventId: `safety-yes-${randomUUID()}`,
        inboxEventId: randomUUID(),
      },
    );
  }

  beforeAll(async () => {
    const baseUrl = requiredDatabaseUrl();
    testDatabaseName = `farm_friend_public_string_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(baseUrl, { max: 1 });
    await adminClient.unsafe(`create database "${testDatabaseName}"`);
    const url = testDatabaseUrl(baseUrl, testDatabaseName);
    const migrationClient = postgres(url, { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    client = postgres(url, { max: 4 });
    db = createDb(url);
    const administrator = await sql()`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', ${at(0)})
      returning id
    `;
    administratorId = administrator[0]?.id as string;
  }, 30_000);

  afterAll(async () => {
    if (db) await db.close();
    if (client) await client.end({ timeout: 5 });
    if (adminClient && testDatabaseName) {
      await adminClient.unsafe(`drop database if exists "${testDatabaseName}"`);
      await adminClient.end({ timeout: 5 });
    }
  });

  it.each(unsafeCases)(
    "SMS refuses a $prohibited injected through $field and publishes nothing",
    async ({ field, prohibited, value }) => {
      const actor = await farmer();
      const proposalId = await openProposal({
        ...actor,
        entries: proposedEntries(field, value),
        activateForSms: true,
      });

      const result = await confirmBySms({
        senderHash: actor.senderHash,
        proposalId,
      });

      expect(result.outcome).toEqual({
        kind: "confirmation",
        status: "unsafe_public_text",
      });
      expect(result.replies.map((reply) => reply.body)).toEqual([
        expectedRefusal(prohibited),
      ]);
      await expectNoPublication({ proposalId, salesLocationId: actor.salesLocationId });
    },
  );

  it.each(unsafeCases)(
    "farmer web refuses a $prohibited injected through $field and publishes nothing",
    async ({ field, prohibited, value }) => {
      const actor = await farmer();
      const proposalId = await openProposal({
        ...actor,
        entries: proposedEntries(field, value),
        activateForSms: false,
      });

      const result = await confirmFromLink(
        {
          db: database(),
          clock: new FixedClock(at(6)),
          activate: (input) => activateWebProposal(database(), input),
        },
        {
          token: actor.token,
          proposalId,
          accept: true,
          confirmationText: "The farmer reviewed this complete snapshot.",
        },
      );

      expect(result).toEqual({
        status: "refused",
        reason: "unsafe_public_text",
        message: expectedRefusal(prohibited),
      });
      await expectNoPublication({ proposalId, salesLocationId: actor.salesLocationId });
    },
  );

  it("SMS publishes legitimate digit-bearing inventory", async () => {
    const actor = await farmer();
    const entries: ProposalEntryInput[] = [
      {
        entryId: "draft_sms_eggs",
        itemName: "2 dozen eggs",
        quantity: 2,
        unit: "dozen",
        priceText: "$12",
      },
      {
        entryId: "draft_sms_potatoes",
        itemName: "potatoes",
        quantity: 18,
        unit: "lbs",
        priceText: "$1.50/lb",
      },
    ];
    const proposalId = await openProposal({
      ...actor,
      entries,
      activateForSms: true,
    });

    const result = await confirmBySms({ senderHash: actor.senderHash, proposalId });
    expect(result.outcome).toEqual({ kind: "confirmation", status: "published" });
    expect(result.replies).toEqual([]);

    const durableEntries = await sql()`
      select item_name, quantity, unit, price_text
      from inventory_entries where sales_location_id = ${actor.salesLocationId}
      order by sort_order
    `;
    expect(durableEntries).toMatchObject([
      { item_name: "2 dozen eggs", quantity: 2, unit: "dozen", price_text: "$12" },
      { item_name: "potatoes", quantity: 18, unit: "lbs", price_text: "$1.50/lb" },
    ]);
    const publicStand = (await listPublicStands({
      db: database(),
      clock: new FixedClock(at(7)),
    })).find((stand) => stand.factId === actor.salesLocationId);
    expect(publicStand?.items).toEqual(
      entries.map(({ entryId: _draftId, ...publicValues }) => publicValues),
    );
  });

  it("farmer web publishes legitimate digit-bearing inventory", async () => {
    const actor = await farmer();
    const entries: ProposalEntryInput[] = [
      {
        entryId: "draft_web_eggs",
        itemName: "2 dozen eggs",
        quantity: 2,
        unit: "dozen",
        priceText: "$12",
      },
      {
        entryId: "draft_web_potatoes",
        itemName: "potatoes",
        quantity: 18,
        unit: "lbs",
        priceText: "$1.50/lb",
      },
    ];
    const proposalId = await openProposal({
      ...actor,
      entries,
      activateForSms: false,
    });

    const result = await confirmFromLink(
      {
        db: database(),
        clock: new FixedClock(at(6)),
        activate: (input) => activateWebProposal(database(), input),
      },
      {
        token: actor.token,
        proposalId,
        accept: true,
        confirmationText: "The farmer reviewed this complete snapshot.",
      },
    );
    expect(result.status).toBe("published");

    const durableEntries = await sql()`
      select item_name, quantity, unit, price_text
      from inventory_entries where sales_location_id = ${actor.salesLocationId}
      order by sort_order
    `;
    expect(durableEntries).toMatchObject([
      { item_name: "2 dozen eggs", quantity: 2, unit: "dozen", price_text: "$12" },
      { item_name: "potatoes", quantity: 18, unit: "lbs", price_text: "$1.50/lb" },
    ]);
    const publicStand = (await listPublicStands({
      db: database(),
      clock: new FixedClock(at(7)),
    })).find((stand) => stand.factId === actor.salesLocationId);
    expect(publicStand?.items).toEqual(
      entries.map(({ entryId: _draftId, ...publicValues }) => publicValues),
    );
  });
});
