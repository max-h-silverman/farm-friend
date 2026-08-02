import { describe, expect, it } from "vitest";
import {
  ADMIN_SESSION_COOKIE,
  clearSessionCookie,
  serializeSessionCookie,
  sessionTokenFromRequest,
} from "./admin-auth";

// F-025a — how the browser carries an admin session, and how the server reads it back.
//
// The session token is an opaque bearer credential, so the cookie's attributes are the whole
// of its transport security. They are asserted here rather than trusted to review.

function requestWithCookie(cookie: string): Request {
  return new Request("https://farmfriend.example/admin", {
    headers: { cookie },
  });
}

describe("admin session cookie", () => {
  it("reads the session token from the cookie header", () => {
    const token = "a".repeat(64);
    expect(
      sessionTokenFromRequest(
        requestWithCookie(`${ADMIN_SESSION_COOKIE}=${token}`),
      ),
    ).toBe(token);
  });

  it("finds the session among other cookies, in any position", () => {
    const token = "b".repeat(64);
    expect(
      sessionTokenFromRequest(
        requestWithCookie(`theme=dark; ${ADMIN_SESSION_COOKIE}=${token}; x=1`),
      ),
    ).toBe(token);
    expect(
      sessionTokenFromRequest(
        requestWithCookie(`${ADMIN_SESSION_COOKIE}=${token}; theme=dark`),
      ),
    ).toBe(token);
  });

  it("returns null when there is no session cookie", () => {
    expect(
      sessionTokenFromRequest(new Request("https://farmfriend.example/admin")),
    ).toBeNull();
    expect(sessionTokenFromRequest(requestWithCookie("theme=dark"))).toBeNull();
    expect(
      sessionTokenFromRequest(requestWithCookie(`${ADMIN_SESSION_COOKIE}=`)),
    ).toBeNull();
  });

  it("does not confuse a cookie whose name merely ends with the session name", () => {
    // `not_ff_admin_session=…` must not be read as the session: a prefix-matching parser
    // would let an attacker-set cookie name supply the credential.
    const token = "c".repeat(64);
    expect(
      sessionTokenFromRequest(
        requestWithCookie(`not_${ADMIN_SESSION_COOKIE}=${token}`),
      ),
    ).toBeNull();
  });

  it("sets the session cookie with every attribute that protects a bearer token", () => {
    const cookie = serializeSessionCookie("d".repeat(64), 3_600_000);

    // HttpOnly: script cannot read an operator's credential (XSS containment).
    expect(cookie).toMatch(/HttpOnly/i);
    // Secure: never sent over plaintext.
    expect(cookie).toMatch(/Secure/i);
    // The admin is embedded from the Cloud Run origin inside VIGA's Squarespace site.
    // `None` permits that cross-site iframe; `Partitioned` confines the credential to
    // that one top-level site rather than making it a general third-party cookie.
    expect(cookie).toMatch(/SameSite=None/i);
    expect(cookie).toMatch(/Partitioned/i);
    // Scoped to the whole app, and bounded — a session cookie that outlives its database
    // record is a confusing dead credential in the browser.
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=3600\b/);
    expect(cookie).toContain(`${ADMIN_SESSION_COOKIE}=${"d".repeat(64)}`);
  });

  it("clears the session cookie by expiring it immediately", () => {
    const cookie = clearSessionCookie();
    expect(cookie).toMatch(/Max-Age=0/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=None/i);
    expect(cookie).toMatch(/Partitioned/i);
    expect(cookie).toContain(`${ADMIN_SESSION_COOKIE}=;`);
  });

  it("never puts the token in a place a log would capture", () => {
    // The credential travels in a cookie, never a query string or a path — both of which
    // are routinely logged by proxies and analytics.
    const cookie = serializeSessionCookie("e".repeat(64), 1000);
    expect(cookie.startsWith(`${ADMIN_SESSION_COOKIE}=`)).toBe(true);
  });
});
