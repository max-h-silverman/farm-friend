import { describe, expect, it } from "vitest";
import {
  farmerInviteUrl,
  hashFarmerInviteToken,
  issueFarmerInviteToken,
} from "./farmer-invite";

describe("farmer invitations", () => {
  it("issues opaque material and hashes it for storage", () => {
    const token = issueFarmerInviteToken();

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(hashFarmerInviteToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashFarmerInviteToken(token)).not.toBe(token);
  });

  it("builds the onboarding URL from the configured origin", () => {
    expect(farmerInviteUrl("https://farmfriend.example/", "abc123")).toBe(
      "https://farmfriend.example/farmer/onboarding/abc123",
    );
  });
});
