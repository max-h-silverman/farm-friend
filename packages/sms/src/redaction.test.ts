import { describe, expect, it } from "vitest";
import {
  containsRawPhone,
  OutboundRedactionError,
  redactOutbound,
  SmsSimulator,
  type OutboundMessage,
} from "./index";

describe("outbound redaction guard — runtime guard (Golden Rule #6, layer 2)", () => {
  it("blocks a raw phone number even if the model output contains one", () => {
    expect(() => redactOutbound("Reply YES. Or call the farmer at (206) 555-1234")).toThrow(
      OutboundRedactionError,
    );
    for (const raw of ["2065551234", "206-555-1234", "206.555.1234", "+1 206 555 1234"]) {
      expect(containsRawPhone(`text ${raw} here`)).toBe(true);
    }
  });

  it("passes a clean message and stamps the brand", () => {
    const body = redactOutbound("Provo Farms: tomatoes, kale, eggs. Still right? Reply YES.");
    // Type-level: `body` is RedactedOutbound, so it's accepted by send() below (compile guard).
    const msg: OutboundMessage = { toPhoneHash: "abc", body };
    expect(typeof body).toBe("string");
    expect(msg.body).toContain("Provo Farms");
  });

  it("only a RedactedOutbound can be sent (the simulator records it)", async () => {
    const sim = new SmsSimulator(() => {});
    await sim.send({ toPhoneHash: "abc", body: redactOutbound("Reply YES to publish.") });
    expect(sim.sent).toHaveLength(1);
    expect(sim.sent[0]!.toPhoneHash).toBe("abc");
  });
});
