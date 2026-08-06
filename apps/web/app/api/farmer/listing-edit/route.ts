import { publicReadContext } from "../../../../lib/public-context";
import {
  farmerListingEditDeps,
  handleFarmerListingEditPost,
} from "../../../../lib/farmer-listing-edit";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const context = publicReadContext();
  return handleFarmerListingEditPost(
    farmerListingEditDeps({ db: context.db, clock: context.clock }),
    request,
  );
}
