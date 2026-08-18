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

const EXPECTED_STANDS = Number(process.env.EXPECTED_STANDS ?? 38);
const EXPECTED_SELLERS = Number(process.env.EXPECTED_SELLERS ?? 40);

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

    console.log(
      `\n${commit ? "wrote" : "would write"}: ${createdSellers} seller(s), ` +
        `${createdProviders} arrangement(s)`,
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
