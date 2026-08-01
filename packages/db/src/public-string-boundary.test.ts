import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const transactionSource = readFileSync(new URL("./transactions.ts", import.meta.url), "utf8");

// Imports and comments are claims, not the construct. Strip them so the test can be
// satisfied only by executable code inside the shared publication transaction.
const transactionBody = transactionSource
  .replace(/^\s*import\s[\s\S]*?;\s*$/gm, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const confirmationStart = transactionBody.indexOf(
  "export async function confirmInventoryPublication",
);
const confirmationEnd = transactionBody.indexOf(
  "export async function queueOutbox",
  confirmationStart,
);
const confirmationBody = transactionBody.slice(confirmationStart, confirmationEnd);

describe("the one inventory publication boundary validates every public string", () => {
  it("calls the shared validator before inserting a revision", () => {
    expect(confirmationStart).toBeGreaterThan(-1);
    expect(confirmationEnd).toBeGreaterThan(confirmationStart);

    // Anchored to the validator CALL and its own argument, not its import or vocabulary.
    // Sabotage: remove this call; this exact assertion must fail.
    const call = confirmationBody.match(/validatePublicStrings\(publicStrings\)/);
    expect(call).not.toBeNull();
    expect(confirmationBody.indexOf(call?.[0] ?? "")).toBeLessThan(
      confirmationBody.indexOf("insert into inventory_revisions"),
    );
  });

  it("feeds item name, unit, and price text to that call", () => {
    // Every free-form string the inventory model can write and the public reader can expose.
    // This is one anchored field projection, not a loose `a|b|c` that any nearby use could
    // satisfy independently.
    expect(confirmationBody).toMatch(
      /const publicStrings = entries\.flatMap\(\(entry\) =>\s*\[entry\.itemName, entry\.unit, entry\.priceText\]/,
    );
  });
});
