import postgres from "postgres";

/*
  F-114 Phase C.1 — RESOLVING THE RETAINED HOSTED NAMES INTO REAL SELLERS.

  `0042` migrated `sales_location_participants` as display-only history and deliberately refused
  to link those names to seller identities:

      "§migration approach forbids linking a display name to a seller identity, and the corpus
       proves why: it holds `Fernhorn Bakery` at Pacific Crest Farm and `Fern Horn Bakery` at
       Tian Tian Farm — almost certainly one bakery, spelled two ways. Matching would either
       merge two stands' relationships on a guess or split one bakery in two. Both fabricate
       authority. These rows migrate as retained history and a VIGA work queue; a person
       resolves each one in Phase C.1."

  This script is that person's decision, written down. **It infers nothing.** Every identity below
  was settled by max on 2026-08-18, including the one the migration could not resolve:

    - "Fernhorn Bakery" (Pacific Crest) and "Fern Horn Bakery" (Tian Tian) are ONE bakery, and
      "Fernhorn" is the correct spelling. So one seller, two arrangements.
    - "Handpicked Homestead" is an EXISTING seller — she already has a live authorization, and
      her own description says her flowers are at Plum Forest Farmstand. Her identity is her own
      word, not a name match, which is why she is linked rather than created.
    - "Gracie's Greens" is a new seller with one arrangement.

  Two rows are deliberately NOT resolved here, because nobody has decided them: "Vashon Island
  Honey Co." at Pacific Crest, and "Kareli Farm" at Provo Farms. They stay as retained history.

  ## Why a script rather than the admin console

  `inviteSellerToStand` mints an invitation and creates a `pending` relationship, which is right
  for a seller who is going to onboard herself and wrong here: nobody is going to redeem a link
  for an arrangement VIGA already knows about, and `pending` is excluded by every public reader,
  so all three would stay off the map indefinitely.

  ## What it writes

  For each entry: a `sellers` row if the seller does not exist, and one `active` `stand_providers`
  row per arrangement, `approval_source = 'viga'` (VIGA is the approver on record) with a NULL
  `approved_by_authorization_id`, as `stand_providers_approval_source_coherent` requires.

  It does NOT retire the participant rows it resolves. Those are history, and `0042` kept them on
  purpose; the public card now credits the real seller, and the display-only row is no longer what
  the map reads.

  ## Running it

  Dry run first. Writes NOTHING and reports exactly what it would do:

      DATABASE_URL='<direct neon url>' npx tsx scripts/resolve-hosted-sellers.ts

  Then, having read that output:

      DATABASE_URL='<direct neon url>' npx tsx scripts/resolve-hosted-sellers.ts --commit

  It PINS the corpus it expects (38 stands, 40 sellers) and refuses anything else, so a mistyped
  connection string fails loudly instead of writing sellers into the wrong database. The pin is
  the state before this script runs; it is not re-pinned afterwards, because a guard edited to
  match whatever the database currently holds has stopped being a guard.
*/

interface Arrangement {
  /** The stand's name, exactly as `sales_locations.name` holds it. */
  standName: string;
  /** The retained participant row this resolves, for reporting. */
  retainedName: string;
}

interface Entry {
  /** The canonical seller name (max, 2026-08-18). */
  sellerName: string;
  arrangements: Arrangement[];
}

/**
 * A stand whose self-pointer must be CLEARED, because the stand sells nothing of its own.
 *
 * `0042` gave every stand a self-pointer, including Morgan Hill, and said why it refused to
 * decide otherwise: *"there is NO signal in the data separating 'a venue with no goods of its
 * own' from 'a seller with one stand'. Any rule that tried would be the inference §migration
 * approach forbids. Clearing the pointer is a VIGA decision made in the C.1 work queue."*
 *
 * This is that decision (max, 2026-08-18): Morgan Hill Community Farm Stand is a VENUE. Its
 * "own seller" is the row `0042` described as *"invented to satisfy NOT NULL, asserting
 * something false"* — the fabricated authority the model exists to remove.
 *
 * Clearing it also removes the native `stand_providers` row, which is what suppressed the
 * stand's typed `alsoSellingHere` names: F-118 makes those a FALLBACK, shown only where a stand
 * has no modelled sellers, so one native row hid four real names while replacing none of them.
 */
interface VenueClearing {
  standName: string;
  /** The fabricated seller the pointer names, refused if it is not exactly this. */
  ownSellerName: string;
}

const ENTRIES: Entry[] = [
  {
    sellerName: "Gracie's Greens",
    arrangements: [
      { standName: "Venison Valley Farm & Creamery", retainedName: "Gracie's Greens" },
    ],
  },
  {
    // ONE bakery, two stands, two spellings in the retained rows (max, 2026-08-18).
    sellerName: "Fernhorn Bakery",
    arrangements: [
      { standName: "Tian Tian Farm", retainedName: "Fern Horn Bakery" },
      { standName: "Pacific Crest Farm", retainedName: "Fernhorn Bakery" },
    ],
  },
  {
    // Already a seller with a live authorization; linked, never created.
    sellerName: "Handpicked Homestead",
    arrangements: [
      { standName: "Plum Forest Farm", retainedName: "Handpicked Homestead" },
    ],
  },
];

/**
 * Morgan Hill's four retained names become real sellers (max, 2026-08-18).
 *
 * They inherit the stand's schedule with NO schedule of their own, and that is not a shortcut:
 * `intersectAvailability` already resolves a seller who states nothing to the stand's own
 * season and hours. Writing Morgan Hill's `open_ended` 6/1 dawn-to-dusk onto each of the four
 * would be a second copy of one fact, free to drift the first time the stand's hours change.
 */
const MORGAN_HILL: Entry[] = [
  "Bywater Flower Farm",
  "Bay Laurel Farm",
  "King\u2019s Arms Farm",
  "Rozy Dawg Farm",
].map((name) => ({
  sellerName: name,
  arrangements: [
    { standName: "Morgan Hill Community Farm Stand", retainedName: name },
  ],
}));

ENTRIES.push(...MORGAN_HILL);

/*
  EMPTY, AND NOW DELIBERATELY PERMANENT (2026-08-18).

  `0042` left Morgan Hill's self-pointer as a C.1 decision, describing the seller it names as *"a
  row invented to satisfy NOT NULL, asserting something false"*. Measured before acting on that,
  the row is not what the note assumed:

    - it carries VIGA's own description — *"This is a community farmstand from the neighbors on
      Morgan Hill"* — and 17 `stand_items`, plus one current `source: 'viga'` revision
    - its name is BYTE-IDENTICAL to the stand's, so a customer sees one entity either way
    - the four `sales_location_participants` rows name it through a composite FK with
      `ON DELETE RESTRICT`, so clearing the pointer means re-rooting display-only history

  So clearing it would re-root four history rows and orphan seventeen items and a published
  revision, to change nothing anyone can see. The truthful reading is the simpler one: Morgan Hill
  is a community stand whose goods are POOLED and published by VIGA as one listing — a stand that
  sells things, not a venue that sells nothing. The 17 items ("vegetables", "salad greens", "duck
  eggs", "variety of herbs") are exactly that pooled offering, and no rule could attribute them to
  any of the four named farms.

  The four names render correctly as of B-085 precisely BECAUSE the self-pointer is the only
  modelled seller: the typed fallback shows whenever a stand has no modelled guest. Clearing the
  pointer would not improve that and would risk it.

  If VIGA later wants the four to own their own listings, the path is onboarding them as sellers
  with handsets — not a data edit.
*/
const VENUES: VenueClearing[] = [];

const EXPECTED_STANDS = Number(process.env.EXPECTED_STANDS ?? 38);
/*
  42, not 40: the first run (Gracie's Greens, Fernhorn Bakery) already landed. The pin is the
  state this script expects to FIND, so it moves when a run of this script changes it — and only
  then. It is not re-pinned to whatever the database happens to hold.
*/
const EXPECTED_SELLERS = Number(process.env.EXPECTED_SELLERS ?? 42);

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === "") {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const commit = process.argv.includes("--commit");
  const sql = postgres(databaseUrl, { max: 1 });

  try {
    // FINGERPRINT FIRST. A wrong target fails here, before anything is written.
    const [counts] = await sql`
      select (select count(*)::int from sales_locations) as stands,
             (select count(*)::int from sellers) as sellers`;
    if (counts?.stands !== EXPECTED_STANDS || counts?.sellers !== EXPECTED_SELLERS) {
      console.error(
        `refusing: expected ${EXPECTED_STANDS} stands and ${EXPECTED_SELLERS} sellers, ` +
          `found ${counts?.stands} and ${counts?.sellers}. Wrong database, or the corpus moved.`,
      );
      process.exit(1);
    }
    console.log(`target has ${counts.stands} stands, ${counts.sellers} sellers — fingerprint OK`);
    console.log(commit ? "\nCOMMITTING\n" : "\nDRY RUN — nothing will be written\n");

    let createdSellers = 0;
    let createdProviders = 0;

    for (const entry of ENTRIES) {
      const existing = await sql`select id, name from sellers where name = ${entry.sellerName}`;
      let sellerId = existing[0]?.id as string | undefined;

      if (sellerId === undefined) {
        console.log(`seller "${entry.sellerName}" — would CREATE`);
        if (commit) {
          const [row] = await sql`
            insert into sellers (name) values (${entry.sellerName}) returning id`;
          sellerId = row?.id as string;
        }
        createdSellers += 1;
      } else {
        console.log(`seller "${entry.sellerName}" — exists, linking`);
      }

      for (const arrangement of entry.arrangements) {
        const stands = await sql`
          select id, name from sales_locations where name = ${arrangement.standName}`;
        const stand = stands[0];
        if (stand === undefined) {
          console.error(`  !! no stand named "${arrangement.standName}" — skipping`);
          continue;
        }

        // Already there? The partial unique index is the arbiter, but reporting it is clearer
        // than a silent ON CONFLICT.
        const already = sellerId
          ? await sql`
              select id from stand_providers
              where sales_location_id = ${stand.id} and seller_id = ${sellerId}
                and ended_at is null`
          : [];
        if (already.length > 0) {
          console.log(`  @ ${arrangement.standName} — already an arrangement, leaving it`);
          continue;
        }

        console.log(
          `  @ ${arrangement.standName} — would ADD active arrangement ` +
            `(resolves retained "${arrangement.retainedName}")`,
        );
        createdProviders += 1;

        if (commit && sellerId !== undefined) {
          /*
            `invited_at`/`accepted_at`/`approved_at` all carry the same moment: VIGA is recording
            an arrangement that already exists in the world, not staging one that is about to
            happen. `stand_providers_hosting_lifecycle_coherent` requires all three on an active
            row and `accepted_at >= invited_at`, which one shared timestamp satisfies exactly.

            `approval_source = 'viga'` with a NULL `approved_by_authorization_id`, as
            `stand_providers_approval_source_coherent` requires — only a `host` approval names an
            authorization, and no host vouched for these.
          */
          await sql`
            insert into stand_providers (
              sales_location_id, seller_id, lifecycle_state,
              invited_at, accepted_at, approval_source, approved_at
            ) values (
              ${stand.id}, ${sellerId}, 'active',
              now(), now(), 'viga', now()
            )
            on conflict (sales_location_id, seller_id) where ended_at is null do nothing`;
        }
      }
    }

    /*
      THE VENUE PASS, and it runs LAST for a reason: clearing the self-pointer drops the stand's
      native arrangement, and the four real sellers must already be in place before that happens
      — otherwise the stand spends the gap with no sellers at all and its typed fallback names
      showing again, which is the state this whole change exists to leave behind.
    */
    let clearedVenues = 0;
    for (const venue of VENUES) {
      const stands = await sql`
        select l.id, l.name, l.own_seller_id, s.name as own_seller_name
        from sales_locations l left join sellers s on s.id = l.own_seller_id
        where l.name = ${venue.standName}`;
      const stand = stands[0];
      if (stand === undefined) {
        console.error(`\n!! no stand named "${venue.standName}" — skipping`);
        continue;
      }
      if (stand.own_seller_id === null) {
        console.log(`\n"${venue.standName}" — already a venue, nothing to clear`);
        continue;
      }
      /*
        REFUSES a self-pointer naming anything other than the fabricated row. If VIGA has since
        pointed this stand at a real seller, clearing it would delete a true fact — so the script
        stops rather than guessing which case it is looking at.
      */
      if (stand.own_seller_name !== venue.ownSellerName) {
        console.error(
          `\n!! "${venue.standName}" points at "${stand.own_seller_name}", not ` +
            `"${venue.ownSellerName}" — refusing to clear it`,
        );
        continue;
      }

      const guests = await sql`
        select count(*)::int as n from stand_providers
        where sales_location_id = ${stand.id} and seller_id <> ${stand.own_seller_id}
          and ended_at is null and lifecycle_state = 'active'`;
      const guestCount = guests[0]?.n ?? 0;
      /*
        A venue with no sellers is worse than a stand with a fabricated one: it publishes a place
        selling nothing. The four above must have landed first.
      */
      if (guestCount === 0) {
        console.error(
          `\n!! "${venue.standName}" would be left with NO sellers — refusing to clear it`,
        );
        continue;
      }

      console.log(
        `\n"${venue.standName}" — would CLEAR the self-pointer ` +
          `("${stand.own_seller_name}" is the invented owner row), leaving ${guestCount} real seller(s)`,
      );
      clearedVenues += 1;

      if (commit) {
        /*
          The native arrangement goes first: `sales_locations_own_seller_fk` is ON DELETE
          restrict, and the provider row's composite key names the pointer being cleared. It is
          ENDED rather than deleted — `stand_providers` is a relationship record, and this
          relationship genuinely ended rather than never having existed.
        */
        await sql`
          update stand_providers set ended_at = now(), updated_at = now()
          where sales_location_id = ${stand.id} and seller_id = ${stand.own_seller_id}
            and ended_at is null`;
        await sql`
          update sales_locations set own_seller_id = null, updated_at = now()
          where id = ${stand.id}`;
      }
    }

    console.log(
      `\n${commit ? "wrote" : "would write"}: ${createdSellers} seller(s), ` +
        `${createdProviders} arrangement(s), ${clearedVenues} venue pointer(s) cleared`,
    );
    if (!commit) console.log("re-run with --commit to apply");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(`failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
