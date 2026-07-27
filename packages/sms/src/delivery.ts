import type { RedactedOutbound } from "./redaction";

// The last-mile delivery capability (F-014).
//
// SMS cannot be sent to a hash, so exactly one place resolves the recipient's single
// stored raw E.164: here, immediately before the provider call. Everything else —
// queued outbox work, workflow values, idempotency keys, metrics, and logs — stays
// hash-only, and no second raw-phone field is ever created (Golden Rule #5).

/** Resolves a recipient hash to the one stored raw E.164, for dialing only. */
export interface PhoneResolver {
  resolveForDelivery(recipientHash: string): Promise<string | null>;
}

/** The provider call. It receives a dialable number and nothing else identifying. */
export type ProviderTransport = (request: {
  toPhone: string;
  body: string;
  idempotencyKey: string;
}) => Promise<{ providerMessageId: string }>;

export interface LastMileLogEntry {
  recipientHash: string;
  idempotencyKey: string;
  outcome: DispatchOutcome["outcome"];
  errorCode?: string;
}

export type LastMileLogger = (entry: LastMileLogEntry) => void;

export type DispatchOutcome =
  | { outcome: "accepted"; providerMessageId: string }
  /** The provider definitely did not accept it; a bounded retry is permitted. */
  | {
      outcome: "definitive_rejection";
      errorCode: string;
      providerCode?: string;
      errorDetail?: string;
    }
  /** It may have been accepted. Never resend automatically. */
  | {
      outcome: "ambiguous";
      errorCode: string;
      providerCode?: string;
      errorDetail?: string;
    };

export interface LastMileSendInput {
  recipientHash: string;
  body: RedactedOutbound;
  idempotencyKey: string;
}

export interface LastMileSenderOptions {
  resolver: PhoneResolver;
  transport: ProviderTransport;
  logger?: LastMileLogger;
}

/**
 * HTTP statuses where the provider definitively rejected the request. Anything else —
 * a timeout, a connection reset, a 5xx, an unrecognized failure — may have been accepted
 * and is therefore ambiguous rather than retryable.
 */
const DEFINITIVE_REJECTION_STATUSES = new Set([400, 401, 403, 404, 422]);

function classify(error: unknown): DispatchOutcome {
  const status = (error as { status?: number } | null)?.status;
  const code = (error as { code?: string } | null)?.code;

  // B-010: the transport attaches the provider's own code and explanation when it could
  // parse them. Both are carried through to storage as DIAGNOSTICS — `errorCode` stays the
  // value the retry policy reads, so adding these changes no dispatch decision today.
  //
  // `providerCode` is the machine token (Telnyx `40300`); it is validated as a token by
  // `summarizeProviderError`, which is what makes it safe for a future rule to key on.
  // `errorDetail` is free text and nothing may ever branch on it.
  const providerCode = (error as { providerCode?: string } | null)?.providerCode;
  const detail = (error as { detail?: string } | null)?.detail;
  const diagnostics = {
    ...(typeof providerCode === "string" ? { providerCode } : {}),
    ...(typeof detail === "string" ? { errorDetail: detail } : {}),
  };

  if (typeof status === "number" && DEFINITIVE_REJECTION_STATUSES.has(status)) {
    return { outcome: "definitive_rejection", errorCode: String(status), ...diagnostics };
  }
  return {
    outcome: "ambiguous",
    errorCode: code ?? (typeof status === "number" ? String(status) : "unknown"),
    ...diagnostics,
  };
}

/**
 * Build the narrow send capability. The returned function is the only path from a
 * recipient hash to a dialed number, and it never returns or logs that number.
 */
export function createLastMileSender(options: LastMileSenderOptions) {
  return async function send(input: LastMileSendInput): Promise<DispatchOutcome> {
    const log = (result: DispatchOutcome) => {
      options.logger?.({
        recipientHash: input.recipientHash,
        idempotencyKey: input.idempotencyKey,
        outcome: result.outcome,
        ...("errorCode" in result ? { errorCode: result.errorCode } : {}),
      });
      return result;
    };

    const toPhone = await options.resolver.resolveForDelivery(input.recipientHash);
    if (toPhone === null) {
      // Fail closed: an unresolvable recipient is never a retryable provider condition.
      return log({
        outcome: "definitive_rejection",
        errorCode: "recipient_unresolved",
      });
    }

    try {
      const { providerMessageId } = await options.transport({
        toPhone,
        body: input.body,
        idempotencyKey: input.idempotencyKey,
      });
      return log({ outcome: "accepted", providerMessageId });
    } catch (error) {
      return log(classify(error));
    }
  };
}
