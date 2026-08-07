import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEmailSimulatorTransport } from "./email-simulator-transport";

/**
 * F-079 local development — the mail sink that makes the verification flow runnable without a
 * relay. These tests carry two different weights.
 *
 * The delivery assertions are convenience: they prove a developer can find the code.
 *
 * The refusal assertion is SAFETY, and it is the reason this file exists. GL-019 is the
 * precedent: `LLM_PROVIDER` defaulted to `stub` and production ran the test double for its
 * entire life with every check green. A mail sink is the same hazard with a worse failure —
 * it accepts every message and returns success, so verification emails would stop reaching
 * farmers while the logs read "accepted". It must be unable to construct on a real deployment.
 */
describe("email simulator transport", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ff-mail-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const request = {
    toEmail: "farmer@example.com",
    fromAddress: "board@vigafarms.org",
    fromName: "VIGA",
    subject: "Your Farm Friend code: 123456",
    text: "Your code is 123456. It expires in 15 minutes.",
    idempotencyKey: "key-1",
  };

  it("refuses to construct when NODE_ENV is production", () => {
    // The whole point. A file-writing mail sink on a deployed instance would swallow real
    // verification emails and report success.
    expect(() => createEmailSimulatorTransport({ directory: dir, nodeEnv: "production" })).toThrow(
      /never be used on a deployment/i,
    );
  });

  it("constructs for local development", () => {
    expect(() =>
      createEmailSimulatorTransport({ directory: dir, nodeEnv: "development" }),
    ).not.toThrow();
  });

  it("writes the message where a developer can read the code", async () => {
    const send = createEmailSimulatorTransport({ directory: dir, nodeEnv: "development" });
    await send(request);

    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const written = readFileSync(join(dir, files[0] as string), "utf8");
    // The code lives in the subject line, which is where the real message puts it.
    expect(written).toContain("Your Farm Friend code: 123456");
    expect(written).toContain("farmer@example.com");
    expect(written).toContain("Your code is 123456.");
  });

  it("returns a provider message id, so the sender records the same shape as SMTP", async () => {
    const send = createEmailSimulatorTransport({ directory: dir, nodeEnv: "development" });
    const result = await send(request);
    expect(result.providerMessageId).toContain("key-1");
  });

  it("keeps every message rather than overwriting, so a re-request does not hide the first", async () => {
    const send = createEmailSimulatorTransport({ directory: dir, nodeEnv: "development" });
    await send(request);
    await send({ ...request, idempotencyKey: "key-2", subject: "Your Farm Friend code: 654321" });

    expect(readdirSync(dir)).toHaveLength(2);
  });

  it("creates the directory when it does not exist yet", async () => {
    const nested = join(dir, "does", "not", "exist");
    const send = createEmailSimulatorTransport({ directory: nested, nodeEnv: "development" });
    await send(request);
    expect(readdirSync(nested)).toHaveLength(1);
  });
});
