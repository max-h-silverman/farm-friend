import { appContext } from "../../../../lib/composition";
import { handleStockOutRequest } from "../../../../lib/public-stockout";

// The QR stock-out form — the ONE public unauthenticated model-backed handler at launch,
// and therefore the only thing behind the abuse/cost throttle (F-019).
//
// The sales location is bound by the REQUEST BODY's opaque identifier, which the QR code
// carries, and is then validated against real rows before anything else happens. The farmer
// recipient is resolved in code from that location. Neither ever comes from model output.
//
// The handler lives in lib/ because Next.js permits only its own fields as route exports;
// this file is the thin binding from the composition root to that handler.

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const context = appContext();
  return handleStockOutRequest(req, {
    db: context.db,
    model: context.stockOut,
    clock: context.clock,
    throttle: context.publicActionThrottle,
    signalSalt: context.config.phoneSalt,
  });
}
