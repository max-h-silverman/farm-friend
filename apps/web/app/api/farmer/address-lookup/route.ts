import { appContext } from "../../../../lib/composition";
import {
  farmerAddressLookupDeps,
  handleAddressLookupPost,
} from "../../../../lib/farmer-address-lookup";

// F-068 — the DRAFT pin lookup for onboarding (max reopened the no-geocoder boundary for farm
// stand onboarding, 2026-08-05).
//
// The provider key is read HERE, server-side, from the composition root. It never reaches the
// browser: this route returns a coordinate and a status, and nothing else.
//
// The handler lives in lib/ because Next.js permits only its own fields as route exports; this
// file is the thin binding from the composition root to that handler.

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const context = appContext();
  return handleAddressLookupPost(
    farmerAddressLookupDeps({
      db: context.db,
      clock: context.clock,
      throttle: context.addressLookupThrottle,
      clientSignalSalt: context.config.phoneSalt,
      geocodingApiKey: context.config.geocodingApiKey,
    }),
    request,
  );
}
