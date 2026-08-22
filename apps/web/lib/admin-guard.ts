import { resolveAdministrator } from "./auth";

// The one guard every admin route calls (F-025a, extracted for F-030).
//
// This lived privately inside `app/api/admin/sellers/route.ts` while there was one admin route.
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

/** The one VIGA page allowed to host and submit the embedded administrator console. */
const VIGA_ADMIN_EMBED_ORIGIN = "https://vigavashon.org";

/**
 * A partitioned cookie can travel in VIGA's cross-site iframe, so SameSite no longer rejects
 * forged writes for us. A browser admin write must originate in either this app itself or the
 * one VIGA origin that officially embeds it. No other frame owner is trusted.
 *
 * The expected origin is CONFIGURED (`PUBLIC_BASE_URL`), never derived from the request. Cloud
 * Run terminates TLS at its proxy and forwards plain HTTP to a container bound to `0.0.0.0:8080`,
 * and Next builds `req.url` from that bind address rather than the public `Host`. Comparing
 * against `new URL(req.url).origin` therefore compared the browser's real origin to
 * `localhost:8080` and refused every admin write in production while passing in a test that
 * hand-built the URL. The request cannot be the authority on its own trusted origin.
 *
 * Fails closed: with no valid configured origin there is no way to distinguish the app's own
 * write from a forged one, so nothing is trusted.
 */
export function isTrustedAdminMutationSource(
  req: Request,
  publicBaseUrl = process.env.PUBLIC_BASE_URL,
): boolean {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return true;
  const origin = req.headers.get("origin");
  if (origin === null) return false;
  if (publicBaseUrl === undefined || publicBaseUrl === "") return false;
  let expected: string;
  try {
    expected = new URL(publicBaseUrl).origin;
  } catch {
    return false;
  }
  return origin === expected || origin === VIGA_ADMIN_EMBED_ORIGIN;
}

/**
 * Resolve the caller to a live administrator, or the Response that refuses them.
 *
 * **The two refusals NAME THEMSELVES**, because they need different next moves and the screen
 * cannot tell 403 from 403. A wrong origin means the console is open at the wrong address — the
 * `*.run.app` host rather than `PUBLIC_BASE_URL`'s custom domain — and no amount of signing in
 * will fix it. `not_signed_in` is the one a sign-in does fix.
 *
 * Measured in production 2026-08-19: both answered a bare `forbidden`, the screen guessed
 * "session expired", and max signed in three times against a refusal that was never about his
 * session. A wrong diagnosis is worse than none.
 *
 * `publicBaseUrl` is injected so the origin rule can be exercised without reaching for the
 * process environment, the same way `isTrustedAdminMutationSource` already takes it.
 */
export async function requireAdministrator(
  req: Request,
  publicBaseUrl = process.env.PUBLIC_BASE_URL,
): Promise<AdminCaller | Response> {
  if (!isTrustedAdminMutationSource(req, publicBaseUrl)) {
    return Response.json({ error: "wrong_origin" }, { status: 403 });
  }
  const administrator = await resolveAdministrator(req);
  if (administrator === null) {
    return Response.json({ error: "not_signed_in" }, { status: 403 });
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
