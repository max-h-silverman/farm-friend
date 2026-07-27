import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// F-032 — the request-link ROUTE is wired to the guarantees the handler provides.
//
// The handler suite proves behavior over injected dependencies. That leaves one gap a
// behavioral test cannot close: a route that forgets to pass the throttle, or passes the
// wrong one, or builds the link from the request. Those are wiring mistakes, and what must
// not exist is a line of code — so they are asserted against the route SOURCE, the same
// technique `cron-auth.test.ts` uses to prove the absence of a development bypass.

const routeSource = readFileSync(
  resolve(process.cwd(), "apps/web/app/api/auth/request-link/route.ts"),
  "utf8",
);

const handlerSource = readFileSync(
  resolve(process.cwd(), "apps/web/lib/request-link.ts"),
  "utf8",
);

describe("the request-link route is wired correctly", () => {
  it("passes the sign-in throttle, not the stock-out one", () => {
    // Sharing the stock-out budget would let anonymous QR traffic from a shared NAT exhaust
    // a real operator's ability to sign in.
    expect(routeSource).toContain("context.signInThrottle");
    expect(routeSource).not.toContain("publicActionThrottle");
  });

  it("builds links from configured config, never from the request", () => {
    expect(routeSource).toContain("context.config.publicBaseUrl");
  });

  it("injects a narrow predicate rather than a database handle", () => {
    // The handler's job is to make every address indistinguishable. Handing it query
    // capability would invite a later change that returns a row and lets some detail of it
    // reach the response.
    expect(routeSource).toContain("isAdministrator");
    expect(routeSource).not.toMatch(/\bdb,\s*$/m);
  });
});

describe("the handler cannot leak a link through a log", () => {
  it("contains no console call at all", () => {
    // A vendor SDK routinely attaches the request payload — containing the live sign-in link
    // — to the error it throws. There is no safe console call on this path, so the rule is
    // simply that there are none.
    expect(handlerSource).not.toMatch(/console\s*\./);
  });

  it("does not derive the origin from a request header", () => {
    // `Host:` is attacker-controlled. A link built from it would have Farm Friend mail a real
    // operator a working-looking link pointing at the attacker's origin.
    expect(handlerSource).not.toMatch(/headers\.get\(\s*["'`]host/i);
    expect(handlerSource).not.toMatch(/x-forwarded-host/i);
  });
});
