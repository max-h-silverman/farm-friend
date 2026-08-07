import { EmailNormalizationError, normalizeEmail } from "../privacy/email";

// F-078 — the email sending seam.
//
// Deliberately the same shape as `packages/sms/src/delivery.ts`: config that fails closed, a
// narrow injected transport, and outcomes split into definitive / ambiguous. Farm Friend now
// has two last-mile channels and they should be one pattern, not two.
//
// THE PROVIDER IS BEHIND A SEAM. `transport` is a function, so nothing here imports an SMTP
// library and every test runs without a mail server. Swapping Google's relay for another
// provider is a new transport, not a change to any of this.

/** Resolved, complete email configuration. */
export interface EmailConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  /** The visible From. Configuration, never a hard-coded string. */
  fromAddress: string;
}

export type EmailConfigResult =
  | { ok: true; config: EmailConfig }
  | {
      ok: false;
      reason:
        | "not_configured"
        | "incomplete"
        | "invalid_port"
        | "blocked_port"
        | "invalid_sender";
      missing: string[];
    };

const REQUIRED_VARS = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USERNAME",
  "SMTP_PASSWORD",
  "SMTP_FROM_ADDRESS",
] as const;

/**
 * Resolve email configuration.
 *
 * **Absent is a supported deployment**, exactly like `GEOCODING_API_KEY`: with nothing set,
 * `not_configured` means email verification is unavailable and everything else runs. That is
 * why this returns a result rather than throwing.
 *
 * **Partial is NOT.** A host with no password is the dangerous middle — it is how mail
 * silently goes nowhere while the configuration looks present. Every partial state fails
 * closed and names what is missing.
 *
 * No value from the environment is ever interpolated into a reason or a message here, because
 * these results reach logs and one of the values is a live credential.
 */
export function resolveEmailConfig(
  env: Record<string, string | undefined>,
): EmailConfigResult {
  const present = REQUIRED_VARS.filter((name) => {
    const value = env[name];
    return value !== undefined && value.trim() !== "";
  });

  if (present.length === 0) {
    return { ok: false, reason: "not_configured", missing: [...REQUIRED_VARS] };
  }

  const missing = REQUIRED_VARS.filter((name) => !present.includes(name));
  if (missing.length > 0) {
    return { ok: false, reason: "incomplete", missing: [...missing] };
  }

  const port = Number((env.SMTP_PORT as string).trim());
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, reason: "invalid_port", missing: ["SMTP_PORT"] };
  }
  // Google Cloud blocks outbound port 25 with no way to open it, so a relay reached on 25
  // fails from Cloud Run no matter how it is configured. Refused here as well as in Terraform:
  // the platform check catches a bad deploy, this catches a bad `.env`.
  if (port === 25) {
    return { ok: false, reason: "blocked_port", missing: ["SMTP_PORT"] };
  }

  let fromAddress: string;
  try {
    fromAddress = normalizeEmail(env.SMTP_FROM_ADDRESS as string);
  } catch (error) {
    if (!(error instanceof EmailNormalizationError)) throw error;
    return { ok: false, reason: "invalid_sender", missing: ["SMTP_FROM_ADDRESS"] };
  }

  return {
    ok: true,
    config: {
      host: (env.SMTP_HOST as string).trim(),
      port,
      username: (env.SMTP_USERNAME as string).trim(),
      password: env.SMTP_PASSWORD as string,
      fromAddress,
    },
  };
}

/** The provider call. Receives a deliverable address and the rendered message, nothing else. */
export type EmailTransport = (request: {
  toEmail: string;
  fromAddress: string;
  subject: string;
  text: string;
  idempotencyKey: string;
}) => Promise<{ providerMessageId: string }>;

export type EmailDispatchOutcome =
  | { outcome: "accepted"; providerMessageId: string }
  /** The relay definitely did not accept it. A bounded retry is permitted. */
  | { outcome: "definitive_rejection"; errorCode: string }
  /** It may have been accepted. NEVER resend automatically. */
  | { outcome: "ambiguous"; errorCode: string };

export interface EmailLogEntry {
  /** The hash, when the caller has one. Never the address. */
  recipientHash?: string;
  idempotencyKey: string;
  outcome: EmailDispatchOutcome["outcome"];
  errorCode?: string;
}

export type EmailLogger = (entry: EmailLogEntry) => void;

export interface EmailSendInput {
  toEmail: string;
  /** Carried through to logs so an operator can correlate without seeing the address. */
  recipientHash?: string;
  subject: string;
  text: string;
  idempotencyKey: string;
}

export interface EmailSenderOptions {
  config: EmailConfig;
  transport: EmailTransport;
  logger?: EmailLogger;
}

/**
 * SMTP reply codes where the relay definitively refused. `5xx` is permanent by the protocol —
 * a bad mailbox, a rejected sender. Everything else, including `4xx` and any transport-level
 * failure, may still have been accepted.
 */
function classify(error: unknown): EmailDispatchOutcome {
  const responseCode = (error as { responseCode?: number } | null)?.responseCode;
  if (typeof responseCode === "number" && responseCode >= 500 && responseCode < 600) {
    return { outcome: "definitive_rejection", errorCode: String(responseCode) };
  }

  // NOTHING from the error's message or body reaches `errorCode` — only a numeric response
  // code or a transport error code. An SMTP auth failure's text can echo the credential back,
  // and this value is logged.
  const code = (error as { code?: string } | null)?.code;
  return {
    outcome: "ambiguous",
    errorCode:
      typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code)
        ? code
        : typeof responseCode === "number"
          ? String(responseCode)
          : "unknown",
  };
}

/**
 * Build the send capability.
 *
 * **A failure is never automatically resent by this function.** An ambiguous outcome on a
 * verification code is worse than a definitive one: the farmer may already hold a valid code,
 * and sending a second invalidates the first while they are typing it.
 */
export function createEmailSender(options: EmailSenderOptions) {
  return async function send(input: EmailSendInput): Promise<EmailDispatchOutcome> {
    const log = (result: EmailDispatchOutcome) => {
      options.logger?.({
        ...(input.recipientHash !== undefined
          ? { recipientHash: input.recipientHash }
          : {}),
        idempotencyKey: input.idempotencyKey,
        outcome: result.outcome,
        ...("errorCode" in result ? { errorCode: result.errorCode } : {}),
      });
      return result;
    };

    let toEmail: string;
    try {
      toEmail = normalizeEmail(input.toEmail);
    } catch (error) {
      if (!(error instanceof EmailNormalizationError)) throw error;
      // Fail closed before the transport is reached. An unresolvable recipient is never a
      // retryable provider condition.
      return log({ outcome: "definitive_rejection", errorCode: "recipient_invalid" });
    }

    try {
      const { providerMessageId } = await options.transport({
        toEmail,
        fromAddress: options.config.fromAddress,
        subject: input.subject,
        text: input.text,
        idempotencyKey: input.idempotencyKey,
      });
      return log({ outcome: "accepted", providerMessageId });
    } catch (error) {
      return log(classify(error));
    }
  };
}
