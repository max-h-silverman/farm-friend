import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "@farm-friend/core";
import { createDb, issueFarmerLink, type Db, type Sql } from "@farm-friend/db";
import { applyInterpretedInventory } from "./interpretation";
import { resolveStandFromToken } from "./farmer-stand";

/*
  F-114 Phase C.3 — WHAT A FARMER'S NEXT EDIT IS COMPOSED AGAINST.

  ## The one shape where the provider dimension is the sole arbiter

  A proposal is one per SENDER, and before C.3 the composition base was looked up by
  `(sender, stand)` with the provider derived as the stand's own listing. Both halves are wrong
  once a stand has two listings a single phone can reach, and the failure is silent in both
  directions:

    * the BASE — a hosted seller's edit composed against her HOST'S published items, so "sold out
      of eggs" names eggs that are not hers;
    * the PENDING lookup — an open proposal on one listing picked up as the starting point for
      the other, so a host part-way through editing Gracie's listing continues that draft when
      she starts on her own.

  Every other suite in the repo has one listing per stand, where the two lookups agree with the
  provider-scoped ones on every row — which is exactly why a deliberate removal of the
  `provider_id` filter passed the whole web suite untouched until this file existed. A guard is
  unfalsifiable until a case exists where it is the ONLY thing that could refuse.

  The actor here is the HOST holding `host_may_update_stock`, because that is the only way one
  phone legitimately reaches two listings at one stand.
*/

describe("F-114 C.3 per-provider composition (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let db: Db | undefined;
  let databaseName = "";

  let standId = "";
  let hostSellerId = "";
  let hostProviderId = "";
  let guestSellerId = "";
  let guestProviderId = "";
  let hostSenderHash = "";

  const now = new Date("2026-08-16T18:00:00.000Z");
  const sql = (): Sql => client as Sql;
  const database = (): Db => db as Db;

  const deps = () => ({ db: database(), clock: new FixedClock(now) });

  const publish = async (providerId: string, sellerId: string, items: string[]) => {
    await sql()`
      update inventory_revisions set is_current = false
      where provider_id = ${providerId} and is_current
    `;
    const revisions = await sql()`
      insert into inventory_revisions (
        seller_id, sales_location_id, provider_id, source, published_at, is_current
      ) values (
        ${sellerId}, ${standId}, ${providerId}, 'viga', ${now}, true
      ) returning id
    `;
    const revisionId = revisions[0]?.id as string;
    for (const [index, itemName] of items.entries()) {
      await sql()`
        insert into inventory_entries (
          inventory_revision_id, sales_location_id, item_name, sort_order
        ) values (${revisionId}, ${standId}, ${itemName}, ${index})
      `;
    }
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    databaseName = `ff_c3compose_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(base, { max: 1 });
    await adminClient.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    client = postgres(url.toString(), { max: 4 });
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: "packages/db/drizzle" });
    await migrationClient.end({ timeout: 5 });
    db = createDb(url.toString());

    const sellers = await sql()`
      insert into sellers (name) values ('Venison Valley'), ('Gracies Greens')
      returning id, name
    `;
    hostSellerId = sellers.find((row) => row.name === "Venison Valley")?.id as string;
    guestSellerId = sellers.find((row) => row.name === "Gracies Greens")?.id as string;

    await sql()`
      insert into seller_approvals (seller_id, approved_at)
      values (${hostSellerId}, ${now}), (${guestSellerId}, ${now})
    `;

    const stands = await sql()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type, is_public,
        public_address, public_latitude, public_longitude
      ) values (
        ${hostSellerId}, 'farm_stand', 'Venison Valley Stand', 'America/Los_Angeles',
        'visitable', 'produce', true, 'Venison Valley Road, Vashon WA', 47.4473,
        -122.4590
      ) returning id
    `;
    standId = stands[0]?.id as string;

    const own = await sql()`
      select id from stand_providers
      where sales_location_id = ${standId} and seller_id = ${hostSellerId}
    `;
    hostProviderId = own[0]?.id as string;

    // Gracie grants the host the right to state her stock — the only way one phone reaches two
    // listings at one stand, and therefore the only shape this file can be written in.
    const guest = await sql()`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, host_may_update_stock,
        invited_at, accepted_at, approval_source, approved_at
      ) values (
        ${standId}, ${guestSellerId}, 'active', true, ${now}, ${now}, 'viga', ${now}
      ) returning id
    `;
    guestProviderId = guest[0]?.id as string;

    hostSenderHash = `h${randomUUID().replaceAll("-", "")}`;
    const contacts = await sql()`
      insert into contacts (phone_e164, phone_hash)
      values ('+12065551000', ${hostSenderHash}) returning id
    `;
    await sql()`
      insert into farmer_authorizations (
        seller_id, contact_id, phone_verified_at, authorized_at
      ) values (${hostSellerId}, ${contacts[0]?.id as string}, ${now}, ${now})
    `;
  }, 60_000);

  afterAll(async () => {
    await db?.close();
    await client?.end({ timeout: 5 });
    if (adminClient && databaseName) {
      await adminClient.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminClient.end({ timeout: 5 });
    }
  });

  beforeEach(async () => {
    await sql()`
      truncate inventory_publication_proposals, outbox_work, sender_states, farmer_links
      restart identity cascade
    `;
    await sql()`delete from inventory_entries`;
    await sql()`update inventory_revisions set is_current = false`;
    await sql()`delete from inventory_revisions`;
  });

  describe("a standing link to a hosted listing dies when the grant does", () => {
    /*
      F-040's load-bearing property — *the lookup is per-request, so revocation is immediate* —
      extended to the two arms C.3 added. Nothing is cached in the token, so the only thing that
      can keep a link alive after the authority behind it is gone is `resolveFarmerLink`
      forgetting to re-ask. It re-asks with the SAME arms the menu uses.

      Both cases are the host's link to GRACIE'S listing, because that is the only link whose
      validity depends on a fact that is not the holder's own: the seller's opt-in, and the
      relationship being live. A link to one's own listing survives both changes, so a suite
      built only from those cannot see this at all — removing the arms from the link query
      passed 1,242 tests untouched before these existed.
    */
    const linkToGuestListing = async (): Promise<string> => {
      const authorizations = await sql()`
        select auth.id from farmer_authorizations as auth
        join contacts on contacts.id = auth.contact_id
        where contacts.phone_hash = ${hostSenderHash} and auth.revoked_at is null
      `;
      const issued = await issueFarmerLink(database(), {
        authorizationId: authorizations[0]?.id as string,
        providerId: guestProviderId,
        occurredAt: now,
      });
      if (issued.status !== "issued") throw new Error("fixture link was not issued");
      return issued.token;
    };

    it("stops resolving the moment the seller withdraws the host's stock right", async () => {
      const token = await linkToGuestListing();
      expect(await resolveStandFromToken(database(), token)).toMatchObject({
        providerId: guestProviderId,
      });

      await sql()`
        update stand_providers set host_may_update_stock = false where id = ${guestProviderId}
      `;
      // Dead on the very next request. Nothing expired and nothing was revoked — the host's
      // own authorization is untouched, so the withdrawn grant is the only thing that can
      // refuse.
      expect(await resolveStandFromToken(database(), token)).toBeNull();
      await sql()`
        update stand_providers set host_may_update_stock = true where id = ${guestProviderId}
      `;
    });

    it("stops resolving the moment the relationship ends", async () => {
      const token = await linkToGuestListing();
      expect(await resolveStandFromToken(database(), token)).not.toBeNull();

      await sql()`update stand_providers set ended_at = ${now} where id = ${guestProviderId}`;
      expect(await resolveStandFromToken(database(), token)).toBeNull();
      await sql()`update stand_providers set ended_at = null where id = ${guestProviderId}`;
    });
  });

  it("composes each listing against its OWN published items", async () => {
    await publish(hostProviderId, hostSellerId, ["Elk sausage"]);
    await publish(guestProviderId, guestSellerId, ["Kale"]);

    // Editing Gracie's listing must start from KALE, never from the host's venison. Before C.3
    // the base was the stand's own listing whatever provider the caller named.
    const outcome = await applyInterpretedInventory(deps(), {
      senderHash: hostSenderHash,
      salesLocationId: standId,
      providerId: guestProviderId,
      edit: { kind: "edits", additions: [{ itemName: "Chard" }], changes: [], removals: [] },
    });

    expect(outcome.outcome).toBe("proposed");
    if (outcome.outcome !== "proposed") return;
    expect(outcome.confirmationText).toContain("Kale");
    expect(outcome.confirmationText).toContain("Chard");
    // A distinct word from the stand name, which the header legitimately repeats.
    expect(outcome.confirmationText).not.toContain("Elk sausage");
  });

  it("does not continue the OTHER listing's open draft", async () => {
    /*
      The case the `provider_id` filter alone can refuse.

      One sender, one stand, two listings. A draft is open on Gracie's; starting an edit on the
      host's own must compose from the host's PUBLISHED items, not from that draft. Removing the
      provider filter from the pending lookup makes this test — and nothing else in the repo —
      fail, because every other suite has one listing per stand where the two lookups agree.
    */
    await publish(hostProviderId, hostSellerId, ["Elk sausage"]);
    await publish(guestProviderId, guestSellerId, ["Kale"]);

    const draft = await applyInterpretedInventory(deps(), {
      senderHash: hostSenderHash,
      salesLocationId: standId,
      providerId: guestProviderId,
      edit: { kind: "edits", additions: [{ itemName: "Rhubarb" }], changes: [], removals: [] },
    });
    expect(draft.outcome).toBe("proposed");

    const own = await applyInterpretedInventory(deps(), {
      senderHash: hostSenderHash,
      salesLocationId: standId,
      providerId: hostProviderId,
      edit: { kind: "edits", additions: [{ itemName: "Bratwurst" }], changes: [], removals: [] },
    });

    expect(own.outcome).toBe("proposed");
    if (own.outcome !== "proposed") return;
    expect(own.confirmationText).toContain("Elk sausage");
    expect(own.confirmationText).toContain("Bratwurst");
    // Neither the other listing's published items nor its unconfirmed draft.
    expect(own.confirmationText).not.toContain("Kale");
    expect(own.confirmationText).not.toContain("Rhubarb");
  });
});
