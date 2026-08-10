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

/** The visible sender identity shared by every email provider. */
export interface EmailConfig {
  /** The visible From. Configuration, never a hard-coded string. */
  fromAddress: string;
  /** The display name a recipient's mail client shows. */
  fromName?: string;
}

/** Resolved SMTP configuration. SMTP-only connection values stay out of other providers. */
export interface SmtpConfig extends EmailConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

export type EmailConfigResult =
  | { ok: true; config: SmtpConfig }
  | {
      ok: false;
      reason:
        | "not_configured"
        | "incomplete"
        | "invalid_port"
        | "blocked_port"
        | "invalid_sender"
        | "invalid_sender_name";
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

  // The display name is folded into a header, so a value carrying quotes, angle brackets, or a
  // line break can RESTRUCTURE that header — `"VIGA" <someone@else.com>` makes the sender a
  // recipient sees differ from the one configured, and a newline can append headers outright
  // (a Bcc, for instance). Refused rather than escaped: this is deployment configuration with
  // a handful of legitimate values, and a strict allowlist is the honest tool.
  const rawName = env.SMTP_FROM_NAME?.trim();
  if (rawName !== undefined && rawName !== "" && !/^[A-Za-z0-9 .,'&()-]{1,64}$/.test(rawName)) {
    return { ok: false, reason: "invalid_sender_name", missing: ["SMTP_FROM_NAME"] };
  }

  return {
    ok: true,
    config: {
      host: (env.SMTP_HOST as string).trim(),
      port,
      username: (env.SMTP_USERNAME as string).trim(),
      password: env.SMTP_PASSWORD as string,
      fromAddress,
      ...(rawName !== undefined && rawName !== "" ? { fromName: rawName } : {}),
    },
  };
}

/** The provider call. Receives a deliverable address and the rendered message, nothing else. */
export type EmailTransport = (request: {
  toEmail: string;
  fromAddress: string;
  /** Absent when unconfigured; the transport then sends the bare address. */
  fromName?: string;
  subject: string;
  text: string;
  /** HTML alternative, when the message has a styled version. */
  html?: string;
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
  html?: string;
  idempotencyKey: string;
}

export interface EmailSenderOptions {
  config: EmailConfig;
  transport: EmailTransport;
  logger?: EmailLogger;
}

/**
 * A transport declares a definitive refusal only when its protocol proves no message was
 * accepted. Everything else — including an HTTP 5xx or a dropped connection — stays ambiguous.
 */
function classify(error: unknown): EmailDispatchOutcome {
  const failure = error as { responseCode?: number; definitive?: boolean; code?: string } | null;
  const responseCode = failure?.responseCode;
  // NOTHING from an error message or response body reaches the log. Gmail error bodies can
  // contain OAuth details; only a numeric provider status or a constrained transport code may.
  const errorCode =
    typeof failure?.code === "string" && /^[A-Z0-9_]{1,32}$/.test(failure.code)
      ? failure.code
      : typeof responseCode === "number"
        ? String(responseCode)
        : "unknown";
  if (failure?.definitive === true) {
    return { outcome: "definitive_rejection", errorCode };
  }

  return {
    outcome: "ambiguous",
    errorCode,
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
        ...(options.config.fromName !== undefined
          ? { fromName: options.config.fromName }
          : {}),
        subject: input.subject,
        text: input.text,
        ...(input.html === undefined ? {} : { html: input.html }),
        idempotencyKey: input.idempotencyKey,
      });
      return log({ outcome: "accepted", providerMessageId });
    } catch (error) {
      return log(classify(error));
    }
  };
}
