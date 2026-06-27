export interface OutboundSmsMessage {
  to: string;
  body: string;
  meta?: Record<string, string>;
}

export interface SmsSendResult {
  providerMessageId: string;
  transport: string;
}

export interface SmsTransport {
  readonly name: string;
  send(message: OutboundSmsMessage): Promise<SmsSendResult>;
}

export class SimulatorSmsTransport implements SmsTransport {
  readonly name = "simulator";
  readonly sent: OutboundSmsMessage[] = [];

  async send(message: OutboundSmsMessage): Promise<SmsSendResult> {
    this.sent.push(message);
    return {
      providerMessageId: `sim-${this.sent.length}`,
      transport: this.name,
    };
  }
}
