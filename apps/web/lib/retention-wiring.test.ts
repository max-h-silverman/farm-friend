import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// F-026 — the retention purge is REACHABLE and SILENT.
//
// The purge being correct is proven against real Postgres in
// `packages/db/src/retention.integration.test.ts`. These tests own the two properties that
// suite cannot see, both of which are exactly the failure mode this repo keeps hitting:
//
//   1. it is actually INVOKED on the schedule. F-023 existed because `runInboundPass` was
//      correct and unreachable — a passing suite proved a function, not a product. A purge
//      nothing calls is the same claim-without-a-mechanism that F-026 exists to fix.
//   2. it LOGS NOTHING. A purge that reported what it deleted would defeat its own purpose,
//      and "no raw phone or body content is logged by the purge itself" is an acceptance
//      criterion, so it is asserted rather than assumed.
//
// Both are asserted against SOURCE. Property 1 is about a call existing in the one trigger;
// property 2 is about a statement not existing anywhere on the path. Neither is something a
// behavioural test of the function could establish.

const routeSource = readFileSync(
  new URL("../app/api/internal/cron/route.ts", import.meta.url),
  "utf8",
);
const workersSource = readFileSync(
  new URL("./workers.ts", import.meta.url),
  "utf8",
);
const transactionsSource = readFileSync(
  new URL("../../../packages/db/src/transactions.ts", import.meta.url),
  "utf8",
);

describe("the retention purge runs on the one scheduled trigger", () => {
  it("is invoked from the cron route", () => {
    expect(routeSource).toMatch(/await runRetentionPass\(/);
  });

  it("is imported from the shared workers module rather than reimplemented", () => {
    expect(routeSource).toMatch(
      /import\s*\{[^}]*runRetentionPass[^}]*\}\s*from\s*"\.\.\/\.\.\/\.\.\/\.\.\/lib\/workers"/s,
    );
  });

  it("adds no second cron surface", () => {
    // One general mechanism. A retention-specific route, schedule, or trigger would be the
    // second bespoke mechanism CLAUDE.md's zen-desk rule rejects, and F-026's own scope
    // says the second scheduled job reuses the first's trigger.
    expect(workersSource).not.toMatch(/export async function (GET|POST)\b/);
    expect(routeSource).toMatch(/runInboundPass/);
    expect(routeSource).toMatch(/runOutboundPass/);
  });

  it("enumerates its own work, taking no ID list from the trigger", () => {
    // What made the F-023 workers uncallable by a scheduler was a caller-supplied ID list:
    // a cron route has no way to know which rows are expired.
    const call = routeSource.slice(routeSource.indexOf("runRetentionPass("));
    const args = call.slice(0, call.indexOf("});") + 3);
    expect(args).not.toMatch(/Ids|ids:|\[\s*\]/);
    expect(args).toMatch(/db:/);
    expect(args).toMatch(/clock:/);
  });

  it("takes its instant from the injected clock, never the wall clock", () => {
    const pass = workersSource.slice(
      workersSource.indexOf("export async function runRetentionPass"),
    );
    const body = pass.slice(0, pass.indexOf("\n}"));
    expect(body).toMatch(/deps\.clock\.now\(\)/);
    expect(body).not.toMatch(/new Date\(\)|Date\.now\(\)/);
  });
});

describe("the retention purge logs nothing", () => {
  /** The purge implementation, isolated from the rest of the transactions module. */
  const purge = (() => {
    const start = transactionsSource.indexOf(
      "export async function purgeExpiredBodies",
    );
    expect(start).toBeGreaterThan(-1);
    return transactionsSource.slice(start);
  })();

  it("emits no console output from the purge itself", () => {
    expect(purge).not.toMatch(/console\.(log|info|warn|error|debug)/);
  });

  it("emits no console output from the retention worker pass", () => {
    const pass = workersSource.slice(
      workersSource.indexOf("export async function runRetentionPass"),
    );
    const body = pass.slice(0, pass.indexOf("\n}"));
    expect(body).not.toMatch(/console\./);
  });

  it("emits no console output from the scheduled trigger", () => {
    expect(routeSource).not.toMatch(/console\./);
  });

  it("returns counts only — no body, no identifier, no phone", () => {
    // The shape of the result is the guarantee: three integers. A field carrying an ID or a
    // body would put purged content into the trigger's HTTP response, which is a log.
    const result = transactionsSource.slice(
      transactionsSource.indexOf("export interface RetentionPassResult"),
    );
    const fields = result.slice(0, result.indexOf("}"));
    expect(fields).toMatch(/messageBodiesPurged: number/);
    expect(fields).toMatch(/outboxBodiesPurged: number/);
    expect(fields).toMatch(/exempted: number/);
    // Nothing else. Any other field name would be carrying something that is not a count.
    const declared = [...fields.matchAll(/^\s*(\w+):/gm)].map((match) => match[1]!);
    expect(declared.sort()).toEqual(
      ["exempted", "messageBodiesPurged", "outboxBodiesPurged"].sort(),
    );
  });

  it("selects no body text back out of the database", () => {
    // `returning id` is deliberate: `returning *` or `returning body` would pull the very
    // text being purged into application memory and into the pass's result.
    expect(purge).not.toMatch(/returning\s+\*/);
    expect(purge).not.toMatch(/returning\s+[^\n]*\bbody\b/);

    // `body` may appear only in a PREDICATE (`where m.body is not null`), never in a select
    // list. Each select list is the text between `select` and its `from`; naming a body
    // column there would read the content the purge exists to destroy.
    const selectLists = [...purge.matchAll(/\bselect\b([\s\S]*?)\bfrom\b/g)].map(
      (match) => match[1]!,
    );
    expect(selectLists.length).toBeGreaterThan(0);
    for (const list of selectLists) {
      expect(list).not.toMatch(/\bbody\b/);
      expect(list).not.toMatch(/\*/);
    }
  });
});
