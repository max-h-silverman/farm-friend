import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FixedClock,
  issueFarmerLinkToken,
  type StructuredInventoryEdit,
} from "@farm-friend/core";
import {
  activateWebProposal,
  approveFarm,
  authorizeFarmer,
  createDb,
  issueFarmerLink,
  readNativeProviderId,
  openFarmerOnboardingRequest,
  revokeFarmerAuthorization,
  type Db,
  type Sql,
} from "@farm-friend/db";
import {
  confirmFromLink,
  proposeStructuredFromLink,
  resolveStandFromToken,
  saveParticipantsFromLink,
} from "./farmer-stand";

// F-040 — THE BLAST RADIUS OF A LEAKED LINK.
//
// max chose a link that never expires until revoked, and named the consequence exactly:
// a leaked link may at worst propose a wrong listing on ONE stand, and can never
//
//   1. change farm ownership,
//   2. grant or alter authorization,
//   3. reach another farm's listing,
//   4. read another actor's data,
//   5. publish without confirmation.
//
// Each of those has its own test below, and each was sabotaged to prove it can fail. This
// file is the reason the never-expiring link is a defensible decision rather than a hope.
//
// The sixth guarantee — a revoked link dies on the NEXT request — is the safety net that
// makes the other five recoverable, and is asserted here as well as in the db suite, because
// the property that matters to a farmer is that the SURFACE refuses, not that a resolver
// returns null.

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");
const databaseUrl = process.env.DATABASE_URL;

function requiredDatabaseUrl(): string {
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required; a skipped integration run is not green",
    );
  }
  return databaseUrl;
}

function testDatabaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

describe("the farmer web surface behind a standing link (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let db: Db | undefined;
  let testDatabaseName: string | undefined;
  let farmerStandRoute: typeof import("../app/api/farmer/stand/route");

  const anchor = Date.now() - 24 * 60 * 60 * 1000;
  const at = (hours: number) => new Date(anchor + hours * 60 * 60 * 1000);
  const sql = () => client as Sql;
  const database = () => db as Db;

  let administratorId: string;
  let counter = 0;

  /** A complete, authorized, approved farmer with a live link. The normal case. */
  async function farmer(): Promise<{
    token: string;
    farmId: string;
    salesLocationId: string;
    contactHash: string;
    authorizationId: string;
  }> {
    counter += 1;
    const digits = String(3000 + counter);
    const contactHash = `ab${counter.toString(16)}`.padStart(64, "0");
    await sql()`
      insert into contacts (phone_e164, phone_hash)
      values (${`+1206555${digits}`}, ${contactHash})
      on conflict (phone_hash) do nothing
    `;
    const sellers = await sql()`
      insert into sellers (name) values (${`Web Farm ${randomUUID()}`}) returning id
    `;
    const farmId = sellers[0]?.id as string;
    const locations = await sql()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type, public_address,
        public_latitude, public_longitude
      )
      values (
        ${farmId}, 'farm_stand', ${`Web Stand ${randomUUID()}`}, 'America/Los_Angeles', 'visitable',
        'produce', '3 Vashon Hwy', 47.43, -122.43
      )
      returning id
    `;

    const opened = await openFarmerOnboardingRequest(database(), {
      contactHash,
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
    const authorizationId =
      authorized.status === "authorized" ? authorized.authorizationId : "";
    await approveFarm(database(), { farmId, administratorId, occurredAt: at(1) });

    const issued = await issueFarmerLink(database(), {
      authorizationId,
      // The stand's own listing (F-114 C.3): a link opens one listing, and every fixture here
      // is a farmer at a stand of her own.
      providerId: await readNativeProviderId(database(), {
        salesLocationId: locations[0]?.id as string,
      }),
      occurredAt: at(2),
    });

    return {
      token: issued.status === "issued" ? issued.token : "",
      farmId,
      salesLocationId: locations[0]?.id as string,
      contactHash,
      authorizationId,
    };
  }

  /** The deterministic web dependencies plus the direct edit this test will submit. */
  function deps(edit: StructuredInventoryEdit) {
    return {
      db: database(),
      edit,
      clock: new FixedClock(at(3)),
      activate: (input: {
        proposalId: string;
        senderHash: string;
        confirmationText: string;
        at: Date;
      }) => activateWebProposal(database(), input),
    };
  }

  function propose(d: ReturnType<typeof deps>, token: string) {
    return proposeStructuredFromLink(d, { token, edit: d.edit });
  }

  /** Propose then confirm, the whole farmer journey in one call. */
  async function publish(
    token: string,
    items: string[],
  ): Promise<{ status: string }> {
    const d = deps({
      kind: "edits",
      additions: items.map((itemName) => ({ itemName })),
      changes: [],
      removals: [],
    });
    const proposed = await propose(d, token);
    if (proposed.outcome !== "proposed") return { status: proposed.outcome };
    return confirmFromLink(d, {
      token,
      proposalId: proposed.proposalId,
      accept: true,
      confirmationText: proposed.confirmationText,
    });
  }

  beforeAll(async () => {
    const baseUrl = requiredDatabaseUrl();
    testDatabaseName = `farm_friend_web_stand_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(baseUrl, { max: 1 });
    await adminClient.unsafe(`create database "${testDatabaseName}"`);
    const url = testDatabaseUrl(baseUrl, testDatabaseName);
    client = postgres(url, { max: 1 });
    const migrationClient = postgres(url, { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    db = createDb(url);
    process.env.DATABASE_URL = url;
    farmerStandRoute = await import("../app/api/farmer/stand/route");

    const administrators = await sql()`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', ${at(0).toISOString()})
      returning id
    `;
    administratorId = administrators[0]?.id as string;
  }, 30_000);

  afterAll(async () => {
    if (db) await db.close();
    if (client) await client.end({ timeout: 5 });
    const { publicReadContext } = await import("./public-context");
    await publicReadContext().db.close();
    if (adminClient && testDatabaseName) {
      await adminClient.unsafe(`drop database if exists "${testDatabaseName}"`);
      await adminClient.end({ timeout: 5 });
    }
  });

  describe("the journey the link exists for", () => {
    it("proposes and publishes through the SAME gate SMS uses", async () => {
      const { token, salesLocationId } = await farmer();

      const result = await publish(token, ["duck eggs", "rhubarb"]);
      expect(result.status).toBe("published");

      // Verified by EFFECT: the published rows, not a success status.
      const entries = await sql()`
        select entry.item_name
        from inventory_entries as entry
        join inventory_revisions as revision
          on revision.id = entry.inventory_revision_id
        where revision.sales_location_id = ${salesLocationId} and revision.is_current
        order by entry.sort_order
      `;
      expect(entries.map((row) => row.item_name)).toEqual(["duck eggs", "rhubarb"]);

      // And the revision records the authorization AND the approval it was published under
      // — the pairing that structurally prevents a fabricated confirmation.
      const revisions = await sql()`
        select published_by_authorization_id, farm_approval_id, proposal_id
        from inventory_revisions where sales_location_id = ${salesLocationId}
      `;
      expect(revisions[0]?.published_by_authorization_id).not.toBeNull();
      expect(revisions[0]?.farm_approval_id).not.toBeNull();
      expect(revisions[0]?.proposal_id).not.toBeNull();
    });

    it("declines without publishing, leaving the listing untouched", async () => {
      const { token, salesLocationId } = await farmer();
      await publish(token, ["carrots"]);

      const d = deps({
        kind: "edits",
        additions: [{ itemName: "beets" }],
        changes: [],
        removals: [],
      });
      const proposed = await propose(d, token);
      expect(proposed.outcome).toBe("proposed");
      const declined = await confirmFromLink(d, {
        token,
        proposalId:
          proposed.outcome === "proposed" ? proposed.proposalId : "",
        accept: false,
        confirmationText: "Your stand will show: …",
      });
      expect(declined.status).toBe("declined");

      const entries = await sql()`
        select entry.item_name
        from inventory_entries as entry
        join inventory_revisions as revision
          on revision.id = entry.inventory_revision_id
        where revision.sales_location_id = ${salesLocationId} and revision.is_current
      `;
      expect(entries.map((row) => row.item_name)).toEqual(["carrots"]);
    });

    it("publishes a structured web edit in ONE request and returns the published rows", async () => {
      // F-097 (max, 2026-08-08) — `propose`/`confirm`/`decline` collapsed into one `publish`.
      // The two-press gate is right for SMS, where code interpreted prose and had to show its
      // reading first; on this surface the farmer is looking at the rows they typed.
      //
      // **The confirmation TRANSACTION is unchanged**, which is what this asserts by effect: a
      // real `inventory_entries` row exists afterwards, written through
      // `confirmInventoryPublication` with all its authority, approval and retirement checks —
      // not by a new writer that reached around them. The neighbouring tests in this file
      // sabotage each of those bounds and still pass.
      const { token, salesLocationId } = await farmer();
      const response = await farmerStandRoute.POST(
        new Request("https://ff.example/api/farmer/stand", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token,
            action: "publish",
            edit: {
              additions: [{ itemName: "Eggs", quantity: 12, unit: "dozen", priceText: "$6" }],
              changes: [],
              removals: [],
            },
          }),
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        status: "published",
        currentEntries: [
          { itemName: "Eggs", quantity: 12, unit: "dozen", priceText: "$6" },
        ],
      });
      expect(await sql()`
        select item_name, quantity, unit, price_text
        from inventory_entries where sales_location_id = ${salesLocationId}
      `).toEqual([{ item_name: "Eggs", quantity: 12, unit: "dozen", price_text: "$6" }]);

      // The proposal was consumed rather than left open: an `open` row would occupy the
      // one-per-sender slot and refuse the farmer's next SMS update.
      expect(await sql()`
        select count(*)::int as open from inventory_publication_proposals
        where sales_location_id = ${salesLocationId} and state = 'open'
      `).toEqual([{ open: 0 }]);

      // AND NOTHING WAS TEXTED. The web path writes its activation record `suppressed`: the
      // farmer read the exact snapshot on screen as they saved it, so a text restating it is
      // noise for an errand already finished. The row still EXISTS, because
      // `activation_coherent` requires a message the proposal activated from.
      //
      // Scoped to THIS stand's proposal by logical key rather than counting every confirmation
      // in the database — other tests in this file publish too, and a global count would make
      // this pass or fail on their ordering rather than on the property it names.
      const proposals = await sql()`
        select id from inventory_publication_proposals
        where sales_location_id = ${salesLocationId}
      `;
      const queued = await sql()`
        select state from outbox_work
        where logical_key = ${`web-proposal-${proposals[0]?.id as string}`}
      `;
      expect(queued).toEqual([{ state: "suppressed" }]);
    });

    it("refuses free text at the web boundary without opening a proposal", async () => {
      const { token, contactHash } = await farmer();
      const response = await farmerStandRoute.POST(
        new Request("https://ff.example/api/farmer/stand", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, action: "publish", text: "eggs and kale" }),
        }),
      );

      expect(response.status).toBe(400);
      expect(await sql()`
        select id from inventory_publication_proposals where sender_hash = ${contactHash}
      `).toEqual([]);
    });
  });

  describe("owner-confirmed names of other sellers", () => {
    it("accepts the structured save over HTTP and returns the durable active list", async () => {
      const { token, salesLocationId } = await farmer();

      const response = await farmerStandRoute.POST(
        new Request("https://ff.example/api/farmer/stand", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token,
            action: "save_participants",
            participantNames: ["Guest Growers", "Island Apiary"],
          }),
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        status: "saved",
        activeDisplayNames: ["Guest Growers", "Island Apiary"],
      });
      expect(await sql()`
        select display_name from sales_location_participants
        where sales_location_id = ${salesLocationId} and retired_at is null
        order by display_name
      `).toEqual([
        { display_name: "Guest Growers" },
        { display_name: "Island Apiary" },
      ]);
    });

    it("saves a complete active list and retires omissions without deleting history", async () => {
      const { token, salesLocationId } = await farmer();
      const d = deps({ kind: "clear_all" });

      expect(
        await saveParticipantsFromLink(d, {
          token,
          activeDisplayNames: ["Guest Growers", "Island Apiary"],
        }),
      ).toMatchObject({
        status: "saved",
        activeDisplayNames: ["Guest Growers", "Island Apiary"],
      });
      expect(
        await saveParticipantsFromLink(d, {
          token,
          activeDisplayNames: ["Island Apiary"],
        }),
      ).toMatchObject({
        status: "saved",
        activeDisplayNames: ["Island Apiary"],
        retiredDisplayNames: ["Guest Growers"],
      });

      expect(await sql()`
        select display_name, retired_at is not null as retired
        from sales_location_participants
        where sales_location_id = ${salesLocationId}
        order by display_name
      `).toEqual([
        { display_name: "Guest Growers", retired: true },
        { display_name: "Island Apiary", retired: false },
      ]);
    });

    it("can write only the location carried by its own token", async () => {
      const victim = await farmer();
      const holder = await farmer();

      expect(
        await saveParticipantsFromLink(deps({ kind: "clear_all" }), {
          token: holder.token,
          activeDisplayNames: ["Named By Holder"],
        }),
      ).toMatchObject({ status: "saved" });

      expect(await sql()`
        select display_name from sales_location_participants
        where sales_location_id = ${victim.salesLocationId}
      `).toEqual([]);
      expect(await sql()`
        select display_name from sales_location_participants
        where sales_location_id = ${holder.salesLocationId}
      `).toEqual([{ display_name: "Named By Holder" }]);
    });

    it("refuses unsafe public text and a link revoked before the next save", async () => {
      const holder = await farmer();
      const d = deps({ kind: "clear_all" });

      expect(
        await saveParticipantsFromLink(d, {
          token: holder.token,
          activeDisplayNames: ["Call 206-555-0199"],
        }),
      ).toMatchObject({ status: "refused", reason: "unsafe_public_text" });
      await revokeFarmerAuthorization(database(), {
        authorizationId: holder.authorizationId,
        administratorId,
        occurredAt: at(4),
      });
      expect(
        await saveParticipantsFromLink(d, {
          token: holder.token,
          activeDisplayNames: ["Guest Growers"],
        }),
      ).toEqual({ status: "not_authorized" });
      expect(await sql()`
        select id from sales_location_participants
        where sales_location_id = ${holder.salesLocationId}
      `).toEqual([]);
    });
  });

  /*
    F-114 Phase C.1 — THE STAND OWNER'S OWN INVITATION DOOR.

    VIGA could already invite a seller to a stand by API. Kelsey could not do it at all, from her
    phone or from her own page, which left the Venison Valley case — the one VIGA actually asked
    for — reachable only by a coordinator typing on her behalf.

    **The authority is the link itself, and nothing new.** `resolveFarmerLink` joins
    `location.own_seller_id = link.owner_seller_id = auth.seller_id`, so a token that resolves at
    all belongs to a phone authorized for the seller its stand names as itself — which is exactly
    what §there is no second permission system means by "stand owner", derived through the
    self-pointer and never stored. This surface therefore invents no role and reads no new column;
    it hands `inviteSellerToStand` the authorization the token already resolved, and that writer
    re-reads it under lock before writing anything.

    **The SMS half is the link a farmer already holds** (a judgment call, recorded here). `LINK`
    and `SETTINGS` both text the farmer this page, so "invite from my phone" is satisfied by the
    door they already have rather than by a new keyword. A keyword would need a free-text grammar
    for a name that becomes a public brand, plus a way to text a 64-hex link back for forwarding —
    a second mechanism for a door that already opens.

    **What this genuinely widens, stated rather than buried.** A leaked link can now create a
    seller row and a `pending` relationship at its own stand. It still cannot authorize anybody:
    the invitation mints no authorization, acceptance requires the invited seller's own handset
    and a bare `START`, and `pending` is excluded by every public reader — so the worst a leak
    achieves is an unaccepted invitation VIGA can revoke. That bound is asserted below, not
    assumed.
  */
  describe("the stand owner invites a seller to their own stand", () => {
    it("mints a forwardable link and a pending relationship the owner vouched for", async () => {
      const { token, salesLocationId, authorizationId } = await farmer();

      const response = await farmerStandRoute.POST(
        new Request("https://ff.example/api/farmer/stand", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token,
            action: "invite_seller",
            newSellerName: "Gracies Greens",
          }),
        }),
      );

      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        status: string;
        sellerName?: string;
        link?: string;
      };
      expect(payload.status).toBe("invited");
      expect(payload.sellerName).toBe("Gracies Greens");
      // A LINK, not a bare token: the host forwards this by hand, and a farmer cannot be asked
      // to assemble a URL. The onboarding path is the ordinary farmer one, which is the whole
      // point of reusing the farmer invitation.
      expect(payload.link).toMatch(
        /^https?:\/\/[^/]+\/farmer\/onboarding\/[0-9a-f]{64}$/,
      );

      const providers = await sql()`
        select p.lifecycle_state, p.host_may_update_stock, p.accepted_at, p.approval_source, p.id
        from stand_providers p
        join sellers s on s.id = p.seller_id
        where p.sales_location_id = ${salesLocationId} and s.name = 'Gracies Greens'
      `;
      expect(providers[0]).toMatchObject({
        lifecycle_state: "pending",
        // Acceptance never grants more than it says: the host's stock right stays OFF, and it is
        // the seller's to turn on afterwards.
        host_may_update_stock: false,
        accepted_at: null,
        approval_source: null,
      });

      // The VOUCH — `approval_source = 'host'` at acceptance follows from this column, and this
      // is the door that fills it. VIGA's door fills the administrator column instead.
      const invitations = await sql()`
        select invited_by_authorization_id, created_by_administrator_id, token_hash
        from farmer_invitations where stand_provider_id = ${providers[0]?.id as string}
      `;
      expect(invitations[0]).toMatchObject({
        invited_by_authorization_id: authorizationId,
        created_by_administrator_id: null,
      });
      // Only the hash is stored. The link in the response is the one readable copy.
      const rawToken = (payload.link ?? "").split("/").at(-1);
      expect(invitations[0]?.token_hash).not.toBe(rawToken);
    });

    it("can invite only to the stand its own token carries", async () => {
      // The blast radius, asserted the way every other guarantee in this file is. The location
      // comes from the token's row; there is no field in the request that names one.
      const victim = await farmer();
      const holder = await farmer();

      await farmerStandRoute.POST(
        new Request("https://ff.example/api/farmer/stand", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token: holder.token,
            action: "invite_seller",
            newSellerName: "Invited By Holder",
            // Ignored, and it must be: a caller naming another stand must not reach it.
            standId: victim.salesLocationId,
            salesLocationId: victim.salesLocationId,
          }),
        }),
      );

      expect(await sql()`
        select count(*)::int as total from stand_providers
        where sales_location_id = ${victim.salesLocationId}
          and seller_id <> ${victim.farmId}
      `).toEqual([{ total: 0 }]);
      expect(await sql()`
        select s.name from stand_providers p join sellers s on s.id = p.seller_id
        where p.sales_location_id = ${holder.salesLocationId} and s.name = 'Invited By Holder'
      `).toEqual([{ name: "Invited By Holder" }]);
    });

    it("authorizes nobody — acceptance is still the invited seller's own handset", async () => {
      // The bound on what a leaked link achieves. An invitation is not an authorization, and
      // nothing here shortens the path the invited seller walks: their own `START`, from the
      // handset they stated on the form, is what mints one.
      const { token } = await farmer();
      const before = await sql()`
        select
          (select count(*)::int from farmer_authorizations) as authorizations,
          (select count(*)::int from seller_approvals) as approvals
      `;

      const response = await farmerStandRoute.POST(
        new Request("https://ff.example/api/farmer/stand", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token,
            action: "invite_seller",
            newSellerName: "Authorizes Nobody",
          }),
        }),
      );
      expect(response.status).toBe(200);

      expect(await sql()`
        select
          (select count(*)::int from farmer_authorizations) as authorizations,
          (select count(*)::int from seller_approvals) as approvals
      `).toEqual(before);
    });

    it("refuses a name that would put contact details on the public map", async () => {
      // A hosted seller is CREDITED on the stand's public card, so this name reaches the
      // island's guide. The refusal is the writer's, surfaced here with the farmer-facing copy
      // the participant save already uses rather than a second wording.
      const { token, salesLocationId } = await farmer();

      const response = await farmerStandRoute.POST(
        new Request("https://ff.example/api/farmer/stand", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token,
            action: "invite_seller",
            newSellerName: "Gracies Greens 206-555-0199",
          }),
        }),
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        reason: "unsafe_public_text",
        message: expect.stringContaining("phone number"),
      });
      // Nothing invited, and no seller left behind. The stand's OWN provider row is excluded
      // deliberately: the self-pointer creates it when the stand is saved, so counting it would
      // be asserting against a row this request had nothing to do with.
      expect(await sql()`
        select count(*)::int as total from stand_providers p
        join sales_locations l on l.id = p.sales_location_id
        where p.sales_location_id = ${salesLocationId}
          and p.seller_id is distinct from l.own_seller_id
      `).toEqual([{ total: 0 }]);
      expect(await sql()`
        select count(*)::int as total from sellers where name like 'Gracies Greens %'
      `).toEqual([{ total: 0 }]);
    });

    it("refuses a revoked link, inviting nobody", async () => {
      const holder = await farmer();
      await revokeFarmerAuthorization(database(), {
        authorizationId: holder.authorizationId,
        administratorId,
        occurredAt: at(4),
      });

      const response = await farmerStandRoute.POST(
        new Request("https://ff.example/api/farmer/stand", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token: holder.token,
            action: "invite_seller",
            newSellerName: "Invited After Revocation",
          }),
        }),
      );

      expect(response.status).toBe(403);
      expect(await sql()`
        select count(*)::int as total from sellers where name = 'Invited After Revocation'
      `).toEqual([{ total: 0 }]);
    });

    it("refuses a blank name and a name given twice over", async () => {
      const { token, farmId } = await farmer();

      for (const body of [
        { action: "invite_seller" },
        { action: "invite_seller", newSellerName: "   " },
        { action: "invite_seller", newSellerName: 42 },
        { action: "invite_seller", newSellerName: "Both Named", sellerId: farmId },
      ]) {
        const response = await farmerStandRoute.POST(
          new Request("https://ff.example/api/farmer/stand", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token, ...body }),
          }),
        );
        expect(response.status, JSON.stringify(body)).toBe(400);
      }
    });
  });

  // ── The five guarantees, one test each ──────────────────────────────────────────────

  describe("a leaked link CANNOT publish without confirmation (5)", () => {
    it("writes no revision from a proposal alone", async () => {
      const { token, salesLocationId } = await farmer();
      const d = deps({
        kind: "edits",
        additions: [{ itemName: "invented squash" }],
        changes: [],
        removals: [],
      });

      const proposed = await propose(d, token);
      expect(proposed.outcome).toBe("proposed");

      // Proposing is not publishing. Nothing is current, and nothing is visible to a
      // customer, until the farmer confirms.
      const revisions = await sql()`
        select id from inventory_revisions where sales_location_id = ${salesLocationId}
      `;
      expect(revisions).toHaveLength(0);

      const entries = await sql()`
        select entry.id from inventory_entries as entry
        where entry.sales_location_id = ${salesLocationId}
      `;
      expect(entries).toHaveLength(0);
    });

    it("refuses a confirmation for a proposal that was never opened", async () => {
      const { token, salesLocationId } = await farmer();
      const d = deps({ kind: "clear_all" });

      const result = await confirmFromLink(d, {
        token,
        proposalId: randomUUID(),
        accept: true,
        confirmationText: "Your stand will show: …",
      });
      expect(result.status).toBe("refused");

      const revisions = await sql()`
        select id from inventory_revisions where sales_location_id = ${salesLocationId}
      `;
      expect(revisions).toHaveLength(0);
    });
  });

  describe("a leaked link CANNOT reach another farm's listing (3)", () => {
    it("publishes only to the stand its own token names", async () => {
      const victim = await farmer();
      const attacker = await farmer();

      // The attacker's link publishes. If the location came from anywhere but the token's
      // own row, the victim's stand would move.
      const result = await publish(attacker.token, ["attacker kale"]);
      expect(result.status).toBe("published");

      const victimEntries = await sql()`
        select entry.item_name from inventory_entries as entry
        where entry.sales_location_id = ${victim.salesLocationId}
      `;
      expect(victimEntries).toHaveLength(0);

      const attackerEntries = await sql()`
        select entry.item_name from inventory_entries as entry
        where entry.sales_location_id = ${attacker.salesLocationId}
      `;
      expect(attackerEntries.map((row) => row.item_name)).toEqual(["attacker kale"]);
    });

    it("cannot confirm ANOTHER farmer's pending proposal by naming its id", async () => {
      const victim = await farmer();
      const attacker = await farmer();

      // The victim opens a proposal and has not confirmed it.
      const victimDeps = deps({
        kind: "edits",
        additions: [{ itemName: "victim plums" }],
        changes: [],
        removals: [],
      });
      const victimProposal = await propose(victimDeps, victim.token);
      expect(victimProposal.outcome).toBe("proposed");
      const victimProposalId =
        victimProposal.outcome === "proposed" ? victimProposal.proposalId : "";

      // The attacker, holding their OWN valid link, tries to confirm it.
      const attackerDeps = deps({ kind: "clear_all" });
      const result = await confirmFromLink(attackerDeps, {
        token: attacker.token,
        proposalId: victimProposalId,
        accept: true,
        confirmationText: "Your stand will show: …",
      });
      expect(result.status).toBe("refused");

      // Nothing published on the victim's stand, and their proposal is still open and
      // still theirs to accept.
      const revisions = await sql()`
        select id from inventory_revisions
        where sales_location_id = ${victim.salesLocationId}
      `;
      expect(revisions).toHaveLength(0);
      const proposals = await sql()`
        select state, consumed_token from inventory_publication_proposals
        where id = ${victimProposalId}
      `;
      expect(proposals[0]?.state).toBe("open");

      // Sabotage found this missing. Asserting only "refused" and "still open" was
      // satisfiable by the exact attack it was written to forbid: reading the sender hash
      // from the NAMED PROPOSAL rather than from the attacker's own token makes the
      // attacker BECOME the victim, so the gate matches, publishes on the victim's behalf,
      // and consumes their proposal — after which "still open" is false but nothing else
      // checked was. The proposal must be UNCONSUMED, and the attacker's own stand must not
      // have acquired the victim's items either.
      expect(proposals[0]?.consumed_token).toBeNull();

      const attackerEntries = await sql()`
        select entry.item_name from inventory_entries as entry
        where entry.sales_location_id = ${attacker.salesLocationId}
      `;
      expect(attackerEntries.map((row) => row.item_name)).not.toContain("victim plums");
    });

    it("cannot ACTIVATE another farmer's proposal, even given its id", async () => {
      // The cross-farmer guarantee has TWO independent defenses, and sabotage showed the
      // suite could only see the pair: removing either one alone still refused, so neither
      // was individually asserted. This isolates the second one.
      //
      //   1. `confirmFromLink` takes the sender hash from the TOKEN'S row, so the gate looks
      //      for the attacker's proposal and finds nothing. (Asserted above.)
      //   2. `activateWebProposal` is scoped to that same sender hash, so a proposal
      //      belonging to someone else is never activated — and an unactivated proposal
      //      publishes nothing, whatever else goes wrong. (Asserted here.)
      //
      // Redundant defenses are worth having. Redundant defenses nobody can tell apart are
      // how one of them gets deleted as dead code.
      const victim = await farmer();
      const attacker = await farmer();

      const victimDeps = deps({
          kind: "edits",
          additions: [{ itemName: "victim pears" }],
          changes: [],
          removals: [],
        });
      const victimProposal = await propose(victimDeps, victim.token);
      const victimProposalId =
        victimProposal.outcome === "proposed" ? victimProposal.proposalId : "";

      // The attacker's OWN sender hash against the victim's proposal id — exactly what
      // `confirmFromLink` passes down when a holder names someone else's proposal.
      await activateWebProposal(database(), {
        proposalId: victimProposalId,
        senderHash: attacker.contactHash,
        confirmationText: "Your stand will show: …",
        at: at(3),
      });

      const rows = await sql()`
        select activated_at, activated_version, expires_at, activation_outbox_id
        from inventory_publication_proposals where id = ${victimProposalId}
      `;
      // Untouched. An unactivated proposal cannot be confirmed by anyone, including its
      // rightful owner, until they activate it themselves.
      expect(rows[0]?.activated_at).toBeNull();
      expect(rows[0]?.activated_version).toBeNull();
      expect(rows[0]?.expires_at).toBeNull();
      expect(rows[0]?.activation_outbox_id).toBeNull();
    });
  });

  describe("a leaked link CANNOT change ownership or authorization (1, 2)", () => {
    it("leaves sellers, authorizations, approvals, and administrators untouched", async () => {
      const { token, farmId, authorizationId } = await farmer();

      const before = await sql()`
        select
          (select count(*)::int from sellers) as sellers,
          (select count(*)::int from farmer_authorizations) as authorizations,
          (select count(*)::int from seller_approvals) as approvals,
          (select count(*)::int from administrators) as administrators,
          (select count(*)::int from farmer_links) as links,
          (select count(*)::int from farmer_onboarding_requests) as requests
      `;

      // Everything the surface can do, done.
      await publish(token, ["beans"]);
      await propose(deps({ kind: "clear_all" }), token);

      const after = await sql()`
        select
          (select count(*)::int from sellers) as sellers,
          (select count(*)::int from farmer_authorizations) as authorizations,
          (select count(*)::int from seller_approvals) as approvals,
          (select count(*)::int from administrators) as administrators,
          (select count(*)::int from farmer_links) as links,
          (select count(*)::int from farmer_onboarding_requests) as requests
      `;
      expect(after[0]).toEqual(before[0]);

      // And the holder's OWN authorization is byte-identical — it cannot even widen itself.
      const authorization = await sql()`
        select seller_id, contact_id, phone_verified_at, authorized_at, revoked_at
        from farmer_authorizations where id = ${authorizationId}
      `;
      expect(authorization[0]?.seller_id).toBe(farmId);
      expect(authorization[0]?.revoked_at).toBeNull();
    });
  });

  describe("a leaked link CANNOT read another actor's data (4)", () => {
    it("resolves to one stand and carries no other farm, customer, or phone", async () => {
      const other = await farmer();
      const { token, farmId, salesLocationId } = await farmer();

      // A customer's stock-out report exists — private data the surface must not surface.
      await sql()`
        insert into stock_out_reports (
          sales_location_id, unlisted_item_text, status, reported_at
        )
        values (${other.salesLocationId}, 'secret customer report', 'open', ${at(2).toISOString()})
      `;

      const resolved = await resolveStandFromToken(database(), token);
      expect(resolved).not.toBeNull();
      /*
        EXACTLY these fields. A projection that grew a farm list, a contact, or a report would
        fail here rather than quietly becoming readable.

        `providerId` is the FIFTH, added by F-114 C.3, and the widening is deliberate: a link
        opens ONE listing, and after C.2 a stand has several. Without it the resolver would
        return "this stand" to a surface that must edit one seller's goods, and a hosted
        seller's bookmarked page would compose against her host's items.

        It discloses nothing new. It is an opaque id for the relationship the link was already
        issued against — the same blast radius the `salesLocationId` beside it already has, one
        level narrower. The four assertions below still bound what it can reach: no other farm,
        no other stand, no customer report, no raw phone.
      */
      expect(Object.keys(resolved ?? {}).sort()).toEqual([
        "authorizationId",
        "farmId",
        "providerId",
        "salesLocationId",
        "senderHash",
      ]);
      expect(resolved?.farmId).toBe(farmId);
      expect(resolved?.salesLocationId).toBe(salesLocationId);

      const serialized = JSON.stringify(resolved);
      expect(serialized).not.toContain(other.farmId);
      expect(serialized).not.toContain(other.salesLocationId);
      expect(serialized).not.toContain("secret customer report");
      // No raw phone number anywhere.
      expect(serialized).not.toMatch(/\+1\d{10}/);
    });

  });

  // ── Revocation: the safety net that makes the rest recoverable ──────────────────────

  describe("revocation bites on the NEXT request", () => {
    it("refuses to propose once the farmer's access is revoked", async () => {
      const { token, authorizationId } = await farmer();

      // Working before.
      const d = deps({
        kind: "edits",
        additions: [{ itemName: "before" }],
        changes: [],
        removals: [],
      });
      expect(
        (await propose(d, token)).outcome,
      ).toBe("proposed");

      await revokeFarmerAuthorization(database(), {
        authorizationId,
        administratorId,
        occurredAt: at(4),
      });

      // Dead on the very next request. Nothing expired; nothing was cached.
      expect(
        (await propose(d, token)).outcome,
      ).toBe("not_authorized");
    });

    it("refuses to publish a proposal opened BEFORE the revocation", async () => {
      // The dangerous window: the farmer (or a leak) had the form open with a live
      // proposal, and VIGA revoked while it sat there.
      const { token, authorizationId, salesLocationId } = await farmer();
      const d = deps({
        kind: "edits",
        additions: [{ itemName: "in flight" }],
        changes: [],
        removals: [],
      });
      const proposed = await propose(d, token);
      expect(proposed.outcome).toBe("proposed");

      await revokeFarmerAuthorization(database(), {
        authorizationId,
        administratorId,
        occurredAt: at(4),
      });

      const result = await confirmFromLink(d, {
        token,
        proposalId: proposed.outcome === "proposed" ? proposed.proposalId : "",
        accept: true,
        confirmationText: "Your stand will show: …",
      });
      expect(result.status).toBe("not_authorized");

      const revisions = await sql()`
        select id from inventory_revisions where sales_location_id = ${salesLocationId}
      `;
      expect(revisions).toHaveLength(0);
    });

    it("refuses everything for a fabricated or malformed token", async () => {
      // The shape check is asserted by EFFECT below rather than only by "returns null": a
      // malformed token returns null whether or not the guard exists, because no row
      // matches its hash. Sabotage caught that — deleting the regex passed the whole suite.
      // What the guard actually buys is that garbage never reaches the driver at all, so
      // the assertion is on the query count.
      for (const token of [
        issueFarmerLinkToken(),
        "not-a-token",
        "",
        "../../etc/passwd",
        "a".repeat(63),
        "A".repeat(64),
      ]) {
        expect(await resolveStandFromToken(database(), token), token).toBeNull();
        expect(
          (await propose(deps({ kind: "clear_all" }), token)).outcome,
          token,
        ).toBe("not_authorized");
      }
    });

    it("rejects a malformed token WITHOUT querying the database at all", async () => {
      // The shape guard's real job. Anything outside the token alphabet and length is not a
      // near-miss to look up, and refusing it in code keeps an absurd path segment from ever
      // reaching the driver. Asserted by counting queries, because "returns null" is true with
      // or without the guard.
      //
      // F-097 widened the shape from 64 hex to base64url spanning 22–64 characters, so the
      // fixtures below are ones that are still outside it: wrong characters, empty, a path
      // traversal, too short to be a credential, and absurdly long. A 64-character run of "A"
      // is no longer malformed — it is a well-formed token that simply matches no row, which
      // the final assertion in this test already covers.
      let queries = 0;
      const counting = {
        ...database(),
        sql: new Proxy(database().sql, {
          apply(target, thisArg, args: unknown[]) {
            queries += 1;
            return Reflect.apply(
              target as unknown as (...a: unknown[]) => unknown,
              thisArg,
              args,
            );
          },
          // `apply` alone counts only TAGGED TEMPLATES. F-114 C.3 made `resolveFarmerLink`
          // compose the shared authority arms, which must go through `.unsafe(…)` — a property
          // call this trap never sees. Counting only templates would leave the final assertion
          // ("a well-formed token DOES reach the database") passing on zero queries, which is
          // exactly the vacuous pass its own comment exists to rule out.
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver) as unknown;
            if (property !== "unsafe" || typeof value !== "function") return value;
            return (...args: unknown[]) => {
              queries += 1;
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          },
        }),
      } as Db;

      for (const token of [
        "not-a-token!",
        "",
        "../../etc/passwd",
        "abc",
        "A".repeat(65),
      ]) {
        expect(await resolveStandFromToken(counting, token), token).toBeNull();
      }
      expect(queries).toBe(0);

      // And a WELL-FORMED token does reach the database — so this is not passing because
      // the resolver never queries anything.
      expect(await resolveStandFromToken(counting, issueFarmerLinkToken())).toBeNull();
      expect(queries).toBeGreaterThan(0);
    });

    it("stops publishing when VIGA withdraws the FARM's approval", async () => {
      // The other half of the pairing. Authorization says who may speak for the farm;
      // approval says whether the farm publishes at all. Both are re-read at the gate.
      const { token, farmId, salesLocationId } = await farmer();
      const d = deps({
        kind: "edits",
        additions: [{ itemName: "unapproved" }],
        changes: [],
        removals: [],
      });
      const proposed = await propose(d, token);

      await sql()`
        update seller_approvals set revoked_at = ${at(4).toISOString()}
        where seller_id = ${farmId} and revoked_at is null
      `;

      const result = await confirmFromLink(d, {
        token,
        proposalId: proposed.outcome === "proposed" ? proposed.proposalId : "",
        accept: true,
        confirmationText: "Your stand will show: …",
      });
      expect(result.status).toBe("refused");
      expect(result.status === "refused" ? result.reason : "").toBe("not_approved");

      const revisions = await sql()`
        select id from inventory_revisions where sales_location_id = ${salesLocationId}
      `;
      expect(revisions).toHaveLength(0);
    });
  });

  describe("one proposal per farmer, whatever the channel", () => {
    it("revises the pending proposal rather than opening a second one", async () => {
      const { token, contactHash } = await farmer();

      for (const item of ["first", "second", "third"]) {
        const d = deps({
            kind: "edits",
            additions: [{ itemName: item }],
            changes: [],
            removals: [],
          });
        await propose(d, token);
      }

      const open = await sql()`
        select id, proposal_version from inventory_publication_proposals
        where sender_hash = ${contactHash} and state = 'open'
      `;
      expect(open).toHaveLength(1);
      expect(open[0]?.proposal_version).toBe(3);
    });

    it("consumes a proposal EXACTLY once — a double submit publishes one revision", async () => {
      const { token, salesLocationId } = await farmer();
      const d = deps({
        kind: "edits",
        additions: [{ itemName: "one only" }],
        changes: [],
        removals: [],
      });
      const proposed = await propose(d, token);
      const proposalId =
        proposed.outcome === "proposed" ? proposed.proposalId : "";

      const first = await confirmFromLink(d, {
        token,
        proposalId,
        accept: true,
        confirmationText:
          proposed.outcome === "proposed" ? proposed.confirmationText : "",
      });
      expect(first.status).toBe("published");

      // The farmer double-clicks, or a leaked link replays the submit.
      const second = await confirmFromLink(d, {
        token,
        proposalId,
        accept: true,
        confirmationText:
          proposed.outcome === "proposed" ? proposed.confirmationText : "",
      });
      expect(second.status).toBe("refused");

      const revisions = await sql()`
        select id from inventory_revisions where sales_location_id = ${salesLocationId}
      `;
      expect(revisions).toHaveLength(1);
    });
  });
});
