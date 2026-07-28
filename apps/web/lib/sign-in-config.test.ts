import { describe, expect, it } from "vitest";
import { createUnconfiguredMailSender, MailNotConfiguredError } from "@farm-friend/core";
import { ConfigurationError, resolveConfig, type EnvVars } from "./composition";

// F-032 — sign-in configuration fails CLOSED.
//
// Two secrets guard the admin recovery path, and each has a specific failure it prevents:
//
//   - MAGIC_LINK_SECRET signs the link. A guessable or empty value means anyone can forge
//     one, and the administrator lookup behind it is then the only remaining barrier.
//   - PUBLIC_BASE_URL is the origin links point at. It is configured rather than derived
//     from the request precisely so a `Host:` header cannot redirect an operator's link.
//
// The mail seam fails closed separately, at send time rather than at startup, and the last
// test here states why that is the deliberate choice rather than an oversight.

const baseEnv = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/farmfriend",
  PHONE_HASH_SALT: "test-salt",
  CRON_SECRET: "test-cron-secret",
  MAGIC_LINK_SECRET: "test-magic-secret",
  PUBLIC_BASE_URL: "https://ff.example",
  SMS_PROVIDER: "simulator",
  // Required since GL-019: there is no default provider, so a fixture that omits this
  // is an unconfigured app rather than a stubbed one.
  LLM_PROVIDER: "stub",
} satisfies EnvVars;

describe("sign-in configuration fails closed", () => {
  it("resolves when both values are present", () => {
    const config = resolveConfig({ ...baseEnv });
    expect(config.magicLinkSecret).toBe("test-magic-secret");
    expect(config.publicBaseUrl).toBe("https://ff.example");
  });

  it("throws when MAGIC_LINK_SECRET is absent", () => {
    const { MAGIC_LINK_SECRET: _omitted, ...without } = baseEnv;
    expect(() => resolveConfig(without)).toThrow(ConfigurationError);
    expect(() => resolveConfig(without)).toThrow(/MAGIC_LINK_SECRET/);
  });

  it("throws when MAGIC_LINK_SECRET is blank rather than signing with an empty key", () => {
    expect(() => resolveConfig({ ...baseEnv, MAGIC_LINK_SECRET: "   " })).toThrow(
      ConfigurationError,
    );
  });

  it("throws when PUBLIC_BASE_URL is absent", () => {
    const { PUBLIC_BASE_URL: _omitted, ...without } = baseEnv;
    expect(() => resolveConfig(without)).toThrow(ConfigurationError);
    expect(() => resolveConfig(without)).toThrow(/PUBLIC_BASE_URL/);
  });

  it("rejects a PUBLIC_BASE_URL that is not a valid absolute URL", () => {
    // A relative or malformed value would produce links that silently do not work, which on
    // this path means an operator who can never sign in and no signal saying why.
    expect(() => resolveConfig({ ...baseEnv, PUBLIC_BASE_URL: "/admin" })).toThrow(
      ConfigurationError,
    );
    expect(() => resolveConfig({ ...baseEnv, PUBLIC_BASE_URL: "not a url" })).toThrow(
      ConfigurationError,
    );
  });

  it("rejects a plaintext http base URL outside localhost", () => {
    // The link is a bearer credential; mailing one that travels over http would put it in
    // cleartext on the wire. Localhost stays allowed so local development works.
    expect(() => resolveConfig({ ...baseEnv, PUBLIC_BASE_URL: "http://ff.example" })).toThrow(
      ConfigurationError,
    );
    expect(() =>
      resolveConfig({ ...baseEnv, PUBLIC_BASE_URL: "http://localhost:3000" }),
    ).not.toThrow();
  });

  it("strips a trailing slash so links never contain a doubled separator", () => {
    expect(resolveConfig({ ...baseEnv, PUBLIC_BASE_URL: "https://ff.example/" }).publicBaseUrl)
      .toBe("https://ff.example");
  });
});

describe("the mail seam fails closed at send time, deliberately", () => {
  it("configuration resolves with no mail provider set", () => {
    // Startup must NOT require a mail provider today: F-031 has not chosen one, and making
    // it mandatory would take down every other surface — the map, the SMS webhook, the cron
    // worker — over a feature none of them use.
    expect(() => resolveConfig({ ...baseEnv })).not.toThrow();
  });

  it("but sending without one throws rather than silently succeeding", async () => {
    // This is the other half of that trade. The cost of not failing at startup is paid here:
    // an attempted send is a loud, attributable failure, never a quiet no-op that would
    // present as a healthy system that never delivers.
    await expect(
      createUnconfiguredMailSender().send({
        to: "operator@viga.example",
        subject: "s",
        text: "t",
      }),
    ).rejects.toThrow(MailNotConfiguredError);
  });
});
