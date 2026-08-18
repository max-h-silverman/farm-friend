import { hashPhone, normalizePhone, PhoneNormalizationError } from "@farm-friend/core";
import {
  addAdministratorPhone,
  removeAdministratorPhone,
} from "@farm-friend/db";
import { requireAdministrator } from "../../../../lib/admin-guard";
import { publicReadContext } from "../../../../lib/public-context";

// F-074 — who may see test sellers over SMS.
//
// A route of its own rather than another action on `/api/admin/sellers`, because the subject is
// genuinely different: that route records decisions about a FARM, and this one manages a
// credential list. Folding them together would put phone handling in a route that has no
// business touching a phone number.
//
// **This is the one place a raw phone number exists on this path, and it does not leave it.**
// The number is normalized and hashed here, at the boundary, and only the hash and the last
// four digits reach `packages/db` — so no raw E.164 can be logged by the data layer, enter
// model context, or be read back out of the table later (Golden Rule #5). Unlike `contacts`
// there is deliberately no raw column at all: that one exists because the outbound sender
// needs something to send to, and nothing on this path ever sends.
//
// What being listed grants: seeing test sellers in SMS answers. Nothing else. No route consults
// `administrator_phones` for any other decision.

export const dynamic = "force-dynamic";

/** Add a number to the test-farm visibility list, or remove one. */
export async function POST(req: Request): Promise<Response> {
  const caller = await requireAdministrator(req);
  if (caller instanceof Response) return caller;

  let body: { phone?: unknown; id?: unknown; action?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const { db, clock } = publicReadContext();
  const occurredAt = clock.now();

  if (body.action === "remove") {
    const id = typeof body.id === "string" ? body.id : null;
    if (id === null) return Response.json({ error: "invalid_request" }, { status: 400 });
    const removed = await removeAdministratorPhone(db, {
      id,
      administratorId: caller.administratorId,
      occurredAt,
    });
    const status =
      removed.status === "removed"
        ? 200
        : removed.status === "not_an_administrator"
          ? 403
          : 404;
    return Response.json({ status: removed.status }, { status });
  }

  if (body.action !== "add") {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const phone = typeof body.phone === "string" ? body.phone : null;
  if (phone === null) return Response.json({ error: "invalid_request" }, { status: 400 });

  // Trimmed, exactly as `farmerLinkRequestConfig` reads it: a salt that differs by whitespace
  // from the one the webhook hashes with produces a hash that matches no sender, and the
  // symptom would be a list that silently does nothing.
  const salt = process.env.PHONE_HASH_SALT?.trim();
  if (salt === undefined || salt === "") {
    // Fail loudly rather than hashing under a default. A salt that silently varies would make
    // a listed number stop matching the sender it was added for, and the symptom — "the list
    // does nothing" — would look like a bug anywhere but here.
    return Response.json({ error: "phone_hashing_unavailable" }, { status: 503 });
  }

  let phoneHash: string;
  let lastFour: string;
  try {
    // Normalized FIRST so the last four digits come from the canonical form. Taking them from
    // whatever the operator typed would let "(206) 555-0139 x4" record a meaningless suffix.
    const normalized = normalizePhone(phone);
    phoneHash = hashPhone(normalized, salt);
    lastFour = normalized.slice(-4);
  } catch (error) {
    if (error instanceof PhoneNormalizationError) {
      return Response.json({ error: "invalid_phone" }, { status: 400 });
    }
    throw error;
  }

  const added = await addAdministratorPhone(db, {
    phoneHash,
    phoneLastFour: lastFour,
    administratorId: caller.administratorId,
    occurredAt,
  });
  const status =
    added.status === "added"
      ? 200
      : added.status === "not_an_administrator"
        ? 403
        : 409;
  // The response deliberately carries no hash. An operator needs to know the number was added;
  // echoing the lookup key back to a browser is how a key ends up in a log or a screenshot.
  //
  // It DOES carry the row's id and its masked last four (F-101). Neither is the lookup key, and
  // without them the list rendered the new row from what the operator TYPED — so a number that
  // normalized differently showed the typo's suffix until a reload, under a `pending-<phone>`
  // key the remove control then sent to a server that had no such row. Both values are already
  // in hand here: `lastFour` comes from the NORMALIZED number, and the writer returned the id.
  return Response.json(
    added.status === "added"
      ? { status: added.status, id: added.id, lastFour }
      : { status: added.status },
    { status },
  );
}
