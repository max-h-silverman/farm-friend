import { describe, expect, it } from "vitest";
import nextConfig from "../next.config.mjs";
import { isTrustedAdminMutationSource } from "./admin-guard";

const APP_ORIGIN = "https://farm-friend-web-p5mfxfp5za-uw.a.run.app";

describe("embedded administrator security", () => {
  it("permits browser writes only when the admin app itself initiated them", () => {
    const request = (origin?: string) =>
      new Request(`${APP_ORIGIN}/api/admin/farms`, {
        method: "POST",
        headers: origin === undefined ? {} : { origin },
      });

    expect(isTrustedAdminMutationSource(request(APP_ORIGIN))).toBe(true);
    expect(isTrustedAdminMutationSource(request("https://www.vigavashon.org"))).toBe(false);
    expect(isTrustedAdminMutationSource(request("https://attacker.example"))).toBe(false);
    expect(isTrustedAdminMutationSource(request())).toBe(false);
  });

  it("allows only the app itself and VIGA to frame administrator pages", async () => {
    const rules = await nextConfig.headers?.();
    const adminRule = rules?.find((rule) => rule.source === "/admin/:path*");
    const policy = adminRule?.headers.find(
      (header) => header.key.toLowerCase() === "content-security-policy",
    )?.value;

    expect(policy).toBe(
      "frame-ancestors 'self' https://vigavashon.org https://www.vigavashon.org",
    );
  });
});
