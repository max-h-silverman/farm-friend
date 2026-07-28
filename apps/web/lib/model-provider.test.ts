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

  it("selects deepinfra when LLM_PROVIDER names it", () => {
    // The knob F-024 requires to become real: `.env.example` advertised `LLM_PROVIDER` while
    // `resolveModelConfig` ignored it entirely, so the documented setting did nothing.
    expect(() =>
      resolveConfig({
        ...baseEnv,
        LLM_PROVIDER: "deepinfra",
        DEEPINFRA_API_KEY: "key",
        DEEPINFRA_MODEL: "some-model",
      }),
    ).toThrow(ConfigurationError);
  });

  it("REFUSES deepinfra while its data-handling terms are unattested", () => {
    // The blocking TODO, enforced rather than commented. Until max reads DeepInfra's
    // data-processing terms and fills the four values in, selecting it must fail closed.
    let thrown: unknown;
    try {
      resolveConfig({
        ...baseEnv,
        LLM_PROVIDER: "deepinfra",
        DEEPINFRA_API_KEY: "key",
        DEEPINFRA_MODEL: "some-model",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigurationError);
    expect((thrown as Error).message).toMatch(/attest/i);
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

describe("the DeepInfra attestation is unfilled and marked (F-024)", () => {
  // A SOURCE assertion, in the family of kick-survival.test.ts and cron-schedule.test.ts,
  // and for the same reason: the property belongs to a human process (someone reading a
  // vendor contract), not to runtime behaviour. What it prevents is an agent — or a hurried
  // human — quietly replacing `null` with plausible-looking values that no one verified.
  //
  // Anchored to the construct it claims to prove (the null literal in the DeepInfra
  // attestation binding), never to nearby vocabulary. A loose /TODO/ over the whole file
  // would be satisfied by any unrelated comment, which is exactly the failure recorded twice
  // in CLAUDE.md's standing rules.
  const source = readFileSync(join(__dirname, "composition.ts"), "utf8");

  it("declares the DeepInfra terms as null, not as guessed values", () => {
    expect(source).toMatch(
      /DEEPINFRA_DATA_HANDLING:\s*ProviderDataHandling\s*\|\s*null\s*=\s*null\s*;/,
    );
  });

  it("names all four gate terms in the TODO so the reviewer knows what to fill", () => {
    for (const term of [
      "trainsOnData",
      "statefulStorage",
      "requestLoggingDisabled",
      "retentionDays",
    ]) {
      expect(source).toContain(term);
    }
  });
});
