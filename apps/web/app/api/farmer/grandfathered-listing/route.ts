import { publicReadContext } from "../../../../lib/public-context";
import {
  grandfatheredListingDeps,
  handleGrandfatheredListingPost,
} from "../../../../lib/grandfathered-listing";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const context = publicReadContext();
  return handleGrandfatheredListingPost(
    grandfatheredListingDeps({ db: context.db, clock: context.clock }),
    request,
  );
}
