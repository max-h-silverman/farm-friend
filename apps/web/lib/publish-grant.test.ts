import { describe, expect, it } from "vitest";

import {
  PUBLISH_GRANT_COOKIE,
  clearPublishGrantCookie,
  grantTokenFromRequest,
  serializePublishGrantCookie,
} from "./publish-grant";

function withCookie(header: string): Request {
  return new Request("https://example.test/farmer", { headers: { cookie: header } });
}

describe("the publish grant cookie", () => {
  it("round-trips a token", () => {
    const cookie = serializePublishGrantCookie("abc123", 1_800_000);
    expect(cookie.startsWith(`${PUBLISH_GRANT_COOKIE}=abc123`)).toBe(true);
    expect(grantTokenFromRequest(withCookie(`${PUBLISH_GRANT_COOKIE}=abc123`))).toBe("abc123");
  });

  it("is HttpOnly, Secure, and SameSite=Lax", () => {
    // The grant lets its holder publish onto VIGA's public map, so these attributes are its
    // whole transport security, exactly as they are for the admin session.
    //
    // **`Lax`, NOT the admin cookie's `None`** — and the difference is deliberate rather than
    // an oversight. The admin surface is intentionally embedded in VIGA's Squarespace page and
    // needs `None` to survive the iframe. The farmer's verification flow is not embedded
    // anywhere, so `Lax` is available, and it is the stronger choice: it means another site
    // cannot cause a publish with the farmer's grant riding along.
    const cookie = serializePublishGrantCookie("abc123", 1_800_000);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("carries a Max-Age, so an abandoned grant does not sit in the browser", () => {
    expect(serializePublishGrantCookie("abc123", 1_800_000)).toContain("Max-Age=1800");
  });

  it("parses whole name=value pairs, never a substring", () => {
    // A prefix match would let an attacker-set `not_ff_publish_grant=…` supply the credential.
    expect(grantTokenFromRequest(withCookie(`not_${PUBLISH_GRANT_COOKIE}=evil`))).toBeNull();
    expect(
      grantTokenFromRequest(withCookie(`not_${PUBLISH_GRANT_COOKIE}=evil; ${PUBLISH_GRANT_COOKIE}=real`)),
    ).toBe("real");
  });

  it("returns null when the cookie is absent or empty", () => {
    expect(grantTokenFromRequest(new Request("https://example.test/farmer"))).toBeNull();
    expect(grantTokenFromRequest(withCookie(`${PUBLISH_GRANT_COOKIE}=`))).toBeNull();
  });

  it("clears with Max-Age=0 and the same attributes", () => {
    const cleared = clearPublishGrantCookie();
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("HttpOnly");
    expect(cleared).toContain("SameSite=Lax");
  });
});
