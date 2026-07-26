import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// B-004 — the kick is wired so it CANNOT delay or fail the acknowledgement.
//
// The end-to-end behaviour is proven against real Postgres in `latency.integration.test.ts`.
// What that suite cannot prove is the absence of a shape: an `await` in front of the kick
// would still pass every behavioural assertion while putting the inbound pass — a model
// call, an SMS provider call — inside the request Telnyx is waiting on. That is the exact
// objection which got an inline kick rejected during F-023 planning, and it is a property
// of the source, so it is asserted against the source.
//
// This is the same tripwire technique `cron-auth.test.ts` uses for the auth bypass, and for
// the same reason: what must not exist is a construct, and no single execution can
// demonstrate that a construct appears nowhere.

const routeSource = readFileSync(
  resolve(process.cwd(), "apps/web/app/api/sms/webhook/route.ts"),
  "utf8",
);

describe("the webhook acknowledges before it kicks", () => {
  it("constructs the acknowledgement before starting the kick", () => {
    // Ordering in the source: the inbound branch's 200 is BUILT before the kick begins, so
    // the response owes nothing to the kick's outcome.
    const kickIndex = routeSource.indexOf("kickSenderPasses(");
    expect(kickIndex).toBeGreaterThan(-1);

    const ackIndex = routeSource.indexOf("const acknowledgement");
    expect(ackIndex).toBeGreaterThan(-1);
    expect(ackIndex).toBeLessThan(kickIndex);
  });

  it("starts the kick with an explicitly discarded promise", () => {
    // `void` marks the floating call as deliberate rather than a forgotten `await` — the
    // distinction this whole design rests on.
    expect(routeSource).toMatch(/void\s+kickSenderPasses\(/);
  });

  it("never awaits the kick", () => {
    // `await kickSenderPasses(...)` would hold the response open for the whole inbound
    // pass — model call, provider call and all — which is precisely what must not happen.
    expect(routeSource).not.toMatch(/await\s+kickSenderPasses/);
  });

  it("attaches a rejection handler to the floating kick", () => {
    // A floating promise with no handler is an unhandled rejection, which some runtimes
    // treat as a fatal invocation error. `kickSenderPasses` already swallows internally;
    // this is the belt-and-braces the route owes a promise it deliberately does not await.
    const kickIndex = routeSource.indexOf("void kickSenderPasses(");
    expect(kickIndex).toBeGreaterThan(-1);
    // The `.catch` must attach to the kick, before the handler returns the response.
    const afterKick = routeSource.slice(kickIndex);
    const catchIndex = afterKick.indexOf(".catch(");
    const returnIndex = afterKick.indexOf("return acknowledgement");
    expect(catchIndex).toBeGreaterThan(-1);
    expect(catchIndex).toBeLessThan(returnIndex);
  });
});
