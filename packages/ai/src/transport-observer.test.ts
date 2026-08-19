import { describe, expect, it } from "vitest";
import { createTransportObserver } from "./transport-observer";
import { generateValidated, type LLMProvider } from "./index";
import { projectRequestClassification } from "./projections";
import { z } from "zod";

const ctx = () => projectRequestClassification({ taskText: "who has eggs?" });
const anySchema = z.object({ kind: z.string() });

/** A provider that answers, or throws the way the DeepInfra adapter throws on a 502. */
function providerThat(behaviour: () => string): LLMProvider {
  return { async generateJson() { return behaviour(); } };
}

describe("transport observer", () => {
  it("records nothing when the provider answers", async () => {
    const observer = createTransportObserver(
      providerThat(() => JSON.stringify({ kind: "search_stands" })),
    );
    const mark = observer.begin();
    await generateValidated(observer.provider, ctx(), anySchema);
    expect(mark.transportFailed()).toBe(false);
  });

  it("records a transport failure when the provider throws", async () => {
    const observer = createTransportObserver(
      providerThat(() => { throw new Error("deepinfra responded 502"); }),
    );
    const mark = observer.begin();
    await generateValidated(observer.provider, ctx(), anySchema);
    expect(mark.transportFailed()).toBe(true);
  });

  /*
    The distinction the whole bug turns on. A model that returns well-formed JSON the schema
    rejects is a QUALITY failure — the provider answered fine. Only a throw is transport.
  */
  it("does not treat schema-rejected output as a transport failure", async () => {
    const observer = createTransportObserver(
      providerThat(() => JSON.stringify({ nonsense: true })),
    );
    const mark = observer.begin();
    const result = await generateValidated(observer.provider, ctx(), anySchema);
    expect(result.ok).toBe(false);
    expect(mark.transportFailed()).toBe(false);
  });

  it("scopes failures to the fixture that saw them", async () => {
    let fail = true;
    const observer = createTransportObserver(
      providerThat(() => {
        if (fail) throw new Error("deepinfra responded 502");
        return JSON.stringify({ kind: "search_stands" });
      }),
    );

    const first = observer.begin();
    await generateValidated(observer.provider, ctx(), anySchema);
    expect(first.transportFailed()).toBe(true);

    fail = false;
    const second = observer.begin();
    await generateValidated(observer.provider, ctx(), anySchema);
    expect(second.transportFailed()).toBe(false);
  });

  it("flags a fixture where only one of several calls failed", async () => {
    let calls = 0;
    const observer = createTransportObserver(
      providerThat(() => {
        calls += 1;
        if (calls === 2) throw new Error("deepinfra responded 502");
        return JSON.stringify({ kind: "search_stands" });
      }),
    );
    const mark = observer.begin();
    await generateValidated(observer.provider, ctx(), anySchema);
    await generateValidated(observer.provider, ctx(), anySchema);
    expect(mark.transportFailed()).toBe(true);
  });

  it("passes the projected context through untouched", async () => {
    const seen: unknown[] = [];
    const observer = createTransportObserver({
      async generateJson(context) {
        seen.push(context);
        return JSON.stringify({ kind: "search_stands" });
      },
    });
    const context = ctx();
    await observer.provider.generateJson(context);
    expect(seen).toEqual([context]);
  });
});
