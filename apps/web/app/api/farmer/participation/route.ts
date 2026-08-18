import { publicReadContext } from "../../../../lib/public-context";
import { handleFarmerParticipationPost } from "../../../../lib/farmer-settings";

// F-101 — a farmer pauses, resumes, or ends her own listing from her settings screen.
//
// The farmer-facing twin of `/api/admin/participation`, and thin for the same reason: the seam
// owns authority, locking, idempotence and invalidation. The only difference is who is acting —
// a link token here, a session there — and neither is ever taken from the request body.

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const context = publicReadContext();
  return handleFarmerParticipationPost(
    { db: context.db, clock: context.clock },
    request,
  );
}
