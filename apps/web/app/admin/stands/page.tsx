import { headers } from "next/headers";
import {
  listFarmerAuthorizations,
  listFarmsForApproval,
  listOpenFarmerOnboardingRequests,
  listStandProvidersForAdministration,
  listStandsForAdministration,
} from "@farm-friend/db";
import { resolveAdministrator } from "../../../lib/auth";
import { publicReadContext } from "../../../lib/public-context";
import { AdminShell, SignedOutAdmin } from "../admin-shell";
import { asStandCards } from "../stand-cards";
import { StandsAndSellers, type SellerCard, type StandCard } from "../stands-and-sellers";

// Stands & Sellers — the one destination VIGA spends its time in.
//
// VIGA's whole job is four verbs (max, 2026-08-17): view and edit stands and sellers, invite
// new stands or sellers. So this screen is not "the farms table" — it is those two subjects,
// each listing entities, with everything an operator does living inside the detail view of the
// thing it is about. The old Farms tab is gone rather than renamed.
//
// The joins happen HERE rather than in SQL. Each underlying query is already the minimal
// projection its own surface needed (Golden Rule #5), and assembling them in TypeScript keeps
// that property instead of writing a new wide query that would have to re-earn it.
//
// Same server-side authorization shape as every other admin page: an unauthenticated caller is
// never handed farm data, because it is never fetched for them.

export const dynamic = "force-dynamic";

export default async function StandsAndSellersPage() {
  const cookie = headers().get("cookie") ?? "";
  const administrator = await resolveAdministrator(
    new Request("https://farm-friend.internal/admin/stands", {
      headers: cookie === "" ? {} : { cookie },
    }),
  );

  if (administrator === null) {
    return <SignedOutAdmin />;
  }

  const { db } = publicReadContext();
  const [sellers, stands, providers, authorizations, openInvites] = await Promise.all([
    listFarmsForApproval(db),
    listStandsForAdministration(db),
    listStandProvidersForAdministration(db),
    listFarmerAuthorizations(db),
    // Invites moved here from SMS Users (max, 2026-08-19): inviting a farmer is about a stand
    // or seller joining the roster, which is this screen's subject.
    listOpenFarmerOnboardingRequests(db),
  ]);

  // One read of the arrangements, indexed both ways. The same row appears under its stand on
  // one view and under its seller on the other — it is one relationship seen from two sides,
  // so reading it twice would be two chances to disagree.
  const byStand = new Map<string, StandCard["providers"]>();
  const bySeller = new Map<string, SellerCard["providers"]>();
  for (const row of providers) {
    const standRows = byStand.get(row.salesLocationId);
    if (standRows === undefined) byStand.set(row.salesLocationId, [row]);
    else standRows.push(row);

    const sellerRows = bySeller.get(row.sellerId);
    if (sellerRows === undefined) bySeller.set(row.sellerId, [row]);
    else sellerRows.push(row);
  }

  // `asStandCards` builds the shape `StandDetails` already renders — the stand's own metadata,
  // its retire/restore control, its Farm Bucks decision and the F-114 invite button. Reused
  // rather than rebuilt, from the same query, so there is one way to render a stand.
  const detailsByStand = new Map(asStandCards(stands).map((card) => [card.standId, card]));

  const standCards: StandCard[] = stands.map((stand) => {
    const details = detailsByStand.get(stand.standId);
    return {
      standId: stand.standId,
      name: stand.name,
      farmName: stand.farmName,
      approved: stand.approved,
      retired: stand.retired,
      providers: byStand.get(stand.standId) ?? [],
      ...(details === undefined ? {} : { details }),
    };
  });

  // Masked at the query boundary: `listFarmerAuthorizations` returns `senderMask` and no phone
  // or hash, so this page could not leak a number even if it tried to render one.
  const accessByFarm = new Map<string, SellerCard["access"]>();
  for (const row of authorizations) {
    const entry = {
      authorizationId: row.authorizationId,
      senderMask: row.senderMask,
      authorizedAt: row.authorizedAt.toISOString(),
      revokedAt: row.revokedAt?.toISOString() ?? null,
    };
    const existing = accessByFarm.get(row.farmId);
    if (existing === undefined) accessByFarm.set(row.farmId, [entry]);
    else existing.push(entry);
  }

  const sellerCards: SellerCard[] = sellers.map((farm) => ({
    farmId: farm.farmId,
    name: farm.name,
    approved: farm.approved,
    retired: farm.retired,
    description: farm.description,
    isTestFarm: farm.isTestFarm,
    providers: bySeller.get(farm.farmId) ?? [],
    access: accessByFarm.get(farm.farmId) ?? [],
  }));

  return (
    // No heading and no subtitle (max, 2026-08-17, extending F-071's rule to this screen).
    // The tab already says where you are; repeating it underneath is chrome, and the intro
    // paragraph said nothing an operator could act on.
    <AdminShell currentPath="/admin/stands">
      <StandsAndSellers
        stands={standCards}
        sellers={sellerCards}
        invites={{
          requests: openInvites.map((request) => ({
            requestId: request.requestId,
            senderMask: request.senderMask,
            requestedAt: request.requestedAt.toISOString(),
            farmId: request.farmId,
            farmName: request.farmName,
          })),
          // Retired sellers are not offered: inviting a farmer to take over a farm VIGA has
          // taken down would produce a link that onboards someone onto nothing.
          sellers: sellers
            .filter((farm) => !farm.retired)
            .map((farm) => ({ farmId: farm.farmId, name: farm.name })),
        }}
      />
    </AdminShell>
  );
}
