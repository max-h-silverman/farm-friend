import type { RedactedOutbound } from "./redaction";

export * from "./redaction";

export interface OutboundMessage {
  toPhoneHash: string; // recipient keyed by hash, never raw
  body: RedactedOutbound; // compile guard: only the redaction guard can produce this
}

export interface SentMessage {
  toPhoneHash: string;
  body: string;
  sentAt: Date;
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

  async send(msg: OutboundMessage): Promise<void> {
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

/** Telnyx adapter stub — the seam is wired; live sending lands with the A2P campaign. */
export class TelnyxTransport implements SmsTransport {
  constructor(private readonly apiKey: string) {}

  async send(_msg: OutboundMessage): Promise<void> {
    throw new Error("TelnyxTransport.send not implemented (Phase 0 stub)");
  }

  async verify(_phoneHash: string): Promise<void> {
    throw new Error("TelnyxTransport.verify not implemented (Phase 0 stub)");
  }
}
