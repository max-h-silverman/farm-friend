import { resolveAdministrator } from "./auth";

// The one guard every admin route calls (F-025a, extracted for F-030).
//
// This lived privately inside `app/api/admin/farms/route.ts` while there was one admin route.
// F-030 adds three more, and four copies of an authorization check is four places for one to
// drift — so it becomes one mechanism with several consumers rather than a family of
// near-duplicates.
//
// It resolves the caller server-side and returns the administrator ROW, because every
// consequential admin write needs an `administrator_id` and none of them may take it from the
// request body. The refusal is a `Response` rather than a thrown error so that a route cannot
// accidentally continue past a failed check: there is nothing to catch and ignore.
//
// Session resolution joins the live administrator row directly. Consequential writes still
// re-read that same row under lock so a revocation that commits mid-request wins.

export interface AdminCaller {
  administratorId: string;
  /** The administrator's email — what the principal names them by. Never a phone. */
  email: string;
}

/** Resolve the caller to a live administrator, or the Response that refuses them. */
export async function requireAdministrator(
  req: Request,
): Promise<AdminCaller | Response> {
  const administrator = await resolveAdministrator(req);
  if (administrator === null) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  return {
    administratorId: administrator.administratorId,
    email: administrator.email,
  };
}

/** The HTTP status a review-queue write result maps to. One table, every consumer. */
export function statusForWriteResult(result: string): number {
  switch (result) {
    case "disposed":
    case "triaged":
    case "resolved":
      return 200;
    case "unknown_flag":
    case "unknown_report":
      return 404;
    case "not_an_administrator":
      return 403;
    // `already_disposed` / `already_triaged`: the row is no longer open. 409 rather than 200,
    // because the caller's decision was NOT recorded and telling them otherwise would be a
    // lie about an audit record.
    default:
      return 409;
  }
}
