import { timingSafeEqual } from "node:crypto";

// F-079 — the secret that gates the migration door.
//
// ## This is OBSCURITY, not authentication, and the distinction is load-bearing
//
// The secret travels in the URL path. That means it lands in browser history, in `Referer`
// headers on any outbound link, in access logs, and in any proxy along the way. Unlike
// `/stand/[token]` it is neither one-use nor revocable per farmer — it is one shared value for
// everyone VIGA sends it to.
//
// So it is NOT the thing protecting a farm's listing. It keeps the migration path from being
// crawled and casually walked in by anyone who finds `/farmer/start`; the actual proof that a
// person may publish for a farm is the emailed code, which is per-farm, expiring, single-use,
// and rate-limited. Documented as such in DATA_ARCHITECTURE.md §privacy.
//
// ## Why this resolver lives here and not in `composition.ts`
//
// `resolveConfig` validates every configured surface — SMS credentials, the model provider, the
// map URL. Binding an unauthenticated farmer page to it is what made F-073's link-request route
// return 500 on an unrelated missing variable, found by RUNNING it rather than by the suite.
//
// This is the same hazard, so it gets the same answer `publicReadContext` gives the public map:
// one narrow module reading one variable. A farmer arriving on the migration link must not be
// turned away because a model credential is absent.

/**
 * The shortest deployable secret.
 *
 * The whole value is the credential and it is exposed in logs and history, so a short one is
 * guessable. 32 characters of a random alphabet is far past what a crawler or an opportunist
 * will find, which is the threat this actually defends against.
 *
 * Enforced in the resolver rather than documented in the runbook: a rule that lives only in
 * prose is a rule a hurried deploy skips.
 */
export const MINIMUM_SECRET_LENGTH = 32;

/**
 * Read the configured secret, or `null` when the door is closed.
 *
 * **Absent is a supported deployment**, exactly like `GEOCODING_API_KEY` and the SMTP block: no
 * value means the migration door does not exist and every other surface runs normally. That is
 * why this returns `null` rather than throwing — a throw renders a 500, and a 500 where a 404
 * belongs tells a prober the route is real and merely misconfigured.
 *
 * Blank and too-short values are `null` for the same reason they are not secrets: an empty
 * string matches every request, and a short one is guessable.
 */
export function resolveFarmerStartSecret(
  env: Record<string, string | undefined>,
): string | null {
  // Trimmed BEFORE measuring. A secret pasted into a Terraform variable or a Secret Manager
  // version arrives with a trailing newline more often than not, and measuring the untrimmed
  // value would accept a 31-character secret padded to 32.
  const secret = env.FARMER_START_SECRET?.trim();
  if (secret === undefined || secret.length < MINIMUM_SECRET_LENGTH) return null;
  return secret;
}

/**
 * Whether a supplied path segment is the configured secret.
 *
 * **Returns `false` identically for "not configured" and "wrong value"**, which is the whole
 * point: callers render the SAME 404 for both, so the response never reveals that the door
 * exists and is switched off.
 *
 * **The length check is not an optimization.** `timingSafeEqual` THROWS on buffers of differing
 * length, so without it a probe of the wrong length would produce a 500 while a probe of the
 * right length produced a 404 — an oracle for the secret's length. It is also why the
 * comparison below can assume equal lengths.
 *
 * Honest note, because the suite cannot prove otherwise: swapping `timingSafeEqual` for `===`
 * fails NO test here. Timing behavior is not observable from a unit test, and claiming the
 * suite verifies it would be a false claim about the evidence. What IS tested is the length
 * guard and the uniform `false`. The constant-time comparison is defence in depth, chosen
 * because it costs nothing, not because this test file demonstrates its effect.
 */
export function farmerStartSecretMatches(
  env: Record<string, string | undefined>,
  supplied: string,
): boolean {
  const configured = resolveFarmerStartSecret(env);
  if (configured === null) return false;

  const a = Buffer.from(configured, "utf8");
  const b = Buffer.from(supplied, "utf8");
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}
