import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConfigurationError, resolveConfig } from "./composition";

// F-023 — the scheduled-worker trigger fails CLOSED.
//
// The route drives consent transitions and outbound SMS, so an unauthenticated or
// environment-conditional guard is not a configuration nicety: it is a remote way to make
// Farm Friend text real people. These tests own two properties:
//
//   1. CRON_SECRET is required with no default — a deployment missing it does not start
//   2. the guard has no development bypass — Golden Rule #6 rejects conditional safety
//
// Property 2 is asserted against the route SOURCE rather than by booting Next.js, because
// what must not exist is a branch. A test that exercised the handler in one environment
// could not prove the absence of a different branch in another.

const baseEnv = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/farmfriend",
  PHONE_HASH_SALT: "test-salt",
  CRON_SECRET: "test-cron-secret",
  // Required since F-032. Present here only so the CRON_SECRET assertions below fail for
  // the reason they name; sign-in configuration has its own suite in sign-in-config.test.ts.
  MAGIC_LINK_SECRET: "test-magic-secret",
  PUBLIC_BASE_URL: "https://ff.example",
  SMS_PROVIDER: "simulator",
} satisfies NodeJS.ProcessEnv;

describe("scheduled worker configuration fails closed", () => {
  it("resolves when CRON_SECRET is present", () => {
    expect(resolveConfig({ ...baseEnv }).cronSecret).toBe("test-cron-secret");
  });

  it("throws when CRON_SECRET is absent, exactly as PHONE_HASH_SALT does", () => {
    const { CRON_SECRET: _omitted, ...withoutSecret } = baseEnv;
    expect(() => resolveConfig(withoutSecret)).toThrow(ConfigurationError);
    expect(() => resolveConfig(withoutSecret)).toThrow(/CRON_SECRET/);
  });

  it("throws when CRON_SECRET is blank rather than accepting an empty token", () => {
    // An empty secret would make the bearer check trivially satisfiable.
    expect(() => resolveConfig({ ...baseEnv, CRON_SECRET: "   " })).toThrow(
      ConfigurationError,
    );
  });
});

describe("the cron route has no environment-dependent auth bypass", () => {
  const source = readFileSync(
    new URL("../app/api/internal/cron/route.ts", import.meta.url),
    "utf8",
  );

  it("reads no NODE_ENV, VERCEL_ENV, or development flag", () => {
    // A guard that relaxes in "development" is one misconfigured deploy from being public.
    expect(source).not.toMatch(/NODE_ENV|VERCEL_ENV|isDev|__DEV__/);
  });

  it("returns 401 as the only unauthenticated outcome", () => {
    expect(source).toMatch(/401/);
    // The secret is compared, never defaulted at the call site.
    expect(source).not.toMatch(/cronSecret\s*(?:\?\?|\|\|)/);
  });

  it("compares the token in constant time", () => {
    // A byte-by-byte early return leaks the secret through response timing.
    expect(source).toMatch(/secretMatches/);
    expect(source).toMatch(/\^/);
  });

  it("guards every exported HTTP method", () => {
    const exported = [...source.matchAll(/export async function (GET|POST|PUT|DELETE|PATCH)/g)]
      .map((match) => match[1]!);
    expect(exported.length).toBeGreaterThan(0);
    // Each handler must route through the one guarded entry point rather than doing work
    // directly, so adding a method cannot accidentally skip the check.
    for (const method of exported) {
      const body = source.slice(
        source.indexOf(`export async function ${method}`),
      ).split("}")[0]!;
      expect(body, method).toMatch(/runScheduledWork/);
    }
  });
});
