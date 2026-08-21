import { describe, expect, it } from "vitest";
import nextConfig from "../next.config.mjs";

/*
  THE PUBLIC MAP'S RESPONSE HEADERS.

  Reported by a farmer 2026-08-14: Webroot blocked the embedded map as phishing. What a
  reputation scanner sees is a third-party iframe on a community site pointing at a raw
  `*.run.app` subdomain with a random-looking string in the host, no domain history, and a
  response carrying no security headers at all — the shape of an injected-iframe attack. The
  `/admin/*` routes had a framing policy from the start; the map, the one surface the public
  actually loads, had none.

  Headers alone do not clear a reputation verdict — a custom domain is what addresses that —
  but a bare response is one of the signals, and until this the map could be framed by anyone
  anywhere. That is worth closing on its own.

  Asserted against the config Next actually exports rather than against a curl of production,
  so the rule cannot be quietly dropped in a refactor and noticed only by the next scanner.
*/
const rulesFor = async (path: string) => {
  const rules = (await nextConfig.headers?.()) ?? [];
  const rule = rules.find((candidate) => candidate.source === path);
  return new Map(
    (rule?.headers ?? []).map((header) => [header.key.toLowerCase(), header.value]),
  );
};

describe("public map response headers", () => {
  it("permits framing by VIGA and the app itself, and nobody else", async () => {
    const headers = await rulesFor("/:path*");
    expect(headers.get("content-security-policy")).toBe(
      "frame-ancestors 'self' https://vigavashon.org https://www.vigavashon.org",
    );
  });

  it("refuses content-type sniffing and trims the referrer", async () => {
    const headers = await rulesFor("/:path*");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  it("keeps the administrator policy the map rule must not weaken", async () => {
    /*
      The catch-all `/:path*` matches `/admin/...` too. Next applies EVERY matching rule, and
      two `Content-Security-Policy` headers on one response are intersected by the browser —
      so the admin pages keep their canonical-origin-only policy and cannot be loosened by the
      broader public-map rule.
      Asserted here because the failure would be silent: admin pages would still render.
    */
    const headers = await rulesFor("/admin/:path*");
    expect(headers.get("content-security-policy")).toBe(
      "frame-ancestors 'self' https://vigavashon.org",
    );
  });
});
