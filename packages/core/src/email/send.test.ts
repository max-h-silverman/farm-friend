import { describe, expect, it, vi } from "vitest";

import { createEmailSender, resolveEmailConfig } from "./send";

const CONFIG = {
  host: "smtp-relay.gmail.com",
  port: 587,
  username: "board@vigavashon.org",
  password: "abcdefghijklmnop",
  fromAddress: "board@vigavashon.org",
};

describe("resolveEmailConfig", () => {
  const complete = {
    SMTP_HOST: "smtp-relay.gmail.com",
    SMTP_PORT: "587",
    SMTP_USERNAME: "board@vigavashon.org",
    SMTP_PASSWORD: "abcdefghijklmnop",
    SMTP_FROM_ADDRESS: "board@vigavashon.org",
  };

  it("carries a DISPLAY NAME when one is configured", () => {
    // What a recipient's mail client shows in the sender column. Without it they see the bare
    // mailbox — "board" — which says nothing about who is writing.
    const result = resolveEmailConfig({
      ...complete,
      SMTP_FROM_NAME: "VIGA",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.fromName).toBe("VIGA");
  });

  it("treats the display name as OPTIONAL, unlike the address", () => {
    // Absent is a working deployment: the address alone is a valid sender. Only the address is
    // load-bearing, because it is what the relay authorizes and what replies return to.
    const result = resolveEmailConfig(complete);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.fromName).toBeUndefined();
  });

  it("refuses a display name that could forge a second address", () => {
    // A name containing quotes, angle brackets, or a newline can restructure the From header —
    // `"VIGA" <someone@else.com>` — so the sender a recipient sees is not the one configured.
    // Header injection via a newline is the sharper case: it can append entirely new headers.
    for (const bad of [
      'VIGA" <evil@example.com',
      "VIGA <evil@example.com>",
      "VIGA\nBcc: evil@example.com",
      "VIGA\r\nBcc: evil@example.com",
    ]) {
      const result = resolveEmailConfig({ ...complete, SMTP_FROM_NAME: bad });
      expect(result.ok, bad).toBe(false);
      if (!result.ok) expect(result.reason).toBe("invalid_sender_name");
    }
  });

  it("accepts the ordinary names VIGA would actually use", () => {
    for (const good of ["VIGA", "VIGA Farm Stand Map", "VIGA - Farm Stands"]) {
      const result = resolveEmailConfig({ ...complete, SMTP_FROM_NAME: good });
      expect(result.ok, good).toBe(true);
    }
  });

  it("reads a complete configuration", () => {
    const result = resolveEmailConfig(complete);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config).toEqual(CONFIG);
  });

  it("reports EMAIL UNCONFIGURED when nothing is set, which is a supported deployment", () => {
    // Absent is not an error. Like GEOCODING_API_KEY, no SMTP configuration means the feature
    // is unavailable, never that the deployment fails to start.
    const result = resolveEmailConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_configured");
  });

  it("FAILS CLOSED on a partial configuration rather than guessing", () => {
    // The dangerous middle: someone set the host and forgot the password. Falling back to a
    // default host or an unauthenticated send is how mail silently goes nowhere.
    for (const omitted of Object.keys(complete)) {
      const partial = { ...complete };
      delete (partial as Record<string, string>)[omitted];
      const result = resolveEmailConfig(partial);
      expect(result.ok, `omitting ${omitted}`).toBe(false);
      if (!result.ok) {
        expect(result.reason, `omitting ${omitted}`).toBe("incomplete");
        expect(result.missing, `omitting ${omitted}`).toContain(omitted);
      }
    }
  });

  it("treats a blank value as absent, not as a value", () => {
    const result = resolveEmailConfig({ ...complete, SMTP_PASSWORD: "   " });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toContain("SMTP_PASSWORD");
  });

  it("refuses port 25, which Google Cloud blocks outbound with no way to open it", () => {
    const result = resolveEmailConfig({ ...complete, SMTP_PORT: "25" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("blocked_port");
  });

  it("refuses a non-numeric port rather than defaulting to one", () => {
    const result = resolveEmailConfig({ ...complete, SMTP_PORT: "five-eight-seven" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_port");
  });

  it("refuses a sender that is not a single address", () => {
    const result = resolveEmailConfig({ ...complete, SMTP_FROM_ADDRESS: "VIGA Board" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_sender");
  });

  it("never puts the password in the failure reason or the missing list values", () => {
    // A config error goes to logs. The password must not ride along with it.
    const result = resolveEmailConfig({ ...complete, SMTP_PORT: "25" });
    expect(JSON.stringify(result)).not.toContain("abcdefghijklmnop");
  });
});

describe("createEmailSender", () => {
  it("sends through the transport with the configured sender", async () => {
    const transport = vi.fn().mockResolvedValue({ providerMessageId: "m1" });
    const send = createEmailSender({ config: CONFIG, transport });

    const result = await send({
      toEmail: "cathy@example.com",
      subject: "284107 is your VIGA Farm Stand Map code",
      text: "body",
      html: "<p>body</p>",
      idempotencyKey: "k1",
    });

    expect(result).toEqual({ outcome: "accepted", providerMessageId: "m1" });
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        toEmail: "cathy@example.com",
        fromAddress: "board@vigavashon.org",
        html: "<p>body</p>",
      }),
    );
  });

  it("passes the display name through to the transport when configured", async () => {
    const transport = vi.fn().mockResolvedValue({ providerMessageId: "m1" });
    const send = createEmailSender({
      config: { ...CONFIG, fromName: "VIGA" },
      transport,
    });

    await send({
      toEmail: "cathy@example.com",
      subject: "s",
      text: "t",
      idempotencyKey: "k",
    });

    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        fromAddress: "board@vigavashon.org",
        fromName: "VIGA",
      }),
    );
  });

  it("classifies a rejected recipient as definitive, never as retryable", async () => {
    const transport = vi.fn().mockRejectedValue({ responseCode: 550, definitive: true });
    const send = createEmailSender({ config: CONFIG, transport });

    const result = await send({
      toEmail: "nobody@example.com",
      subject: "s",
      text: "t",
      idempotencyKey: "k",
    });

    expect(result.outcome).toBe("definitive_rejection");
  });

  it("keeps an unclassified provider 5xx ambiguous", async () => {
    const transport = vi.fn().mockRejectedValue({ responseCode: 500 });
    const send = createEmailSender({ config: CONFIG, transport });

    const result = await send({
      toEmail: "cathy@example.com",
      subject: "s",
      text: "t",
      idempotencyKey: "k",
    });

    expect(result).toEqual({ outcome: "ambiguous", errorCode: "500" });
  });

  it("records a provider-declared refusal as definitive even when it has no SMTP reply code", async () => {
    const transport = vi.fn().mockRejectedValue({ responseCode: 401, definitive: true });
    const send = createEmailSender({ config: CONFIG, transport });

    const result = await send({
      toEmail: "cathy@example.com",
      subject: "s",
      text: "t",
      idempotencyKey: "k",
    });

    expect(result).toEqual({ outcome: "definitive_rejection", errorCode: "401" });
  });

  it("classifies a timeout as AMBIGUOUS, so it is never blindly resent", async () => {
    // The relay may have accepted it. Resending a verification code because the connection
    // dropped sends a farmer two different codes and invalidates the one they are typing.
    const transport = vi.fn().mockRejectedValue({ code: "ETIMEDOUT" });
    const send = createEmailSender({ config: CONFIG, transport });

    const result = await send({
      toEmail: "cathy@example.com",
      subject: "s",
      text: "t",
      idempotencyKey: "k",
    });

    expect(result.outcome).toBe("ambiguous");
  });

  it("logs the recipient HASH and never the address", async () => {
    const entries: unknown[] = [];
    const transport = vi.fn().mockResolvedValue({ providerMessageId: "m1" });
    const send = createEmailSender({
      config: CONFIG,
      transport,
      logger: (entry) => entries.push(entry),
    });

    await send({
      toEmail: "cathy@example.com",
      recipientHash: "a".repeat(64),
      subject: "s",
      text: "t",
      idempotencyKey: "k",
    });

    const serialized = JSON.stringify(entries);
    expect(serialized).toContain("a".repeat(64));
    expect(serialized).not.toContain("cathy@example.com");
    expect(serialized).not.toContain("cathy");
  });

  it("never logs the message body, which carries the code", async () => {
    const entries: unknown[] = [];
    const transport = vi.fn().mockResolvedValue({ providerMessageId: "m1" });
    const send = createEmailSender({
      config: CONFIG,
      transport,
      logger: (entry) => entries.push(entry),
    });

    await send({
      toEmail: "cathy@example.com",
      subject: "284107 is your VIGA Farm Stand Map code",
      text: "your code is 284107",
      idempotencyKey: "k",
    });

    expect(JSON.stringify(entries)).not.toContain("284107");
  });

  it("never logs the password even when the transport throws it back", async () => {
    const entries: unknown[] = [];
    const transport = vi
      .fn()
      .mockRejectedValue(new Error("535 auth failed for abcdefghijklmnop"));
    const send = createEmailSender({
      config: CONFIG,
      transport,
      logger: (entry) => entries.push(entry),
    });

    await send({
      toEmail: "cathy@example.com",
      subject: "s",
      text: "t",
      idempotencyKey: "k",
    });

    expect(JSON.stringify(entries)).not.toContain("abcdefghijklmnop");
  });

  it("refuses a recipient that is not a single address before any transport call", async () => {
    const transport = vi.fn();
    const send = createEmailSender({ config: CONFIG, transport });

    const result = await send({
      toEmail: "not-an-address",
      subject: "s",
      text: "t",
      idempotencyKey: "k",
    });

    expect(result.outcome).toBe("definitive_rejection");
    expect(transport).not.toHaveBeenCalled();
  });
});
