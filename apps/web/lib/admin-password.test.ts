import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { adminLoginBucketsFor } from "./admin-login-signal";
import {
  hashAdminPassword,
  isSupportedAdminPasswordHash,
  resolveAdminPasswordHash,
  verifyAdminPassword,
} from "./admin-password";

/** Remove text that can mention a contract without executing it. */
function executableSource(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/^\s*import[\s\S]*?;\s*$/gm, "");
}

describe("administrator password verifier", () => {
  it("hashes and verifies through maintained Argon2id", async () => {
    const verifier = await hashAdminPassword("correct horse battery staple");
    expect(isSupportedAdminPasswordHash(verifier)).toBe(true);
    expect(await verifyAdminPassword(verifier, "correct horse battery staple")).toBe(true);
    expect(await verifyAdminPassword(verifier, "wrong password")).toBe(false);
    expect(verifier).not.toContain("correct horse battery staple");
  });

  it("fails closed on absent, malformed, unsupported, or unbounded configuration", () => {
    const salt = Buffer.alloc(16).toString("base64").replace(/=+$/, "");
    const digest = Buffer.alloc(32).toString("base64").replace(/=+$/, "");
    const valid = `$argon2id$v=19$m=65536,t=3,p=1$${salt}$${digest}`;
    expect(resolveAdminPasswordHash({ ADMIN_PASSWORD_HASH: valid })).toBe(valid);

    for (const value of [
      undefined,
      "",
      valid.replace("argon2id", "argon2i"),
      valid.replace("v=19", "v=16"),
      valid.replace("m=65536", "m=1"),
      valid.replace("t=3", "t=99"),
      valid.replace("p=1", "p=99"),
    ]) {
      expect(() => resolveAdminPasswordHash({ ADMIN_PASSWORD_HASH: value })).toThrow(
        /ADMIN_PASSWORD_HASH/,
      );
    }
  });

  it("refuses malformed or unsupported PHC input without a fallback verifier", async () => {
    await expect(verifyAdminPassword("not-a-phc", "correct horse battery staple")).resolves.toBe(false);
    await expect(verifyAdminPassword(
      "$argon2i$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$ZGlnaWVzdGRpZ2VzdGRpZ2VzdGRpZ2VzdGRpZ2VzdA",
      "correct horse battery staple",
    )).resolves.toBe(false);
  });

  it("bounds plaintext before Argon2 work", async () => {
    await expect(hashAdminPassword("short")).rejects.toThrow(/12/);
    await expect(hashAdminPassword("x".repeat(1025))).rejects.toThrow(/1024/);
  });
});

describe("durable login bucket projection", () => {
  const salt = "deployment-only-salt";
  const headers = (value: string) => new Headers({ "x-forwarded-for": value });

  it("uses the Cloud Run observed hop and coarse network, storing only hashes", () => {
    const a = adminLoginBucketsFor(headers("1.1.1.1, 198.51.100.7"), salt);
    const sameNetwork = adminLoginBucketsFor(headers("9.9.9.9, 198.51.100.200"), salt);
    const otherNetwork = adminLoginBucketsFor(headers("9.9.9.9, 198.51.101.7"), salt);
    expect(a.clientBucketHash).toBe(sameNetwork.clientBucketHash);
    expect(a.clientBucketHash).not.toBe(otherNetwork.clientBucketHash);
    expect(a.accountBucketHash).toBe(otherNetwork.accountBucketHash);
    expect(Object.values(a)).toEqual([
      expect.stringMatching(/^[0-9a-f]{64}$/),
      expect.stringMatching(/^[0-9a-f]{64}$/),
    ]);
    expect(JSON.stringify(a)).not.toContain("198.51");
  });
});

describe("password-login wiring and dead-contract boundary", () => {
  const route = readFileSync(
    resolve(process.cwd(), "apps/web/app/api/auth/login/route.ts"),
    "utf8",
  );
  const handler = readFileSync(
    resolve(process.cwd(), "apps/web/lib/admin-password-login.ts"),
    "utf8",
  );
  const provisioner = readFileSync(
    resolve(process.cwd(), "apps/web/scripts/provision-admin-password.ts"),
    "utf8",
  );
  const executableRoute = executableSource(route);
  const executableHandler = executableSource(handler);
  const executableProvisioner = executableSource(provisioner);

  it("anchors password, dual throttle, session, and cookie calls to executable sites", () => {
    expect(executableRoute).toMatch(/verifyPassword:\s*verifyAdminPassword/);
    expect(executableRoute).toMatch(/reserveAttempt:\s*\(input\)\s*=>\s*reserveAdminLoginAttempt\(db,\s*input\)/);
    expect(executableRoute).toMatch(/clearFailures:\s*\(input\)\s*=>\s*clearAdminLoginFailures\(db,\s*input\)/);
    expect(executableRoute).toMatch(/createSession:\s*\(input\)\s*=>\s*createAdminSession\(db,\s*input\)/);
    expect(executableHandler).toMatch(/const reservation = await deps\.reserveAttempt\(\{ \.\.\.buckets, now \}\)/);
    expect(executableHandler).toMatch(/await deps\.clearFailures\(buckets\)/);
    expect(executableHandler).toMatch(/await deps\.createSession\(\{/);
    expect(executableHandler).toMatch(/serializeSessionCookie\(sessionToken,\s*ADMIN_SESSION_TTL_MS\)/);
    expect(executableHandler).toMatch(/await deps\.findAdministrator\(\)/);
  });

  it("keeps plaintext and verifier out of logs and command arguments", () => {
    expect(executableHandler).not.toMatch(/console\s*\./);
    expect(executableProvisioner).toMatch(/child\.stdin\.end\(verifier\)/);
    expect(executableProvisioner).toMatch(/spawn\(\s*"gcloud"/);
    expect(executableProvisioner).not.toMatch(/console\s*\./);
    expect(executableProvisioner).not.toMatch(/process\.argv/);
  });

  it("removes the magic request and callback route modules", () => {
    expect(existsSync(resolve(process.cwd(), "apps/web/app/api/auth/request-link/route.ts"))).toBe(false);
    expect(existsSync(resolve(process.cwd(), "apps/web/app/api/auth/callback/route.ts"))).toBe(false);
  });
});
