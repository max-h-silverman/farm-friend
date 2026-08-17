import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "@farm-friend/core";
import {
  createDb,
  listFarmerAuthorizations,
  listPublicSellers,
  readCurrentInventoryByProvider,
  readStandProviderFacts,
  resolveFarmerTarget,
  resolveProviderWriteAuthority,
  setInventoryPromptPreference,
  setProviderParticipation,
  type Db,
} from "@farm-friend/db";
import { runScheduledPromptPass } from "./scheduled-prompts";

/*
  F-115 Tranche E — ONE PAUSE, MEASURED ON EVERY SURFACE AT ONCE.

  ## What this file is for

  `provider.ended_at is null and provider.lifecycle_state in ('active','paused')` appeared
  VERBATIM at ten call sites. `visibleFarms` already carries this codebase's answer to that
  shape — *"four copies is four chances to miss one"*, citing F-072's `NO_LIVE_FARMER` and F-074.

  Collapsing them into ONE fragment would have been wrong, and this file is the evidence. The ten
  are two rules that happened to agree while `paused` was unreachable:

    * **PUBLIC** — §hosting and approval lifecycle: *"Ending or pausing hides current public facts
      without deleting history."* A paused seller's goods leave the map, the seller list, the
      stand card, and both SMS retrieval queries.
    * **REACHABLE** — §facts and authority: *"A paused provider is offered re-opening, never
      refused."* Her authority, her SMS menu, her reminders and VIGA's roster all still find her.

  Nothing could tell the two apart until Tranche D made `paused` a state a farmer can enter, which
  is exactly why the work order sequences E after D. A fragment written against an unreachable
  state records whatever its author assumed.

  ## Why it asserts through the SURFACES

  A unit test of `publicProviders()` and `reachableProviders()` would prove the strings and
  nothing about who composes them — the same reason `creditSeller` sat unused with five surfaces
  deciding its rule for themselves (Tranche C). One pause, then every reader asked in turn.
*/

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required; a skipped integration run is not green");

const BASE = new Date("2026-05-01T17:00:00.000Z");
const LATER = new Date("2026-05-02T17:00:00.000Z");

describe("F-115 one pause, across every provider-liveness surface (integration)", () => {
  let admin: ReturnType<typeof postgres> | undefined;
  let db: Db | undefined;
  let databaseName = "";

  let hostSellerId = "";
  let hostStandId = "";
  let hostProviderId = "";
  let hostSenderHash = "";

  let guestSellerId = "";
  let guestProviderId = "";
  let guestSenderHash = "";
  let guestAuthorizationId = "";

  function handle(): Db {
    if (!db) throw new Error("database unavailable");
    return db;
  }

  async function mkSeller(name: string, phone: string, administratorId: string) {
    const sql = handle().sql;
    const senderHash = `h${randomUUID().replaceAll("-", "")}`;
    const sellers = await sql`insert into sellers (name) values (${name}) returning id`;
    const sellerId = sellers[0]?.id as string;
    const contacts = await sql`
      insert into contacts (phone_e164, phone_hash, created_at)
      values (${phone}, ${senderHash}, ${BASE}) returning id
    `;
    const authorizations = await sql`
      insert into farmer_authorizations (seller_id, contact_id, phone_verified_at, authorized_at)
      values (${sellerId}, ${contacts[0]?.id as string}, ${BASE}, ${BASE}) returning id
    `;
    await sql`
      insert into seller_approvals (seller_id, administrator_id, approved_at)
      values (${sellerId}, ${administratorId}, ${BASE})
    `;
    await sql`
      insert into sms_consents (
        recipient_hash, state, capture_source, captured_at, capture_evidence_ref, updated_at
      ) values (
        ${senderHash}, 'active', 'farmer_onboarding', ${BASE}, ${`liveness-${name}`}, ${BASE}
      )
    `;
    return {
      sellerId,
      senderHash,
      authorizationId: authorizations[0]?.id as string,
    };
  }

  /** One published revision with one item, so every public reader has something to show. */
  async function publish(input: {
    sellerId: string;
    providerId: string;
    authorizationId: string;
    senderHash: string;
    itemName: string;
  }): Promise<void> {
    const sql = handle().sql;
    const proposals = await sql`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, provider_id, payload, proposal_version,
        has_inventory, has_closure, base_revision_id, base_is_first_publication,
        state, closed_at
      ) values (
        ${input.senderHash}, ${hostStandId}, ${input.providerId},
        ${sql.json({ entries: [] })}, 1, true, false, null, true, 'invalidated', ${BASE}
      ) returning id
    `;
    const approvals = await sql`
      select id from seller_approvals where seller_id = ${input.sellerId}
    `;
    const revisions = await sql`
      insert into inventory_revisions (
        seller_id, sales_location_id, provider_id, proposal_id,
        published_by_authorization_id, farm_approval_id, source, published_at
      ) values (
        ${input.sellerId}, ${hostStandId}, ${input.providerId},
        ${proposals[0]?.id as string}, ${input.authorizationId},
        ${approvals[0]?.id as string}, 'sms', ${BASE}
      ) returning id
    `;
    await sql`
      insert into inventory_entries (
        inventory_revision_id, sales_location_id, item_name, quantity, unit,
        price_text, approximation, sort_order
      ) values (
        ${revisions[0]?.id as string}, ${hostStandId}, ${input.itemName}, 3, 'bunches',
        '$4', 'plentiful', 0
      )
    `;
  }

  beforeAll(async () => {
    databaseName = `ff_liveness_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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
    const sql = handle().sql;

    const administrators = await sql`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', ${BASE}) returning id
    `;
    const administratorId = administrators[0]?.id as string;

    const host = await mkSeller("Kelseys Farm", "+12065557000", administratorId);
    hostSellerId = host.sellerId;
    hostSenderHash = host.senderHash;
    const guest = await mkSeller("Gracies Greens", "+12065557001", administratorId);
    guestSellerId = guest.sellerId;
    guestSenderHash = guest.senderHash;
    guestAuthorizationId = guest.authorizationId;

    const locations = await sql`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        is_public, public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      ) values (
        ${hostSellerId}, 'farm_stand', 'Kelseys Stand', 'America/Los_Angeles',
        'visitable', 'produce', true, '1 Kelsey Way', 47.45, -122.46, false, true
      ) returning id
    `;
    hostStandId = locations[0]?.id as string;
    const own = await sql`
      select id from stand_providers
      where sales_location_id = ${hostStandId} and seller_id = ${hostSellerId}
    `;
    hostProviderId = own[0]?.id as string;

    const hosted = await sql`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, host_may_update_stock,
        invited_at, accepted_at, approval_source, approved_at
      ) values (
        ${hostStandId}, ${guestSellerId}, 'active', false, ${BASE}, ${BASE}, 'viga', ${BASE}
      ) returning id
    `;
    guestProviderId = hosted[0]?.id as string;

    await publish({
      sellerId: hostSellerId,
      providerId: hostProviderId,
      authorizationId: host.authorizationId,
      senderHash: hostSenderHash,
      itemName: "Kale",
    });
    await publish({
      sellerId: guestSellerId,
      providerId: guestProviderId,
      authorizationId: guestAuthorizationId,
      senderHash: guestSenderHash,
      itemName: "Sourdough",
    });
  }, 90_000);

  afterAll(async () => {
    if (db) await db.close();
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  }, 30_000);

  /** Ask every reader at once. One shape, so a case reads as a row of yes/no per surface. */
  async function measure() {
    const [facts, sellers, inventory, authority, roster] = await Promise.all([
      readStandProviderFacts(handle(), {
        salesLocationIds: [hostStandId],
        includeTestFarms: false,
      }),
      listPublicSellers(handle(), { includeTestSellers: false }),
      readCurrentInventoryByProvider(handle(), { salesLocationId: hostStandId }),
      resolveProviderWriteAuthority(handle(), {
        providerId: guestProviderId,
        senderHash: guestSenderHash,
      }),
      listFarmerAuthorizations(handle()),
    ]);
    const target = await resolveFarmerTarget(handle(), {
      senderHash: guestSenderHash,
      occurredAt: LATER,
      purpose: "update",
    });
    return {
      // PUBLIC surfaces
      onStandCard: (facts.get(hostStandId) ?? []).some(
        (p) => p.providerId === guestProviderId,
      ),
      inSellerList: sellers.some((s) => s.sellerId === guestSellerId),
      inCurrentInventory: inventory.some((p) => p.providerId === guestProviderId),
      // REACHABLE surfaces
      mayWrite: authority.status === "authorized",
      hasSmsTarget:
        target.status === "selected" && target.target.providerId === guestProviderId,
      inVigaRoster: (roster.find((r) => r.farmId === guestSellerId)?.stands ?? []).some(
        (s) => s.salesLocationId === hostStandId,
      ),
    };
  }

  it("shows an ACTIVE hosted seller on every surface, public and reachable alike", async () => {
    // The baseline, and the thing that keeps the paused case from passing vacuously: if the
    // fixture failed to publish anything, every assertion below would read `false` for the
    // right answer and the wrong reason.
    expect(await measure()).toEqual({
      onStandCard: true,
      inSellerList: true,
      inCurrentInventory: true,
      mayWrite: true,
      hasSmsTarget: true,
      inVigaRoster: true,
    });
  });

  it("hides a PAUSED seller from the public and keeps her reachable", async () => {
    /*
      The whole point of the pair, in one measurement. Every `true` below is a rule from a
      different sentence of the contract, and the two halves pull in opposite directions —
      which is why one shared fragment for all ten sites would have had to be wrong somewhere.
    */
    expect(
      await setProviderParticipation(handle(), {
        providerId: guestProviderId,
        transition: "pause",
        senderHash: guestSenderHash,
        occurredAt: LATER,
      }),
    ).toMatchObject({ status: "changed", lifecycleState: "paused" });

    expect(await measure()).toEqual({
      // §hosting and approval lifecycle: pausing HIDES current public facts.
      onStandCard: false,
      inSellerList: false,
      inCurrentInventory: false,
      // §facts and authority: a paused provider is OFFERED RE-OPENING, never refused.
      mayWrite: true,
      hasSmsTarget: true,
      inVigaRoster: true,
    });
  });

  it("still prompts a paused seller, so she can be offered her listing back", async () => {
    // The scheduler is on the reachable side and this is why: the re-open confirmation arrives
    // as the answer to a prompt, so a pass that skipped paused listings would leave a paused
    // seller with no route back except remembering to text first.
    // Through the real writer, so the row carries whatever `setInventoryPromptPreference`
    // actually writes rather than a fixture's guess at its columns.
    const saved = await setInventoryPromptPreference(handle(), {
      senderHash: guestSenderHash,
      authorizationId: guestAuthorizationId,
      providerId: guestProviderId,
      cadence: "weekly",
      clock: new FixedClock(BASE),
    });
    expect(saved.status).toBe("saved");

    /*
      The pass is run at the slot the WRITER computed, not at an invented one. It re-derives
      `nextPromptDueSlot` from the later of the preference's own update and the listing's last
      publication and defers a prompt whose stored slot no longer matches — the "a farmer
      publication resets the cadence" rule — so forcing `next_due_at` earlier produces a silent
      `ineligible` that reads exactly like the refusal this case is trying to disprove.
    */
    const due = (await handle().sql`
      select next_due_at from inventory_prompt_preferences
    `)[0]?.next_due_at as Date;

    const result = await runScheduledPromptPass({
      db: handle(),
      clock: new FixedClock(due),
    });
    expect(result).toEqual({ scheduled: 1, deferred: 0 });
    expect(await handle().sql`
      select provider_id from scheduled_inventory_prompt_subjects
    `).toEqual([{ provider_id: guestProviderId }]);
  });

  it("brings her back to the public on RESUME, with the history she never lost", async () => {
    // *"without deleting history"* — the half a hiding rule is easy to get wrong by deleting.
    expect(
      await setProviderParticipation(handle(), {
        providerId: guestProviderId,
        transition: "resume",
        senderHash: guestSenderHash,
        occurredAt: LATER,
      }),
    ).toMatchObject({ status: "changed", lifecycleState: "active" });

    expect(await measure()).toEqual({
      onStandCard: true,
      inSellerList: true,
      inCurrentInventory: true,
      mayWrite: true,
      hasSmsTarget: true,
      inVigaRoster: true,
    });
    // The same item, from the same revision. Nothing was republished to get it back.
    const facts = await readStandProviderFacts(handle(), {
      salesLocationIds: [hostStandId],
      includeTestFarms: false,
    });
    const guest = (facts.get(hostStandId) ?? []).find(
      (p) => p.providerId === guestProviderId,
    );
    expect(guest?.confirmedItems.map((i) => i.itemName)).toEqual(["Sourdough"]);
  });

  it("takes an ENDED seller off BOTH sides", async () => {
    // Ended is the one answer both fragments share, and it has to stay shared: there is no
    // relationship left to publish and none to be offered back into.
    await setProviderParticipation(handle(), {
      providerId: guestProviderId,
      transition: "end",
      senderHash: guestSenderHash,
      occurredAt: LATER,
    });
    expect(await measure()).toEqual({
      onStandCard: false,
      inSellerList: false,
      inCurrentInventory: false,
      mayWrite: false,
      hasSmsTarget: false,
      inVigaRoster: false,
    });
  });

  it("leaves the HOST untouched throughout", async () => {
    // Asserted as an absence beside all of the above: every case here changes one seller's
    // relationship, and a stand-scoped predicate would take her host down with her.
    const facts = await readStandProviderFacts(handle(), {
      salesLocationIds: [hostStandId],
      includeTestFarms: false,
    });
    const host = (facts.get(hostStandId) ?? []).find(
      (p) => p.providerId === hostProviderId,
    );
    expect(host?.confirmedItems.map((i) => i.itemName)).toEqual(["Kale"]);
  });
});
