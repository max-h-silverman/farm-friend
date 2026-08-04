import { describe, expect, it } from "vitest";
import nextConfig from "../next.config.mjs";
import { isTrustedAdminMutationSource } from "./admin-guard";

const APP_ORIGIN = "https://farm-friend-web-p5mfxfp5za-uw.a.run.app";

// Cloud Run terminates TLS at its proxy and forwards plain HTTP to the container, which binds
// `0.0.0.0:8080`. Next builds a route handler's `req.url` from that BIND address, not from the
// public `Host` header — verified against the real standalone server, which reported
// `https://localhost:8791/...` for a request carrying the public Host and `X-Forwarded-Proto`.
// So the request URL a deployed handler sees is `localhost:8080`, never the public origin.
//
// Every request below is therefore built the way production actually delivers it. The previous
// version of this test hand-built the URL as the public origin — a shape that never occurs
// behind the proxy — which is why it stayed green while every admin write 403'd in production.
const deployedRequest = (origin?: string, method = "POST") =>
  new Request("http://localhost:8080/api/admin/farms", {
    method,
    headers: {
      host: "farm-friend-web-p5mfxfp5za-uw.a.run.app",
      "x-forwarded-proto": "https",
      ...(origin === undefined ? {} : { origin }),
    },
  });

describe("embedded administrator security", () => {
  it("permits browser writes only when the admin app itself initiated them", () => {
    expect(isTrustedAdminMutationSource(deployedRequest(APP_ORIGIN), APP_ORIGIN)).toBe(true);
    expect(isTrustedAdminMutationSource(deployedRequest("https://www.vigavashon.org"), APP_ORIGIN)).toBe(false);
    expect(isTrustedAdminMutationSource(deployedRequest("https://attacker.example"), APP_ORIGIN)).toBe(false);
    expect(isTrustedAdminMutationSource(deployedRequest(), APP_ORIGIN)).toBe(false);
  });

  it("still permits page renders, which are exempt by method", () => {
    expect(isTrustedAdminMutationSource(deployedRequest(undefined, "GET"), APP_ORIGIN)).toBe(true);
  });

  it("refuses every write when the public origin is not configured", () => {
    // Fail closed: a missing/blank setting must never turn into "allow anything".
    expect(isTrustedAdminMutationSource(deployedRequest(APP_ORIGIN), undefined)).toBe(false);
    expect(isTrustedAdminMutationSource(deployedRequest(APP_ORIGIN), "")).toBe(false);
    expect(isTrustedAdminMutationSource(deployedRequest(APP_ORIGIN), "not a url")).toBe(false);
  });

  it("compares origins, not URL prefixes", () => {
    // A configured value carrying a path or trailing slash must still compare as an origin,
    // and a lookalike host must not pass.
    expect(isTrustedAdminMutationSource(deployedRequest(APP_ORIGIN), `${APP_ORIGIN}/admin`)).toBe(true);
    // Longer lookalike: caught by equality, and by any `expected === origin.slice(...)` variant.
    expect(
      isTrustedAdminMutationSource(
        deployedRequest("https://farm-friend-web-p5mfxfp5za-uw.a.run.app.evil.example"),
        APP_ORIGIN,
      ),
    ).toBe(false);
    // Shorter prefix of the real origin. This is the case a `startsWith` comparison lets
    // through: "https://farm-friend-web-p5mfxfp5za-uw.a.run.ap" is a prefix of the expected
    // origin, so only exact equality refuses it.
    expect(
      isTrustedAdminMutationSource(deployedRequest(APP_ORIGIN.slice(0, -1)), APP_ORIGIN),
    ).toBe(false);
    expect(isTrustedAdminMutationSource(deployedRequest("https://farm-friend-web"), APP_ORIGIN)).toBe(
      false,
    );
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
