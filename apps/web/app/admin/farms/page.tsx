import { headers } from "next/headers";
import {
  listFarmerAuthorizations,
  listFarmsAwaitingOnboarding,
  listFarmsForApproval,
  listStandsForAdministration,
} from "@farm-friend/db";
import { resolveAdministrator } from "../../../lib/auth";
import { publicReadContext } from "../../../lib/public-context";
import { AdminShell, SignedOutAdmin } from "../admin-shell";
import { FarmList, type AdminFarmCard } from "../farm-list";
import { asStandCards } from "../stand-cards";

// Everything about a farm, in one place.
//
// This screen replaces six presentations of the same entity that were spread across two
// pages: the approval queue, the flat stand index, the test-farm toggle, "farms with no one
// to update them", the farmer-access roster, and the invite form's farm dropdown. Each named
// the farm differently and none of them linked to the others, so "what is going on with this
// farm?" was a cross-referencing exercise.
//
// Same server-side authorization shape as every other admin page: an unauthenticated caller
// is never handed farm data, because it is never fetched for them.
//
// The joins happen HERE rather than in SQL. Each underlying query is already the minimal
// projection its own surface needed (Golden Rule #5) — in particular `listFarmerAuthorizations`
// returns a masked `senderMask` and no phone or hash — and assembling them in TypeScript keeps
// that property instead of writing a new wide query that would have to re-earn it.

export const dynamic = "force-dynamic";

export default async function FarmsPage() {
  const cookie = headers().get("cookie") ?? "";
  const administrator = await resolveAdministrator(
    new Request("https://farm-friend.internal/admin/farms", {
      headers: cookie === "" ? {} : { cookie },
    }),
  );

  if (administrator === null) {
    return <SignedOutAdmin />;
  }

  const { db, clock } = publicReadContext();
  const [farms, stands, authorizations, awaiting] = await Promise.all([
    listFarmsForApproval(db),
    listStandsForAdministration(db),
    listFarmerAuthorizations(db),
    listFarmsAwaitingOnboarding(db, clock.now()),
  ]);

  // `listStandsForAdministration` carries the farm NAME rather than its id, so stands are
  // grouped by name. That is safe only because the name is what the operator sees on both
  // sides; if two farms ever share a name the grouping would merge them, which is why the
  // farm card shows its stand count on the summary — a wrong count is visible immediately.
  const standsByFarm = new Map<string, ReturnType<typeof asStandCards>>();
  for (const stand of asStandCards(stands)) {
    const existing = standsByFarm.get(stand.farmName);
    if (existing === undefined) standsByFarm.set(stand.farmName, [stand]);
    else existing.push(stand);
  }

  const accessByFarm = new Map<string, AdminFarmCard["access"]>();
  for (const row of authorizations) {
    const entry = {
      authorizationId: row.authorizationId,
      senderMask: row.senderMask,
      authorizedAt: row.authorizedAt.toISOString(),
      revokedAt: row.revokedAt?.toISOString() ?? null,
      stands: row.stands,
      hasLiveLink: row.hasLiveLink,
      liveLinkStand: row.liveLinkStand,
    };
    const existing = accessByFarm.get(row.farmId);
    if (existing === undefined) accessByFarm.set(row.farmId, [entry]);
    else existing.push(entry);
  }

  const awaitingByFarm = new Map(awaiting.map((row) => [row.farmId, row]));

  const cards: AdminFarmCard[] = farms.map((farm) => {
    const waiting = awaitingByFarm.get(farm.farmId);
    return {
      farmId: farm.farmId,
      name: farm.name,
      description: farm.description,
      approved: farm.approved,
      approvedAt: farm.approvedAt?.toISOString() ?? null,
      approvedByEmail: farm.approvedByEmail,
      isTestFarm: farm.isTestFarm,
      retired: farm.retired,
      // A farm absent from the awaiting list already has someone who can update it, so its
      // invitation state is not a question anyone is asking.
      invitationState: waiting?.invitationState ?? "not_applicable",
      invitationExpiresAt: waiting?.invitationExpiresAt?.toISOString() ?? null,
      access: accessByFarm.get(farm.farmId) ?? [],
      stands: standsByFarm.get(farm.name) ?? [],
    };
  });

  return (
    <AdminShell currentPath="/admin/farms">
      <h2 className="admin-section-title">Farms</h2>
      <p className="admin-note">
        Everything VIGA knows about a farm, and everything you can do about it. What a stand
        has and when it is open belongs to the farmer — this is VIGA’s own record.
      </p>
      <FarmList farms={cards} />
    </AdminShell>
  );
}
