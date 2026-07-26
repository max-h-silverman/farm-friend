import {
  AuthorizationError,
  requireRole,
  type Principal,
} from "@farm-friend/core";
import { findAdministratorByEmail } from "@farm-friend/db";
import { resolvePrincipal } from "./auth";
import { publicReadContext } from "./public-context";

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
// Note the layering. This is the SECOND of three checks, and deliberately not the load-bearing
// one: `resolvePrincipal` proves a live session, this proves a live administrator row, and the
// write's own transaction re-reads that row under lock. Only the third can see a revocation
// that commits mid-request, which is why it exists in `packages/db` rather than here.

export interface AdminCaller {
  administratorId: string;
  /** The administrator's email — what the principal names them by. Never a phone. */
  email: string;
}

/** Resolve the caller to a live administrator, or the Response that refuses them. */
export async function requireAdministrator(
  req: Request,
): Promise<AdminCaller | Response> {
  let principal: Principal | null;
  try {
    principal = await resolvePrincipal(req);
    requireRole(principal, "admin");
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    throw error;
  }

  const { db } = publicReadContext();
  const administrator = await findAdministratorByEmail(db, principal.personId);
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
