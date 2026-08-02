// How an admin session travels between the browser and the server (F-025a).
//
// The session token is an opaque bearer credential — whoever holds it is the administrator
// until it expires or is revoked. So the cookie attributes below are not boilerplate; they
// are the whole of its transport security, and `admin-auth.test.ts` asserts each one.
//
// The token goes in a cookie rather than a query string or path segment because those are
// routinely logged by proxies, analytics, and browser history. Golden Rule #5's discipline —
// credentials and identifiers do not end up in logs — applies to this credential too.

export const ADMIN_SESSION_COOKIE = "ff_admin_session";

/**
 * Read the session token from a request's cookies, or null.
 *
 * Parses whole `name=value` pairs rather than searching the header for a substring: a
 * prefix match would let an attacker-set `not_ff_admin_session=…` supply the credential.
 */
export function sessionTokenFromRequest(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (header === null) return null;

  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    if (pair.slice(0, separator).trim() !== ADMIN_SESSION_COOKIE) continue;
    const value = pair.slice(separator + 1).trim();
    return value === "" ? null : value;
  }
  return null;
}

/** The `Set-Cookie` value that establishes a session, valid for `ttlMs`. */
export function serializeSessionCookie(token: string, ttlMs: number): string {
  const maxAgeSeconds = Math.floor(ttlMs / 1000);
  return [
    `${ADMIN_SESSION_COOKIE}=${token}`,
    "Path=/",
    // Script must not be able to read an operator's credential: this is what keeps an XSS
    // anywhere in the app from becoming farm-approval authority.
    "HttpOnly",
    // Never sent over plaintext.
    "Secure",
    // The admin is intentionally embedded cross-site on VIGA's Squarespace page. `None`
    // permits the iframe to carry the session; `Partitioned` keys it to VIGA's top-level
    // site, so the credential is not available when another site embeds this origin.
    "SameSite=None",
    "Partitioned",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

/** The `Set-Cookie` value that ends a session in the browser. */
export function clearSessionCookie(): string {
  return [
    `${ADMIN_SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=None",
    "Partitioned",
    "Max-Age=0",
  ].join("; ");
}
