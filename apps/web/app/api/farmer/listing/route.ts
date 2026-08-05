import { publicReadContext } from "../../../../lib/public-context";
import {
  farmerListingDeps,
  handleFarmerListingPost,
} from "../../../../lib/farmer-listing";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const context = publicReadContext();
  return handleFarmerListingPost(
    farmerListingDeps({ db: context.db, clock: context.clock }),
    request,
  );
}
