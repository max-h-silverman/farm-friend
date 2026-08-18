import postgres from "postgres";

/*
  F-114 C.1 — HANDPICKED HOMESTEAD SELLS ONLY AT PLUM FOREST (max, 2026-08-18).

  She was onboarded with a stand record of her own, and it is the only place her listing has ever
  lived. max confirmed the real-world fact: **she sells hosted at Plum Forest and nowhere else**,
  so a stand of her own asserts a place that does not exist.

  ## Why this republishes rather than re-points

  The obvious move — update the revisions' `provider_id` — is REFUSED by the database, and
  correctly. `guard_inventory_revision_history` is a Golden Rule #1 protection, widened by `0042`
  to cover `provider_id`, and it raises *"published inventory revision history is immutable"* on
  exactly this UPDATE. Probed against production before writing this script.

  That refusal is right, not an obstacle to work around: those two revisions record what she
  published AT HER OWN STAND on 2026-08-11 and 2026-08-17. Re-pointing them would make history
  claim she had published at Plum Forest on those dates, which she had not.

  So this does what a farmer's own update does — supersede and publish anew, following
  `farmer.ts` §supersede first:

    1. Her Plum Forest arrangement gets a NEW revision carrying the same entries ("Flowers"),
       `source = 'viga'`, published now.
    2. Her old stand's current revision is superseded, so the history stays intact and stops
       being current. `inventory_revisions_one_current_per_location` allows one current revision
       per stand, which is why the supersede comes first.

  ## What else moves

  Her operational rows are re-pointed at the Plum Forest arrangement, because those are not
  history — they are live settings that must follow her: the reminder cadence, the standing link,
  the scheduled prompt, and her usual items. Her authorization needs no change at all: it is bound
  to her SELLER, never to the stand.

  ## What is left behind

  The stand record is retired, not deleted: its revisions are history and `sales_locations` is
  referenced by them. Retiring takes it off the map while every published fact it carried stays
  readable.

  Dry run by default. Fingerprints its target and refuses anything else.

      DATABASE_URL='<direct neon url>' npx tsx scripts/move-handpicked-to-plum-forest.ts
      DATABASE_URL='<direct neon url>' npx tsx scripts/move-handpicked-to-plum-forest.ts --commit
*/

const SELLER = "Handpicked Homestead";
const HOST_STAND = "Plum Forest Farm";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === "") {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const commit = process.argv.includes("--commit");
  const sql = postgres(databaseUrl, { max: 1 });

  try {
    const [seller] = await sql`select id, name from sellers where name = ${SELLER}`;
    if (seller === undefined) {
      console.error(`no seller named "${SELLER}" — refusing`);
      process.exit(1);
    }
    const [ownStand] = await sql`
      select id, name, is_public from sales_locations where own_seller_id = ${seller.id}`;
    const [hostProvider] = await sql`
      select p.id, p.sales_location_id from stand_providers p
      join sales_locations l on l.id = p.sales_location_id
      where p.seller_id = ${seller.id} and l.name = ${HOST_STAND} and p.ended_at is null`;

    if (ownStand === undefined) {
      console.log("she has no stand of her own — nothing to move");
      return;
    }
    if (hostProvider === undefined) {
      console.error(`she has no live arrangement at "${HOST_STAND}" — refusing`);
      process.exit(1);
    }

    const [nativeProvider] = await sql`
      select id from stand_providers
      where sales_location_id = ${ownStand.id} and seller_id = ${seller.id} and ended_at is null`;

    console.log(`seller:        ${seller.name}`);
    console.log(`her stand:     ${ownStand.name} (${ownStand.id})`);
    console.log(`host provider: ${hostProvider.id} at ${HOST_STAND}`);
    console.log(commit ? "\nCOMMITTING\n" : "\nDRY RUN — nothing will be written\n");

    const [current] = await sql`
      select id from inventory_revisions
      where sales_location_id = ${ownStand.id} and is_current`;
    const entries = current
      ? await sql`
          select item_name, price_text, sort_order from inventory_entries
          where inventory_revision_id = ${current.id} order by sort_order`
      : [];

    console.log(
      `would REPUBLISH ${entries.length} item(s) at ${HOST_STAND}: ` +
        entries.map((e) => `"${e.item_name}"`).join(", "),
    );
    console.log(`would SUPERSEDE her old current revision (history kept, no longer current)`);
    for (const [table, column] of [
      ["stand_items", "provider_id"],
      ["inventory_prompt_preferences", "provider_id"],
      ["farmer_links", "provider_id"],
    ] as const) {
      const [n] = await sql`
        select count(*)::int as n from ${sql(table)} where ${sql(column)} = ${nativeProvider?.id}`;
      if (n.n > 0) console.log(`would MOVE ${n.n} ${table} row(s) to the ${HOST_STAND} arrangement`);
    }
    console.log(`would RETIRE the stand "${ownStand.name}" (is_public -> false)`);

    if (!commit) {
      console.log("\nre-run with --commit to apply");
      return;
    }

    await sql.begin(async (tx) => {
      /*
        SUPERSEDE FIRST, then publish — `farmer.ts` §supersede first. The unique index allows one
        current revision per stand, and her OLD stand is a different stand from Plum Forest, so
        the order matters here only for correctness of the history, not to dodge the index.
      */
      if (current !== undefined) {
        await tx`
          update inventory_revisions set is_current = false, superseded_at = now()
          where id = ${current.id}`;
      }

      if (entries.length > 0) {
        /*
          `source = 'viga'` carries NO approval and NO authorization, and
          `inventory_revisions_source_keys_coherent` enforces exactly that — an earlier draft of
          this script passed her approval and was refused by the database.

          The constraint is right, and so is the source. A `viga` revision is VIGA hand-entering
          a fact with no farmer behind it, which is precisely what this is: max moved her listing,
          she did not text it. Her original stayed `sms` — her own word — and is kept as
          superseded history rather than restated in someone else's voice.
        */
        const [rev] = await tx`
          insert into inventory_revisions (
            seller_id, sales_location_id, provider_id, proposal_id,
            published_by_authorization_id, farm_approval_id, source, published_at
          ) values (
            ${seller.id}, ${hostProvider.sales_location_id}, ${hostProvider.id}, null,
            null, null, 'viga', now()
          ) returning id`;
        for (const entry of entries) {
          await tx`
            insert into inventory_entries (
              inventory_revision_id, sales_location_id, item_name, price_text, sort_order
            ) values (
              ${rev.id}, ${hostProvider.sales_location_id}, ${entry.item_name},
              ${entry.price_text}, ${entry.sort_order}
            )`;
        }
      }

      /*
        LIVE SETTINGS FOLLOW HER; HISTORY DOES NOT.

        `scheduled_inventory_prompt_subjects` is deliberately NOT in this list, and the database
        is what taught it: the row carries an `outbox_work_id`, a `due_slot_at` and an
        `inventory_base_revision_id`, and moving it raised
        `scheduled_prompt_subjects_inventory_base_fk` because that base revision belongs to her
        old stand.

        The refusal is right. That row is a RECORD OF A PROMPT ALREADY SENT on 2026-08-17, not a
        setting — re-pointing it would make history claim VIGA prompted her about Plum Forest,
        which it never did. It stays with the stand it happened at, exactly like the revisions.

        The `inventory_prompt_preferences` row beside it IS a setting — the weekly cadence that
        decides future prompts — so that one moves and her reminders continue.
      */
      for (const table of [
        "stand_items",
        "inventory_prompt_preferences",
        "farmer_links",
      ] as const) {
        await tx`
          update ${sql(table)}
          set provider_id = ${hostProvider.id},
              sales_location_id = ${hostProvider.sales_location_id}
          where provider_id = ${nativeProvider?.id}`;
      }

      // Off the map. Retired rather than deleted — its revisions are history that must stay.
      await tx`update sales_locations set is_public = false, updated_at = now()
        where id = ${ownStand.id}`;
    });

    console.log("\nwrote: listing republished at Plum Forest, old stand retired");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(`failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
