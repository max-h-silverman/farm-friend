// F-079 — how a verified farmer's publish rights travel between browser and server.
//
// ## What this credential is, and the two things it is NOT
//
// It says: *whoever holds this proved control of an address VIGA has on file for farm X, and
// may edit farm X's listing until it expires.*
//
// It is **not farmer authorization.** It creates no `farmer_authorizations` row and grants no
// SMS authority, so its holder cannot update stock by text — that still requires an inbound
// message from a consented handset. The page says so; this module is why it is structurally
// true rather than merely promised.
//
// It is **not a standing link.** `/stand/[token]` is a durable capability a farmer bookmarks;
// this expires on its own, because it was issued to an authentication EVENT rather than to a
// lasting relationship.
//
// ## Why the token is a row and not a signature
//
// The same reason `farmer-link.ts` gives: a signed self-contained grant keeps verifying after
// the fact with nothing able to say otherwise. Here the token's hash points at the consumed
// `seller_email_verifications` row, which already records the farm and the instant — so the
// grant's validity is a per-request database question, and there is no second credential table.

export const PUBLISH_GRANT_COOKIE = "ff_publish_grant";

/**
 * Read the grant token from a request's cookies, or null.
 *
 * Parses whole `name=value` pairs rather than searching for a substring: a prefix match would
 * let an attacker-set `not_ff_publish_grant=…` supply the credential.
 */
export function grantTokenFromRequest(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (header === null) return null;

  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    if (pair.slice(0, separator).trim() !== PUBLISH_GRANT_COOKIE) continue;
    const value = pair.slice(separator + 1).trim();
    return value === "" ? null : value;
  }
  return null;
}

/**
 * The `Set-Cookie` value establishing a publish grant.
 *
 * **`SameSite=Lax`, not the admin cookie's `None`.** The admin surface is deliberately embedded
 * in VIGA's Squarespace page and needs `None` to survive the iframe; this flow is not embedded
 * anywhere, so the stronger setting is available — another site cannot cause a publish with the
 * farmer's grant riding along.
 */
export function serializePublishGrantCookie(token: string, ttlMs: number): string {
  return [
    `${PUBLISH_GRANT_COOKIE}=${token}`,
    "Path=/",
    // An XSS anywhere in the app must not become the ability to publish onto the public map.
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${Math.floor(ttlMs / 1000)}`,
  ].join("; ");
}

/** The `Set-Cookie` value that ends a grant in the browser. */
export function clearPublishGrantCookie(): string {
  return [
    `${PUBLISH_GRANT_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=0",
  ].join("; ");
}
