import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "@farm-friend/core";
import {
  confirmInventoryPublication,
  createDb,
  openOrReviseProposal,
  type Db,
  type Sql,
} from "./index";

/*
  F-114 Phase C.2 / B-077 — MORGAN HILL CAN SHUT ITS GATE.

  ## What this proves that the constraint suite cannot

  `closure-stand-arm.integration.test.ts` proves the RECORD admits a venue's closure. That is
  necessary and it is not the guarantee: a nullable column no writer can produce is exactly the
  half-built state C.1 declined to ship. This file drives the real two-step publication path —
  propose, activate, confirm — and asserts the row that comes out the other end.

  ## Whose authority, at a stand with no seller

  A venue's manager holds a STAND-armed authorization: there is no seller to name, so there is no
  seller authorization to hold. `resolveProviderWriteAuthority` cannot answer here and is not
  asked to — it answers "may this phone write THIS PROVIDER'S stock", and a venue's closure is
  not any provider's stock. Closure is a stand fact with its own authority, and that is the
  distinction §facts and authority draws: a stand shutdown OVERRIDES every provider.

  ## What a closure at a venue does to its sellers

  Nothing to their records, everything to their rendering. §facts and authority: a stand shutdown
  renders NOTHING itemized — no seller's items show, hosted or native — and hosted sellers are
  NOT notified, because closure is planned and the host communicates with their sellers directly.
  Their inventory rows stay exactly as they were, which is what lets the same goods still appear
  on the seller's own page and at their other stands.

  Both halves are asserted: the closure exists and is current, AND the hosted seller's revision
  is untouched and un-superseded. The second is the one a wrong implementation would break while
  looking correct.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("a venue records a closure (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let db: Db | undefined;
  let databaseName = "";

  let venueId = "";
  let venueAuthorizationId = "";
  let venueSenderHash = "";
  let hostedSellerId = "";
  let hostedProviderId = "";
  let hostedSenderHash = "";
  let hostedRevisionId = "";

  const T0 = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60 * 1000);
  const sql = (): Sql => client as Sql;
  const database = (): Db => db as Db;

  const localDate = (): string => {
    const iso = new Date(T0.getTime() + 3 * 86_400_000).toISOString();
    return iso.slice(0, 10);
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    databaseName = `ff_venueclosure_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(base, { max: 1 });
    await adminClient.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    client = postgres(url.toString(), { max: 4 });
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    db = createDb(url.toString());

    const sellers = await sql()`
      insert into sellers (name) values ('Gracies Greens') returning id
    `;
    hostedSellerId = sellers[0]?.id as string;
    await sql()`
      insert into seller_approvals (seller_id, approved_at)
      values (${hostedSellerId}, ${at(0)})
    `;

    // Morgan Hill's shape: a venue with no seller of its own and sellers nested inside it.
    const locations = await sql()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type, is_public,
        public_address, public_latitude, public_longitude
      ) values (
        null, 'farm_stand', 'Morgan Hill Community Stand', 'America/Los_Angeles',
        'visitable', 'produce', true, 'Morgan Hill Road, Vashon WA', 47.4473,
        -122.4590
      ) returning id
    `;
    venueId = locations[0]?.id as string;

    const providers = await sql()`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, invited_at, accepted_at,
        approval_source, approved_at
      ) values (
        ${venueId}, ${hostedSellerId}, 'active', ${at(0)}, ${at(0)}, 'viga', ${at(0)}
      ) returning id
    `;
    hostedProviderId = providers[0]?.id as string;

    const mkFarmer = async (input: {
      phone: string;
      sellerId?: string;
      salesLocationId?: string;
    }): Promise<{ senderHash: string; authorizationId: string }> => {
      const senderHash = `h${randomUUID().replaceAll("-", "")}`;
      const contacts = await sql()`
        insert into contacts (phone_e164, phone_hash)
        values (${input.phone}, ${senderHash}) returning id
      `;
      const rows = await sql()`
        insert into farmer_authorizations (
          seller_id, sales_location_id, contact_id, phone_verified_at, authorized_at
        ) values (
          ${input.sellerId ?? null}, ${input.salesLocationId ?? null},
          ${contacts[0]?.id as string}, ${at(0)}, ${at(0)}
        ) returning id
      `;
      await sql()`
        insert into sms_consents (
          recipient_hash, state, capture_source, captured_at, capture_evidence_ref, updated_at
        ) values (
          ${senderHash}, 'active', 'farmer_onboarding', ${at(0)},
          ${`onboarding-${input.phone}`}, ${at(0)}
        )
      `;
      return { senderHash, authorizationId: rows[0]?.id as string };
    };

    // The venue's manager. Measured 2026-08-15 no phone had ever been authorized for Morgan
    // Hill — a TRANSITIONAL state, not a permanent one, and designing around it was the reading
    // error §there is no second permission system records.
    ({ senderHash: venueSenderHash, authorizationId: venueAuthorizationId } =
      await mkFarmer({ phone: "+12065551000", salesLocationId: venueId }));
    ({ senderHash: hostedSenderHash } = await mkFarmer({
      phone: "+12065551001",
      sellerId: hostedSellerId,
    }));
  }, 60_000);

  afterAll(async () => {
    await db?.close();
    await client?.end({ timeout: 5 });
    if (adminClient && databaseName) {
      await adminClient.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminClient.end({ timeout: 5 });
    }
  });

  const publish = async (input: {
    senderHash: string;
    at: Date;
    providerId?: string;
    entries?: { entryId: string; itemName: string }[];
    closure?: { result: "close"; closureKind: "temporary"; startsOn: string };
  }): Promise<{ status: string }> => {
    const opened = await openOrReviseProposal(database(), {
      senderHash: input.senderHash,
      salesLocationId: venueId,
      ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
      ...(input.entries !== undefined ? { entries: input.entries } : {}),
      ...(input.closure !== undefined ? { closure: input.closure } : {}),
      now: input.at,
    });
    await opened.activate({ providerAcceptedAt: input.at });
    return (await confirmInventoryPublication(database(), {
      proposalId: opened.proposalId,
      senderHash: input.senderHash,
      token: "yes",
      providerEventId: randomUUID(),
      occurredAt: new Date(input.at.getTime() + 60_000),
      clock: new FixedClock(new Date(input.at.getTime() + 60_000)),
    })) as { status: string };
  };

  it("the hosted seller publishes at the venue first", async () => {
    // Set-up as an assertion, not as silent fixture: the venue's closure below has to be shown
    // NOT to disturb this, so this row must be real and its identity known.
    const result = await publish({
      senderHash: hostedSenderHash,
      providerId: hostedProviderId,
      entries: [{ entryId: randomUUID(), itemName: "salad greens" }],
      at: at(10),
    });
    expect(result.status).toBe("published");

    const rows = await sql()`
      select id from inventory_revisions
      where sales_location_id = ${venueId} and provider_id = ${hostedProviderId}
        and is_current
    `;
    hostedRevisionId = rows[0]?.id as string;
    expect(hostedRevisionId).toBeTruthy();
  });

  it("the venue's manager closes the stand", async () => {
    // B-077, end to end. Before this, `openOrReviseProposal` refused the venue outright — its
    // authority check resolved the stand's own seller and a venue has none — and the closure row
    // could not have been written even if it had not.
    const result = await publish({
      senderHash: venueSenderHash,
      closure: { result: "close", closureKind: "temporary", startsOn: localDate() },
      at: at(20),
    });
    expect(result.status).toBe("published");

    const rows = await sql()`
      select owner_seller_id, owner_approval_id, owner_authorization_id, result, closure_kind
      from closure_revisions
      where sales_location_id = ${venueId} and is_current
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ result: "close", closure_kind: "temporary" });
    // The stand arm, in the row: no seller, no seller-approval, and a person all the same.
    expect(rows[0]?.owner_seller_id).toBeNull();
    expect(rows[0]?.owner_approval_id).toBeNull();
    expect(rows[0]?.owner_authorization_id).toBe(venueAuthorizationId);
  });

  it("leaves the hosted seller's inventory exactly as it was", async () => {
    // §a stand shutdown renders nothing itemized — a RENDERING rule, never a data one. The
    // hosted seller's goods still exist, which is what lets them show on that seller's own page
    // and at their other stands. A closure that superseded them would destroy that.
    const rows = await sql()`
      select id, is_current, superseded_at from inventory_revisions
      where sales_location_id = ${venueId} and provider_id = ${hostedProviderId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(hostedRevisionId);
    expect(rows[0]?.is_current).toBe(true);
    expect(rows[0]?.superseded_at).toBeNull();
  });

  it("tells the hosted seller nothing", async () => {
    // §hosted sellers are NOT notified: closure is planned and the host communicates directly.
    // Asserted as the ABSENCE of any queued message to that handset, rather than as the presence
    // of the manager's own confirmation — the wrong behavior here is a message that exists.
    const rows = await sql()`
      select count(*)::int as total from outbox_work
      where recipient_hash = ${hostedSenderHash}
        and created_at >= ${at(20)}
    `;
    expect(rows[0]?.total).toBe(0);
  });

  it("refuses a hosted seller closing the venue", async () => {
    // Owner-only, and at a venue that means the STAND arm. A seller who merely sells here may
    // not shut the place — the same rule that refuses a hosted seller at an ordinary stand, and
    // the reason the arm is decided by the stand rather than chosen by the writer.
    await expect(
      publish({
        senderHash: hostedSenderHash,
        providerId: hostedProviderId,
        closure: { result: "close", closureKind: "temporary", startsOn: localDate() },
        at: at(30),
      }),
    ).rejects.toThrow(/not authorized/i);

    // The absence of the effect: still exactly one closure, still the manager's.
    const rows = await sql()`
      select owner_authorization_id from closure_revisions
      where sales_location_id = ${venueId} and is_current
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.owner_authorization_id).toBe(venueAuthorizationId);
  });

  it("refuses a closure whose authority was withdrawn between propose and confirm", async () => {
    /*
      Why the confirmation re-reads stand authority at all, rather than trusting the proposal
      that already passed it. The window between composing and confirming is real — a farmer
      may take twelve hours to answer — and a manager removed in that window must not be able
      to shut the stand with a `YES` they typed while they still could.

      This is the case that makes the second check falsifiable. Without it, removing the
      confirmation-side resolution changes no test result: nothing else can produce a closure
      proposal whose authority has since gone.
    */
    const opened = await openOrReviseProposal(database(), {
      senderHash: venueSenderHash,
      salesLocationId: venueId,
      closure: { result: "reopen" },
      now: at(60),
    });
    await opened.activate({ providerAcceptedAt: at(60) });

    const before = await sql()`
      select id, result from closure_revisions
      where sales_location_id = ${venueId} and is_current
    `;

    // VIGA removes the manager AFTER the prompt was accepted and before the reply lands.
    await sql()`
      update farmer_authorizations set revoked_at = ${at(61)}
      where id = ${venueAuthorizationId}
    `;

    const result = await confirmInventoryPublication(database(), {
      proposalId: opened.proposalId,
      senderHash: venueSenderHash,
      token: "yes",
      providerEventId: randomUUID(),
      occurredAt: at(62),
      clock: new FixedClock(at(62)),
    });
    expect(result.status).toBe("not_authorized");

    // The absence of the effect: the stand is still closed, exactly as it was, and no new
    // closure revision was written under a revoked authorization.
    const after = await sql()`
      select id, result from closure_revisions
      where sales_location_id = ${venueId} and is_current
    `;
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(after[0]?.result).toBe("close");

    await sql()`
      update farmer_authorizations set revoked_at = null
      where id = ${venueAuthorizationId}
    `;
  });

  it("refuses a stand-armed authorization for a DIFFERENT stand", async () => {
    // The arm is not a skeleton key. Being the manager of one venue says nothing about another,
    // exactly as a seller authorization is bounded to its seller.
    const other = await sql()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type, is_public,
        public_address, public_latitude, public_longitude
      ) values (
        null, 'farm_stand', 'Another Community Stand', 'America/Los_Angeles',
        'visitable', 'produce', true, 'Other Road, Vashon WA', 47.4673, -122.4790
      ) returning id
    `;
    await expect(
      openOrReviseProposal(database(), {
        senderHash: venueSenderHash,
        salesLocationId: other[0]?.id as string,
        closure: { result: "close", closureKind: "temporary", startsOn: localDate() },
        now: at(40),
      }),
    ).rejects.toThrow(/not authorized/i);
  });

  it("refuses a venue's manager publishing a hosted seller's stock without the opt-in", async () => {
    // The stand arm is the authority to manage the PLACE, never the goods in it. It confers
    // exactly what a seller-armed host's does — the `host_may_update_stock` opt-in and nothing
    // more — which is what keeps "who manages the venue" from becoming "who owns everything
    // sold there".
    await expect(
      openOrReviseProposal(database(), {
        senderHash: venueSenderHash,
        salesLocationId: venueId,
        providerId: hostedProviderId,
        entries: [{ entryId: randomUUID(), itemName: "salad greens" }],
        now: at(50),
      }),
    ).rejects.toThrow(/not authorized/i);
  });
});
