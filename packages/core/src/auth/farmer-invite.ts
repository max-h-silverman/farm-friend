import { createHash, randomBytes } from "node:crypto";

/** One-use material for an administrator-created farmer onboarding invitation. */
export function issueFarmerInviteToken(): string {
  return randomBytes(32).toString("hex");
}

/** Store only the hash of the invitation token; the URL is the one readable copy. */
export function hashFarmerInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Build the public onboarding URL from the configured origin, never a request host. */
export function farmerInviteUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/farmer/onboarding/${encodeURIComponent(token)}`;
}
