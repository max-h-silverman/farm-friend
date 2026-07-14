import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  assembleContext,
  assembleSmsContext,
  COORDINATOR_SMS_OUTPUT_INSTRUCTIONS,
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

  it("adds concise, non-destructive output guidance for SMS composition", () => {
    const ctx = assembleSmsContext("farmstand-query-answer", {
      rows: [{ stand: "José's Farm", items: ["piñata squash"] }],
    });

    expect(ctx.outputInstructions).toBe(COORDINATOR_SMS_OUTPUT_INSTRUCTIONS);
    expect(ctx.outputInstructions).toContain("Prefer one GSM-7 segment");
    expect(ctx.outputInstructions).toContain("never truncate");
    expect(ctx.fields.rows[0]!.stand).toBe("José's Farm");
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
