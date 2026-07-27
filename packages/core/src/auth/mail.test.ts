import { describe, expect, it } from "vitest";
import { createUnconfiguredMailSender, MailNotConfiguredError } from "./mail";

// F-032 — the mail seam fails CLOSED when no provider is configured.
//
// The failure mode this forecloses: a "no provider configured" sender that quietly returns
// success. Everything downstream would look healthy — the route would answer 202, the tests
// would pass, the operator would never receive a link, and nothing would say why. A seam
// that silently swallows the one message the feature exists to send is worse than no seam.
//
// So the unconfigured sender THROWS. F-031 replaces it with a real adapter; until then the
// composition root wires this one and any attempt to send is a loud, attributable failure.

describe("createUnconfiguredMailSender", () => {
  const message = {
    to: "operator@viga.example",
    subject: "Your Farm Friend sign-in link",
    text: "https://ff.example/api/auth/callback?token=abc.def",
  };

  it("throws rather than pretending to send", async () => {
    const sender = createUnconfiguredMailSender();
    await expect(sender.send(message)).rejects.toThrow(MailNotConfiguredError);
  });

  it("names the missing configuration so the failure is actionable", async () => {
    const sender = createUnconfiguredMailSender();
    await expect(sender.send(message)).rejects.toThrow(/mail provider/i);
  });

  it("does not put the message body in the error it throws", async () => {
    // The body carries a live sign-in link. An error message is the single most likely thing
    // to reach a log aggregator, so the credential must not ride along in one.
    const sender = createUnconfiguredMailSender();
    const error = await sender.send(message).catch((e: unknown) => e);
    const serialized = `${String(error)} ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`;
    expect(serialized).not.toContain("token=abc.def");
    expect(serialized).not.toContain(message.text);
  });

  it("does not put the recipient address in the error it throws", async () => {
    // Who VIGA's operators are is exactly what this feature must not leak (see the
    // enumeration tests on the route). A thrown error is not an exception to that.
    const sender = createUnconfiguredMailSender();
    const error = await sender.send(message).catch((e: unknown) => e);
    const serialized = `${String(error)} ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`;
    expect(serialized).not.toContain("operator@viga.example");
  });
});
