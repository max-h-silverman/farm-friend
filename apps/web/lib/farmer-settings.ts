import type { Clock, PromptCadence } from "@farm-friend/core";
import {
  listFarmerSettingsTargets,
  selectFarmerTargetForAuthorization,
  setInventoryPromptPreference,
  type Db,
} from "@farm-friend/db";
import { resolveStandFromToken } from "./farmer-stand";

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
  const locations = await listFarmerSettingsTargets(db, {
    senderHash: stand.senderHash,
    authorizationId: stand.authorizationId,
  });
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
  const selected = await selectFarmerTargetForAuthorization(deps.db, {
    senderHash: stand.senderHash,
    authorizationId: stand.authorizationId,
    salesLocationId: input.salesLocationId,
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
    const result = await setInventoryPromptPreference(deps.db, {
      senderHash: stand.senderHash,
      authorizationId: stand.authorizationId,
      salesLocationId: body.salesLocationId,
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
