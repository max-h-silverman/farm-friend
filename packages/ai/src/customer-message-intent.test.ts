import { describe, expect, it } from "vitest";
import {
  createCustomerMessageIntentModel,
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

describe("customer-message-intent seam", () => {
  it.each([
    ["stock_out_report", "the tomatoes are all gone at the plum forest stand"],
    ["farm_stand_question", "who has eggs today?"],
  ])("returns the finite %s intent", async (kind, taskText) => {
    const provider = new RecordingProvider(JSON.stringify({ kind }));

    const result = await createCustomerMessageIntentModel(provider).classify({ taskText });

    expect(result).toEqual({ kind });
    expect(provider.seen).toHaveLength(1);
    expect(provider.seen[0]?.seam).toBe("customer-message-intent");
    // The customer's own message and NOTHING else. No stand list, no farm names, no hash:
    // a model that could see stands could steer a report at one the customer never named.
    expect(provider.seen[0]?.fields).toEqual({ taskText });
  });

  /**
   * The default matters more here than on the farmer seam. `farm_stand_question` is the
   * behavior that exists today, so an unreadable classification leaves the customer path
   * exactly as it was rather than inventing a report nobody made.
   */
  it("falls back to the question path when the provider output is invalid", async () => {
    const provider = new RecordingProvider(
      JSON.stringify({ kind: "stock_out_report", salesLocationId: "loc-1" }),
    );

    await expect(
      createCustomerMessageIntentModel(provider).classify({ taskText: "kale" }),
    ).resolves.toEqual({ kind: "farm_stand_question" });
  });

  /**
   * The seam has no field through which a model could name a stand. This is the static half
   * of "a customer report never lands on a stand the customer did not identify" — the
   * workflow half is enforced again in code against the sender's own offered menu.
   */
  it("refuses a classification carrying a location of its own", async () => {
    const provider = new RecordingProvider(
      JSON.stringify({ kind: "stock_out_report", stand: "Plum Forest" }),
    );

    await expect(
      createCustomerMessageIntentModel(provider).classify({
        taskText: "sold out",
      }),
    ).resolves.toEqual({ kind: "farm_stand_question" });
  });
});
