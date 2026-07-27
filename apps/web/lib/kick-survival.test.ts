import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// B-009 — the kick must be REGISTERED with the runtime, not merely started.
//
// The defect this file exists to prevent, observed in production on 2026-07-27: two real
// inbound `HELP` messages were committed durably and acknowledged 200, and then nothing
// else ever happened. `provider_inbox_events` held both rows with `claimed_at` NULL,
// `sender_states` / `outbox_work` / `outbox_dispatch_attempts` / `sms_consents` were all
// empty. The first missing step was the first step past the durable commit.
//
// The cause is a platform contract, not a logic error. `void kickSenderPasses(...)` starts
// work the runtime knows nothing about; once the handler returns its response, Vercel is
// free to suspend or reclaim the invocation, and the floating promise gets no reliable
// execution time. Vercel's own reference says it outright: "If you don't await an
// asynchronous operation, the serverless function might be shut down before the operation
// is complete." `waitUntil` is the registration that extends the invocation's lifetime.
//
// This is a SOURCE test for the same reason `kick-wiring.test.ts` and `cron-auth.test.ts`
// are: what must exist is a construct at a specific place, and no in-process execution can
// demonstrate it. Vitest runs in Node, where a floating promise DOES resolve — which is
// precisely why the entire existing kick suite passed while production dropped every
// message. A behavioural test in this runtime cannot see this bug at all.
//
// Note `after()` from `next/server` is the modern equivalent, but it requires Next 15.1+;
// this app is on Next 14, so `waitUntil` is the correct primitive here. If Next is ever
// upgraded past 15.1, `after()` may replace it — the assertion below permits either, since
// what matters is that the work is registered, not which API registers it.

const webhookSource = readFileSync(
  resolve(process.cwd(), "apps/web/app/api/sms/webhook/route.ts"),
  "utf8",
);

const webhookManifest = JSON.parse(
  readFileSync(resolve(process.cwd(), "apps/web/package.json"), "utf8"),
) as { dependencies?: Record<string, string> };

/**
 * The source with import statements stripped.
 *
 * The first draft of this test asserted `/waitUntil\s*\(/` against the whole file and
 * SURVIVED its own sabotage: reverting the call site to a bare `void` still left
 * `import { waitUntil } from "@vercel/functions"` at the top, which the regex happily
 * matched. The test would have shipped a guarantee it did not hold. Registration is a
 * property of the CALL SITE, so the import must not be allowed to satisfy it.
 */
const webhookBody = webhookSource.replace(/^\s*import\s[\s\S]*?;\s*$/gm, "");

describe("the kick survives the response", () => {
  it("registers the kick with the runtime rather than merely starting it", () => {
    // The load-bearing assertion. Sabotage check: revert the route to a bare
    // `void kickSenderPasses(...)` and this fails, which is the production defect exactly.
    const registered =
      /waitUntil\s*\(/.test(webhookBody) || /\bafter\s*\(/.test(webhookBody);
    expect(registered).toBe(true);
  });

  it("passes the kick itself to the runtime, not an unrelated promise", () => {
    // Registering *something* is not enough — it must be the kick whose lifetime is
    // extended. A `waitUntil` around some other promise would satisfy the check above
    // while leaving the inbound pass exactly as abandoned as before.
    const registration = webhookBody.match(
      /(?:waitUntil|after)\s*\(([\s\S]*?)\n\s*\);/,
    );
    expect(registration).not.toBeNull();
    expect(registration?.[1]).toContain("kickSenderPasses");
  });

  it("declares the package the registration comes from", () => {
    // B-007/B-008's family: npm workspaces hoisting means an undeclared dependency
    // resolves locally and fails only in an isolated install — which is what a deploy is.
    // A `waitUntil` import that is not declared here would break the build that matters
    // and no other suite would notice.
    if (/@vercel\/functions/.test(webhookSource)) {
      expect(webhookManifest.dependencies ?? {}).toHaveProperty(
        "@vercel/functions",
      );
    }
  });

  it("still never awaits the kick", () => {
    // The fix must not become a regression in the other direction. `waitUntil` extends the
    // invocation's lifetime WITHOUT holding the response open; `await` would put the whole
    // inbound pass — model call, provider call and all — inside the request Telnyx waits
    // on. That is the objection which got an inline kick rejected during F-023 planning,
    // and it stays rejected.
    expect(webhookSource).not.toMatch(/await\s+kickSenderPasses/);
  });

  it("still builds the acknowledgement before registering the kick", () => {
    // Ordering is unchanged by B-009: the 200 is constructed first and owes nothing to the
    // kick's outcome. Registration extends the invocation; it must not reorder the commit.
    const ackIndex = webhookSource.indexOf("const acknowledgement");
    const kickIndex = webhookSource.indexOf("kickSenderPasses(");
    expect(ackIndex).toBeGreaterThan(-1);
    expect(kickIndex).toBeGreaterThan(-1);
    expect(ackIndex).toBeLessThan(kickIndex);
  });
});

describe("the kick still owns no guarantee", () => {
  it("keeps cron as the only trigger for the retention purge", () => {
    // B-009 fixes the kick's LATENCY role. It must not acquire a durability role: the
    // retention purge (F-026) runs on the scheduled trigger alone, never per-message.
    // If this ever fails, the kick has grown a guarantee it is not built to keep.
    expect(webhookSource).not.toMatch(/runRetentionPass/);
  });

  it("does not make the acknowledgement conditional on the kick", () => {
    // The durable commit has already succeeded by this point. Turning a kick failure into
    // a non-200 would make Telnyx retry a message Farm Friend has already accepted.
    const kickIndex = webhookSource.indexOf("kickSenderPasses(");
    const afterKick = webhookSource.slice(kickIndex);
    expect(afterKick).toMatch(/return acknowledgement/);
  });
});
