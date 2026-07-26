import { appContext } from "../../../../lib/composition";
import { handleStandsRequest } from "../../../../lib/public-listing";

// Public discovery — ungated, anonymous, MODEL-FREE, and deliberately NOT throttled.
//
// This is the read side of F-019's channel boundary. It answers "what is at the stands
// right now" from the same published revisions SMS reads, with the same recency wording.
// It accepts no free-text question: natural-language inquiry is SMS-only at launch, so
// there is no query parameter here for a customer to ask something into.
//
// No throttle by design. Ordinary browsing costs a database query, not a model call, and
// rate-capping a customer for reading the map would be a product failure wearing a safety
// label (docs/ARCHITECTURE.md §"Abuse / cost throttle").
//
// The handler lives in lib/ because Next.js permits only its own fields as route exports;
// this file is the thin binding from the composition root to that handler.

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const context = appContext();
  return handleStandsRequest({ db: context.db, clock: context.clock });
}
