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

  it("takes the client hop Cloud Run appends, ignoring caller-supplied prefixes", () => {
    // THE PLATFORM CONTRACT, and it is the reverse of Vercel's.
    //
    // On Cloud Run the caller controls everything it sends in `X-Forwarded-For`; Google's
    // front end APPENDS the address it actually observed. So the trustworthy hop is at the
    // RIGHT, and the leftmost entry is attacker-chosen text.
    //
    // Reading from the left here — as this did while the app ran on Vercel — hands the
    // abuse throttle to the attacker: send a random leftmost hop per request and every
    // request lands in a fresh bucket with a fresh budget, which is the throttle removed
    // rather than merely weakened.
    const attacker = "203.0.113.7";
    const observed = "70.41.3.18";
    const a = clientSignalFor(
      new Headers({ "x-forwarded-for": `${attacker}, ${observed}` }),
      salt,
    );
    const b = clientSignalFor(
      new Headers({ "x-forwarded-for": `198.51.100.99, ${observed}` }),
      salt,
    );
    // Same real client, different spoofed prefix — must be ONE bucket.
    expect(a).toBe(b);
  });

  it("does not let a spoofed prefix mint a new bucket per request", () => {
    // The same property stated as the attack it prevents, so a refactor that reintroduces
    // left-reading fails a test whose name says what broke.
    const observed = "70.41.3.18";
    const buckets = new Set(
      ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4"].map((spoofed) =>
        clientSignalFor(
          new Headers({ "x-forwarded-for": `${spoofed}, ${observed}` }),
          salt,
        ),
      ),
    );
    expect(buckets.size).toBe(1);
  });

  it("separates genuinely different clients behind the same proxy", () => {
    // The counterpart: taking the rightmost hop must not collapse everyone into one bucket.
    const a = clientSignalFor(
      new Headers({ "x-forwarded-for": "203.0.113.7, 70.41.3.18" }),
      salt,
    );
    const b = clientSignalFor(
      new Headers({ "x-forwarded-for": "203.0.113.7, 150.172.238.178" }),
      salt,
    );
    expect(a).not.toBe(b);
  });

  it("ignores trailing blank entries when selecting the appended hop", () => {
    // A malformed trailing comma must not make the signal bucket on empty text — that
    // would collapse every malformed request into one shared bucket by accident rather
    // than by the deliberate null path below.
    const withTrailer = clientSignalFor(
      new Headers({ "x-forwarded-for": "203.0.113.7, 70.41.3.18, " }),
      salt,
    );
    const clean = clientSignalFor(
      new Headers({ "x-forwarded-for": "203.0.113.7, 70.41.3.18" }),
      salt,
    );
    expect(withTrailer).toBe(clean);
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
