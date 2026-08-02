import {
  CONTACT_CARD_FILENAME,
  CONTACT_CARD_MEDIA_TYPE,
  renderContactCard,
} from "@farm-friend/core";

// The served contact card (F-039) — `GET /api/public/contact-card`.
//
// The whole surface is: read one environment variable, render a vCard, set two headers. There
// is no database read, no model seam, no session, and no request body — a customer taps a link
// and their phone opens its add-contact sheet.
//
// The handler lives in lib/ because Next.js permits only its own fields as route exports; the
// route file is the thin binding, matching `stands/` and `stock-out/`.
//
// ## Why it is NOT wired through the composition root
//
// `appContext()` constructs the model seams, so importing it here would put the model package
// in this public route's module graph — the exact structural problem `lib/public-context.ts`
// was split out to fix (F-019), and the thing `public-surface-model-free.test.ts` polices.
// `publicReadContext()` would be wrong for the opposite reason: it opens the database pool,
// and this route has nothing to read. So configuration is resolved by `contactCardConfig`
// below, which reads exactly one variable and nothing else.
//
// ## Why there is no throttle
//
// `createPublicActionThrottle` fronts public handlers that perform an EXPENSIVE or
// CONSEQUENTIAL action — such as the QR stock-out form's paid model call. This route does neither.
// It renders ~150 bytes
// of static text from an environment variable; the response is byte-identical for every
// caller, so there is nothing to enumerate and nothing metered to exhaust. Capping it would be
// the failure mode the repo rule names — "normal public lookup is never artificially capped" —
// and it would cap it on the one surface whose entire purpose is to remove friction from a
// customer's first contact. Ordinary edge/platform request limits are the right layer for
// volume here, exactly as they are for `GET /api/public/stands`.
//
// ## What this deliberately does not do
//
// It records nothing. Saving a contact is a device-local act: no consent transition, no
// `contacts` row, no proactive-send permission. It is not `JOIN` — see `vcard.ts`, where the
// copy's compliance boundary is asserted.

export interface ContactCardDeps {
  /**
   * The SMS number in exact E.164 form. Supplied by the caller from `TELNYX_FROM_NUMBER` via
   * `contactCardConfig` — never a literal, so the card cannot drift from the number that
   * actually sends (`packages/sms/src/telnyx.ts`).
   */
  phoneNumber: string;
}

/**
 * The name of the variable the card is built from.
 *
 * Stated as a constant because it is the SAME variable the send path reads. That shared
 * identity is the entire anti-drift guarantee: there is one number in configuration, and both
 * the card a farmer saves and the messages Farm Friend sends come from it.
 */
const SENDING_NUMBER_VAR = "TELNYX_FROM_NUMBER";

/**
 * Resolve the card's only input from the environment.
 *
 * Fails CLOSED and LOUDLY on an absent or blank value rather than serving a card with a
 * placeholder in it. A missing number should be a 500 an operator can see, not a contact entry
 * a farmer keeps forever with the wrong digits in it — and the E.164 validation in
 * `renderContactCard` is the second half of the same posture.
 */
export function contactCardConfig(
  env: Record<string, string | undefined> = process.env,
): ContactCardDeps {
  const phoneNumber = env[SENDING_NUMBER_VAR];
  if (phoneNumber === undefined || phoneNumber.trim() === "") {
    throw new Error(
      `${SENDING_NUMBER_VAR} is required to serve the contact card: the card must carry the ` +
        "same number the send path uses, and there is deliberately no fallback",
    );
  }
  return { phoneNumber };
}

/**
 * Serve the contact card.
 *
 * Both headers are part of the MECHANISM, not decoration. `text/vcard` is what makes iOS and
 * Android hand the payload to Contacts instead of rendering it as a page of text, and the
 * `.vcf` filename in `Content-Disposition` is the half Android uses to pick the receiving
 * application. Getting either wrong fails SILENTLY — the link downloads something inert and
 * the tap appears to do nothing.
 *
 * Async only to match the route-handler shape its siblings use; it awaits nothing.
 */
export async function handleContactCardRequest(
  deps: ContactCardDeps,
): Promise<Response> {
  const card = renderContactCard({ phoneNumber: deps.phoneNumber });

  return new Response(card, {
    status: 200,
    headers: {
      "content-type": CONTACT_CARD_MEDIA_TYPE,
      "content-disposition": `attachment; filename="${CONTACT_CARD_FILENAME}"`,
    },
  });
}
