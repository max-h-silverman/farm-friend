import { describe, expect, it } from "vitest";
import { clientSignalFor } from "./client-signal";

// The coarse cost-bucket signal for the one public model surface (F-019).
//
// This is NOT identity and must never become a customer profile. It exists to keep one
// abuser from spending the model budget, so it is derived, hashed, kept out of durable
// state, and never logged raw.

describe("public client signal", () => {
  const salt = "test-salt";

  it("derives a stable signal for the same client", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.7" });
    const a = clientSignalFor(headers, salt);
    const b = clientSignalFor(headers, salt);
    expect(a).toBe(b);
  });

  it("never returns the raw address", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.7" });
    const signal = clientSignalFor(headers, salt);
    expect(signal).not.toContain("203.0.113.7");
    // An opaque hex digest, not a network address.
    expect(signal).toMatch(/^[0-9a-f]{64}$/);
  });

  it("separates different clients", () => {
    const a = clientSignalFor(new Headers({ "x-forwarded-for": "203.0.113.7" }), salt);
    const b = clientSignalFor(new Headers({ "x-forwarded-for": "203.0.113.8" }), salt);
    expect(a).not.toBe(b);
  });

  it("uses only the first hop of a forwarded chain", () => {
    // Downstream proxies append; the leftmost entry is the closest thing to the client.
    // Without this, an attacker appends a random hop per request and buys a fresh bucket.
    const a = clientSignalFor(
      new Headers({ "x-forwarded-for": "203.0.113.7, 70.41.3.18" }),
      salt,
    );
    const b = clientSignalFor(
      new Headers({ "x-forwarded-for": "203.0.113.7, 150.172.238.178" }),
      salt,
    );
    expect(a).toBe(b);
  });

  it("is salted, so the bucket key is not a rainbow-table lookup of an address", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.7" });
    expect(clientSignalFor(headers, "salt-a")).not.toBe(
      clientSignalFor(headers, "salt-b"),
    );
  });

  it("returns null when no address header is present", () => {
    // The throttle collapses null into one shared bucket — restrictive, not exempt.
    expect(clientSignalFor(new Headers(), salt)).toBeNull();
  });

  it("ignores a blank or whitespace-only header rather than bucketing on empty text", () => {
    expect(clientSignalFor(new Headers({ "x-forwarded-for": "   " }), salt)).toBeNull();
  });
});
