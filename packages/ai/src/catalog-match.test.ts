import { describe, expect, it } from "vitest";
import {
  createCatalogMatcher,
  projectCatalogMatch,
  StubLLMProvider,
} from "./index";

describe("catalog matching seam", () => {
  it("shows one deduplicated catalog and returns only matching values", async () => {
    const matcher = createCatalogMatcher(
      new StubLLMProvider({
        "catalog-match": JSON.stringify({ matches: ["butter lettuce", "chard"] }),
      }),
    );

    await expect(
      matcher.match({
        taskText: "any leafy greens?",
        catalogType: "inventory",
        values: ["butter lettuce", "Chard", "chard"],
      }),
    ).resolves.toEqual({ ok: true, matches: ["butter lettuce", "chard"] });

    const context = projectCatalogMatch({
      taskText: "any leafy greens?",
      catalogType: "inventory",
      values: ["butter lettuce", "Chard", "chard"],
    });
    expect(context.fields).toEqual({
      taskText: "any leafy greens?",
      catalogType: "inventory",
      values: ["butter lettuce", "Chard"],
    });
    expect(JSON.stringify(context.fields)).not.toMatch(/stand|fact|farm|paymentMethods|itemNames/i);
  });

  it("distinguishes a valid empty match from provider or schema failure", async () => {
    const empty = createCatalogMatcher(
      new StubLLMProvider({ "catalog-match": JSON.stringify({ matches: [] }) }),
    );
    await expect(
      empty.match({ taskText: "durian?", catalogType: "inventory", values: ["eggs"] }),
    ).resolves.toEqual({ ok: true, matches: [] });

    const invalid = createCatalogMatcher(
      new StubLLMProvider({
        "catalog-match": JSON.stringify({ kind: "broad", matches: [] }),
      }),
    );
    await expect(
      invalid.match({ taskText: "durian?", catalogType: "inventory", values: ["eggs"] }),
    ).resolves.toEqual({ ok: false, reason: "invalid_output" });

    const unavailable = createCatalogMatcher({
      async generateJson() {
        throw new Error("provider unavailable");
      },
    });
    await expect(
      unavailable.match({ taskText: "durian?", catalogType: "inventory", values: ["eggs"] }),
    ).resolves.toEqual({ ok: false, reason: "provider_error" });
  });
});
