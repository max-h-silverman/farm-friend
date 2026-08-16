import type { Clock, PromptCadence } from "@farm-friend/core";
import {
  listFarmerSettingsTargets,
  selectFarmerTargetForAuthorization,
  setInventoryPromptPreference,
  type Db,
} from "@farm-friend/db";
import { resolveStandFromToken } from "./farmer-stand";

/*
  F-114 Phase C.3 — this surface still speaks in STANDS, and that is deliberate for one more
  sub-phase.

  The default-stand picker and the reminder rows are one screen and one save. C.4 owns reminder
  cadence, so widening this page to one row per LISTING belongs there, with the cadence it sits
  beside — splitting it across two tranches would leave the screen half-converted, showing a
  listing picker above a stand-keyed reminder.

  What C.3 changes is that the seam beneath it now names a provider, so this file resolves the
  one it means — the stand's own listing — rather than the seam quietly guessing. A farmer with
  no stand of her own (a hosted-only seller like Zoe) is refused HERE rather than silently shown
  a stand she does not own, and that refusal is asserted.
*/

export type FarmerSettingsResult =
  | {
      status: "active";
      locations: {
        salesLocationId: string;
        locationName: string;
        selected: boolean;
        cadence: PromptCadence | null;
      }[];
    }
  | { status: "not_authorized" };

/** Resolve the existing standing credential and expose only its editable stand choices. */
export async function loadFarmerSettings(
  db: Db,
  token: string,
): Promise<FarmerSettingsResult> {
  const stand = await resolveStandFromToken(db, token);
  if (stand === null) return { status: "not_authorized" };
  // One row per LISTING comes back now. This page shows stands, so it keeps the stand's own
  // listing and drops the hosted ones rather than rendering a stand twice under one name — the
  // per-listing screen is C.4's, with the cadence it belongs beside.
  const locations = (await listFarmerSettingsTargets(db, {
    senderHash: stand.senderHash,
    authorizationId: stand.authorizationId,
  }))
    .filter((target) => target.describesOwnStand)
    .map((target) => ({
      salesLocationId: target.salesLocationId,
      locationName: target.locationName,
      selected: target.selected,
      cadence: target.cadence,
    }));
  if (locations.length === 0) return { status: "not_authorized" };
  return { status: "active", locations };
}

export type SaveFarmerDefaultStandResult =
  | { status: "saved"; salesLocationId: string; locationName: string }
  | { status: "not_authorized" };

/** Save only the sender's default SMS target; consent and prompt cadence are out of scope. */
export async function saveFarmerDefaultStand(
  deps: { db: Db; clock: Clock },
  input: { token: string; salesLocationId: string },
): Promise<SaveFarmerDefaultStandResult> {
  const stand = await resolveStandFromToken(deps.db, input.token);
  if (stand === null) return { status: "not_authorized" };
  // The stand named by the picker, resolved to the LISTING this page means: the stand's own,
  // by SELF-POINTER. A stand this authorization cannot reach yields nothing and is refused
  // here, which is the same answer the seam would give and one round trip earlier.
  const targets = await listFarmerSettingsTargets(deps.db, {
    senderHash: stand.senderHash,
    authorizationId: stand.authorizationId,
  });
  const ownListing = targets.find(
    (target) =>
      target.salesLocationId === input.salesLocationId && target.describesOwnStand,
  );
  if (ownListing === undefined) return { status: "not_authorized" };
  const selected = await selectFarmerTargetForAuthorization(deps.db, {
    senderHash: stand.senderHash,
    authorizationId: stand.authorizationId,
    providerId: ownListing.providerId,
    occurredAt: deps.clock.now(),
  });
  if (selected.status !== "selected") return selected;
  return {
    status: "saved",
    salesLocationId: selected.target.salesLocationId,
    locationName: selected.target.locationName,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** HTTP boundary for the one structured settings write. */
export async function handleFarmerSettingsPost(
  deps: { db: Db; clock: Clock },
  request: Request,
): Promise<Response> {
  let body: { token?: unknown; salesLocationId?: unknown; cadence?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  if (
    typeof body.token !== "string" ||
    typeof body.salesLocationId !== "string" ||
    !UUID_RE.test(body.salesLocationId) ||
    (body.cadence !== undefined && ![
      "every_2_days", "weekly", "every_2_weeks", "paused",
    ].includes(body.cadence as string))
  ) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  if (body.cadence !== undefined) {
    const stand = await resolveStandFromToken(deps.db, body.token);
    if (stand === null) {
      return Response.json({ error: "not_authorized" }, { status: 403 });
    }
    // The cadence seam takes a LISTING now (C.4). This screen still names a stand, so it
    // resolves the one it means — the stand's own listing, by self-pointer — exactly as the
    // default-stand path above does. C.4e widens the screen itself to one row per listing.
    const targets = await listFarmerSettingsTargets(deps.db, {
      senderHash: stand.senderHash,
      authorizationId: stand.authorizationId,
    });
    const ownListing = targets.find(
      (target) =>
        target.salesLocationId === body.salesLocationId && target.describesOwnStand,
    );
    if (ownListing === undefined) {
      return Response.json({ error: "not_authorized" }, { status: 403 });
    }
    const result = await setInventoryPromptPreference(deps.db, {
      senderHash: stand.senderHash,
      authorizationId: stand.authorizationId,
      providerId: ownListing.providerId,
      cadence: body.cadence as PromptCadence,
      clock: deps.clock,
    });
    return result.status === "saved"
      ? Response.json(result)
      : Response.json({ error: "not_authorized" }, { status: 403 });
  }

  const result = await saveFarmerDefaultStand(deps, {
    token: body.token,
    salesLocationId: body.salesLocationId,
  });
  return result.status === "saved"
    ? Response.json(result)
    : Response.json({ error: "not_authorized" }, { status: 403 });
}
