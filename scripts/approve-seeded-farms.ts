import postgres from "postgres";

// F-067 follow-up — approve the 35 farms VIGA seeded, so the admin's approval queue reflects
// reality (max, 2026-08-05).
//
// WHY THIS IS NOT A RUBBER STAMP. `farm_approvals` gates whether a farmer may PUBLISH — it is
// read by `confirmProposal` and the scheduled prompts, not by `listPublicStands`. These 35 farms
// are already on the public map because `is_public` is what shows a stand. So the queue was
// presenting 35 items as pending VIGA action while approving them changed nothing a customer
// sees, and the one thing it DOES change — whether the farmer can publish an update — is the
// thing VIGA already decided when it put them on the map.
//
// The decision recorded is therefore the real one: VIGA listed these farms, so VIGA approves
// them. It is attributed to the fixed administrator account, which is the only identity the
// schema permits and the one a coordinator signs in as.
//
// Insert-only, idempotent, and scoped: `on conflict do nothing` against the partial unique index
// `farm_approvals_one_current_per_farm`, which is the arbiter rather than a preceding read — a
// `for update` cannot serialize a row that does not exist yet (the F-050 / B-011 precedent).
const url = process.env.DATABASE_URL;
if (url === undefined) throw new Error("DATABASE_URL required");

const sql = postgres(url, { max: 1 });

// Fingerprint before writing. A database "assumed" to be the right one has held real user data
// more than once, so a mistyped connection string must fail loudly here rather than silently
// approve farms somewhere else.
const [fingerprint] = (await sql`
  select current_database() as db,
         (select count(*)::int from farms) as farms,
         (select count(*)::int from sales_locations) as locations
`) as unknown as [{ db: string; farms: number; locations: number }];
console.log("target:", JSON.stringify(fingerprint));
if (fingerprint.db !== "neondb" || fingerprint.farms !== 35) {
  throw new Error(
    `refusing: expected neondb with 35 farms, found ${fingerprint.db} with ${fingerprint.farms}`,
  );
}

const before = await sql`
  select count(*)::int as n from farm_approvals where revoked_at is null
`;
console.log("live approvals before:", before[0]!.n);

const inserted = await sql.begin(async (tx) => {
  const admins = await tx`
    select id, email from administrators where revoked_at is null limit 1
  `;
  const administratorId = admins[0]?.id as string | undefined;
  if (administratorId === undefined) {
    throw new Error("no live administrator; run bootstrap-administrator.ts first");
  }
  console.log("attributing to:", admins[0]!.email);

  const rows = await tx`
    insert into farm_approvals (farm_id, administrator_id, approved_at)
    select f.id, ${administratorId}, now()
    from farms f
    where not exists (
      select 1 from farm_approvals a
      where a.farm_id = f.id and a.revoked_at is null
    )
    on conflict (farm_id) where revoked_at is null do nothing
    returning farm_id
  `;
  return rows.length;
});
console.log("approvals written:", inserted);

// Verify BY EFFECT, not by the insert's row count.
const after = await sql`
  select
    (select count(*)::int from farms) as farms,
    (select count(*)::int from farm_approvals where revoked_at is null) as approved,
    (select count(*)::int from farms f where not exists (
       select 1 from farm_approvals a where a.farm_id = f.id and a.revoked_at is null
     )) as still_unapproved,
    (select count(*)::int from sales_locations) as locations
`;
console.log("after:", JSON.stringify(after[0]));
const ok = after[0]!.still_unapproved === 0 && after[0]!.locations === 35;
console.log(ok ? "VERIFIED: queue is empty, listings untouched" : "FAILED");

await sql.end();
process.exit(ok ? 0 : 1);
