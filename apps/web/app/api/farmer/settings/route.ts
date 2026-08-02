import { publicReadContext } from "../../../../lib/public-context";
import { handleFarmerSettingsPost } from "../../../../lib/farmer-settings";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const context = publicReadContext();
  return handleFarmerSettingsPost(
    { db: context.db, clock: context.clock },
    request,
  );
}
