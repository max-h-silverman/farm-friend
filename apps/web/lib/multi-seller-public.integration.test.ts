import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "@farm-friend/core";
import { createDb, openOrReviseProposal, type Db, type Sql } from "@farm-friend/db";
import { listPublicStands, serializePublicStand } from "./public-listing";
import { standCardSellerGroups } from "./stand-card-sellers";
import { standListingLines } from "./map-view";

/*
  F-114 Phase C.5 — WHAT A CUSTOMER SEES WHEN TWO SELLERS SHARE A STAND.

  This is the surface test. `stand-provider-facts.integration.test.ts` proves the reader; this
  proves that the public map's payload actually carries what the reader returns, and that the
  card built from it says the right thing.

  ## Why a surface test and not only a reader test

  DEVELOPMENT.md §gotchas: *"A test that asserts through the ADMIN reader proves nothing about
  what customers see."* The same applies one level down — a correct reader wired into nothing,
  or wired in beside the old stand-wide query, leaves the map exactly as wrong as before with
  the reader's own suite fully green. So every assertion here goes through `listPublicStands`
  and `serializePublicStand`, which is what the page and `GET /api/public/stands` both call.

  ## The fixture

  Venison Valley Stand: Kelsey's own listing (venison, confirmed recently) and Gracie's Greens
  hosted beside it (salad greens, confirmed three weeks ago, and one usual item nobody has
  confirmed). Two sellers, two prices, two freshnesses — the shape every collapsing bug shows
  up in.
*/

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");

describe("multi-seller public surface (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let db: Db | undefined;
  let databaseName = "";

  let standId = "";
  let hostSellerId = "";
  let hostProviderId = "";
  let guestSellerId = "";
  let guestProviderId = "";

  const NOW = new Date("2026-08-16T18:00:00Z");
  const hoursAgo = (hours: number): Date =>
    new Date(NOW.getTime() - hours * 60 * 60 * 1000);
  const sql = (): Sql => client as Sql;
  const database = (): Db => db as Db;
  const deps = () => ({ db: database(), clock: new FixedClock(NOW) });

  const publish = async (input: {
    providerId: string;
    sellerId: string;
    publishedAt: Date;
    items: { itemName: string; priceText?: string }[];
  }): Promise<void> => {
    const revisions = await sql()`
      insert into inventory_revisions (
        sales_location_id, provider_id, seller_id, published_at, is_current, source
      ) values (
        ${standId}, ${input.providerId}, ${input.sellerId},
        ${input.publishedAt}, true, 'viga'
      ) returning id
    `;
    const revisionId = revisions[0]?.id as string;
    let sortOrder = 0;
    for (const item of input.items) {
      await sql()`
        insert into inventory_entries (
          inventory_revision_id, sales_location_id, item_name, price_text, sort_order
        ) values (
          ${revisionId}, ${standId}, ${item.itemName}, ${item.priceText ?? null}, ${sortOrder}
        )
      `;
      sortOrder += 1;
    }
  };

  const findStand = async () => {
    const stands = await listPublicStands(deps());
    const stand = stands.find((candidate) => candidate.factId === standId);
    expect(stand).toBeDefined();
    return serializePublicStand(stand!);
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_multiseller_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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
      insert into sellers (name) values ('Venison Valley'), ('Gracies Greens')
      returning id, name
    `;
    hostSellerId = sellers.find((row) => row.name === "Venison Valley")?.id as string;
    guestSellerId = sellers.find((row) => row.name === "Gracies Greens")?.id as string;
    for (const sellerId of [hostSellerId, guestSellerId]) {
      await sql()`
        insert into seller_approvals (seller_id, approved_at) values (${sellerId}, ${hoursAgo(100)})
      `;
    }

    const locations = await sql()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type, is_public,
        prices_public, public_address, public_latitude, public_longitude
      ) values (
        ${hostSellerId}, 'farm_stand', 'Venison Valley Stand', 'America/Los_Angeles',
        'visitable', 'produce', true, true, 'Vashon Hwy, Vashon WA', 47.4473,
        -122.4590
      ) returning id
    `;
    standId = locations[0]?.id as string;

    const own = await sql()`
      select id from stand_providers
      where sales_location_id = ${standId} and seller_id = ${hostSellerId}
    `;
    hostProviderId = own[0]?.id as string;

    const guest = await sql()`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, host_may_update_stock,
        invited_at, accepted_at, approval_source, approved_at
      ) values (
        ${standId}, ${guestSellerId}, 'active', false,
        ${hoursAgo(100)}, ${hoursAgo(99)}, 'viga', ${hoursAgo(99)}
      ) returning id
    `;
    guestProviderId = guest[0]?.id as string;

    // Kelsey confirmed venison three hours ago; Zoe confirmed salad greens two days ago. The
    // gap is the point: a stand-wide timestamp has to pick one and dates the other wrongly.
    await publish({
      providerId: hostProviderId,
      sellerId: hostSellerId,
      publishedAt: hoursAgo(3),
      items: [{ itemName: "venison", priceText: "$14/lb" }],
    });
    await publish({
      providerId: guestProviderId,
      sellerId: guestSellerId,
      publishedAt: hoursAgo(48),
      items: [{ itemName: "salad greens", priceText: "$5" }],
    });

    // A standing claim nobody has confirmed — the hosted seller's public-on-approval case.
    await sql()`
      insert into stand_items (
        sales_location_id, provider_id, display_name, usually_carried,
        price_amount, price_quantity, price_unit, price_basis, sort_order
      ) values (
        ${standId}, ${guestProviderId}, 'rhubarb', true, '4.00', '1', 'bunch', 'per', 0
      )
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

  it("carries every seller onto the served payload", async () => {
    const payload = await findStand();
    expect(payload.sellers?.map((s) => s.sellerName)).toEqual([
      "Venison Valley",
      "Gracies Greens",
    ]);
  });

  it("dates each seller's goods by that seller's own update", async () => {
    /*
      THE CASE THE WHOLE PHASE EXISTS FOR.

      Kelsey confirmed 3 hours ago; Zoe confirmed 2 days ago. A payload built from the
      stand-wide `is_current` join carries ONE recency for both, and whichever it picks makes
      the other seller's goods look fresher or staler than they are. Asserting the two
      DIFFERENT strings is what a collapsing reader cannot satisfy.
    */
    const payload = await findStand();
    const host = payload.sellers?.find((s) => s.sellerName === "Venison Valley");
    const guest = payload.sellers?.find((s) => s.sellerName === "Gracies Greens");

    expect(host?.cardRecency).toBe("Last updated 3 hours ago");
    expect(guest?.cardRecency).toBe("Last updated 2 days ago");
    expect(host?.cardRecency).not.toBe(guest?.cardRecency);
  });

  it("keeps each seller's items and prices with that seller", async () => {
    const payload = await findStand();
    const host = payload.sellers?.find((s) => s.sellerName === "Venison Valley");
    const guest = payload.sellers?.find((s) => s.sellerName === "Gracies Greens");

    expect(host?.confirmedItems.map((i) => i.itemName)).toEqual(["venison"]);
    expect(host?.confirmedItems[0]?.priceText).toBe("$14/lb");
    expect(guest?.confirmedItems.map((i) => i.itemName)).toEqual(["salad greens"]);
    expect(guest?.confirmedItems[0]?.priceText).toBe("$5");
    // And the ABSENCE of the other seller's goods, which is what a leak would show.
    expect(host?.confirmedItems.map((i) => i.itemName)).not.toContain("salad greens");
    expect(guest?.confirmedItems.map((i) => i.itemName)).not.toContain("venison");
  });

  it("marks only the stand's own seller by the self-pointer", async () => {
    const payload = await findStand();
    expect(
      payload.sellers?.map((s) => [s.sellerName, s.describesOwnStand]),
    ).toEqual([
      ["Venison Valley", true],
      ["Gracies Greens", false],
    ]);
  });

  it("publishes a hosted seller's usual item with a price and no date", async () => {
    const payload = await findStand();
    const guest = payload.sellers?.find((s) => s.sellerName === "Gracies Greens");
    expect(guest?.usualItems).toEqual([{ itemName: "rhubarb", priceText: "$4 / bunch" }]);
    // The type gives a usual item nowhere to carry a date. Asserted as an exact object so a
    // future field that could read as one fails here rather than reaching a customer.
  });

  it("builds a seller-major card from the served payload", async () => {
    const sections = standCardSellerGroups(await findStand());
    const confirmed = sections.find((s) => s.register === "confirmed");

    // Each seller's own block, carrying exactly the items that seller published (F-119).
    expect(confirmed?.sellers.map((s) => s.sellerName)).toEqual([
      "Venison Valley",
      "Gracies Greens",
    ]);
    expect(confirmed?.sellers[0]?.items.map((i) => i.itemName)).toEqual(["venison"]);
    expect(confirmed?.sellers[1]?.items.map((i) => i.itemName)).toEqual(["salad greens"]);

    const usual = sections.find((s) => s.register === "usual");
    expect(usual?.sellers.flatMap((s) => s.items.map((i) => i.itemName))).toEqual(["rhubarb"]);
    // A standing claim is dated by nothing, on the real payload as in the unit suite.
    expect(usual?.sellers.every((s) => s.recency === undefined)).toBe(true);
  });

  it("gives each seller its own block when they carry the same thing", async () => {
    // The shared-item case, on the real surface. Written as its own provider so it does not
    // perturb the fixture the other cases assert against.
    // Supersede FIRST: `inventory_revisions_one_current_per_provider` is a unique index, so a
    // second current revision for one provider is refused rather than accepted and reconciled.
    await sql()`
      update inventory_revisions set is_current = false, superseded_at = ${hoursAgo(2)}
      where provider_id = ${hostProviderId} and is_current
    `;
    await publish({
      providerId: hostProviderId,
      sellerId: hostSellerId,
      publishedAt: hoursAgo(2),
      items: [{ itemName: "eggs", priceText: "$8" }],
    });
    await sql()`
      update inventory_revisions set is_current = false, superseded_at = ${hoursAgo(1)}
      where provider_id = ${guestProviderId} and is_current
    `;
    await publish({
      providerId: guestProviderId,
      sellerId: guestSellerId,
      publishedAt: hoursAgo(1),
      items: [{ itemName: "eggs", priceText: "$7" }],
    });

    const sections = standCardSellerGroups(await findStand());
    const confirmed = sections.find((s) => s.register === "confirmed");

    /*
      TWO SELLERS, ONE ITEM, TWO BLOCKS (F-119). Seller-major prints `eggs` under each seller
      rather than once with both nested — the deliberate tradeoff, and the reason it is not a
      regression is right here: each copy carries THAT seller's price, under a heading carrying
      THAT seller's freshness. The comparison is the point.
    */
    expect(confirmed?.sellers.map((s) => s.sellerName)).toEqual([
      "Venison Valley",
      "Gracies Greens",
    ]);
    expect(confirmed?.sellers.map((s) => s.items.map((i) => i.itemName))).toEqual([
      ["eggs"],
      ["eggs"],
    ]);
    expect(confirmed?.sellers.map((s) => s.items[0]?.priceText)).toEqual(["$8", "$7"]);
    expect(confirmed?.sellers.map((s) => s.recency)).toEqual([
      "Last updated 2 hours ago",
      "Last updated 1 hour ago",
    ]);
    // Both blocks are headed, because two sellers share the section (B-088).
    expect(confirmed?.sellers.every((s) => s.showHeading)).toBe(true);
  });

  describe("a stand shutdown overrides every seller", () => {
    /*
      F-114's open criterion: **a stand shutdown renders nothing itemized, and hosted sellers
      are not notified.** A closed stand is a locked box — whatever any seller published, and
      however fresh, none of it is buyable there.

      ASSERTED ON THE PAYLOAD, not only on the card. `standCardSellerGroups` already refuses to
      itemize under an active closure, but the payload feeds several readers: the compact card
      reads `items`, the search haystack reads `items` and `usuallySells`, and SMS parity reads
      the same fields. Suppressing only in the detail card would leave a closed stand's stock
      answering a produce search and printing on the compact card, with the detail card's own
      suite fully green — DEVELOPMENT.md §gotchas, the admin-reader lesson one level down.
    */
    /*
      A closure revision names the authorization and approval it was published under — the
      stand owner's, by `closure_revisions_guard_arm`. So closing the stand needs the host's
      farmer authorization and VIGA approval to exist, which the fixture creates lazily here
      rather than in `beforeAll`: no other case needs them, and a stand carrying a live
      authorization would change what the other cases are reading.
    */
    const closeStand = async (): Promise<void> => {
      const contacts = await sql()`
        insert into contacts (phone_e164, phone_hash)
        values ('+12065551234', 'closurehosthash0000000000000000000000')
        on conflict (phone_hash) do update set phone_hash = excluded.phone_hash
        returning id
      `;
      const authorizations = await sql()`
        insert into farmer_authorizations (
          seller_id, contact_id, phone_verified_at, authorized_at
        )
        select ${hostSellerId}, ${contacts[0]?.id as string}, ${hoursAgo(100)}, ${hoursAgo(100)}
        where not exists (
          select 1 from farmer_authorizations
          where seller_id = ${hostSellerId} and contact_id = ${contacts[0]?.id as string}
        )
        returning id
      `;
      const authorizationId =
        (authorizations[0]?.id as string | undefined) ??
        ((
          await sql()`
            select id from farmer_authorizations
            where seller_id = ${hostSellerId} and contact_id = ${contacts[0]?.id as string}
          `
        )[0]?.id as string);
      const approvals = await sql()`
        select id from seller_approvals where seller_id = ${hostSellerId}
      `;
      // Through the REAL proposal writer: a closure revision references
      // `inventory_publication_proposals`, and hand-writing one would mean restating the
      // payload shape and version rules the writer owns.
      const proposal = await openOrReviseProposal(database(), {
        senderHash: "closurehosthash0000000000000000000000",
        salesLocationId: standId,
        providerId: hostProviderId,
        closure: { result: "close", closureKind: "temporary", startsOn: "2026-08-10" },
        now: hoursAgo(6),
      });
      await sql()`
        insert into closure_revisions (
          owner_seller_id, sales_location_id, proposal_id, owner_authorization_id,
          owner_approval_id, result, closure_kind, starts_on, published_at, is_current
        ) values (
          ${hostSellerId}, ${standId}, ${proposal.proposalId},
          ${authorizationId}, ${approvals[0]?.id as string},
          'close', 'temporary', '2026-08-10', ${hoursAgo(5)}, true
        )
      `;
    };
    /**
     * Take the closure back down.
     *
     * SUPERSEDED, not deleted: `reject_closure_history_mutation` refuses every delete, because
     * a stand's closure history is as immutable as its inventory. `is_current = false` is what
     * a real reopening does, and `readPublicClosure` reads only the current row — so this is
     * the production path rather than a test-only escape hatch.
     */
    const reopenStand = async (): Promise<void> => {
      await sql()`
        update closure_revisions set is_current = false, superseded_at = ${hoursAgo(4)}
        where sales_location_id = ${standId} and is_current
      `;
    };

    it("empties the itemized payload while the closure is active", async () => {
      await closeStand();
      try {
        const payload = await findStand();
        // The closure itself IS still published — the customer is told the stand is shut.
        expect(payload.closure?.state).toBe("active");
        // And nothing itemized survives it, in either register or either shape.
        expect(payload.items).toEqual([]);
        expect(payload.usuallySells).toEqual([]);
        expect(
          (payload.sellers ?? []).flatMap((seller) => seller.confirmedItems),
        ).toEqual([]);
        expect((payload.sellers ?? []).flatMap((seller) => seller.usualItems)).toEqual([]);
        // No recency either: a date beside a closed stand claims a listing it does not have.
        expect(payload.updated).toBeUndefined();
        expect(standCardSellerGroups(payload)).toEqual([]);
      } finally {
        await reopenStand();
      }
    });

    it("leaves everything itemized once the closure is gone", async () => {
      // The other direction, and what makes the case above falsifiable — without it a reader
      // that returned nothing for every stand would pass.
      const payload = await findStand();
      expect(payload.items.length).toBeGreaterThan(0);
      expect(standCardSellerGroups(payload).length).toBeGreaterThan(0);
    });
  });

  describe("a seller's availability is the INTERSECTION with the stand's", () => {
    /*
      §facts and authority, and the last of F-114's open criteria: *"Provider availability is
      the intersection with the stand's — closed inside an open stand, never open inside a
      closed one."*

      The real case it supports is a hosted seller who takes only cash and locks their box
      before the stand shuts. `intersectAvailability` has decided this since Phase A and had NO
      consumer until now — it was the seam the readers were being moved onto, and this is the
      surface that finally asks it.

      **`unknown` PERMITS.** 5 of 34 production stands state no season and 12 state no hours,
      so a stand that stated nothing has not stated that it is shut and cannot close a seller
      who DID state a schedule. That is the case a naive "both must be open" rule gets wrong.
    */
    /*
      THE SEASON IS SET ALONGSIDE THE HOURS, and it has to be.

      `openNow` answers `unknown` whenever the season is unresolved, BEFORE it looks at the time
      of day — an honest rule (a stand out of season is not open whatever its hours say), and one
      that makes a fixture stating hours alone answer `unknown` for a reason that has nothing to
      do with the intersection. Measured, not assumed: the first version of these cases set hours
      only and every one returned `unknown`.
    */
    const setStandHours = async (input: {
      kind: string | null;
      from?: number | null;
      until?: number | null;
    }): Promise<void> => {
      await sql()`
        update sales_locations
        set season_kind = ${input.kind === null ? null : "year_round"}::season_kind,
            open_hours_kind = ${input.kind}::open_hours_kind,
            open_from_minutes = ${input.from ?? null},
            open_until_minutes = ${input.until ?? null}
        where id = ${standId}
      `;
    };
    const setSellerHours = async (input: {
      providerId: string;
      kind: string | null;
      from?: number | null;
      until?: number | null;
    }): Promise<void> => {
      await sql()`
        update stand_providers
        set season_kind = ${input.kind === null ? null : "year_round"}::season_kind,
            open_hours_kind = ${input.kind}::open_hours_kind,
            open_from_minutes = ${input.from ?? null},
            open_until_minutes = ${input.until ?? null}
        where id = ${input.providerId}
      `;
    };
    const clearHours = async (): Promise<void> => {
      await setStandHours({ kind: null });
      await setSellerHours({ providerId: guestProviderId, kind: null });
    };

    /** NOW is 18:00 UTC — 11:00 in Vashon's summer, so a 9–13 window is open and 14–17 is not. */
    const openState = async (providerId: string): Promise<string | undefined> => {
      const payload = await findStand();
      return (payload.sellers ?? []).find((seller) => seller.providerId === providerId)
        ?.openState;
    };

    it("lets a seller be closed inside an open stand", async () => {
      await setStandHours({ kind: "clock_range", from: 9 * 60, until: 18 * 60 });
      await setSellerHours({
        providerId: guestProviderId,
        kind: "clock_range",
        from: 14 * 60,
        until: 17 * 60,
      });
      try {
        expect(await openState(hostProviderId)).toBe("open");
        // The seller's own window has not started. The STAND is open, and the seller is not.
        expect(await openState(guestProviderId)).toBe("closed");
      } finally {
        await clearHours();
      }
    });

    it("never lets a seller be open inside a closed stand", async () => {
      /*
        THE ONE-DIRECTIONAL HALF, and the one that matters. A stand that is shut is a locked
        box: the seller's own schedule cannot reopen it, however emphatically it says 9-to-13.
        Without this a customer is sent to a locked stand by a line that says "open now".
      */
      await setStandHours({ kind: "clock_range", from: 14 * 60, until: 17 * 60 });
      await setSellerHours({
        providerId: guestProviderId,
        kind: "clock_range",
        from: 9 * 60,
        until: 13 * 60,
      });
      try {
        expect(await openState(guestProviderId)).toBe("closed");
        expect(await openState(guestProviderId)).not.toBe("open");
      } finally {
        await clearHours();
      }
    });

    it("does not let an unstated stand schedule close a seller who stated one", async () => {
      // `unknown` PERMITS. A stand that said nothing has not said it is shut.
      await setStandHours({ kind: null });
      await setSellerHours({
        providerId: guestProviderId,
        kind: "clock_range",
        from: 9 * 60,
        until: 13 * 60,
      });
      try {
        expect(await openState(guestProviderId)).toBe("open");
      } finally {
        await clearHours();
      }
    });

    it("reports unknown for a seller who stated nothing at an unstated stand", async () => {
      // Neither said anything, and "we don't know" is the honest answer — never "closed".
      await clearHours();
      expect(await openState(guestProviderId)).toBe("unknown");
    });

    it("gives a seller who stated nothing the stand's own answer", async () => {
      await setStandHours({ kind: "clock_range", from: 9 * 60, until: 18 * 60 });
      await setSellerHours({ providerId: guestProviderId, kind: null });
      try {
        expect(await openState(guestProviderId)).toBe("open");
        expect(await openState(hostProviderId)).toBe("open");
      } finally {
        await clearHours();
      }
    });
  });

  it("keeps the stand-wide item list agreeing with the per-seller one", async () => {
    /*
      WEB AND SMS MUST AGREE (DEVELOPMENT.md §before you ship). `items` is what the compact card
      and every SMS-parity surface read; `sellers` is what the detail card reads. They are two
      shapes of one fact, and this is the assertion that keeps them from becoming two facts.
    */
    const payload = await findStand();
    // The VOCABULARY must agree, not the multiplicity: two sellers carrying eggs is one entry
    // stand-wide and two nested lines, which is the whole point of the split. What must never
    // happen is an item in one shape and absent from the other.
    const fromSellers = new Set(
      (payload.sellers ?? []).flatMap((seller) =>
        seller.confirmedItems.map((item) => item.itemName),
      ),
    );
    expect(new Set(payload.items.map((item) => item.itemName))).toEqual(fromSellers);
    // And the stand-wide list prints each name ONCE, however many sellers carry it — a
    // duplicate here is the "three Tomatoes rows" defect wearing the compact card's clothes.
    expect(payload.items.map((item) => item.itemName)).toEqual([...fromSellers]);

    // The sentence-shaped lines the SMS surfaces share render the same vocabulary.
    const confirmedLine = standListingLines(payload).find(
      (line) => line.kind === "confirmed",
    );
    expect(new Set(confirmedLine?.items ?? [])).toEqual(fromSellers);
  });
});
