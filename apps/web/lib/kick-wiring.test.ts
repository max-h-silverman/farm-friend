import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// B-004 / B-009, restated for Cloud Run — the fast path CANNOT delay or fail the
// acknowledgement, and it cannot be silently discarded either.
//
// These two hazards pull in opposite directions, which is why both are asserted here:
//
//   - Do too much before responding, and the inbound pass (a model call, a provider call)
//     ends up inside the request Telnyx is waiting on. That objection got an inline kick
//     rejected during F-023 planning and it still stands.
//   - Do it without making it durable, and the work is dropped when the container is
//     reclaimed. That is B-009 exactly: committed, acknowledged, never processed.
//
// `waitUntil` sat between the two and satisfied neither completely — it kept the invocation
// alive but shared its timeout, so the work was cancellable by construction. Enqueueing a
// Cloud Task satisfies both: one bounded API call before responding, after which the queue
// owns the work independently of this container.
//
// The end-to-end behaviour is proven against real Postgres in `latency.integration.test.ts`.
// What no behavioural test in vitest can prove is the ABSENCE of a shape — and Node resolves
// floating promises, which is exactly how the entire kick suite stayed green while production
// dropped every message. So the shape is asserted against the source, the same tripwire
// technique `cron-auth.test.ts` uses.

const routeSource = readFileSync(
  resolve(process.cwd(), "apps/web/app/api/sms/webhook/route.ts"),
  "utf8",
);

/**
 * The source with import statements stripped.
 *
 * Imports AND COMMENTS both removed. `kick-survival.test.ts`'s first draft asserted a bare
 * `/waitUntil\s*\(/` over the whole file and survived its own sabotage, because the import
 * line satisfied the regex. Writing this file reproduced the same trap a third way: the
 * prohibitions below matched the comments explaining why those constructs are absent. Prose
 * about a construct is not the construct — strip everything that is not code.
 */
const routeBody = routeSource
  .replace(/^\s*import\s[\s\S]*?;\s*$/gm, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("the webhook acknowledges before it enqueues", () => {
  it("constructs the acknowledgement before enqueueing", () => {
    // The inbound branch's 200 is BUILT before the enqueue begins, so the response owes
    // nothing to the queue's availability.
    const enqueueIndex = routeBody.indexOf("enqueueSenderWork(");
    expect(enqueueIndex).toBeGreaterThan(-1);

    const ackIndex = routeBody.indexOf("const acknowledgement");
    expect(ackIndex).toBeGreaterThan(-1);
    expect(ackIndex).toBeLessThan(enqueueIndex);
  });

  it("returns the acknowledgement that was built before the enqueue", () => {
    // The enqueue must not be allowed to change what is returned. If a future edit made the
    // response conditional on the enqueue result, an ingress whose durable commit already
    // succeeded could start returning non-2xx, and Telnyx would retry a message Farm Friend
    // has already accepted.
    const enqueueIndex = routeBody.indexOf("enqueueSenderWork(");
    const afterEnqueue = routeBody.slice(enqueueIndex);
    expect(afterEnqueue).toMatch(/return acknowledgement/);
  });
});

describe("the enqueue is awaited, and that is the point", () => {
  it("awaits the task creation", () => {
    // THE B-009 GUARD, inverted for this platform.
    //
    // On Vercel the rule was "never await" — the awaited thing would have been the passes
    // themselves. Here the awaited thing is only the task CREATION, one bounded call, and
    // awaiting it is what makes the work durable BEFORE the handler returns.
    //
    // A fire-and-forget enqueue would reintroduce B-009 precisely: a floating promise the
    // runtime may discard when the container is reclaimed, leaving a message committed,
    // acknowledged, and abandoned. Sabotage check: drop the `await` and this fails.
    expect(routeBody).toMatch(/await\s+enqueueSenderWork\(/);
  });

  it("does not register the enqueue as fire-and-forget background work", () => {
    // The specific regression to forbid. `void`, `waitUntil`, or `after` around the enqueue
    // would each hand the durability question back to the platform — which is the mistake
    // this migration exists to stop making.
    expect(routeBody).not.toMatch(/void\s+enqueueSenderWork/);
    expect(routeBody).not.toMatch(/waitUntil\s*\(/);
    expect(routeBody).not.toMatch(/\bafter\s*\(/);
  });

  it("does not run the passes inline in the webhook", () => {
    // The other direction. The webhook enqueues; the WORKER runs the passes. Calling
    // `kickSenderPasses` or a pass directly here would put a model call and a provider call
    // inside the request Telnyx is waiting on.
    expect(routeBody).not.toMatch(/kickSenderPasses\s*\(/);
    expect(routeBody).not.toMatch(/runInboundPass\s*\(/);
    expect(routeBody).not.toMatch(/runOutboundPass\s*\(/);
  });
});

describe("the fast path still owns no guarantee", () => {
  it("keeps the retention purge off the per-message path", () => {
    // F-026's purge runs on the scheduled trigger alone, never per message. If this fails,
    // the fast path has grown a durability role it is not built to keep.
    expect(routeSource).not.toMatch(/runRetentionPass/);
  });

  it("no longer depends on the Vercel runtime", () => {
    // The coupling this migration removes. `@vercel/functions` in this file would mean the
    // webhook still relies on a platform primitive that is not present on Cloud Run — where
    // it would not fail loudly, it would simply never run the work.
    expect(routeSource).not.toMatch(/@vercel\/functions/);
  });
});
