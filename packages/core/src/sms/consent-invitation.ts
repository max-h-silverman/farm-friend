import type { ConsentState } from "./consent";

/**
 * F-121 — Farm Friend answers nothing substantive until the sender has agreed to receive texts.
 *
 * **The rule (max, 2026-08-18):** a sender with no consent record gets one invitation and
 * nothing else. Not their stand answer with an invitation appended — the invitation INSTEAD of
 * the answer. Consent comes first.
 *
 * ## What stays reachable, and why it is not a hand-kept list
 *
 * The exemption is exactly the **carrier-registered compliance keywords**, which already exist
 * as data in `commands.ts`: the opt-out list, the opt-in list (`JOIN`/`START`/`VIGA`) and the
 * help list. They are exempt because they are how a person opts in, opts out, or asks for
 * help — gating them would either make opting in impossible or leave an opt-out unheard.
 *
 * That exemption is enforced by ORDER in `routeInboundMessage`, not by a second list here:
 * compliance keywords are routed above the gate, so nothing has to remember to exclude them.
 * Two consequences worth stating because forgetting either breaks a real journey:
 *
 * - **`VIGA` must pass.** It is how an invited farmer completes onboarding, from a handset that
 *   by definition has no consent row yet. Gated, the farmer is told to reply `JOIN` — and
 *   `JOIN` can never complete onboarding, so the farmer path would dead-end.
 * - **Every `STOP` synonym must pass.** `UNSUBSCRIBE` reaching an invitation instead of the
 *   opt-out writer would leave someone enrolled while being asked to join.
 *
 * Everything else gates: `MAP`, `YES`/`NO`, `LINK`/`STAND`/`SETTINGS`, `MORE`, a stand menu
 * number, and all free text. `MAP` is named because it is the case that looks most like an
 * exception and is not — it is a service Farm Friend provides, not a consent control.
 */
export const CONSENT_INVITATION_REPLY =
  "Hi there! Reply JOIN to agree to receive text messages from VIGA Farm Friend, " +
  "and I can tell you what our farm stands have.";

/** The stored consent record this gate reads. `null` when the sender has never opted in. */
export interface ConsentGateRecord {
  state: ConsentState;
}

/**
 * Must this sender be asked to consent before Farm Friend answers them?
 *
 * True for a sender with no record and for one who opted out. The two are gated for opposite
 * reasons and are handled differently by the caller: the first is INVITED, while the second is
 * answered with silence — dispatch suppresses their reply regardless, and queuing an opt-in
 * pitch at someone who texted `STOP` is precisely what `STOP` exists to end.
 */
export function requiresConsentBeforeAnswering(
  consent: ConsentGateRecord | null,
): boolean {
  return consent?.state !== "active";
}

/** Whether a gated sender should be invited, as opposed to left alone. */
export function shouldInviteToConsent(consent: ConsentGateRecord | null): boolean {
  return consent === null;
}
