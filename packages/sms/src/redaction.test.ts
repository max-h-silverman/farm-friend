import { describe, expect, it } from "vitest";
import {
  containsRawPhone,
  OutboundRedactionError,
  redactOutbound,
  SmsSimulator,
  type OutboundMessage,
} from "./index";

// These tests demonstrate the guard's NARROW behavior: brand provenance and the named
// raw-phone class. They are not evidence that outbound text is universally clean — see the
// header of redaction.ts for what is deliberately not claimed.
describe("outbound guard — runtime enforcement of the named raw-phone class", () => {
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

  it("does not claim to detect private values outside the named class", () => {
    // Recorded deliberately: these PASS the guard. The boundary keeps them out by
    // code-rendering cross-actor messages from typed facts and returning model prose only
    // to its own author — not by scanning outbound text for arbitrary sensitive content.
    for (const body of [
      "Email the farmer at grower@example.com",
      "The stand is at 11 Stand Way, behind the red barn",
      "Call two oh six, five five five, one two three four",
    ]) {
      expect(() => redactOutbound(body)).not.toThrow();
    }
  });

  // B-001. The guard matched ANY run of ten digits, so a UUID's hex digits could form a
  // "phone" by chance — ~3% of random UUIDs. That randomly refused legitimate sends in
  // production and made the integration suite fail about 1 run in 8 on whichever test
  // happened to put a UUID in scanned text. A phone number is digits standing on their own,
  // not ten digits embedded in a longer alphanumeric run.
  it("does not mistake identifiers that merely contain ten digits for a phone", () => {
    for (const uuid of [
      "45eb719d-1cda-4d04-8386-4f4416231050",
      "fbb67d7e-ac70-499b-b2aa-312028693170",
      "b65c1c32-26c2-43c3-9697-7323340e2fe7",
      "739e6864-4404-4310-a752-167579010e61",
      "0ff3f20f-91e4-4b1b-aede-8364953947c7",
    ]) {
      expect(containsRawPhone(uuid)).toBe(false);
      expect(containsRawPhone(`{"factId":"${uuid}"}`)).toBe(false);
      expect(() => redactOutbound(`Your listing ${uuid} is published.`)).not.toThrow();
    }
  });

  it("still blocks a real phone adjacent to identifier-ish text", () => {
    // The boundary fix must not be a loophole: a genuine phone stays refused even when it
    // sits beside JSON punctuation or an identifier.
    expect(containsRawPhone('{"id":"a1b2","phone":"206-555-1234"}')).toBe(true);
    expect(containsRawPhone("call 2065551234, then reply YES")).toBe(true);
    expect(() => redactOutbound("ref 7f3a — call (206) 555-1234")).toThrow(
      OutboundRedactionError,
    );
  });

  it("only a RedactedOutbound can be sent (the simulator records it)", async () => {
    const sim = new SmsSimulator(() => {});
    await sim.send({ toPhoneHash: "abc", body: redactOutbound("Reply YES to publish.") });
    expect(sim.sent).toHaveLength(1);
    expect(sim.sent[0]!.toPhoneHash).toBe("abc");
  });
});
