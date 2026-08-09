import { describe, expect, it, vi } from "vitest";

import { createGmailTransport } from "./gmail-transport";

const CONFIG = {
  fromAddress: "board@vigavashon.org",
  fromName: "VIGA",
  clientId: "client-id.apps.googleusercontent.com",
  clientSecret: "client-secret",
  refreshToken: "refresh-token",
};

describe("Gmail transport", () => {
  it("exchanges the refresh token then submits one RFC 2822 message over HTTPS", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ access_token: "access-token", expires_in: 3600 }))
      .mockResolvedValueOnce(Response.json({ id: "gmail-message-id" }));
    const send = createGmailTransport(CONFIG, { fetcher });

    await expect(
      send({
        toEmail: "farmer@example.com",
        fromAddress: CONFIG.fromAddress,
        fromName: CONFIG.fromName,
        subject: "284107 is your VIGA Farm Stand Map code",
        text: "Your code is 284107.",
        idempotencyKey: "verification-123",
      }),
    ).resolves.toEqual({ providerMessageId: "gmail-message-id" });

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer access-token" }),
      }),
    );

    const request = fetcher.mock.calls[1]?.[1] as RequestInit;
    const raw = Buffer.from(JSON.parse(request.body as string).raw, "base64url").toString("utf8");
    expect(raw).toContain("From: =?UTF-8?B?VklHQQ==?= <board@vigavashon.org>\r\n");
    expect(raw).toContain("To: farmer@example.com\r\n");
    expect(raw).toContain("Reply-To: board@vigavashon.org\r\n");
    expect(raw).toContain("X-Farm-Friend-Idempotency-Key: verification-123\r\n");
    expect(raw).toContain("Content-Transfer-Encoding: base64\r\n\r\n");
    expect(raw).toContain(Buffer.from("Your code is 284107.").toString("base64"));
  });

  it("marks a rejected Gmail API request as definitive without logging its body", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ access_token: "access-token" }))
      .mockResolvedValueOnce(Response.json({ error: { message: "do not log me" } }, { status: 403 }));
    const send = createGmailTransport(CONFIG, { fetcher });

    await expect(
      send({
        toEmail: "farmer@example.com",
        fromAddress: CONFIG.fromAddress,
        subject: "subject",
        text: "secret code",
        idempotencyKey: "verification-123",
      }),
    ).rejects.toEqual({ responseCode: 403, definitive: true });
  });
});
