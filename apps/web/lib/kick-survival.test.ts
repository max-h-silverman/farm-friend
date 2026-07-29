import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// B-009 — post-response work must be DURABLE, not merely started.
//
// The defect this file exists to prevent, observed in production on 2026-07-27: two real
// inbound `HELP` messages were committed durably and acknowledged 200, and then nothing else
// ever happened. `provider_inbox_events` held both rows with `claimed_at` NULL, and
// `sender_states` / `outbox_work` / `outbox_dispatch_attempts` / `sms_consents` were all
// empty. The first missing step was the first step past the durable commit.
//
// THE DEFECT CLASS SURVIVES THE MIGRATION; ITS MECHANISM DOES NOT. On Vercel the cause was a
// floating promise the runtime never knew about, and `waitUntil` was the registration that
// fixed it — imperfectly, since a registered promise still shared the function timeout and
// was cancelled when it elapsed. On Cloud Run there is no `waitUntil` and no equivalent: work
// started after the response races container reclamation with no contract at all.
//
// So the answer is no longer "register the promise" but "make the work durable before
// responding". The Cloud Task exists in the queue before the handler returns; the queue then
// drives `/api/internal/kick` independently of this container's lifetime. This file asserts
// that shape, and refuses the shapes that would quietly restore the defect.
//
// These are SOURCE assertions for the reason B-009 taught: vitest runs in Node, where a
// floating promise DOES resolve, so a behavioural test cannot see this bug at all. That is
// precisely why the entire kick suite passed while production dropped every message.

const webhookSource = readFileSync(
  resolve(process.cwd(), "apps/web/app/api/sms/webhook/route.ts"),
  "utf8",
);

const webhookManifest = JSON.parse(
  readFileSync(resolve(process.cwd(), "apps/web/package.json"), "utf8"),
) as { dependencies?: Record<string, string> };

/**
 * The source reduced to EXECUTABLE CODE — imports and comments removed.
 *
 * This has now bitten three times in this repo, twice before today and once while writing
 * this file. The first draft of this test asserted `/waitUntil\s*\(/` against the whole file
 * and SURVIVED its own sabotage, because `import { waitUntil } from "@vercel/functions"`
 * satisfied the regex. Then `external-scheduler.test.ts` passed against a workflow that
 * accepted every HTTP status, because its loose alternation matched an unrelated flag.
 *
 * And then this file's own prohibition on `waitUntil(` matched the COMMENT above explaining
 * why `waitUntil` is absent — a test failing because the code was correctly documented.
 *
 * The general rule, stated once: a source assertion must be anchored to the construct it
 * claims to prove, never to vocabulary that appears near it. Prose about a construct is not
 * the construct. Strip everything that is not code before asserting over it.
 */
const webhookBody = webhookSource
  .replace(/^\s*import\s[\s\S]*?;\s*$/gm, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("post-response work is durable before the response", () => {
  it("makes the work durable rather than starting it in the background", () => {
    // The load-bearing assertion, and the direct descendant of the `waitUntil` check this
    // replaces. The work must be handed to the queue — which persists it — inside the
    // handler, not started alongside it.
    //
    // Sabotage check: change `await enqueueSenderWork(...)` to `void enqueueSenderWork(...)`
    // and this fails. That is the production defect in its Cloud Run form — the enqueue
    // would race container reclamation exactly as the old floating kick raced suspension.
    expect(webhookBody).toMatch(/await\s+enqueueSenderWork\s*\(/);
  });

  it("enqueues the sender's own work, not an unrelated task", () => {
    // Enqueueing *something* is not enough — it must carry the identifiers the worker needs
    // to find this sender's pending event. A task missing them would satisfy the check above
    // while leaving the inbound pass exactly as abandoned as before.
    // Anchored to the call's own argument list, which ends at `});` — the object literal
    // carrying the two identifiers.
    const call = webhookBody.match(/enqueueSenderWork\s*\(([\s\S]*?)\n\s*\}\);/);
    expect(call).not.toBeNull();
    expect(call?.[1]).toContain("senderHash");
    expect(call?.[1]).toContain("providerEventId");
  });

  it("does not depend on a platform primitive for post-response work", () => {
    // `waitUntil` does not exist on Cloud Run, and `after()` would reintroduce the same
    // cancellable-background-work model this migration removes. Either one here means the
    // durability question has been handed back to the platform.
    expect(webhookBody).not.toMatch(/waitUntil\s*\(/);
    expect(webhookBody).not.toMatch(/\bafter\s*\(/);
  });

  it("declares no dependency on the Vercel runtime", () => {
    // B-007/B-008's family: an undeclared or vestigial dependency resolves locally through
    // workspace hoisting and fails only in an isolated install — which is what a container
    // build is. `@vercel/functions` must be gone from both the source and the manifest.
    expect(webhookSource).not.toMatch(/@vercel\/functions/);
    expect(webhookManifest.dependencies ?? {}).not.toHaveProperty(
      "@vercel/functions",
    );
  });

  it("still builds the acknowledgement before the enqueue", () => {
    // Ordering is unchanged by the migration: the 200 is constructed first and owes nothing
    // to the queue's availability. Making the work durable must not reorder the commit.
    const ackIndex = webhookSource.indexOf("const acknowledgement");
    const enqueueIndex = webhookSource.indexOf("enqueueSenderWork(");
    expect(ackIndex).toBeGreaterThan(-1);
    expect(enqueueIndex).toBeGreaterThan(-1);
    expect(ackIndex).toBeLessThan(enqueueIndex);
  });
});

describe("the fast path still owns no guarantee", () => {
  it("keeps the scheduled trigger as the only trigger for the retention purge", () => {
    // The fast path fixes LATENCY. It must not acquire a durability role: the retention
    // purge (F-026) runs on the scheduled trigger alone, never per message.
    expect(webhookSource).not.toMatch(/runRetentionPass/);
  });

  it("does not make the acknowledgement conditional on the enqueue", () => {
    // The durable commit has already succeeded by this point. Turning an enqueue failure
    // into a non-200 would make Telnyx retry a message Farm Friend has already accepted —
    // which would turn a queue outage into a duplicate-message incident.
    const enqueueIndex = webhookSource.indexOf("enqueueSenderWork(");
    const afterEnqueue = webhookSource.slice(enqueueIndex);
    expect(afterEnqueue).toMatch(/return acknowledgement/);
  });
});
