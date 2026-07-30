import {
  contactCardConfig,
  handleContactCardRequest,
} from "../../../../lib/contact-card";

// One-tap "add Farm Friend to contacts" (F-039) — the served vCard.
//
// Every SMS journey in this product starts with a number the person does not have saved: they
// read ten digits off a sign, a poster, or the map and type them in. This route removes that
// step. Served as `text/vcard`, it opens the native add-contact sheet on iOS and Android.
//
// It is the THINNEST public route in the app, and deliberately so — configuration in, static
// text out:
//
//   - **No database.** It imports neither `appContext` nor `publicReadContext`. There is
//     nothing to read; opening a connection pool to serve a constant would be waste, and
//     importing the full context would drag the model package into a public route's module
//     graph (F-019, policed by `lib/public-surface-model-free.test.ts`).
//   - **No model, no throttle.** Nothing here is expensive or consequential. The reasoning for
//     both is written out in `lib/contact-card.ts`.
//   - **No consent implication.** Saving a contact is device-local; it grants nothing and
//     records nothing, and is emphatically not `JOIN`.
//
// The handler lives in lib/ because Next.js permits only its own fields as route exports; this
// file is the thin binding from configuration to that handler, matching `stands/` and
// `stock-out/`.
//
// `force-dynamic` because the card is built from an environment variable read at request time.
// A statically-optimized response would bake in whatever the number was at BUILD time, which is
// precisely the drift this item exists to prevent — and it would be invisible, since the card
// would still download and still open the sheet.

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return handleContactCardRequest(contactCardConfig());
}
