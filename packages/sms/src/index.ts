import type { RedactedOutbound } from "./redaction";
import { estimateSmsSegments, type SmsSegmentEstimate } from "./segments";

export * from "./redaction";
export * from "./segments";
export * from "./telnyx";
export * from "./delivery";

export interface OutboundMessage {
  toPhoneHash: string; // recipient keyed by hash, never raw
  body: RedactedOutbound; // compile guard: only the redaction guard can produce this
}

export interface SentMessage {
  toPhoneHash: string;
  body: string;
  sentAt: Date;
}

export interface OutboundSmsMetrics extends SmsSegmentEstimate {
  toPhoneHash: string;
}

export type SmsMetricsLogger = (metrics: OutboundSmsMetrics) => void;

const consoleMetricsLogger: SmsMetricsLogger = (metrics) => {
  console.info("sms.outbound", metrics);
};

/** Log only the recipient hash and cost-relevant body measurements, never message content. */
export function logOutboundSmsMetrics(
  msg: OutboundMessage,
  logger: SmsMetricsLogger = consoleMetricsLogger,
): void {
  logger({
    toPhoneHash: msg.toPhoneHash,
    ...estimateSmsSegments(msg.body),
  });
}

/** The SMS provider seam. `send` accepts only a RedactedOutbound (compile guard); the
 *  concrete transport still receives an already-scanned body (runtime guard). */
export interface SmsTransport {
  send(msg: OutboundMessage): Promise<void>;
  /** Start carrier verification for a number (stubbed in Phase 0). */
  verify(phoneHash: string): Promise<void>;
}

/** In-memory simulator for tests and the local SMS end-to-end. Records what was sent. */
export class SmsSimulator implements SmsTransport {
  readonly sent: SentMessage[] = [];

  constructor(private readonly metricsLogger: SmsMetricsLogger = consoleMetricsLogger) {}

  async send(msg: OutboundMessage): Promise<void> {
    logOutboundSmsMetrics(msg, this.metricsLogger);
    this.sent.push({
      toPhoneHash: msg.toPhoneHash,
      body: msg.body,
      sentAt: new Date(),
    });
  }

  async verify(_phoneHash: string): Promise<void> {
    // no-op in the simulator
  }
}
