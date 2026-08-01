import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const executable = (source: string) =>
  source
    .replace(/^\s*import\s[\s\S]*?;\s*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const workers = executable(
  readFileSync(resolve(process.cwd(), "apps/web/lib/workers.ts"), "utf8"),
);
const transactions = executable(
  readFileSync(
    resolve(process.cwd(), "packages/db/src/transactions.ts"),
    "utf8",
  ),
);

const outboundPass = workers.slice(
  workers.indexOf("export async function runOutboundPass"),
  workers.indexOf("export interface RetentionWorkerDeps"),
);
const dispatchResultTransaction = transactions.slice(
  transactions.indexOf("export async function recordDispatchResult"),
  transactions.indexOf("export async function recoverAbandonedDispatches"),
);

describe("provider acceptance and proposal activation wiring (B-026)", () => {
  it("calls the provider outside one atomic acceptance-and-activation transaction", () => {
    const providerCall = outboundPass.indexOf(
      "const result = await deps.context.sendSms(",
    );
    const transactionCall = outboundPass.indexOf("await recordDispatchResult(");

    expect(providerCall).toBeGreaterThan(-1);
    expect(transactionCall).toBeGreaterThan(providerCall);
    expect(outboundPass.slice(providerCall)).not.toMatch(
      /await\s+activateAcceptedPrompt\s*\(/,
    );

    const acceptedBranch = dispatchResultTransaction.match(
      /if \(input\.outcome === "accepted"\) \{([\s\S]*?)return \{ retryable: false \};/,
    );
    expect(acceptedBranch).not.toBeNull();
    expect(acceptedBranch?.[1]).toMatch(
      /await\s+activateAcceptedPromptInTransaction\s*\(\s*tx,\s*workId,\s*input\.now\s*\)/,
    );
    expect(dispatchResultTransaction).not.toMatch(/sendSms\s*\(/);
  });
});
