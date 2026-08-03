import { describe, expect, it } from "vitest";
import {
  buildInviteDeliveryUrl,
  inviteMessage,
  normalizeInvitePhone,
} from "./farmer-invite";

describe("farmer invite delivery", () => {
  const message = inviteMessage({
    farmName: "Example Farm",
    link: "https://farmfriend.example/farmer/onboarding/token",
  });

  it("normalizes the administrator's US phone before opening SMS", () => {
    expect(normalizeInvitePhone("(206) 555-0123")).toBe("+12065550123");
    expect(normalizeInvitePhone("555-0123")).toBeNull();
  });

  it("opens a prefilled text without requiring an SMS subscription", () => {
    expect(buildInviteDeliveryUrl("sms", "+12065550123", message)).toBe(
      `sms:+12065550123?body=${encodeURIComponent(message)}`,
    );
  });

  it("opens a prefilled email with the same onboarding link", () => {
    const result = buildInviteDeliveryUrl("email", "farmer@example.com", message);

    expect(result).toContain("mailto:farmer@example.com?");
    expect(result).toContain(`body=${encodeURIComponent(message)}`);
    expect(result).toContain(`subject=${encodeURIComponent("Join VIGA Farm Friend")}`);
  });

  it("describes an unbound invitation as new-farm onboarding", () => {
    expect(
      inviteMessage({
        farmName: null,
        link: "https://farmfriend.example/farmer/onboarding/token",
      }),
    ).toBe(
      "VIGA Farm Friend: You are invited to start farmer onboarding. " +
        "Open this link and follow the steps: https://farmfriend.example/farmer/onboarding/token",
    );
  });
});
