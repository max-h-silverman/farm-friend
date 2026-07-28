import { describe, expect, it } from "vitest";
import { extractOfferings } from "./offering-seam";
import type { LLMProvider, ModelSafeContext } from "./index";

// F-035/F-036 — the offering-extraction seam.
//
// The seam PROPOSES item tags from VIGA's prose; the seeder records them for review and code
// commits what a human approved. So the tests that matter are the ones about what happens
// when the model misbehaves: the schema must refuse, and nothing must reach the caller as an
// approved tag.
//
// Every source string is real, from the VIGA export.

class Scripted implements LLMProvider {
  readonly name = "scripted";
  lastContext: ModelSafeContext | undefined;
  constructor(private readonly payload: string) {}
  async generateJson(ctx: ModelSafeContext): Promise<string> {
    this.lastContext = ctx;
    return this.payload;
  }
}

class Failing implements LLMProvider {
  readonly name = "failing";
  async generateJson(): Promise<string> {
    throw new Error("provider exploded");
  }
}

describe("extractOfferings", () => {
  it("returns the proposed tags for a clean list", async () => {
    const provider = new Scripted(
      JSON.stringify({ items: ["eggs", "plant starts", "veggies", "fruit"] }),
    );

    const result = await extractOfferings(provider, {
      sourceText: "Eggs, plant starts, veggies and fruit",
    });

    expect(result).toEqual({
      ok: true,
      items: ["eggs", "plant starts", "veggies", "fruit"],
    });
  });

  it("passes ONLY the description to the model", async () => {
    // No farm name, no location id, no neighbouring stand. A model that could name a farm
    // could attach one farm's produce to another's listing, and extraction does not need it.
    const provider = new Scripted(JSON.stringify({ items: ["eggs"] }));

    await extractOfferings(provider, { sourceText: "Generally: eggs" });

    expect(provider.lastContext?.seam).toBe("offering-extraction");
    expect(Object.keys(provider.lastContext?.fields as object)).toEqual(["sourceText"]);
  });

  it("refuses output that smuggles a consequential field", async () => {
    // `.strict()` matters: Zod strips unknown keys by default, which would silently discard a
    // smuggled field rather than refusing the output that tried to carry it. "The model
    // attempted a consequence" must be a visible refusal, not an invisible cleanup.
    const provider = new Scripted(
      JSON.stringify({ items: ["eggs"], publish: true, salesLocationId: "abc" }),
    );

    const result = await extractOfferings(provider, { sourceText: "eggs" });

    expect(result.ok).toBe(false);
  });

  it("refuses a non-list, an empty item, and an over-long tag", async () => {
    for (const payload of [
      JSON.stringify({ items: "eggs" }),
      JSON.stringify({ items: [""] }),
      JSON.stringify({ items: ["  "] }),
      // A tag is a filter label, not a sentence. The deterministic draft produced
      // "rotational grazing for chickens"; the bound is what stops that shape entering.
      JSON.stringify({ items: ["rotational grazing for chickens and sheep and pigs"] }),
      "not json at all",
    ]) {
      const result = await extractOfferings(new Scripted(payload), { sourceText: "x" });
      expect(result.ok, payload).toBe(false);
    }
  });

  it("normalizes case and drops duplicates without inventing items", async () => {
    const provider = new Scripted(JSON.stringify({ items: ["Eggs", "EGGS", " eggs "] }));

    const result = await extractOfferings(provider, { sourceText: "Eggs" });

    expect(result).toEqual({ ok: true, items: ["eggs"] });
  });

  it("returns not-ok when the provider fails, rather than an empty list", async () => {
    // An empty list and a failed call are different facts. Returning `[]` on failure would
    // record "this stand offers nothing" — a claim nobody made — and the seeder would commit
    // it silently.
    const result = await extractOfferings(new Failing(), { sourceText: "eggs" });

    expect(result.ok).toBe(false);
  });

  it("accepts an empty list as a real answer for prose that lists nothing", async () => {
    // Holmestead's "We place a sign at the bottom of the driveway when we are open" genuinely
    // names no produce. An empty proposal is correct there, and is distinguishable from the
    // failure case above by `ok`.
    const provider = new Scripted(JSON.stringify({ items: [] }));

    const result = await extractOfferings(provider, {
      sourceText: "We place a sign at the bottom of the driveway when we are open",
    });

    expect(result).toEqual({ ok: true, items: [] });
  });
});
