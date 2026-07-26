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
 * The consent consequence of a deterministic compliance keyword, or `null` when it has
 * none. `JOIN` and `START` both establish or restore the ONE launch program — they differ
 * only in recorded provenance, never in what they enroll. There is no `JOIN <program>`
 * grammar for them to carry.
 */
export function consentTransitionFor(
  keyword: ComplianceKeyword,
): ConsentTransitionEffect | null {
  switch (keyword) {
    case "JOIN":
      return { transition: "start", captureSource: "join" };
    case "START":
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
