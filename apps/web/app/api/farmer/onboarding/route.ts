import { publicReadContext } from "../../../../lib/public-context";
import {
  farmerOnboardingDeps,
  handleFarmerOnboardingAgreementPost,
} from "../../../../lib/farmer-onboarding";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const context = publicReadContext();
  return handleFarmerOnboardingAgreementPost(
    farmerOnboardingDeps({ db: context.db, clock: context.clock }),
    request,
  );
}
