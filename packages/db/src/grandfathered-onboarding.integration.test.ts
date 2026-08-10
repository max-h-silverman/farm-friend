import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashFarmerInviteToken, hashPhone } from "@farm-friend/core";
import {
  claimGrandfatheredFarm,
  createDb,
  createFarmerInvitation,
  listClaimableFarms,
  listFarmsForSelfService,
  openFarmerOnboardingRequest,
  readStandListing,
  recordSelfIssuedFarmerClaim,
  revokeFarmerAuthorization,
  saveOnboardingListing,
  type Db,
  type Sql,
} from "./index";

// F-072 — the public "grandfathered" onboarding door.
//
// VIGA's Google form is being replaced by one global Farm Friend link with a farm dropdown, and
// there is NO invitation behind it: max chose the honor system because no phone roster exists to
// verify against (`contacts` holds people who have texted in, not who owns which farm).
//
// So this file owns the one question that keeps that door narrow: **which farms may be claimed,
// and what stops a claim reaching one that may not be?** Two readers answer it and they must
// never disagree — the dropdown is a convenience, and the resolver is the guarantee. A test here
// for each way they could come apart.
//
// "Claimable" is deliberately the SAME predicate `listFarmsAwaitingOnboarding` uses (F-071): the
// absence of a live farmer authorization. Keying on an unredeemed invitation instead would strand
// a farm VIGA authorized straight from the queue, and would miss a farm whose only farmer was
// revoked.

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("grandfathered farm claims (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let db: Db | undefined;
  let databaseName = "";
  let administratorId = "";

  // Clock-derived, never a date literal (B-003 tripwire).
  const now = new Date(Date.now() - 60 * 60 * 1000);
  const later = (ms: number) => new Date(now.getTime() + ms);
  const sql = () => client as Sql;
  const database = () => db as Db;

  async function farm(name: string): Promise<string> {
    const rows = await sql()`insert into farms (name) values (${name}) returning id`;
    return rows[0]?.id as string;
  }

  const names = (rows: Array<{ farmName: string }>) => rows.map((row) => row.farmName).sort();

  /**
   * Put a live farmer authorization on a farm, by the real self-serve chain rather than by
   * inserting the row: an invitation naming the farm, agreed to, redeemed from a handset.
   * Using the real path means these tests break if that chain stops producing authorizations.
   */
  async function onboardFarmer(farmId: string, phone: string): Promise<void> {
    const invitation = await createFarmerInvitation(database(), {
      farmId,
      channel: "sms",
      administratorId,
      occurredAt: now,
    });
    if (invitation.status !== "created") throw new Error(invitation.status);
    const contactHash = hashPhone(phone, "test-salt");
    await sql()`
      insert into contacts (phone_e164, phone_hash) values (${phone}, ${contactHash})
      on conflict (phone_hash) do nothing
    `;
    await sql()`
      update farmer_invitations set agreed_to_sms_at = ${later(1000).toISOString()}
      where token_hash = ${hashFarmerInviteToken(invitation.token)}
    `;
    const opened = await openFarmerOnboardingRequest(database(), {
      contactHash,
      occurredAt: later(2000),
      invitationToken: invitation.token,
      publicBaseUrl: "https://farmfriend.test",
    });
    if (opened.status !== "opened") throw new Error(opened.status);
    if (opened.authorizationId === null) {
      throw new Error("fixture did not authorize; the self-serve chain changed");
    }
  }

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    databaseName = `ff_grandfathered_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(base, { max: 1 });
    await adminClient.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    client = postgres(url.toString(), { max: 4 });
    await migrate(drizzle(client), { migrationsFolder: migrationsDir });
    db = createDb(url.toString());
    // The fixed launch identity: `administrators_fixed_identity` refuses every other email.
    const admins = await sql()`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', ${now.toISOString()}) returning id
    `;
    administratorId = admins[0]?.id as string;
  }, 120_000);

  afterAll(async () => {
    await db?.close();
    await client?.end();
    if (adminClient) {
      await adminClient.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminClient.end();
    }
  });

  describe("listClaimableFarms", () => {
    it("offers a seeded farm nobody has onboarded", async () => {
      const farmId = await farm("Unclaimed Acres");
      const rows = await listClaimableFarms(database());
      expect(names(rows)).toContain("Unclaimed Acres");
      expect(rows.find((row) => row.farmId === farmId)).toBeDefined();
    });

    it("withdraws a farm once a farmer is authorized for it", async () => {
      const farmId = await farm("Claimed Farm");
      expect(names(await listClaimableFarms(database()))).toContain("Claimed Farm");

      await onboardFarmer(farmId, "+12065550101");

      expect(names(await listClaimableFarms(database()))).not.toContain("Claimed Farm");
    });

    it("offers a farm again once its only farmer is revoked", async () => {
      const farmId = await farm("Revoked Farm");
      await onboardFarmer(farmId, "+12065550102");
      expect(names(await listClaimableFarms(database()))).not.toContain("Revoked Farm");

      const authorizations = await sql()`
        select id from farmer_authorizations where farm_id = ${farmId} and revoked_at is null
      `;
      const revoked = await revokeFarmerAuthorization(database(), {
        authorizationId: authorizations[0]?.id as string,
        administratorId,
        occurredAt: later(10_000),
      });
      expect(revoked.status).toBe("revoked");

      // Nobody can publish for this farm again, so it belongs back on the list — the same
      // reasoning F-071's reader uses.
      expect(names(await listClaimableFarms(database()))).toContain("Revoked Farm");
    });

    it("still offers a farm holding an open invitation nobody redeemed", async () => {
      const farmId = await farm("Invited Farm");
      const invitation = await createFarmerInvitation(database(), {
        farmId,
        channel: "sms",
        administratorId,
        occurredAt: now,
      });
      expect(invitation.status).toBe("created");

      // An invitation is not an authorization. A farmer who was sent a link and never used it
      // still cannot publish, so the grandfather door must remain open to them.
      expect(names(await listClaimableFarms(database()))).toContain("Invited Farm");
    });

    it("carries no token, no hash, and no phone number", async () => {
      await farm("Bare Row Farm");
      const rows = await listClaimableFarms(database());
      const row = rows.find((entry) => entry.farmName === "Bare Row Farm");
      expect(row).toBeDefined();
      // The whole row, not a spot check: a public endpoint must expose the farm and nothing
      // else (Golden Rule #5).
      expect(Object.keys(row as object).sort()).toEqual(["farmId", "farmName"]);
    });

    it("names each farm once however many invitations it has had", async () => {
      const farmId = await farm("Thrice Invited");
      for (const _ of [1, 2, 3]) {
        await createFarmerInvitation(database(), {
          farmId,
          channel: "sms",
          administratorId,
          occurredAt: now,
        });
      }
      const rows = await listClaimableFarms(database());
      expect(rows.filter((row) => row.farmName === "Thrice Invited")).toHaveLength(1);
    });
  });

  describe("readStandListing", () => {
    it("reads back exactly what a listing write stored, so an edit form can prefill", async () => {
      // F-073 — an edit form that cannot show current values makes every edit a retype, and a
      // farmer who only wanted to change their hours would blank their address by omission.
      const farmId = await farm("Prefill Farm");
      const saved = await saveOnboardingListing(database(), {
        farmId,
        standName: "Prefill Stand",
        listing: {
          visitability: "visitable",
          offeringType: "produce",
          publicAddress: "12345 Vashon Highway SW",
          addressPublic: true,
          pricesPublic: false,
          latitude: 47.4471,
          longitude: -122.4594,
          hoursText: "Dawn to dusk",
          paymentMethods: ["Cash", "Venmo"],
          items: [{ name: "Eggs", price: null }, { name: "Flowers", price: null }],
        },
        occurredAt: now,
      });
      if (saved.status !== "saved") throw new Error(saved.status);

      const listing = await readStandListing(database(), {
        salesLocationId: saved.salesLocationId,
      });

      // Asserted as VALUES, not shape: a reader returning the right keys with null values would
      // prefill an empty form and silently erase the listing on the next save.
      expect(listing).toMatchObject({
        standName: "Prefill Stand",
        visitability: "visitable",
        offeringType: "produce",
        publicAddress: "12345 Vashon Highway SW",
        addressPublic: true,
        latitude: 47.4471,
        longitude: -122.4594,
        hoursText: "Dawn to dusk",
      });
      expect(listing?.paymentMethods.sort()).toEqual(["Cash", "Venmo"]);
      // F-090 — items read back as name/price pairs. Sorted by NAME rather than by `.sort()`
      // over objects, which orders by "[object Object]" and would pass for any two items.
      expect(
        [...(listing?.items ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
      ).toEqual([
        { name: "Eggs", price: null },
        { name: "Flowers", price: null },
      ]);
    });

    it("returns null for a stand that does not exist", async () => {
      expect(
        await readStandListing(database(), { salesLocationId: randomUUID() }),
      ).toBeNull();
    });
  });

  describe("listFarmsForSelfService", () => {
    it("names every farm, onboarded or not, and says which is which", async () => {
      const unclaimed = await farm("Picker Unclaimed");
      const claimed = await farm("Picker Claimed");
      await onboardFarmer(claimed, "+12065550104");

      const rows = await listFarmsForSelfService(database());
      expect(rows.find((row) => row.farmId === unclaimed)).toEqual({
        farmId: unclaimed,
        farmName: "Picker Unclaimed",
        onboarded: false,
      });
      expect(rows.find((row) => row.farmId === claimed)).toEqual({
        farmId: claimed,
        farmName: "Picker Claimed",
        onboarded: true,
      });
    });

    it("agrees exactly with the claimable list", async () => {
      // The picker shows both kinds and the claimable list shows one. They state the same rule,
      // so a farm may never be claimable AND onboarded, or absent from both.
      const all = await listFarmsForSelfService(database());
      const claimableIds = new Set(
        (await listClaimableFarms(database())).map((row) => row.farmId),
      );

      for (const row of all) {
        expect(row.onboarded).toBe(!claimableIds.has(row.farmId));
      }
      expect(all.length).toBeGreaterThan(claimableIds.size);
      expect(claimableIds.size).toBeGreaterThan(0);
    });

    it("carries no token, no hash, and no phone number", async () => {
      await farm("Picker Bare Row");
      const rows = await listFarmsForSelfService(database());
      const row = rows.find((entry) => entry.farmName === "Picker Bare Row");
      expect(Object.keys(row as object).sort()).toEqual([
        "farmId",
        "farmName",
        "onboarded",
      ]);
    });
  });

  describe("claimGrandfatheredFarm", () => {
    it("resolves a claimable farm to itself", async () => {
      const farmId = await farm("Resolvable Farm");
      const result = await claimGrandfatheredFarm(database(), { farmId });
      expect(result).toEqual({
        status: "claimable",
        farmId,
        farmName: "Resolvable Farm",
        description: null,
      });
    });

    it("returns the farm's stored paragraph, so the form can offer it back", async () => {
      // The migration door publishes over a farm that ALREADY has a listing, and its prose is
      // what the public card is showing today. Without this the form comes up blank and the
      // farmer's own words are dropped by the save — the one field on that form with nothing
      // else to restore it.
      const farmId = await farm("Prose Farm");
      await sql()`
        update farms set description = ${"We put a sign at the bottom of the driveway."}
        where id = ${farmId}
      `;

      const result = await claimGrandfatheredFarm(database(), { farmId });
      expect(result).toEqual({
        status: "claimable",
        farmId,
        farmName: "Prose Farm",
        description: "We put a sign at the bottom of the driveway.",
      });
    });

    it("REFUSES a farm that already has a farmer, even when asked for directly", async () => {
      const farmId = await farm("Guarded Farm");
      await onboardFarmer(farmId, "+12065550103");

      // The dropdown omits this farm, but omission is not a guarantee — anyone can post the id.
      // This refusal is the guarantee, and it is why the resolver exists at all.
      const result = await claimGrandfatheredFarm(database(), { farmId });
      expect(result).toEqual({ status: "already_onboarded" });
    });

    it("refuses a farm that does not exist", async () => {
      const result = await claimGrandfatheredFarm(database(), { farmId: randomUUID() });
      expect(result).toEqual({ status: "unknown_farm" });
    });

    it("agrees with the dropdown on every farm, in both directions", async () => {
      // The two readers state the same rule twice, so this asserts they cannot drift: every
      // farm the list offers resolves, and every farm it omits refuses.
      const claimable = await listClaimableFarms(database());
      const claimableIds = new Set(claimable.map((row) => row.farmId));
      const allFarms = await sql()`select id from farms`;

      for (const row of allFarms) {
        const farmId = row.id as string;
        const result = await claimGrandfatheredFarm(database(), { farmId });
        if (claimableIds.has(farmId)) {
          expect(result.status).toBe("claimable");
        } else {
          expect(result.status).toBe("already_onboarded");
        }
      }
      // A vacuous pass would prove nothing: this run must have seen both kinds.
      expect(claimableIds.size).toBeGreaterThan(0);
      expect(allFarms.length).toBeGreaterThan(claimableIds.size);
    });
  });

  /*
    F-098 — THE SELF-ISSUED CLAIM, end to end.

    The regression: `JOIN <token>` was removed 2026-08-07 and farm identity moved to a phone the
    farmer states on the onboarding form, matched by a bare START against `pending_phone_hash`.
    That column lives on `farmer_invitations`, a row this door could not write — so a
    grandfathered farmer could publish a listing and then never finish onboarding.

    Run through the REAL chain rather than asserting the row's shape: what matters is not that a
    claim exists, but that the farmer's own START finds it and produces an authorization. A test
    that inserted the row and read it back would pass with the matching path broken.
  */
  describe("a farmer who onboards without an invitation (F-098)", () => {
    it("completes onboarding from their own START, exactly as an invited farmer does", async () => {
      const farmId = await farm("Self Issued Farm");
      const phone = "+12065550199";
      const phoneHash = hashPhone(phone, "test-salt");

      const claimed = await recordSelfIssuedFarmerClaim(database(), {
        farmId,
        phoneE164: phone,
        phoneHash,
        agreedToSms: true,
        pendingStock: [{ itemName: "Eggs", priceText: "$6/dozen" }],
        occurredAt: now,
      });
      expect(claimed.status).toBe("recorded");

      // The farm needs a stand for the link the welcome carries, exactly as the invited door
      // has one — the farmer published their listing before texting.
      await saveOnboardingListing(database(), {
        farmId,
        standName: "Self Issued Stand",
        listing: {
          visitability: "visitable",
          offeringType: "produce",
          publicAddress: "12345 Vashon Highway SW",
          addressPublic: true,
          pricesPublic: true,
          latitude: 47.4471,
          longitude: -122.4594,
          hoursText: "Daylight hours",
          paymentMethods: ["cash"],
          items: [{ name: "Eggs", price: null }],
        },
        occurredAt: later(1000),
      });

      await sql()`
        insert into contacts (phone_e164, phone_hash) values (${phone}, ${phoneHash})
        on conflict (phone_hash) do nothing
      `;

      // The claim is held until the handset proves it. A revision before START would make the
      // public map state a dated fact behind an unverified phone.
      const beforeStart = await sql()`
        select revision.id from inventory_revisions revision
        join sales_locations location on location.id = revision.sales_location_id
        where location.owner_farm_id = ${farmId}
      `;
      expect(beforeStart).toHaveLength(0);

      // The farmer's own START — NO invitation token, which is the whole point: the handset is
      // matched against the claim they stated on the form.
      const opened = await openFarmerOnboardingRequest(database(), {
        contactHash: phoneHash,
        occurredAt: later(2000),
        // The handset is the credential: no token, matched against the claim the farmer
        // stated on the form. This is precisely what `JOIN <token>` used to do by hand.
        pendingPhoneHash: phoneHash,
        publicBaseUrl: "https://farmfriend.test",
      });

      // Narrowed before reading `authorizationId`: the result is a union, and `already_open`
      // has no such property.
      if (opened.status !== "opened") throw new Error(opened.status);
      expect(opened.authorizationId).not.toBeNull();

      const published = await sql()`
        select revision.source, revision.proposal_id, revision.published_by_authorization_id,
               entry.item_name, entry.price_text, entry.sort_order
        from inventory_revisions revision
        join sales_locations location on location.id = revision.sales_location_id
        join inventory_entries entry on entry.inventory_revision_id = revision.id
        where location.owner_farm_id = ${farmId} and revision.is_current
        order by entry.sort_order asc
      `;
      expect(published).toEqual([
        {
          source: "web",
          proposal_id: null,
          published_by_authorization_id: opened.authorizationId,
          item_name: "Eggs",
          price_text: "$6/dozen",
          sort_order: 0,
        },
      ]);

      // The listing-live hand-off is queued, not merely intended.
      const queued = await sql()`
        select body from outbox_work where recipient_hash = ${phoneHash}
      `;
      expect(queued.length).toBeGreaterThan(0);
      expect(String(queued[0]?.body)).toContain("Your listing is live.");
    });

    it("refuses a claim the farmer never agreed to be texted on", async () => {
      const farmId = await farm("Unagreed Farm");
      const phone = "+12065550198";

      const claimed = await recordSelfIssuedFarmerClaim(database(), {
        farmId,
        phoneE164: phone,
        phoneHash: hashPhone(phone, "test-salt"),
        agreedToSms: false,
        occurredAt: now,
      });

      expect(claimed.status).toBe("invalid");
      const rows = await sql()`
        select id from farmer_invitations where farm_id = ${farmId}
      `;
      expect(rows).toHaveLength(0);
    });

    it("supersedes the farm's own open claim rather than racing a second handset", async () => {
      // Two claims naming one farm would let the newest handset win a race the farmer never
      // knew they were in. The second submission replaces the first.
      const farmId = await farm("Resubmitted Farm");
      const first = "+12065550197";
      const second = "+12065550196";

      for (const phone of [first, second]) {
        const claimed = await recordSelfIssuedFarmerClaim(database(), {
          farmId,
          phoneE164: phone,
          phoneHash: hashPhone(phone, "test-salt"),
          agreedToSms: true,
          occurredAt: now,
        });
        expect(claimed.status).toBe("recorded");
      }

      const open = await sql()`
        select pending_phone_e164 from farmer_invitations
        where farm_id = ${farmId} and redeemed_at is null
      `;
      expect(open).toHaveLength(1);
      expect(open[0]?.pending_phone_e164).toBe(second);
    });
  });
});
