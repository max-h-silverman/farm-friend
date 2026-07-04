import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  assembleContext,
  ContextAssemblyError,
  generateValidated,
  StubLLMProvider,
} from "./index";

describe("context assembler — runtime guard (Golden Rule #6, layer 2)", () => {
  it("strips/refuses a raw phone number even when the record contains one", () => {
    expect(() =>
      assembleContext("farmstand-inventory-extract", {
        farmerNote: "call me at (206) 555-1234 about the kale",
      }),
    ).toThrow(ContextAssemblyError);
  });

  it("refuses a forbidden key (phone/secret/token) whatever its value", () => {
    expect(() => assembleContext("x", { phone: "unknown" })).toThrow(ContextAssemblyError);
    expect(() => assembleContext("x", { apiKey: "abc" })).toThrow(ContextAssemblyError);
    expect(() => assembleContext("x", { nested: { secret: "s" } })).toThrow(ContextAssemblyError);
  });

  it("allows phone_hash (the sanctioned, non-raw key) and clean grounded rows", () => {
    const ctx = assembleContext("farmstand-query-answer", {
      phone_hash: "deadbeef",
      rows: [{ stand: "Provo Farms", items: ["kale", "eggs"] }],
    });
    expect(ctx.seam).toBe("farmstand-query-answer");
  });

  it("generateValidated treats model output as untrusted and repairs-or-fails", async () => {
    const schema = z.object({ items: z.array(z.string()) });
    const good = new StubLLMProvider({ s: JSON.stringify({ items: ["kale"] }) });
    const ctx = assembleContext("s", { rows: [] });
    const okResult = await generateValidated(good, ctx, "s", schema);
    expect(okResult.ok).toBe(true);

    const bad = new StubLLMProvider({ s: "not json at all" });
    const badResult = await generateValidated(bad, ctx, "s", schema);
    expect(badResult.ok).toBe(false); // never a silent guess
    if (!badResult.ok) expect(badResult.reason).toBe("invalid_output");
  });
});
