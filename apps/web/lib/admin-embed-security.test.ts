import { describe, expect, it } from "vitest";
import nextConfig from "../next.config.mjs";
import { isTrustedAdminMutationSource, requireAdministrator } from "./admin-guard";

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
  new Request("http://localhost:8080/api/admin/sellers", {
    method,
    headers: {
      host: "farm-friend-web-p5mfxfp5za-uw.a.run.app",
      "x-forwarded-proto": "https",
      ...(origin === undefined ? {} : { origin }),
    },
  });

/*
  Measured in production 2026-08-19: max opened the console at the `*.run.app` host, pressed
  "Prepare invite", and was told "Your session expired" — three times, each within seconds of a
  freshly issued and still-live session. The session was never the problem. `PUBLIC_BASE_URL` is
  the custom domain (F-113), so a write from the `run.app` origin fails the origin check, and
  BOTH refusals answered a bare `{ error: "forbidden" }` with status 403. The screen could not
  tell them apart and guessed the wrong one.

  A wrong diagnosis is worse than none: it sent the operator to sign in repeatedly, which could
  never work, while the real fix — open the console on the custom domain — went unconsidered.
  So the two refusals now name themselves, and the screen reads the name rather than the status.
*/
describe("what a refused administrator write says it is", () => {
  it("names a wrong-origin refusal as such, never as an expired session", async () => {
    const refusal = await requireAdministrator(
      deployedRequest("https://farm-friend-web-p5mfxfp5za-uw.a.run.app"),
      "https://farmfriend.vigavashon.org",
    );
    expect(refusal).toBeInstanceOf(Response);
    const response = refusal as Response;
    expect(response.status).toBe(403);
    expect(
      ((await response.json()) as { error?: string }).error,
      "the operator's next move is to use the right address, not to sign in again",
    ).toBe("wrong_origin");
  });

  it("still refuses, and says so, when the origin is right but nobody is signed in", async () => {
    // The other arm. Without it, "names a wrong-origin refusal" would also pass for a guard
    // that called every refusal `wrong_origin` and stranded a genuinely signed-out operator.
    const refusal = await requireAdministrator(
      deployedRequest("https://farmfriend.vigavashon.org"),
      "https://farmfriend.vigavashon.org",
    );
    expect(refusal).toBeInstanceOf(Response);
    const response = refusal as Response;
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error?: string }).error).toBe("not_signed_in");
  });
});

describe("embedded administrator security", () => {
  it("permits browser writes only from the app itself or VIGA's one embedded console", () => {
    expect(isTrustedAdminMutationSource(deployedRequest(APP_ORIGIN), APP_ORIGIN)).toBe(true);
    expect(
      isTrustedAdminMutationSource(deployedRequest("https://vigavashon.org"), APP_ORIGIN),
    ).toBe(true);
    expect(
      isTrustedAdminMutationSource(deployedRequest("https://www.vigavashon.org"), APP_ORIGIN),
    ).toBe(false);
    expect(
      isTrustedAdminMutationSource(deployedRequest("https://attacker.example"), APP_ORIGIN),
    ).toBe(false);
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

    expect(policy).toBe("frame-ancestors 'self' https://vigavashon.org");
  });
});
