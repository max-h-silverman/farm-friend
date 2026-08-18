import {
  inviteSellerToStand,
  restoreStand,
  retireStand,
  saveFarmBucksStatus,
  saveStandMetadata,
  type FarmBucksStatus,
} from "@farm-friend/db";
import { farmerInviteUrl, renderPublicStringRefusal } from "@farm-friend/core";
import { requireAdministrator } from "../../../../lib/admin-guard";
import { resolvePublicBaseUrl } from "../../../../lib/composition";
import { publicReadContext } from "../../../../lib/public-context";

// The per-stand administrator surface. Two acts live here because they are the same KIND of
// act — VIGA recording a decision about one stand — and a second route would be a second
// place to remember the session guard.
//
// Note what this route does NOT do, deliberately: it never touches inventory, a listing, or a
// published revision. Retiring a stand takes it off the public surfaces and closes it to new
// publication; what the farmer already published stays exactly as they published it
// (Golden Rule #1).

export const dynamic = "force-dynamic";

/**
 * Record a Farm Bucks decision, or retire/restore a stand.
 *
 * The acting administrator comes from the SESSION, never the request body: a caller naming
 * someone else must not be able to act as them, and the audit trail records who really did it.
 * Each act re-reads that authority inside its own transaction.
 */
export async function POST(req: Request): Promise<Response> {
  const caller = await requireAdministrator(req);
  if (caller instanceof Response) return caller;

  let body: {
    standId?: unknown;
    farmBucksStatus?: unknown;
    action?: unknown;
    sellerId?: unknown;
    newSellerName?: unknown;
    name?: unknown;
    publicAddress?: unknown;
    addressPublic?: unknown;
    latitude?: unknown;
    longitude?: unknown;
    hoursText?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const standId = typeof body.standId === "string" ? body.standId : null;
  if (standId === null) return Response.json({ error: "invalid_request" }, { status: 400 });

  const { db, clock } = publicReadContext();
  const occurredAt = clock.now();

  /*
    F-114 Phase C.1 — VIGA's invitation door.

    Here rather than on a route of its own for the reason the header already gives: it is the same
    KIND of act, VIGA recording a decision about one stand, and a second route would be a second
    place to remember the session guard.

    **VIGA is the approver on record whenever VIGA issues the link** (max, 2026-08-15), so this
    passes `administratorId` and never a vouching authorization. The stand owner's own door is the
    farmer surface, not this one.

    The response carries the LINK ONCE. Only the token's hash is stored, so a coordinator who
    loses it reissues rather than recovers — and Farm Friend texts the invited seller nothing,
    because no consent record exists for a number nobody gave us.

    A complete URL rather than the bare token, matching `create_invite` on the farmers route and
    the stand owner's own door: an operator forwarding a link must not be asked to assemble one,
    and two doors that answered in different shapes would need two readers.
  */
  if (body.action === "invite_seller") {
    const sellerId = typeof body.sellerId === "string" ? body.sellerId : undefined;
    const newSellerName =
      typeof body.newSellerName === "string" ? body.newSellerName : undefined;
    /*
      NO shape check here, deliberately. `inviteSellerToStand` already refuses a blank name, both
      named at once, and neither named, returning `invalid_seller` — which this route maps to 400.
      A duplicate check was written and then removed: sabotaging it changed no test result,
      because the writer's refusal produced the same 400. An unfalsifiable guard is not a guard,
      and two places stating one rule is exactly what the zen desk forbids.
    */
    const result = await inviteSellerToStand(db, {
      salesLocationId: standId,
      ...(sellerId === undefined ? {} : { sellerId }),
      ...(newSellerName === undefined ? {} : { newSellerName }),
      administratorId: caller.administratorId,
      occurredAt,
    });
    if (result.status === "unsafe_public_text") {
      // The SAME code-rendered refusal the farmer's own door shows. A seller name reaches the
      // public map either way, so a coordinator and a farmer must not be told different things
      // about the same rule.
      return Response.json(
        { ...result, message: renderPublicStringRefusal(result.prohibited) },
        { status: invitationStatusFor(result.status) },
      );
    }
    if (result.status !== "invited") {
      return Response.json(result, { status: invitationStatusFor(result.status) });
    }
    // The raw token is deliberately NOT echoed beside the link. One readable copy, in the form
    // the coordinator actually forwards.
    const { token, ...rest } = result;
    return Response.json({
      ...rest,
      link: farmerInviteUrl(resolvePublicBaseUrl(process.env), token),
    });
  }

  /*
    F-101 — VIGA corrects a stand's own facts.

    Here for the reason the header gives: the same KIND of act, VIGA recording a decision about
    one stand. The seam names its columns and touches nothing the farmer owns, so this route
    validates shape and passes it through — see `saveStandMetadata`.

    `name` is the only required field. The rest are nullable columns and `null` is a real answer
    ("no address", "no hours stated"), so absence and emptiness both mean null rather than
    "leave it alone" — a partial writer here would need a second way to say "clear this".
  */
  if (body.action === "save_metadata") {
    const name = typeof body.name === "string" ? body.name : null;
    if (name === null) return Response.json({ error: "invalid_request" }, { status: 400 });

    const text = (value: unknown): string | null =>
      typeof value === "string" && value.trim() !== "" ? value : null;
    const coordinate = (value: unknown): number | null =>
      typeof value === "number" && Number.isFinite(value) ? value : null;

    const result = await saveStandMetadata(db, {
      standId,
      administratorId: caller.administratorId,
      name,
      publicAddress: text(body.publicAddress),
      addressPublic: body.addressPublic !== false,
      latitude: coordinate(body.latitude),
      longitude: coordinate(body.longitude),
      hoursText: text(body.hoursText),
      occurredAt,
    });
    // Each refusal keeps its own status: a blank name and a stripped address are both the
    // operator's to fix, and a 403 would send them to their sign-in instead.
    switch (result.status) {
      case "saved":
        return Response.json(result, { status: 200 });
      case "unknown_stand":
        return Response.json(result, { status: 404 });
      case "invalid_name":
      case "incomplete_location":
        return Response.json(result, { status: 400 });
      default:
        return Response.json(result, { status: 403 });
    }
  }

  if (body.action !== undefined) {
    const action =
      body.action === "retire" || body.action === "restore" ? body.action : null;
    if (action === null) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const result =
      action === "retire"
        ? await retireStand(db, {
            salesLocationId: standId,
            administratorId: caller.administratorId,
            occurredAt,
          })
        : await restoreStand(db, {
            salesLocationId: standId,
            administratorId: caller.administratorId,
            occurredAt,
          });
    return Response.json(result, { status: retirementStatusFor(result.status) });
  }

  const status = ["accepts", "does_not_accept", "not_eligible"].includes(body.farmBucksStatus as string)
    ? body.farmBucksStatus as FarmBucksStatus
    : null;
  if (status === null) return Response.json({ error: "invalid_request" }, { status: 400 });

  const result = await saveFarmBucksStatus(db, {
    standId,
    administratorId: caller.administratorId,
    status,
    occurredAt,
  });
  const httpStatus = result.status === "saved" ? 200 : result.status === "unknown_stand" ? 404 : 403;
  return Response.json(result, { status: httpStatus });
}

/**
 * One status table for both retirement acts, so a new one cannot answer inconsistently.
 *
 * `already_retired` / `not_retired` are 409 rather than 200: the caller's decision was NOT
 * recorded, and answering 200 would be a lie about an audit record.
 */
/**
 * One status table for the invitation, so a new refusal cannot answer inconsistently.
 *
 * `already_selling_here` is 409 rather than 200 for the same reason `already_retired` is: the
 * coordinator's decision was NOT recorded and no link was minted, so 200 would be a lie. A blank
 * or doubly-named seller is 400 — a caller bug, not a state conflict.
 */
function invitationStatusFor(status: string): number {
  switch (status) {
    case "invited":
      return 200;
    case "unknown_stand":
    case "unknown_seller":
      return 404;
    case "not_an_administrator":
    case "not_authorized":
      return 403;
    case "invalid_seller":
    case "invalid_issuer":
      return 400;
    default:
      return 409;
  }
}

function retirementStatusFor(status: string): number {
  switch (status) {
    case "retired":
    case "restored":
      return 200;
    case "unknown_stand":
      return 404;
    case "not_an_administrator":
      return 403;
    default:
      return 409;
  }
}
