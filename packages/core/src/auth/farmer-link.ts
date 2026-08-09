import { createHash, randomBytes } from "node:crypto";

// The farmer's standing link (F-040).
//
// A farmer reaches their own listing form through a link they can bookmark. max chose that it
// **never expires until revoked**, which makes it a durable capability rather than an
// authentication event — and that difference is the whole reason this is a handful of lines
// rather than a second auth system.
//
// A self-contained signed standing claim would be exactly wrong: a signature is stateless, so
// a revoked farmer's link would keep verifying forever with nothing able to say otherwise.
// Revocation is the ONLY safety net
// this design has, so the link must be a lookup key into a row someone can withdraw — never
// something a verifier can validate on its own.
//
// So there are no claims in the token at all. It is random bytes and nothing else; everything
// about who it belongs to and whether it still works comes from the database, on every request
// (`resolveFarmerLink`). Nothing here can approve anything.
//
// Same hashing discipline as the session token and the phone hash (Golden Rule #5): only the
// hash is stored, so a database read cannot recover a live credential.

/**
 * Mint opaque link material. Never derived from the farmer or the farm.
 *
 * **16 bytes as base64url, because the token's LENGTH is a product property** (F-097). This
 * whole URL arrives as a text message and is the only thing in it the farmer acts on. At 32
 * bytes of hex it ran 64 characters, wrapped across four lines in the thread, and read as
 * machine output rather than as something to tap. The same value re-encoded is 22 characters
 * and fits on one line beside the host.
 *
 * **The strength is unchanged in the way that matters.** 128 bits of randomness is not
 * guessable — the search space is far beyond anything an online attacker can walk through
 * against a database lookup, and this credential's real safety net is revocation, not width
 * (see the note above). What would be wrong is shortening the *randomness* rather than the
 * *encoding*, so the suite asserts the decoded byte count rather than the character count.
 *
 * base64url specifically, not base64: `+`, `/` and `=` would be percent-encoded into the link,
 * making the message longer than the hex it replaced and breaking a hand-retyped URL.
 */
export function issueFarmerLinkToken(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * Whether a string is shaped like a link token at all, checked before any database work.
 *
 * **It accepts BOTH encodings, and that is a migration requirement rather than laxity.** 35
 * links were live in farmers' text threads when the token shortened, every one of them 64 hex
 * characters. Recognising only the new shape would have dead-linked all of them behind the
 * uniform "this link is not active" refusal — which deliberately cannot be told from a
 * revocation, so no farmer could have discovered why.
 *
 * Hex is a subset of base64url's alphabet, so this is one bounded range rather than two
 * branches: long enough that nothing guessable passes, short enough that an absurd path
 * segment never reaches the driver.
 */
export function isFarmerLinkToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{22,64}$/.test(token);
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
 * `baseUrl` is the CONFIGURED public origin, never a request header: a `Host:` an attacker
 * controls would let us text a farmer a link pointing at the attacker's origin.
 */
export function farmerLinkUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/stand/${encodeURIComponent(token)}`;
}

/** The same standing credential, opened directly on its settings view. */
export function farmerSettingsUrl(baseUrl: string, token: string): string {
  return `${farmerLinkUrl(baseUrl, token)}/settings`;
}
