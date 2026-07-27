import { findAdministratorByEmail } from "@farm-friend/db";
import { appContext } from "../../../../lib/composition";
import { publicReadContext } from "../../../../lib/public-context";
import { handleRequestLinkRequest } from "../../../../lib/request-link";

// The public "send me a sign-in link" endpoint (F-032).
//
// The handler lives in lib/ because Next.js permits only its own fields as route exports;
// this file is the thin binding from the composition root to that handler, matching the QR
// stock-out route.
//
// `isAdministrator` is injected as a narrow predicate rather than handing the handler a
// database. The handler's job is to make an address indistinguishable from every other
// address, and it needs exactly one bit to do that — giving it query capability would invite
// a future change that returns a row and lets some detail of it reach the response.

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const context = appContext();
  const { db } = publicReadContext();

  return handleRequestLinkRequest(req, {
    clock: context.clock,
    mail: context.mail,
    throttle: context.signInThrottle,
    magicLinkSecret: context.config.magicLinkSecret,
    signalSalt: context.config.phoneSalt,
    baseUrl: context.config.publicBaseUrl,
    isAdministrator: async (email) =>
      (await findAdministratorByEmail(db, email)) !== null,
  });
}
