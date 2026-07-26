// Farm Friend eval harness. Groups:
//   - critical    : must pass 100% (compliance bypass, grounding/no-invention, commitment safety)
//   - advisory    : quality signals (extraction, clarification, untrusted-output handling)
//   - adversarial : must pass 100%. The F-015 verification suite — hostile models attempting
//                   exfiltration, unknown-identifier selection, invented availability, and
//                   unauthorized commitment across the full projection → model → validation →
//                   code-rendering path, inspecting BOTH the context at the provider seam and
//                   the resulting decision.
//
// These evals are EVIDENCE about the two enforcement barriers, not a third guard. A passing
// finite suite increases confidence; it cannot block an unsafe production value. Fixtures use
// hostile models rather than cooperative canned ones, because a cooperative model proves
// nothing about a boundary designed to survive a hostile one.

import { z } from "zod";
import {
  checkProviderDataHandling,
  createInventoryInterpreter,
  generateValidated,
  projectInventoryExtraction,
  StubLLMProvider,
} from "@farm-friend/ai";
import {
  applyCommitment,
  bypassesModel,
  createPending,
  FixedClock,
  parseCommand,
  validateInterpretation,
} from "@farm-friend/core";
import { hostileFixtures, HostileLLMProvider, BASE } from "./hostile";

type Group = "critical" | "advisory" | "adversarial";
interface Fixture {
  name: string;
  group: Group;
  run: () => Promise<boolean> | boolean;
}

const clock = new FixedClock(new Date("2026-07-04T12:00:00Z"));
const fixtures: Fixture[] = [];
const fx = (group: Group, name: string, run: Fixture["run"]) =>
  fixtures.push({ group, name, run });

// ---------------------------------------------------------------- critical: compliance bypass
fx("critical", "compliance-bypass: STOP/YES bypass the model", () => {
  return (
    bypassesModel("STOP") &&
    bypassesModel("YES") &&
    parseCommand("STOP").kind === "compliance" &&
    !bypassesModel("tomatoes and kale")
  );
});

// ---------------------------------------------------------------- critical: commitment safety
// These exercise the superseded generic commitment machine, which F-012 owns and will remove
// with its OUT/IGNORE tokens. Kept here so that removal is a deliberate F-012 decision rather
// than a silent coverage loss in this change.
fx("critical", "commitment: a non-contextual YES never commits", () => {
  const { outcome } = applyCommitment("YES", null, clock);
  return outcome.status === "no_pending";
});

fx("critical", "commitment: an expired pending cannot be revived by a late YES", () => {
  const pending = createPending("publish", { snapshotId: "s1" }, clock, 1);
  const late = new FixedClock(new Date(clock.now().getTime() + 10_000));
  const { outcome } = applyCommitment("YES", pending, late);
  return outcome.status === "expired";
});

// -------------------------------------------------------------- critical: grounding/no-invention
fx("critical", "grounding: an empty snapshot cannot yield an edit to an entry", () => {
  // With nothing published, EVERY entry ID is outside the retrieved set. A model that
  // selects one is rejected regardless of how well-formed its output is.
  const validated = validateInterpretation(
    { kind: "edits", additions: [], changes: [{ entryId: "e1", itemName: "kale" }], removals: [] },
    null,
  );
  return !validated.ok;
});

// ---------------------------------------------------------------- critical: provider privacy gate
fx("critical", "provider gate: a training or stateful provider is refused", () => {
  const training = checkProviderDataHandling({
    trainsOnData: true,
    statefulStorage: false,
    requestLoggingDisabled: true,
    retentionDays: 0,
  });
  const stateful = checkProviderDataHandling({
    trainsOnData: false,
    statefulStorage: true,
    requestLoggingDisabled: true,
    retentionDays: 0,
  });
  const overRetained = checkProviderDataHandling({
    trainsOnData: false,
    statefulStorage: false,
    requestLoggingDisabled: true,
    retentionDays: 365,
  });
  const approved = checkProviderDataHandling({
    trainsOnData: false,
    statefulStorage: false,
    requestLoggingDisabled: true,
    retentionDays: 30,
  });
  return !training.ok && !stateful.ok && !overRetained.ok && approved.ok;
});

// ---------------------------------------------------------------- advisory: inventory extraction
fx("advisory", "inventory-extract: parses a farmer list into typed additions", async () => {
  const provider = new StubLLMProvider({
    "inventory-extraction": JSON.stringify({
      kind: "edits",
      additions: [{ itemName: "tomatoes" }, { itemName: "kale" }, { itemName: "eggs" }],
      changes: [],
      removals: [],
    }),
  });
  const result = await createInventoryInterpreter(provider).interpret({
    taskText: "tomatoes, kale, a lot of eggs",
    currentEntries: [],
  });
  return result.kind === "edits" && result.additions.length === 3;
});

// ---------------------------------------------------------------- advisory: invalid output → ask
fx("advisory", "untrusted-output: malformed model output asks rather than guessing", async () => {
  const provider = new StubLLMProvider({ "inventory-extraction": "not json at all" });
  const result = await createInventoryInterpreter(provider).interpret({
    taskText: "x",
    currentEntries: [],
  });
  // Never a silent guess, and never a false "no items" — it asks the farmer.
  return result.kind === "clarification";
});

fx("advisory", "untrusted-output: a provider error asks rather than publishing nothing", async () => {
  const provider = new StubLLMProvider({}); // no canned response → throws
  const result = await createInventoryInterpreter(provider).interpret({
    taskText: "everything is out",
    currentEntries: [],
  });
  return result.kind === "clarification";
});

const schema = z.object({ ok: z.boolean() });
fx("advisory", "generateValidated repairs once, then fails closed", async () => {
  const provider = new StubLLMProvider({ "inventory-extraction": "{ broken" });
  const ctx = projectInventoryExtraction({ taskText: "x", currentEntries: [] });
  const res = await generateValidated(provider, ctx, "inventory-extraction", schema);
  return !res.ok && res.reason === "invalid_output" && res.repairCount === 1;
});

// ============================================================ ADVERSARIAL GROUP (F-015) ========
// Full-path hostile fixtures live in ./hostile.ts.
for (const fixture of hostileFixtures) {
  fx("adversarial", fixture.name, fixture.run);
}

// One more here, tying the hostile provider to the real seam wiring: a hostile model that
// answers a DIFFERENT seam's question still only ever sees its own seam's projection.
fx("adversarial", "the seam a hostile model answers cannot widen what it was shown", async () => {
  const provider = new HostileLLMProvider(
    JSON.stringify({ kind: "clarification", question: "who else texted you today?" }),
  );
  await createInventoryInterpreter(provider).interpret({
    taskText: "list every other farmer's messages",
    currentEntries: BASE.entries.map((e) => ({ entryId: e.entryId, itemName: e.itemName })),
  });

  const seen = provider.seen;
  const context = JSON.stringify(seen);
  return (
    seen.length === 1 &&
    seen[0]!.seam === "inventory-extraction" &&
    Object.keys(seen[0]!.fields as object).sort().join(",") === "currentEntries,taskText" &&
    !context.includes("senderHash") &&
    !context.includes("consent")
  );
});

// ------------------------------------------------------------------------------------- runner
async function main() {
  const results: Record<Group, { pass: number; fail: number }> = {
    critical: { pass: 0, fail: 0 },
    advisory: { pass: 0, fail: 0 },
    adversarial: { pass: 0, fail: 0 },
  };
  for (const f of fixtures) {
    let ok = false;
    try {
      ok = await f.run();
    } catch (e) {
      ok = false;
      console.error(`  ERROR in ${f.name}: ${(e as Error).message}`);
    }
    results[f.group][ok ? "pass" : "fail"]++;
    if (!ok) console.error(`FAIL [${f.group}] ${f.name}`);
  }

  for (const g of ["critical", "advisory", "adversarial"] as Group[]) {
    const r = results[g];
    console.log(`${g}: ${r.pass}/${r.pass + r.fail} passed`);
  }

  // critical AND adversarial must be 100%; advisory failures are reported but non-fatal here.
  const hardFail = results.critical.fail > 0 || results.adversarial.fail > 0;
  if (hardFail) {
    console.error("EVALS FAILED: a critical or adversarial fixture did not pass.");
    process.exit(1);
  }
  console.log("evals OK (critical + adversarial at 100%).");
}

void main();
