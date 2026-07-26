import { createHash } from "node:crypto";

// The coarse cost-bucket signal for the one public unauthenticated model surface (F-019).
//
// Read this before extending it: this is a COST BUCKET, not identity and not
// authorization. It is trivially spoofable by anyone who controls their own headers, and
// that is acceptable — the throttle it feeds exists to stop casual looping, not to
// authenticate a stranger. Never promote it to an authorization decision, never store it
// durably, and never build a customer profile on it (Golden Rule #5: Farm Friend must not
// accumulate a rich personal profile).
//
// It is hashed with the deployment salt so nothing downstream — the throttle map, an error
// message, a stack trace — ever holds a raw network address.

/**
 * Derive an opaque per-client bucket key from request headers, or `null` when no address
 * is available. A `null` signal is NOT an exemption: the throttle collapses it into one
 * shared bucket, so stripping the header restricts an attacker rather than freeing them.
 */
export function clientSignalFor(headers: Headers, salt: string): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded === null) return null;

  // Proxies append hops, so the leftmost entry is the closest thing to the real client.
  // Hashing the whole chain would let an attacker append a random hop per request and buy
  // a fresh budget every time.
  const first = forwarded.split(",")[0]?.trim() ?? "";
  if (first === "") return null;

  return createHash("sha256").update(`${salt}:${first}`).digest("hex");
}
