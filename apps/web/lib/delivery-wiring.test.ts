import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// B-012 — the delivery pass is REACHABLE.
//
// This is the test whose absence WAS the bug. `applyPendingDeliveryEvent` existed, was
// correct, wrapped a well-tested transaction — and had zero callers. Nothing in the repo
// asserted that anything called it, so 20 delivery callbacks sat `pending` in production
// while every suite stayed green. That is the same claim-without-a-mechanism shape as
// F-023 (routing existed, nothing invoked it) and F-026 (the purge existed, nothing
// scheduled it), and it is the third time this repo has shipped it.
//
// Reachability is not something a behavioural test of the pass can establish: a test that
// calls `runDeliveryPass` directly proves the function, never the product. So it is
// asserted against SOURCE, in the same family as `retention-wiring.test.ts`,
// `cron-schedule.test.ts`, and `kick-survival.test.ts`.
//
// Every assertion here is anchored to the CONSTRUCT it claims to prove — the call site,
// the comparison — never to vocabulary that happens to appear nearby. Loose alternation
// is what let two assertions this week survive their own sabotage.

const routeSource = readFileSync(
  new URL("../app/api/internal/cron/route.ts", import.meta.url),
  "utf8",
);
const workersSource = readFileSync(
  new URL("./workers.ts", import.meta.url),
  "utf8",
);

/** `workers.ts` with its import block stripped. */
const workersBody = workersSource.slice(workersSource.lastIndexOf("\nimport "));

describe("the delivery pass runs on the one scheduled trigger", () => {
  it("is invoked from the cron route", () => {
    // Anchored to the awaited CALL, not to the identifier: an import line, a comment, or a
    // type annotation naming `runDeliveryPass` must not satisfy this.
    expect(routeSource).toMatch(/await runDeliveryPass\(/);
  });

  it("is imported from the shared workers module rather than reimplemented", () => {
    expect(routeSource).toMatch(
      /import\s*\{[^}]*runDeliveryPass[^}]*\}\s*from\s*"\.\.\/\.\.\/\.\.\/\.\.\/lib\/workers"/s,
    );
  });

  it("reports its counts in the trigger's response", () => {
    // An operator's only view of this pass is the cron response. A pass whose result is
    // computed and dropped is indistinguishable from one that never ran — which is exactly
    // how B-012 stayed invisible.
    const response = routeSource.slice(routeSource.indexOf("return Response.json("));
    expect(response).toMatch(/delivery/);
  });

  it("adds no second cron surface", () => {
    // One general mechanism (the zen-desk rule). A delivery-specific route or schedule
    // would be the second bespoke trigger, and B-012's own notes say the fourth pass
    // reuses the first's trigger.
    expect(workersSource).not.toMatch(/export async function (GET|POST)\b/);
    expect(routeSource).toMatch(/runInboundPass/);
    expect(routeSource).toMatch(/runOutboundPass/);
    expect(routeSource).toMatch(/runRetentionPass/);
  });

  it("enumerates its own work, taking no ID list from the trigger", () => {
    // What made the F-023 workers uncallable by a scheduler was a caller-supplied ID list:
    // a cron route has no way to know which callbacks are waiting.
    const call = routeSource.slice(routeSource.indexOf("runDeliveryPass("));
    const args = call.slice(0, call.indexOf("});") + 3);
    expect(args).not.toMatch(/Ids|ids:|\[\s*\]/);
    expect(args).toMatch(/db:/);
    expect(args).toMatch(/clock:/);
  });

  it("takes its instant from the injected clock, never the wall clock", () => {
    const pass = workersBody.slice(
      workersBody.indexOf("export async function runDeliveryPass"),
    );
    const body = pass.slice(0, pass.indexOf("\n}"));
    expect(body).toMatch(/deps\.clock\.now\(\)/);
    expect(body).not.toMatch(/new Date\(\)|Date\.now\(\)/);
  });
});

describe("the delivery pass does not enter conversation state", () => {
  /** The delivery pass implementation, isolated from the rest of the module. */
  const pass = (() => {
    const start = workersBody.indexOf("export async function runDeliveryPass");
    expect(start).toBeGreaterThan(-1);
    const rest = workersBody.slice(start);
    return rest.slice(0, rest.indexOf("\n}\n"));
  })();

  it("never locks or advances a sender's conversation state", () => {
    // A delivery callback is not per-sender conversational work. Routing it through the
    // `sender_states` lock would serialize unrelated carrier traffic behind a farmer's
    // conversation and could advance a watermark from an outbound event, which would
    // silently make a later inbound message look stale.
    expect(pass).not.toMatch(/sender_states/);
    expect(pass).not.toMatch(/conversation_occurred_at/);
    expect(pass).not.toMatch(/claimNextInboundEvent/);
  });

  it("selects only delivery event types", () => {
    // Claiming a `message_received` row here would steal conversational work from the
    // inbound pass and apply it as a delivery event.
    expect(pass).not.toMatch(/message_received/);
  });

  it("logs nothing", () => {
    // Delivery rows correlate to a recipient. Nothing on this path is logged, in keeping
    // with the same posture the retention pass holds.
    expect(pass).not.toMatch(/console\./);
  });
});
