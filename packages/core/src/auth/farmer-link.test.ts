import { describe, expect, it } from "vitest";
import { farmerSettingsUrl } from "./farmer-link";

describe("farmer standing-link URLs", () => {
  it("opens settings under the same exact standing credential", () => {
    expect(farmerSettingsUrl("https://farmfriend.example/", "abc/def")).toBe(
      "https://farmfriend.example/stand/abc%2Fdef/settings",
    );
  });
});
