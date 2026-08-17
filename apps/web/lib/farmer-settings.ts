import type { Clock, PromptCadence } from "@farm-friend/core";
import {
  listFarmerSettingsTargets,
  selectFarmerTargetForAuthorization,
  setInventoryPromptPreference,
  type Db,
} from "@farm-friend/db";
import { resolveStandFromToken } from "./farmer-stand";

/*
  F-114 Phase C.4 — this surface speaks in LISTINGS.

  C.3 left it stand-shaped on purpose for exactly one sub-phase: the default-target picker and
  the reminder rows are one screen, and the reminder cadence — the setting that actually differs
  per listing — did not become per-listing until C.4b. Converting the picker alone would have
  left a listing picker sitting above a stand-keyed reminder.

  Both move now. A row is a PROVIDER, so Zoe sees Gracie's Greens at Kelsey's stand and sets its
  cadence without touching Kelsey's, and a host who may restock for a seller at her own stand
  sees two rows that say which is which rather than one stand name twice.

  The seller is named only where it DIFFERS from the stand, by self-pointer and never a name
  match (§suppression follows a pointer) — the same rule the SMS menu follows, so the two
  surfaces cannot come to label the same listing differently.
*/

export type FarmerSettingsResult =
  | {
      status: "active";
      listings: {
        providerId: string;
        salesLocationId: string;
        locationName: string;
        /** NULL where the listing IS the stand's own — nothing to disambiguate. */
        sellerName: string | null;
        selected: boolean;
        cadence: PromptCadence | null;
      }[];
    }
  | { status: "not_authorized" };

/** Resolve the existing standing credential and expose only its editable listings. */
export async function loadFarmerSettings(
  db: Db,
  token: string,
): Promise<FarmerSettingsResult> {
  const stand = await resolveStandFromToken(db, token);
  if (stand === null) return { status: "not_authorized" };
  const listings = (await listFarmerSettingsTargets(db, {
    senderHash: stand.senderHash,
    authorizationId: stand.authorizationId,
  })).map((target) => ({
    providerId: target.providerId,
    salesLocationId: target.salesLocationId,
    locationName: target.locationName,
    sellerName: target.describesOwnStand ? null : target.sellerName,
    selected: target.selected,
    cadence: target.cadence,
  }));
  if (listings.length === 0) return { status: "not_authorized" };
  return { status: "active", listings };
}

export type SaveFarmerDefaultListingResult =
  | {
      status: "saved";
      providerId: string;
      salesLocationId: string;
      locationName: string;
    }
  | { status: "not_authorized" };

/**
 * Save only the sender's default SMS target; consent and prompt cadence are out of scope.
 *
 * Takes the LISTING (C.4). The seam re-validates it under lock anyway, so this passes the id
 * straight through rather than resolving it here — an intermediate lookup would be a second
 * place deciding which listings this token may reach.
 */
export async function saveFarmerDefaultListing(
  deps: { db: Db; clock: Clock },
  input: { token: string; providerId: string },
): Promise<SaveFarmerDefaultListingResult> {
  const stand = await resolveStandFromToken(deps.db, input.token);
  if (stand === null) return { status: "not_authorized" };
  const selected = await selectFarmerTargetForAuthorization(deps.db, {
    senderHash: stand.senderHash,
    authorizationId: stand.authorizationId,
    providerId: input.providerId,
    occurredAt: deps.clock.now(),
  });
  if (selected.status !== "selected") return selected;
  return {
    status: "saved",
    providerId: selected.target.providerId,
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
  let body: { token?: unknown; providerId?: unknown; cadence?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  // The listing, not the stand (C.4). A stand no longer names one thing this screen can save:
  // a host reaches two listings under one roof, and "which stand" has no answer between them.
  if (
    typeof body.token !== "string" ||
    typeof body.providerId !== "string" ||
    !UUID_RE.test(body.providerId) ||
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
    // Straight to the seam. It resolves authority through `resolveProviderWriteAuthority` and
    // refuses a listing this phone may not schedule, so a check here would be a second place
    // deciding the same thing — and the one more likely to drift.
    const result = await setInventoryPromptPreference(deps.db, {
      senderHash: stand.senderHash,
      authorizationId: stand.authorizationId,
      providerId: body.providerId,
      cadence: body.cadence as PromptCadence,
      clock: deps.clock,
    });
    return result.status === "saved"
      ? Response.json(result)
      : Response.json({ error: "not_authorized" }, { status: 403 });
  }

  const result = await saveFarmerDefaultListing(deps, {
    token: body.token,
    providerId: body.providerId,
  });
  return result.status === "saved"
    ? Response.json(result)
    : Response.json({ error: "not_authorized" }, { status: 403 });
}
