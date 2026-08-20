import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type { Sql } from "./sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  planOfferings,
  seedOfferings,
  seedReviewedCorpus,
  seedStands,
  type SeedStandInput,
} from "./seed";

// B-002 — the seeder, proven against real constraints.
//
// The invariants under test are the ones that would be invisible in a unit test with a fake
// database: that zero inventory is STRUCTURAL rather than merely omitted, that re-running
// changes nothing, and that a bad row is refused by the database rather than coerced into it.

const migrationsDir = resolve(process.cwd(), "packages/db", "drizzle");

function requiredDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required; a skipped integration run is not green");
  }
  return url;
}

function testDatabaseUrl(baseUrl: string, name: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

describe("seeding VIGA's stands (B-002)", () => {
  let adminClient: Sql;
  let client: Sql;
  let testDatabaseName: string;

  beforeAll(async () => {
    const baseUrl = requiredDatabaseUrl();
    testDatabaseName = `farm_friend_seed_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(baseUrl, { max: 1 });
    await adminClient.unsafe(`create database "${testDatabaseName}"`);
    client = postgres(testDatabaseUrl(baseUrl, testDatabaseName), { max: 1 });
    await migrate(drizzle(client), { migrationsFolder: migrationsDir });
  }, 30_000);

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
    if (adminClient && testDatabaseName) {
      await adminClient.unsafe(`drop database if exists "${testDatabaseName}" with (force)`);
      await adminClient.end({ timeout: 5 });
    }
  }, 30_000);

  const sample = (): SeedStandInput[] => [
    {
      name: "Alpha Farm",
      place: { address: "1 Example Rd SW", longitude: -122.45, latitude: 47.46 },
      visitability: "visitable",
      offeringType: "produce",
      kind: "farm_stand",
      description: "Open: March to December\nStocking Days: Daily",
      hoursText: "Open: March to December",
      season: { kind: "date_range", startMonth: 3, startDay: 1, endMonth: 12, endDay: 31 },
      openHours: { kind: "dawn_to_dusk" },
      stocking: { cadence: "daily" },
      participants: ["Kareli Farm", "Neighbor Eggs"],
      flags: [],
    },
    {
      name: "Beta Farm",
      place: { address: "2 Example Rd SW", longitude: -122.5, latitude: 47.4 },
      visitability: "visitable",
      offeringType: "produce",
      kind: "farm_stand",
      hoursText: "Open: contradictory",
      season: { kind: "not_stated" },
      openHours: { kind: "not_stated" },
      stocking: { cadence: "not_stated" },
      flags: [
        { reason: "contradictory_hours", sourceText: "two different Open: lines" },
      ],
    },
  ];

  it("creates a farm and a public sales location per stand", async () => {
    const result = await seedStands(client, sample());
    expect(result.seeded).toBe(2);

    const rows = await client`
      select f.name as farm_name, f.description, l.name as location_name, l.public_address,
             l.public_latitude, l.public_longitude, l.is_public
      from sales_locations l join sellers f on f.id = l.own_seller_id
      order by l.name
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.farm_name).toBe("Alpha Farm");
    expect(rows[0]!.description).toBe("Open: March to December\nStocking Days: Daily");
    expect(rows[0]!.is_public).toBe(true);
    expect(Number(rows[0]!.public_longitude)).toBeCloseTo(-122.45, 6);
  });

  it("seeds a contact_only farm with NO pin, against the real constraint (F-038)", async () => {
    // The honesty property the whole join exists to protect. Open Gate Lamb delivers only, and
    // the legacy map export HAS real coordinates for it — seeding them would put a pin on a farm
    // with nothing to buy and no expectation of visitors.
    //
    // Asserted against `sales_locations_coherent_visitability` rather than against the seeder's
    // own bookkeeping: the database is what makes address and coordinates all-or-nothing, so a
    // future change that started copying the map's point through would fail HERE even if every
    // unit test kept passing.
    const result = await seedStands(client, [
      {
        name: "Delivery Only Farm",
        visitability: "contact_only",
        offeringType: "by_order",
        kind: "farm_stand",
        season: { kind: "not_stated" },
        openHours: { kind: "not_stated" },
        stocking: { cadence: "not_stated" },
        flags: [],
      },
    ]);
    expect(result.seeded).toBe(1);

    const rows = await client`
      select visitability, offering_type, public_address, public_latitude, public_longitude,
             is_public
      from sales_locations where name = 'Delivery Only Farm'
    `;
    expect(rows[0]!.visitability).toBe("contact_only");
    expect(rows[0]!.offering_type).toBe("by_order");
    // All three absent TOGETHER — the shape the constraint enforces.
    expect(rows[0]!.public_address).toBeNull();
    expect(rows[0]!.public_latitude).toBeNull();
    expect(rows[0]!.public_longitude).toBeNull();
    // Still discoverable. Not visitable is not the same as not listed.
    expect(rows[0]!.is_public).toBe(true);
  });

  it("REFUSES a coordinate with no address, whatever the visitability", async () => {
    // F-088 narrowed what this asserts, and the narrowing is deliberate.
    //
    // It used to prove that a contact-only farm could carry NOTHING. Since max reopened that
    // (2026-08-07) a contact-only farm may be fully placed — what it may not be is placed
    // without an address, because a bare point is the shape "copy the map export through"
    // produces, and an address is what lets anyone check the point is right.
    //
    // The customer-facing protection moved to where it belongs: the map renders such a farm
    // with its own marker and NO directions link. See the F-088 block below.
    await expect(
      seedStands(client, [
        {
          name: "Incoherent Farm",
          visitability: "contact_only",
          offeringType: "produce",
          // A point with no address: exactly what copying the map export through would produce.
          place: { address: "", longitude: -122.45, latitude: 47.46 },
          kind: "farm_stand",
          season: { kind: "not_stated" },
          openHours: { kind: "not_stated" },
          stocking: { cadence: "not_stated" },
          flags: [],
        },
      ]),
    ).rejects.toThrow();

    const rows = await client`
      select count(*)::integer as count from sales_locations where name = 'Incoherent Farm'
    `;
    expect(rows[0]!.count).toBe(0);
  });

  // ── F-088: every farm may be placed, including one with no stand to visit ──────────────
  //
  // F-038 bundled two rules into one constraint: a complete location or none, AND nothing at
  // all for a contact-only farm. max reopened the second half (2026-08-07): every farm gives
  // an address and coordinates, and what varies is what the MAP INVITES YOU TO DO.
  //
  // The original defect is not reintroduced, because it was never the coordinate — it was the
  // UNLABELLED coordinate. A contact-only farm now renders with its own marker kind
  // ("Farm, no stand", already built and until now unreachable), a card that says there is no
  // stand to visit, and NO directions link. A pin that says "do not drive here" does not send
  // anyone driving.
  //
  // What did NOT relax: half a coordinate pair is still refused in both directions. Latitude
  // alone still puts a pin in the ocean, and that has nothing to do with visitability.

  it("ACCEPTS a contact_only farm with a full location (F-088)", async () => {
    await client`
      insert into sales_locations
        (own_seller_id, kind, name, timezone, visitability, offering_type, public_address,
         public_latitude, public_longitude, is_public, created_at, updated_at)
      values
        ((select id from sellers limit 1), 'farm_stand', 'Placed Delivery Farm', 'America/Los_Angeles',
         'contact_only', 'by_order', '12345 Vashon Highway SW', 47.4471, -122.4594, true, now(), now())
    `;

    const rows = await client`
      select public_address, public_latitude, public_longitude
      from sales_locations where name = 'Placed Delivery Farm'
    `;
    expect(rows[0]!.public_address).toBe("12345 Vashon Highway SW");
    expect(Number(rows[0]!.public_latitude)).toBeCloseTo(47.4471, 6);
    expect(Number(rows[0]!.public_longitude)).toBeCloseTo(-122.4594, 6);
  });

  it("STILL refuses half a coordinate pair, whatever the visitability (F-088)", async () => {
    // The half that did NOT relax, asserted in both directions. Latitude alone puts a pin in
    // the ocean — a defect about coordinates, not about whether there is a stand.
    for (const visitability of ["visitable", "contact_only"] as const) {
      await expect(
        client`
          insert into sales_locations
            (own_seller_id, kind, name, timezone, visitability, offering_type, public_address,
             public_latitude, public_longitude, is_public, created_at, updated_at)
          values
            ((select id from sellers limit 1), 'farm_stand', ${`Half Pinned ${visitability}`},
             'America/Los_Angeles', ${visitability}, 'produce', '12345 Vashon Highway SW', 47.4471, null,
             true, now(), now())
        `,
      ).rejects.toThrow();
    }
  });

  it("STILL requires a complete location for a VISITABLE stand (F-088)", async () => {
    // "Visitable" without a place to go is a promise the map cannot keep. Unchanged.
    await expect(
      client`
        insert into sales_locations
          (own_seller_id, kind, name, timezone, visitability, offering_type, public_address,
           public_latitude, public_longitude, is_public, created_at, updated_at)
        values
          ((select id from sellers limit 1), 'farm_stand', 'Unplaced Visitable Stand',
           'America/Los_Angeles', 'visitable', 'produce', null, null, null, true, now(), now())
      `,
    ).rejects.toThrow();
  });

  it("seeds ZERO inventory — a seeder cannot fabricate a farmer's confirmation", async () => {
    // The central product invariant (Golden Rule #1/#3). VIGA's export carries dated stock
    // notes, and seeding them would present text nobody confirmed as a farmer's current
    // published inventory. Green Ears' most recent note reads "Closed".
    //
    // This is structural, not merely omitted: `inventory_revisions` requires
    // `published_by_authorization_id` and `farm_approval_id`, neither of which the seeder
    // has or can create.
    const revisions = await client`select count(*)::integer as count from inventory_revisions`;
    expect(revisions[0]!.count).toBe(0);
    const entries = await client`select count(*)::integer as count from inventory_entries`;
    expect(entries[0]!.count).toBe(0);
  });

  it("seeds no farmer authorization or approval, so nothing can publish", async () => {
    const auths = await client`select count(*)::integer as count from farmer_authorizations`;
    expect(auths[0]!.count).toBe(0);
    const approvals = await client`select count(*)::integer as count from seller_approvals`;
    expect(approvals[0]!.count).toBe(0);
  });

  it("stores no contact row at all — no phone, no email", async () => {
    // The export carries 22 emails and 4 phone numbers. None may reach the database.
    const contacts = await client`select count(*)::integer as count from contacts`;
    expect(contacts[0]!.count).toBe(0);
  });

  it("writes structured availability, not just prose", async () => {
    const rows = await client`
      select season_kind, season_start_month, season_end_month, open_hours_kind,
             stocking_cadence
      from sales_locations where name = 'Alpha Farm'
    `;
    expect(rows[0]!.season_kind).toBe("date_range");
    expect(rows[0]!.season_start_month).toBe(3);
    expect(rows[0]!.open_hours_kind).toBe("dawn_to_dusk");
    expect(rows[0]!.stocking_cadence).toBe("daily");
  });

  it("raises a stand_data_flag for a contradiction instead of picking a reading", async () => {
    const flags = await client`
      select reason, source_text, resolved_at from stand_data_flags
    `;
    expect(flags).toHaveLength(1);
    expect(flags[0]!.reason).toBe("contradictory_hours");
    expect(flags[0]!.resolved_at).toBeNull();
  });

  it("is IDEMPOTENT — re-running seeds nothing new and duplicates no flag", async () => {
    const before = await client`select count(*)::integer as count from sales_locations`;
    const result = await seedStands(client, sample());
    const after = await client`select count(*)::integer as count from sales_locations`;

    expect(after[0]!.count).toBe(before[0]!.count);
    expect(result.seeded).toBe(0);
    expect(result.skipped).toBe(2);

    // The partial unique index permits one OPEN flag per (location, reason); a second run
    // must not pile up a duplicate copy of the same unresolved question.
    const flags = await client`select count(*)::integer as count from stand_data_flags`;
    expect(flags[0]!.count).toBe(1);
  });

  it("REFUSES a constraint violation rather than coercing the value", async () => {
    // An out-of-range coordinate must abort, not get clamped into the valid envelope. A
    // clamped coordinate is a stand at the wrong place, which is worse than no stand.
    await expect(
      seedStands(client, [
        {
          ...sample()[0]!,
          name: "Bad Coordinate Farm",
          place: { address: "3 Example Rd SW", longitude: -122.45, latitude: 991 },
        },
      ]),
    ).rejects.toThrow();

    const rows = await client`
      select count(*)::integer as count from sales_locations where name = 'Bad Coordinate Farm'
    `;
    expect(rows[0]!.count).toBe(0);
  });

  it("rolls back the whole batch, leaving no half-seeded stand", async () => {
    const before = await client`select count(*)::integer as count from sales_locations`;
    await expect(
      seedStands(client, [
        {
          ...sample()[0]!,
          name: "Good Farm",
          place: { address: "4 Example Rd SW", longitude: -122.45, latitude: 47.46 },
        },
        {
          ...sample()[0]!,
          name: "Doomed Farm",
          place: { address: "5 Example Rd SW", longitude: -122.45, latitude: 991 },
        },
      ]),
    ).rejects.toThrow();

    const after = await client`select count(*)::integer as count from sales_locations`;
    expect(after[0]!.count).toBe(before[0]!.count);
    const good = await client`
      select count(*)::integer as count from sales_locations where name = 'Good Farm'
    `;
    expect(good[0]!.count).toBe(0);
  });

  it("makes a seeded stand visible on the public map with NO recency claim", async () => {
    // B-013's reader property, end to end: a stand nobody has confirmed must appear, and
    // must carry no `updated`/`stale` label, because there is no confirmation to date.
    const rows = await client`
      select l.name,
             (select count(*)::integer from inventory_revisions r
               where r.sales_location_id = l.id) as revisions
      from sales_locations l where l.name = 'Alpha Farm'
    `;
    expect(rows[0]!.revisions).toBe(0);
  });

  // GL-015 — backfilling VIGA's side facts onto a stand that already exists.
  //
  // The gap this closes, found by running F-064's ingest against production (2026-08-07):
  // every stand already existed, so the loader skipped all 35 and wrote nothing. Links, hosts
  // and most payment methods stayed empty, and an insert-only loader had no way to add them —
  // it can create a stand or leave it alone, and nothing in between.
  //
  // The rehearsal did not catch it because it ran from an EMPTY schema, where every stand is
  // an insert. Same code, same CSVs, opposite outcome.
  describe("backfilling side facts onto an existing stand (GL-015)", () => {
    it("adds links, payments and hosts to a stand it did not create", async () => {
      // The stand exists with none of them; a re-run supplies what VIGA now states.
      const before = await client`
        select
          (select count(*)::integer from seller_links) as links,
          (select count(*)::integer from seller_payment_methods) as payments
      `;
      expect(before[0]!.links).toBe(0);

      const [alpha] = sample();
      await seedStands(client, [
        {
          ...alpha!,
          links: [{ label: "Website", url: "https://alpha.example" }],
          paymentMethods: ["Cash", "Venmo"],
          participants: ["Kareli Farm", "Neighbor Eggs"],
        },
      ]);

      const rows = await client`
        select
          (select count(*)::integer from seller_links) as links,
          (select count(*)::integer from seller_payment_methods) as payments,
          (select count(*)::integer from sales_location_participants) as hosts
      `;
      expect(rows[0]!.links).toBe(1);
      expect(rows[0]!.payments).toBe(2);
      expect(rows[0]!.hosts).toBe(2);
    });

    it("NEVER touches the stand's own listing fields, only the empty side tables", async () => {
      // The reason the loader was insert-only in the first place, and it still holds: a
      // farmer's corrected hours must survive a re-run of VIGA's older export. Backfill adds
      // facts to empty side tables; it does not restate the listing.
      const original = await client`
        select public_address, season_kind, open_hours_kind, stocking_cadence
        from sales_locations where name = 'Alpha Farm'
      `;

      await seedStands(client, [
        {
          ...sample()[0]!,
          place: { address: "999 Rewritten Rd SW", longitude: -122.44, latitude: 47.47 },
          season: { kind: "not_stated" },
          openHours: { kind: "by_appointment" },
          stocking: { cadence: "as_needed" },
          links: [{ label: "Website", url: "https://alpha.example" }],
        },
      ]);

      const after = await client`
        select public_address, season_kind, open_hours_kind, stocking_cadence
        from sales_locations where name = 'Alpha Farm'
      `;
      expect(after[0]).toEqual(original[0]);
    });

    it("REFUSES to backfill a stand whose farmer holds a live authorization", async () => {
      // The safety property. Once a farmer is authorized they own the listing (golden rule #1),
      // and VIGA's spreadsheet must not add to it behind their back — they may have deliberately
      // removed a payment method or a host that the older export still names.
      const location = await client`
        select l.id, l.own_seller_id from sales_locations l where l.name = 'Beta Farm'
      `;
      const contact = await client`
        insert into contacts (phone_e164, phone_hash)
        values ('+12065550111', ${`hash-${randomUUID()}`})
        returning id
      `;
      await client`
        insert into farmer_authorizations (
          seller_id, contact_id, phone_verified_at, authorized_at
        )
        values (
          ${location[0]!.own_seller_id as string}, ${contact[0]!.id as string}, now(), now()
        )
      `;

      const result = await seedStands(client, [
        {
          ...sample()[1]!,
          links: [{ label: "Website", url: "https://beta.example" }],
          paymentMethods: ["Cash"],
        },
      ]);

      expect(result.backfillRefused).toBe(1);
      const rows = await client`
        select count(*)::integer as count from seller_links
        where seller_id = ${location[0]!.own_seller_id as string}
      `;
      expect(rows[0]!.count).toBe(0);
    });

    it("adds only what is MISSING, leaving an existing value alone", async () => {
      // Idempotent and additive: a second run must not duplicate a link or resurrect a payment
      // method someone removed. `on conflict do nothing` is the arbiter, per row.
      await seedStands(client, [
        {
          ...sample()[0]!,
          links: [{ label: "Website", url: "https://alpha.example" }],
          paymentMethods: ["Cash", "Venmo"],
        },
      ]);
      const rows = await client`
        select
          (select count(*)::integer from seller_links) as links,
          (select count(*)::integer from seller_payment_methods) as payments
      `;
      expect(rows[0]!.links).toBe(1);
      expect(rows[0]!.payments).toBe(2);
    });
  });

  // F-064 — host sellers from VIGA's records, the third table that had a schema, a reader, and
  // no writer. The public card's "Also selling here" section and the admin table's "Other
  // sellers here" row have both existed since F-050 and both rendered nothing.
  describe("seeding hosted participants", () => {
    it("writes host names as VIGA-sourced, with NO fabricated confirmation", async () => {
      const rows = await client`
        select p.display_name, p.source, p.confirmed_by_authorization_id
        from sales_location_participants p
        join sales_locations l on l.id = p.sales_location_id
        where l.name = 'Alpha Farm'
        order by p.display_name
      `;
      expect(rows.map((row) => row.display_name)).toEqual(["Kareli Farm", "Neighbor Eggs"]);
      // The whole point of the migration: VIGA's spreadsheet is not a farmer's confirmation,
      // and the row says so rather than pointing at an invented authorization.
      expect(rows.every((row) => row.source === "viga")).toBe(true);
      expect(rows.every((row) => row.confirmed_by_authorization_id === null)).toBe(true);
    });

    it("REFUSES a row claiming a farmer confirmed it with no authorization", async () => {
      // The guarantee is the database's, not the loader's. A CHECK passes on NULL, so this
      // asserts the biconditional actually refuses the half-populated row rather than
      // admitting it — the failure mode a per-column rule would have shipped.
      const location = await client`
        select id, own_seller_id from sales_locations where name = 'Alpha Farm'
      `;
      await expect(
        client`
          insert into sales_location_participants (
            owner_seller_id, sales_location_id, display_name, source, confirmed_at
          )
          values (
            ${location[0]!.own_seller_id as string}, ${location[0]!.id as string},
            'Fabricated Farm', 'sms', now()
          )
        `,
      ).rejects.toThrow(/source_keys_coherent/);
    });

    it("is idempotent — re-running adds no duplicate host", async () => {
      // Re-seeding is routine (a corrected row, a new stand), and a duplicate would render the
      // same seller twice under "Also selling here".
      await seedStands(client, sample());
      const rows = await client`
        select count(*)::integer as count
        from sales_location_participants p
        join sales_locations l on l.id = p.sales_location_id
        where l.name = 'Alpha Farm'
      `;
      expect(rows[0]!.count).toBe(2);
    });
  });

  // F-024/F-036 — committing HUMAN-APPROVED offering tags. The model only ever proposed
  // them; this loader is the "code commits what was approved" half, and it writes
  // specialties, never inventory — the same structural separation the stand seeder proves.
  describe("seeding approved offerings", () => {
    it("restores stands and their reviewed usual offerings as one corpus", async () => {
      const stand: SeedStandInput = {
        ...sample()[0]!,
        name: "Corpus Farm",
        place: { address: "30 Example Rd SW", longitude: -122.45, latitude: 47.46 },
      };

      const result = await seedReviewedCorpus(client, [stand], [
        { standName: "Corpus Farm", items: ["eggs", "bok choy"] },
      ]);

      expect(result.stands.seeded).toBe(1);
      expect(result.offerings.inserted).toBe(2);
      const rows = await client`
        select item.display_name
        from stand_items item
        join sales_locations location on location.id = item.sales_location_id
        where location.name = 'Corpus Farm' and item.usually_carried
        order by item.sort_order
      `;
      expect(rows.map((row) => row.display_name)).toEqual(["eggs", "bok choy"]);
    });

    it("rolls the stands back when their reviewed offerings cannot be attributed", async () => {
      const { participants: _participants, ...base } = sample()[0]!;
      const stands: SeedStandInput[] = [
        {
          ...base,
          name: "Corpus Twin Stand",
          place: { address: "31 Example Rd SW", longitude: -122.45, latitude: 47.46 },
        },
        {
          ...base,
          name: "The Corpus Twin Farm",
          place: { address: "32 Example Rd SW", longitude: -122.45, latitude: 47.46 },
        },
      ];

      await expect(
        seedReviewedCorpus(client, stands, [
          { standName: "Corpus Twin", items: ["plums"] },
        ]),
      ).rejects.toThrow(/ambiguous/i);

      const rows = await client`
        select count(*)::integer as count
        from sales_locations
        where name in ('Corpus Twin Stand', 'The Corpus Twin Farm')
      `;
      expect(rows[0]?.count).toBe(0);
    });

    it("commits approved tags for a known stand, in review order", async () => {
      const result = await seedOfferings(client, [
        { standName: "Alpha Farm", items: ["eggs", "bok choy", "cut flowers"] },
      ]);
      expect(result.inserted).toBe(3);
      expect(result.unknownStands).toEqual([]);

      const rows = await client`
        select o.display_name as item, o.sort_order
        from stand_items o
        join sales_locations l on l.id = o.sales_location_id
        where l.name = 'Alpha Farm'
        order by o.sort_order
      `;
      expect(rows.map((row) => row.item)).toEqual(["eggs", "bok choy", "cut flowers"]);
      expect(rows.map((row) => row.sort_order)).toEqual([0, 1, 2]);
    });

    it("is idempotent and never rewrites an existing tag set", async () => {
      const result = await seedOfferings(client, [
        { standName: "Alpha Farm", items: ["eggs", "raspberries"] },
      ]);
      // "eggs" already exists and is left alone; only the genuinely new tag lands.
      expect(result.inserted).toBe(1);
      expect(result.skipped).toBe(1);

      const rows = await client`
        select count(*)::integer as count
        from stand_items o
        join sales_locations l on l.id = o.sales_location_id
        where l.name = 'Alpha Farm'
      `;
      expect(rows[0]!.count).toBe(4);
    });

    it("REFUSES to restore VIGA offerings over a farmer-owned listing", async () => {
      // Beta received a live authorization in the side-fact test above. The complete corpus
      // restore now includes reviewed offerings, so the same ownership boundary must cover
      // them: an old artifact cannot add back an item the farmer deliberately removed.
      const result = await seedOfferings(client, [
        { standName: "Beta Farm", items: ["lamb"] },
      ]);

      expect(result.refusedStands).toEqual(["Beta Farm"]);
      expect(result.inserted).toBe(0);
      const rows = await client`
        select count(*)::integer as count
        from stand_items item
        join sales_locations location on location.id = item.sales_location_id
        where location.name = 'Beta Farm'
      `;
      expect(rows[0]?.count).toBe(0);
    });

    it("reports the same farmer-owned refusal in the dry run", async () => {
      const plan = await planOfferings(client, [
        { standName: "Beta Farm", items: ["lamb"] },
      ]);

      expect(plan.matched).toEqual([]);
      expect(plan.unknownStands).toEqual([]);
      expect(plan.refusedStands).toEqual(["Beta Farm"]);
    });

    it("RAISES the standing state on an item that exists only from a confirmation", async () => {
      // F-066, and a gap a sabotage found: with one item vocabulary, an item can already exist
      // WITHOUT being a standing claim — the 0020 backfill creates exactly that for every name
      // a past revision confirmed, and so does any weekly-form ingest.
      //
      // A plain `on conflict do nothing` looks correct and silently drops the approved tag: the
      // row is there, so nothing is inserted, and `usually_carried` stays false forever. The
      // stand then never shows what it usually sells for that item, with no error anywhere.
      const location = await client`
        select id from sales_locations where name = 'Alpha Farm'
      `;
      const locationId = location[0]?.id as string;

      // The state a confirmation leaves behind: the item exists, but is no standing claim.
      await client`
        insert into stand_items (sales_location_id, provider_id, display_name, usually_carried, sort_order)
        values (${locationId}, (select id from stand_providers
          where sales_location_id = ${locationId} and seller_id = (select own_seller_id from sales_locations where id = ${locationId})), 'Rhubarb', false, 0)
      `;

      const result = await seedOfferings(client, [
        { standName: "Alpha Farm", items: ["rhubarb"] },
      ]);
      expect(result.inserted).toBe(1);

      // One item still — matched case-insensitively — and it is NOW a standing claim.
      const rows = await client`
        select display_name, usually_carried from stand_items
        where sales_location_id = ${locationId}
          and lower(btrim(display_name, E' \t\r\n')) = 'rhubarb'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.usually_carried).toBe(true);
      // The farmer's stored casing is untouched: a re-run raises the flag, it does not rewrite
      // words someone may have edited.
      expect(rows[0]?.display_name).toBe("Rhubarb");
    });

    it("reports an unknown stand rather than silently dropping or inventing it", async () => {
      // The 3 address-refused stands exist in the CSV but not the database; an approved
      // file naming one must surface that, while known stands still commit.
      const result = await seedOfferings(client, [
        { standName: "No Such Stand", items: ["eggs"] },
        { standName: "Corpus Farm", items: ["lamb"] },
      ]);
      expect(result.unknownStands).toEqual(["No Such Stand"]);
      expect(result.inserted).toBe(1);

      const beta = await client`
        select o.display_name as item from stand_items o
        join sales_locations l on l.id = o.sales_location_id
        where l.name = 'Corpus Farm' and o.display_name = 'lamb'
      `;
      expect(beta.map((row) => row.item)).toEqual(["lamb"]);
    });

    it("writes NO inventory — offerings are specialties, never a confirmation", async () => {
      const revisions = await client`select count(*)::integer as count from inventory_revisions`;
      expect(revisions[0]!.count).toBe(0);
      const entries = await client`select count(*)::integer as count from inventory_entries`;
      expect(entries[0]!.count).toBe(0);
    });
  });

  // F-041 — the approved artifact records the MAP EXPORT's name for each farm, while the seed
  // join stores the FORM's ("Aeggy's" vs. "Aeggy's Farm", "Provo Farm" vs. "Provo Farms",
  // "Fruits Des Vignes" vs. "Fruits des Vignes"). An exact-string lookup reported five of the
  // real corpus's 31 stands as unknown and gave them no tags. The fix is the mechanism that
  // already exists: the join's own `matchStandName` key, one general normalization with two
  // consumers, so the loader is immune to the NEXT naming difference rather than to these five.
  describe("matching an approved stand name to a seeded one (F-041)", () => {
    beforeAll(async () => {
      await seedStands(client, [
        {
          ...sample()[0]!,
          name: "Renamed Farm",
          place: { address: "20 Example Rd SW", longitude: -122.45, latitude: 47.46 },
        },
      ]);
    });

    it("matches through the join's normalization, not an exact string", async () => {
      // "Renamed Farms" differs from the seeded "Renamed Farm" only by a generic plural, the
      // exact shape of the Provo Farm/Provo Farms pair. An exact lookup reports it unknown.
      const result = await seedOfferings(client, [
        { standName: "Renamed Farms", items: ["garlic"] },
      ]);
      expect(result.unknownStands).toEqual([]);
      expect(result.inserted).toBe(1);

      const rows = await client`
        select o.display_name as item from stand_items o
        join sales_locations l on l.id = o.sales_location_id
        where l.name = 'Renamed Farm'
      `;
      expect(rows.map((row) => row.item)).toEqual(["garlic"]);
    });

    it("matches across a case difference the exact lookup missed", async () => {
      // The real pair: the artifact says "Fruits Des Vignes Farm", the database holds
      // "Fruits des Vignes Farm". Nothing but capitalization separates them.
      const result = await seedOfferings(client, [
        { standName: "RENAMED farm", items: ["shallots"] },
      ]);
      expect(result.unknownStands).toEqual([]);
      expect(result.inserted).toBe(1);
    });

    it("still reports a genuinely unknown stand rather than matching it loosely", async () => {
      // The refusal must survive the looser key. This is the property the corpus decided:
      // "Lavender Hill Farm" and "Flora Hill Farm" are distinct sellers, and a matcher permissive
      // enough to join them would publish one farm's tags under another's name.
      const result = await seedOfferings(client, [
        { standName: "Lavender Hill Farm", items: ["lavender"] },
      ]);
      expect(result.unknownStands).toEqual(["Lavender Hill Farm"]);
      expect(result.inserted).toBe(0);
    });

    it("REFUSES an ambiguous name rather than picking one of the candidates", async () => {
      // Two seeded stands reducing to one key make the choice arbitrary and order-dependent.
      // Committing either one silently files a farm's tags under a stranger's listing, so the
      // whole batch is refused — the same stance the join takes on a duplicate export name.
      // `participants` is dropped deliberately: this pair is deleted at the end of the test, and
      // a participant row references the location, so an inherited host would block that cleanup
      // behind a foreign key — leaking the ambiguity the cleanup exists to remove.
      const { participants: _participants, ...twinnable } = sample()[0]!;
      await seedStands(client, [
        {
          ...twinnable,
          name: "Twinned Stand",
          place: { address: "21 Example Rd SW", longitude: -122.45, latitude: 47.46 },
        },
        {
          ...twinnable,
          name: "The Twinned Farm",
          place: { address: "22 Example Rd SW", longitude: -122.45, latitude: 47.46 },
        },
      ]);

      await expect(
        seedOfferings(client, [{ standName: "Twinned", items: ["plums"] }]),
      ).rejects.toThrow(/ambiguous/i);

      // Nothing landed for either candidate — a refused batch writes nothing at all.
      const rows = await client`
        select count(*)::integer as count from stand_items o
        join sales_locations l on l.id = o.sales_location_id
        where l.name in ('Twinned Stand', 'The Twinned Farm')
      `;
      expect(rows[0]!.count).toBe(0);

      // Remove the colliding pair before leaving. An ambiguity is a whole-DATABASE property, not
      // a per-call one, so a pair left behind makes EVERY later call in this suite throw — which
      // is exactly what it did, failing the dry-run test below and looking like a defect in the
      // dry run rather than a leaked fixture.
      await client`delete from sales_locations where name in ('Twinned Stand', 'The Twinned Farm')`;
    });

    it("reports what each approved entry resolves to, for review before the real run", async () => {
      // The dry-run acceptance criterion: `--dry-run` must state what WOULD land, which means
      // resolving names against the real database while writing nothing. A dry run that only
      // echoes the file back cannot show the five unknown stands it is there to reveal.
      const before = await client`
        select count(*)::integer as count from stand_items
      `;
      const plan = await planOfferings(client, [
        { standName: "Renamed Farms", items: ["garlic", "leeks"] },
        { standName: "Lavender Hill Farm", items: ["lavender"] },
      ]);

      expect(plan.unknownStands).toEqual(["Lavender Hill Farm"]);
      expect(plan.matched).toEqual([
        { standName: "Renamed Farms", locationName: "Renamed Farm", newItems: ["leeks"], existingItems: ["garlic"] },
      ]);

      const after = await client`
        select count(*)::integer as count from stand_items
      `;
      expect(after[0]!.count).toBe(before[0]!.count);
    });
  });
});
