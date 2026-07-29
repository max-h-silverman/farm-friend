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
 *
 * WHICH HOP IS TRUSTWORTHY IS A PROPERTY OF THE PLATFORM, not of the header.
 *
 * On Cloud Run the caller controls every byte it sends in `X-Forwarded-For`, and Google's
 * front end APPENDS the address it actually observed. The trustworthy hop is therefore the
 * LAST one, and everything to its left is attacker-chosen text to be discarded.
 *
 * This read direction was reversed while the app ran on Vercel, whose proxy normalizes the
 * header so the leftmost entry is the real client. Carrying that reading onto Cloud Run
 * would have handed the abuse throttle to the attacker rather than merely weakening it:
 * a random leftmost hop per request puts every request in a fresh bucket with a fresh
 * budget. If this app ever moves again, revisit this function first — the correct answer
 * changes with the proxy in front of it, and no test of the header alone can tell you.
 */
export function clientSignalFor(headers: Headers, salt: string): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded === null) return null;

  // Rightmost non-blank hop: the one Cloud Run appended. Blank entries are skipped so a
  // malformed trailing comma cannot bucket on empty text — that would collapse malformed
  // requests into a shared bucket by accident instead of through the deliberate null path.
  const hops = forwarded.split(",");
  for (let i = hops.length - 1; i >= 0; i -= 1) {
    const hop = hops[i]?.trim() ?? "";
    if (hop !== "") {
      return createHash("sha256").update(`${salt}:${hop}`).digest("hex");
    }
  }

  return null;
}
