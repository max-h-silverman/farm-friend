import { createHash, randomBytes } from "node:crypto";

// The farmer's standing link (F-040).
//
// A farmer reaches their own listing form through a link they can bookmark. max chose that it
// **never expires until revoked**, which makes it a durable capability rather than an
// authentication event — and that difference is the whole reason this is a handful of lines
// rather than a second auth system.
//
// **Why this is not `magic-link.ts`.** The admin magic link is a SIGNED CLAIM: it carries an
// email and an expiry, and the callback trades it for a session. Signing works there because
// the claim is short-lived and single-use. Here neither is true, and a signed standing claim
// would be exactly wrong: a signature is stateless, so a revoked farmer's link would keep
// verifying forever with nothing able to say otherwise. Revocation is the ONLY safety net
// this design has, so the link must be a lookup key into a row someone can withdraw — never
// something a verifier can validate on its own.
//
// So there are no claims in the token at all. It is 32 random bytes; everything about who it
// belongs to and whether it still works comes from the database, on every request
// (`resolveFarmerLink`). Nothing here can approve anything.
//
// Same hashing discipline as the session token and the phone hash (Golden Rule #5): only the
// hash is stored, so a database read cannot recover a live credential.

/** Mint opaque link material. 32 random bytes — never derived from the farmer or the farm. */
export function issueFarmerLinkToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * The stored lookup key for a link token. Unsalted SHA-256, exactly as `hashSessionToken`:
 * the input is 256 bits of uniform randomness, so there is no candidate set to enumerate,
 * and the lookup must work without a configured secret.
 */
export function hashFarmerLinkToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Build the URL a farmer bookmarks.
 *
 * `baseUrl` is the CONFIGURED public origin, never a request header — the same rule the
 * sign-in link follows, and for the same reason: a `Host:` an attacker controls would let us
 * text a farmer a link pointing at the attacker's origin.
 */
export function farmerLinkUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/stand/${encodeURIComponent(token)}`;
}

/** The same standing credential, opened directly on its settings view. */
export function farmerSettingsUrl(baseUrl: string, token: string): string {
  return `${farmerLinkUrl(baseUrl, token)}/settings`;
}
