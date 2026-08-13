import {
  contactCardConfig,
  handleContactCardRequest,
} from "../../../../lib/contact-card";

// The contact card's ORIGINAL path (F-039), kept serving permanently (B-052).
//
// The card now lives at `/viga-farm-friend`, because iOS titles a message preview from the
// URL's last path segment and this one published `contact-card` — an implementation name — into
// farmers' threads. See `app/viga-farm-friend/route.ts` for that reasoning.
//
// ## Why this file did not move
//
// Every card Farm Friend has already texted points here, in messages nobody can edit or recall.
// A farmer scrolling back to a text they were told to tap must still get a working card, so
// this path is a permanent obligation rather than a deprecation with a sunset.
//
// **It serves rather than redirects.** A redirect adds a hop that some message clients follow
// badly when the destination is a file download, and the failure mode is the silent one this
// whole feature exists to avoid — a tap that appears to do nothing. Serving directly costs one
// binding and cannot regress.
//
// It stays a delegation, never a second renderer: same `handleContactCardRequest`, same
// configuration, byte-identical card. A card that drifted between the two doors would be
// invisible — both taps still open an add-contact sheet.
//
// Nothing new should link here. `CONTACT_CARD_PATH` is what every surface derives its tap
// target from, and it points at the readable path.

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return handleContactCardRequest(contactCardConfig());
}
