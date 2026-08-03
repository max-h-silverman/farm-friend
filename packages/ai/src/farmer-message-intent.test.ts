import { describe, expect, it } from "vitest";
import {
  createFarmerMessageIntentModel,
  type LLMProvider,
  type ModelSafeContext,
} from "./index";

class RecordingProvider implements LLMProvider {
  readonly seen: ModelSafeContext[] = [];

  constructor(private readonly response: string) {}

  async generateJson(ctx: ModelSafeContext): Promise<string> {
    this.seen.push(ctx);
    return this.response;
  }
}

describe("farmer-message-intent seam", () => {
  it.each([
    ["inventory_update", "We have kale and eggs today."],
    ["farm_stand_question", "What does the north stand have today?"],
    ["unclear", "The north stand is busy."],
  ])("returns the finite %s intent", async (kind, taskText) => {
    const provider = new RecordingProvider(JSON.stringify({ kind }));

    const result = await createFarmerMessageIntentModel(provider).classify({ taskText });

    expect(result).toEqual({ kind });
    expect(provider.seen).toHaveLength(1);
    expect(provider.seen[0]?.seam).toBe("farmer-message-intent");
    expect(provider.seen[0]?.fields).toEqual({ taskText });
  });

  it("fails closed to unclear when the provider output is invalid", async () => {
    const provider = new RecordingProvider(
      JSON.stringify({ kind: "inventory_update", publish: true }),
    );

    await expect(
      createFarmerMessageIntentModel(provider).classify({ taskText: "kale" }),
    ).resolves.toEqual({ kind: "unclear" });
  });
});
