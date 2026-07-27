// Launch SMS consent — ONE registered operational program (F-016, handoff finding 4).
//
// Golden Rule #2: consent is deterministic code the model cannot reach around. These are
// pure predicates over a consent record — no database, no model, no conversation state.
//
// The single idea this file exists to hold: launch message types are CATEGORIES inside
// one program, not separate enrollments. There is deliberately no program discriminator,
// no per-category consent, and no follow-up-interest state. A customer-initiated inquiry
// permits its own direct reply and creates nothing durable.

import type { ComplianceKeyword } from "./commands";

export type ConsentState = "active" | "stopped";

/** How launch-program consent was captured. Mirrors the `consent_capture_source` enum. */
export type ConsentCaptureSource = "join" | "start" | "farmer_onboarding";

export interface LaunchConsentRecord {
  state: ConsentState;
  captureSource?: ConsentCaptureSource;
}

/**
 * Every kind of outbound message launch can produce. These are categories within the one
 * program — adding one here does NOT add an enrollment, and must not.
 *
 * - `required_reply` — carrier-required answer to the recipient's own message (opt-out
 *   confirmation, help text). Never suppressed, or STOP could not acknowledge itself.
 * - `inquiry_reply` — the direct answer to a customer's own question. Permitted by the
 *   inbound message, not by a subscription, and it creates no durable consent.
 * - the rest are PROACTIVE: Farm Friend speaks first, so each needs active consent.
 */
export const LAUNCH_MESSAGE_CATEGORIES = [
  "required_reply",
  "inquiry_reply",
  "inventory_prompt",
  "inventory_confirmation",
  "stock_out_alert",
] as const;

export type LaunchMessageCategory = (typeof LAUNCH_MESSAGE_CATEGORIES)[number];

/**
 * Categories that do not require a durable consent basis, because the recipient's own
 * inbound message authorized this specific reply. Everything else is proactive.
 */
const REPLY_CATEGORIES: ReadonlySet<LaunchMessageCategory> = new Set([
  "required_reply",
  "inquiry_reply",
]);

export interface ConsentTransitionEffect {
  transition: "start" | "stop";
  /** Absent for STOP: an opt-out records no capture provenance. */
  captureSource?: ConsentCaptureSource;
}

/**
 * The consent consequence of a deterministic compliance keyword, or `null` when it has none.
 *
 * `JOIN` and `START` enroll in the ONE launch program and differ only in recorded
 * provenance — there is no `JOIN <program>` grammar for them to carry. But they differ in
 * one other way that is not ours to choose (B-011):
 *
 * **The carrier owns its own opt-out list, and only `START` clears it.** Telnyx enforces that
 * list independently of our messaging profile's settings; while a number is on it, every send
 * is refused with 409 / code 40300 (verified 2026-07-27 by direct probe). `START` is a
 * carrier-level keyword that lifts the block. `JOIN` is *ours*, and means nothing to Telnyx's
 * compliance layer — a `join` four minutes after a `stop` still 409'd, while a `start`
 * between them was accepted.
 *
 * So `JOIN` establishes consent only for a sender with **no prior record**. Once a record
 * exists, only `START` restores. This makes our record CONFORM to the carrier's rather than
 * reconciling the two after they diverge: previously a farmer who texted STOP then JOIN was
 * recorded `active` while the carrier blocked every message, and `isProactiveSendPermitted`
 * returned true for sends that could never arrive.
 *
 * Note what this deliberately is NOT: no provider response drives a consent transition. The
 * decision stays a pure function of our own deterministic routing plus our own stored record,
 * which is exactly where Golden Rule #2 keeps it. A 409 is never consulted.
 *
 * `STOP` is unaffected and still applies from every state — narrowing the opt-in path must
 * never narrow the opt-out one.
 */
export function consentTransitionFor(
  keyword: ComplianceKeyword,
  current: LaunchConsentRecord | null,
): ConsentTransitionEffect | null {
  switch (keyword) {
    case "JOIN":
      // First-time opt-in only. An existing record — stopped OR active — means the carrier
      // may hold a block that JOIN cannot clear, so we do not claim consent it will refuse.
      // For an already-active sender there is also nothing to establish, and rewriting
      // `captureSource` would falsify the provenance of the original opt-in.
      return current === null
        ? { transition: "start", captureSource: "join" }
        : null;
    case "START":
      // The carrier's own keyword. Always honoured, from any state, so our record can never
      // swallow the one word that actually lifts a block we cannot see.
      return { transition: "start", captureSource: "start" };
    case "STOP":
      return { transition: "stop" };
    case "HELP":
    case "INFO":
    case "FLAG":
      // Asking for help is not opting in; raising a safety flag is not opting out.
      return null;
  }
}

/**
 * May this message be sent? A required or direct reply rides on the recipient's own
 * inbound message; every proactive category requires ACTIVE launch consent.
 *
 * Note what "active" excludes: a missing record. Absent consent is not permission — a
 * recipient who never opted in has no consent basis, and `state !== "stopped"` would
 * wrongly treat that silence as one.
 */
export function isProactiveSendPermitted(input: {
  consent: LaunchConsentRecord | null;
  category: LaunchMessageCategory;
}): boolean {
  // STOP is global across all Farm Friend messaging and outranks even an owed reply —
  // except the carrier-required acknowledgement of the STOP itself.
  if (input.category === "required_reply") return true;
  if (input.consent?.state === "stopped") return false;
  if (REPLY_CATEGORIES.has(input.category)) return true;

  return input.consent?.state === "active";
}
