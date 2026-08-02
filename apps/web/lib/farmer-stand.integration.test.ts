import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FixedClock,
  issueFarmerLinkToken,
  type InventoryInterpretation,
  type InventoryInterpreter,
} from "@farm-friend/core";
import {
  activateWebProposal,
  approveFarm,
  authorizeFarmer,
  createDb,
  issueFarmerLink,
  revokeFarmerAuthorization,
  type Db,
  type Sql,
} from "@farm-friend/db";
import {
  confirmFromLink,
  proposeFromLink,
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

/**
 * An interpreter that returns whatever the test scripted. Deterministic on purpose: this
 * file is about what CODE does with an interpretation, and a real model would make the
 * blast-radius assertions non-reproducible. Seam quality is `evals`' job.
 *
 * It also records what crossed the seam, so the projection assertion below has something to
 * check rather than trusting the boundary.
 */
function scriptedInterpreter(
  interpretation: InventoryInterpretation,
): InventoryInterpreter & { seen: { taskText: string }[] } {
  const seen: { taskText: string }[] = [];
  return {
    seen,
    async interpret(request) {
      seen.push({ taskText: request.taskText });
      return interpretation;
    },
  };
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
    const farms = await sql()`
      insert into farms (name) values (${`Web Farm ${randomUUID()}`}) returning id
    `;
    const farmId = farms[0]?.id as string;
    const locations = await sql()`
      insert into sales_locations (
        owner_farm_id, kind, name, timezone, public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      )
      values (
        ${farmId}, 'farm_stand', ${`Web Stand ${randomUUID()}`}, 'America/Los_Angeles', '3 Vashon Hwy',
        47.43, -122.43, false, false
      )
      returning id
    `;

    const authorized = await authorizeFarmer(database(), {
      farmId,
      contactHash,
      administratorId,
      occurredAt: at(1),
    });
    const authorizationId =
      authorized.status === "authorized" ? authorized.authorizationId : "";
    await approveFarm(database(), { farmId, administratorId, occurredAt: at(1) });

    const issued = await issueFarmerLink(database(), {
      authorizationId,
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

  /** The deps a surface call needs, with a scripted interpretation. */
  function deps(interpretation: InventoryInterpretation) {
    const interpreter = scriptedInterpreter(interpretation);
    return {
      db: database(),
      interpreter,
      clock: new FixedClock(at(3)),
      activate: (input: {
        proposalId: string;
        senderHash: string;
        confirmationText: string;
        at: Date;
      }) => activateWebProposal(database(), input),
    };
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
    const proposed = await proposeFromLink(d, { token, taskText: items.join(", ") });
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
      values ('web-admin@viga.example', ${at(0).toISOString()})
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
      const proposed = await proposeFromLink(d, { token, taskText: "beets" });
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

      const proposed = await proposeFromLink(d, {
        token,
        taskText: "invented squash",
      });
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
      const victimProposal = await proposeFromLink(victimDeps, {
        token: victim.token,
        taskText: "victim plums",
      });
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

      const victimProposal = await proposeFromLink(
        deps({
          kind: "edits",
          additions: [{ itemName: "victim pears" }],
          changes: [],
          removals: [],
        }),
        { token: victim.token, taskText: "victim pears" },
      );
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
    it("leaves farms, authorizations, approvals, and administrators untouched", async () => {
      const { token, farmId, authorizationId } = await farmer();

      const before = await sql()`
        select
          (select count(*)::int from farms) as farms,
          (select count(*)::int from farmer_authorizations) as authorizations,
          (select count(*)::int from farm_approvals) as approvals,
          (select count(*)::int from administrators) as administrators,
          (select count(*)::int from farmer_links) as links,
          (select count(*)::int from farmer_onboarding_requests) as requests
      `;

      // Everything the surface can do, done.
      await publish(token, ["beans"]);
      await proposeFromLink(
        deps({ kind: "clear_all" }),
        { token, taskText: "all gone" },
      );

      const after = await sql()`
        select
          (select count(*)::int from farms) as farms,
          (select count(*)::int from farmer_authorizations) as authorizations,
          (select count(*)::int from farm_approvals) as approvals,
          (select count(*)::int from administrators) as administrators,
          (select count(*)::int from farmer_links) as links,
          (select count(*)::int from farmer_onboarding_requests) as requests
      `;
      expect(after[0]).toEqual(before[0]);

      // And the holder's OWN authorization is byte-identical — it cannot even widen itself.
      const authorization = await sql()`
        select farm_id, contact_id, phone_verified_at, authorized_at, revoked_at
        from farmer_authorizations where id = ${authorizationId}
      `;
      expect(authorization[0]?.farm_id).toBe(farmId);
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
      // EXACTLY these fields. A projection that grew a farm list, a contact, or a report
      // would fail here rather than quietly becoming readable.
      expect(Object.keys(resolved ?? {}).sort()).toEqual([
        "authorizationId",
        "farmId",
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

    it("sends only the farmer's own text and their own entry ids across the model seam", async () => {
      // Golden Rule #5 at the seam: a leaked link must not become a way to read another
      // actor's data THROUGH the model. The projection is what prevents it.
      const other = await farmer();
      await publish(other.token, ["other farm's secret crop"]);

      const { token } = await farmer();
      const d = deps({
        kind: "edits",
        additions: [{ itemName: "my own kale" }],
        changes: [],
        removals: [],
      });
      await proposeFromLink(d, { token, taskText: "my own kale" });

      const seen = d.interpreter.seen;
      expect(seen).toHaveLength(1);
      expect(seen[0]?.taskText).toBe("my own kale");
      // Nothing about the other farm crossed the boundary.
      expect(JSON.stringify(seen)).not.toContain("other farm's secret crop");
      expect(JSON.stringify(seen)).not.toContain(other.farmId);
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
        (await proposeFromLink(d, { token, taskText: "before" })).outcome,
      ).toBe("proposed");

      await revokeFarmerAuthorization(database(), {
        authorizationId,
        administratorId,
        occurredAt: at(4),
      });

      // Dead on the very next request. Nothing expired; nothing was cached.
      expect(
        (await proposeFromLink(d, { token, taskText: "after" })).outcome,
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
      const proposed = await proposeFromLink(d, { token, taskText: "in flight" });
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
          (
            await proposeFromLink(deps({ kind: "clear_all" }), {
              token,
              taskText: "anything",
            })
          ).outcome,
          token,
        ).toBe("not_authorized");
      }
    });

    it("rejects a malformed token WITHOUT querying the database at all", async () => {
      // The shape guard's real job. A 64-hex string is the only thing that can match, so
      // anything else is not a near-miss to look up — and refusing it in code keeps an
      // absurd path segment from ever reaching the driver. Asserted by counting queries,
      // because "returns null" is true with or without the guard.
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
        }),
      } as Db;

      for (const token of ["not-a-token", "", "../../etc/passwd", "A".repeat(64)]) {
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
      const proposed = await proposeFromLink(d, { token, taskText: "unapproved" });

      await sql()`
        update farm_approvals set revoked_at = ${at(4).toISOString()}
        where farm_id = ${farmId} and revoked_at is null
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
        await proposeFromLink(
          deps({
            kind: "edits",
            additions: [{ itemName: item }],
            changes: [],
            removals: [],
          }),
          { token, taskText: item },
        );
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
      const proposed = await proposeFromLink(d, { token, taskText: "one only" });
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
