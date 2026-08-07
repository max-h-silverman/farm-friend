"use client";

import { useRouter } from "next/navigation";
import { EmailStep } from "../email-step";

/**
 * F-079 — bridges the email step to the server's view of the grant.
 *
 * On success it REFRESHES rather than revealing the form client-side. The grant lives in an
 * HttpOnly cookie the server resolves per request, so the server has to be the one that decides
 * the listing form may be shown — a client flipping its own state would render a form whose
 * submit the boundary would refuse anyway.
 */
export function VerifyGate({ farmId, farmName }: { farmId: string; farmName: string }) {
  const router = useRouter();
  return (
    <EmailStep farmId={farmId} farmName={farmName} onVerified={() => router.refresh()} />
  );
}
