import { createPublicActionThrottle } from "@farm-friend/core";
import { publicReadContext } from "../../../../lib/public-context";
import {
  farmerLinkRequestConfig,
  farmerLinkRequestDeps,
  handleFarmerLinkRequestPost,
} from "../../../../lib/farmer-link-request";

// F-073 — "text me my update link", from the public farm picker.
//
// **Built from `publicReadContext`, NOT the full composition root**, and the difference is not
// cosmetic. `appContext()` validates every configured surface — SMS credentials, the model
// provider, the public map URL — so binding this route to it made an unauthenticated farmer
// page fail with a 500 when an unrelated variable was missing. Caught by RUNNING it: every test
// injects these dependencies, so no test could see the composition.

export const dynamic = "force-dynamic";

/**
 * Rationing for a route that SENDS A TEXT on every accepted request.
 *
 * Module scope, so the window is shared across requests in a process — building it per request
 * would admit every caller and ration nothing. Tighter than the address lookup's twenty: a
 * farmer asks for their link once and then reads their phone, and each admitted request costs a
 * message and buzzes a real handset.
 */
const throttle = createPublicActionThrottle({
  clock: publicReadContext().clock,
  limit: 5,
  windowMs: 60_000,
});

export async function POST(request: Request): Promise<Response> {
  const context = publicReadContext();
  const config = farmerLinkRequestConfig(process.env);
  return handleFarmerLinkRequestPost(
    farmerLinkRequestDeps({
      db: context.db,
      clock: context.clock,
      throttle,
      phoneSalt: config.phoneSalt,
      // The same salt, used for a different purpose: a coarse rate bucket, never identity.
      clientSignalSalt: config.phoneSalt,
      publicBaseUrl: config.publicBaseUrl,
    }),
    request,
  );
}
