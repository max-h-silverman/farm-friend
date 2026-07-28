import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigurationError, resolveConfig } from "./composition";

// F-024 — the provider is selectable by configuration, and an UNATTESTED provider cannot run.
//
// The property under test is not "DeepInfra works". It is that choosing a provider whose
// data-handling terms nobody has read is a startup ERROR, not a silent degradation into
// sending farmer and customer text to a vendor under unknown terms. The attestation is the
// gate's whole input, and it is the one value an agent must never infer (CLAUDE.md; F-024).

const baseEnv = {
  DATABASE_URL: "postgres://user@localhost:5432/db",
  PHONE_HASH_SALT: "salt",
  CRON_SECRET: "cron",
  MAGIC_LINK_SECRET: "magic",
  PUBLIC_BASE_URL: "https://farmfriend.example",
  SMS_PROVIDER: "simulator",
} satisfies NodeJS.ProcessEnv;

describe("model provider selection (F-024)", () => {
  it("defaults to the stub, which makes no network call", () => {
    const config = resolveConfig({ ...baseEnv });
    expect(config.model.provider).toBe("stub");
  });

  it("selects deepinfra when LLM_PROVIDER names it, under the attested terms", () => {
    // The knob F-024 requires to become real: `.env.example` advertised `LLM_PROVIDER` while
    // `resolveModelConfig` ignored it entirely, so the documented setting did nothing.
    const config = resolveConfig({
      ...baseEnv,
      LLM_PROVIDER: "deepinfra",
      DEEPINFRA_API_KEY: "key",
      DEEPINFRA_MODEL: "mistralai/Mistral-Small-24B-Instruct-2501",
    });
    expect(config.model.provider).toBe("deepinfra");
    expect(config.model.deepinfra).toEqual({
      apiKey: "key",
      model: "mistralai/Mistral-Small-24B-Instruct-2501",
    });
    // The attested values, pinned. These are a transcription of DeepInfra's data-privacy
    // documentation (reviewed 2026-07-28, cited at the attestation binding in
    // composition.ts) — changing any of them means the terms were re-read, and this test
    // plus the citation must move together.
    expect(config.model.dataHandling).toEqual({
      trainsOnData: false,
      statefulStorage: false,
      requestLoggingDisabled: true,
      retentionDays: 0,
    });
  });

  it("REFUSES a model DeepInfra routes to a third-party vendor", () => {
    // The attestation's own carve-out, enforced. DeepInfra's terms state they do not train
    // on API data "except when using Google or Anthropic models", where data is transferred
    // to that vendor's endpoints under that vendor's policy. Those terms were NOT attested,
    // so a DEEPINFRA_MODEL under either namespace must fail closed at startup — otherwise
    // the version-controlled attestation is false for a reachable configuration.
    for (const model of ["anthropic/claude-4-sonnet", "google/gemini-2.5-flash"]) {
      let thrown: unknown;
      try {
        resolveConfig({
          ...baseEnv,
          LLM_PROVIDER: "deepinfra",
          DEEPINFRA_API_KEY: "key",
          DEEPINFRA_MODEL: model,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ConfigurationError);
      expect((thrown as Error).message).toMatch(/third[- ]party|routed/i);
    }
  });

  it("rejects an unknown provider name rather than falling back to the stub", () => {
    // A typo in LLM_PROVIDER must not silently run the test double in production.
    expect(() =>
      resolveConfig({ ...baseEnv, LLM_PROVIDER: "gpt-whatever" }),
    ).toThrow(ConfigurationError);
  });

  it("requires deepinfra credentials before the attestation is even consulted", () => {
    // Ordering matters only in that both must fail; neither may be assumed.
    expect(() =>
      resolveConfig({ ...baseEnv, LLM_PROVIDER: "deepinfra" }),
    ).toThrow(ConfigurationError);
  });
});

describe("the DeepInfra attestation is filled and CITED (F-024)", () => {
  // A SOURCE assertion, in the family of kick-survival.test.ts and cron-schedule.test.ts,
  // and for the same reason: the property belongs to a human process (someone reading a
  // vendor contract), not to runtime behaviour. Before 2026-07-28 this block pinned the
  // binding to `null` so no agent could fill it with plausible guesses. max read DeepInfra's
  // data-processing terms and directed the fill (2026-07-28), so the pinned property is now
  // the inverse: the attestation must carry its CITATION — the reviewed source and date —
  // beside the values, so the record of who read what can never drift away from the numbers
  // it justifies.
  //
  // The attestation lives beside the adapter it gates (packages/ai/src/deepinfra.ts), so
  // scripts and evals that construct the provider outside the composition root approve the
  // same declaration. Anchored to the construct it claims to prove (the attestation binding
  // and the citation lines in its doc comment), never to nearby vocabulary.
  const source = readFileSync(
    join(__dirname, "../../../packages/ai/src/deepinfra.ts"),
    "utf8",
  );

  it("declares the four attested values, no longer null", () => {
    const binding =
      /const DEEPINFRA_ATTESTED_DATA_HANDLING: ProviderDataHandling = \{([\s\S]*?)\};/.exec(
        source,
      );
    expect(binding).not.toBeNull();
    const body = binding![1]!;
    expect(body).toMatch(/trainsOnData:\s*false/);
    expect(body).toMatch(/statefulStorage:\s*false/);
    expect(body).toMatch(/requestLoggingDisabled:\s*true/);
    expect(body).toMatch(/retentionDays:\s*0/);
  });

  it("cites the reviewed terms and the review date beside the values", () => {
    // The citation is the attestation's evidence. The URL and date must appear in the
    // comment block immediately preceding the binding, not merely somewhere in the file.
    const withComment =
      /\/\*\*(?:(?!\*\/)[\s\S])*\*\/\s*export const DEEPINFRA_ATTESTED_DATA_HANDLING/.exec(
        source,
      );
    expect(withComment).not.toBeNull();
    const comment = withComment![0]!;
    expect(comment).toContain("docs.deepinfra.com/account/data-privacy");
    expect(comment).toContain("deepinfra.com/privacy");
    expect(comment).toContain("2026-07-28");
  });
});
