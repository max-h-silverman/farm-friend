import { EmailNormalizationError, normalizeEmail, type EmailConfig, type EmailTransport } from "@farm-friend/core";

// B-045 — Gmail's HTTPS API replaces the Cloud Run SMTP socket. This adapter holds the only
// Google OAuth exchange and MIME construction; core still owns recipient validation, rendering,
// logging, and delivery outcomes.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
export interface GmailConfig extends EmailConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

type Fetcher = typeof fetch;

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required for EMAIL_PROVIDER=gmail`);
  }
  return value;
}

/** Resolve the one send-only mailbox identity and OAuth grant Gmail needs. */
export function resolveGmailConfig(env: Record<string, string | undefined>): GmailConfig {
  let fromAddress: string;
  try {
    fromAddress = normalizeEmail(required(env, "GMAIL_SENDER_ADDRESS"));
  } catch (error) {
    if (!(error instanceof EmailNormalizationError)) throw error;
    throw new Error("GMAIL_SENDER_ADDRESS must be a single email address");
  }

  const rawName = env.GMAIL_SENDER_NAME?.trim();
  if (rawName !== undefined && rawName !== "" && !/^[A-Za-z0-9 .,'&()-]{1,64}$/.test(rawName)) {
    throw new Error("GMAIL_SENDER_NAME is invalid");
  }

  return {
    fromAddress,
    ...(rawName !== undefined && rawName !== "" ? { fromName: rawName } : {}),
    clientId: required(env, "GMAIL_OAUTH_CLIENT_ID"),
    clientSecret: required(env, "GMAIL_OAUTH_CLIENT_SECRET"),
    refreshToken: required(env, "GMAIL_OAUTH_REFRESH_TOKEN"),
  };
}

function transportFailure(responseCode: number): { responseCode: number; definitive?: true } {
  // A 4xx response is a completed refusal from Gmail, not a dropped response. A 5xx response
  // may follow a send Gmail accepted, so it stays ambiguous and is never resent automatically.
  return responseCode >= 400 && responseCode < 500
    ? { responseCode, definitive: true }
    : { responseCode };
}

function header(value: string): string {
  if (/[\r\n]/.test(value)) throw { code: "INVALID_MESSAGE", definitive: true };
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function mailbox(value: string): string {
  if (/[\r\n<>]/.test(value)) throw { code: "INVALID_MESSAGE", definitive: true };
  return value;
}

function message(request: Parameters<EmailTransport>[0]): string {
  if (/[\r\n]/.test(request.idempotencyKey) || request.idempotencyKey.length > 256) {
    throw { code: "INVALID_MESSAGE", definitive: true };
  }

  const fromAddress = mailbox(request.fromAddress);
  const toEmail = mailbox(request.toEmail);
  const from = request.fromName === undefined
    ? fromAddress
    : `${header(request.fromName)} <${fromAddress}>`;
  const body = Buffer.from(request.text, "utf8").toString("base64");

  return [
    `From: ${from}`,
    `To: ${toEmail}`,
    `Reply-To: ${fromAddress}`,
    `Subject: ${header(request.subject)}`,
    `X-Farm-Friend-Idempotency-Key: ${request.idempotencyKey}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join("\r\n");
}

/**
 * Build the Gmail HTTPS transport. A refresh token is bound to the board mailbox and grants
 * only `gmail.send`; it cannot read mailbox contents or send as another VIGA account.
 */
export function createGmailTransport(
  config: GmailConfig,
  options: { fetcher?: Fetcher } = {},
): EmailTransport {
  const fetcher = options.fetcher ?? fetch;

  return async function send(request) {
    const tokenResponse = await fetcher(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!tokenResponse.ok) throw transportFailure(tokenResponse.status);

    const token = await tokenResponse.json() as { access_token?: unknown };
    if (typeof token.access_token !== "string" || token.access_token === "") {
      throw { code: "TOKEN_RESPONSE" };
    }

    const sendResponse = await fetcher(SEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ raw: Buffer.from(message(request), "utf8").toString("base64url") }),
    });
    if (!sendResponse.ok) throw transportFailure(sendResponse.status);

    const payload = await sendResponse.json() as { id?: unknown };
    if (typeof payload.id !== "string" || payload.id === "") throw { code: "SEND_RESPONSE" };
    return { providerMessageId: payload.id };
  };
}
