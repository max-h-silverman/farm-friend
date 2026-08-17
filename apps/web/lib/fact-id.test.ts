import { describe, expect, it } from "vitest";
import { offeringFactId, providerFactId, standKeyOfFactId } from "./inquiry";

/*
  THE CODE-OWNED PAGING IDENTIFIER, and what it has to survive (F-114 C.5).

  A pending result list stores fact ids and `MORE` replays them. Two rules govern them:

  1. **Distinct rows get distinct ids.** Two rows sharing one id makes one unreachable on the
     second page and, worse, silently substitutes the other's items when the list is
     dereferenced.
  2. **`standKeyOfFactId` recovers the STAND from any of them.** Paging sizes a page in stands
     rather than in rows, so a stand's several rows must be recognisable as one stand. A page
     that took a flat count split a stand across two messages and printed it twice (B-062).

  ## What C.5 adds, and why it is a suffix rather than another nibble

  The offering variant is encoded by rewriting one hex nibble INSIDE the uuid — four values,
  which is exactly enough for "confirmed or offering". A stand now has an unbounded number of
  sellers, so the same trick cannot be extended: there is no nibble left, and no fixed-size
  encoding can carry a uuid.

  So a provider row appends `@<providerId>`. `@` cannot occur in a uuid, which is what makes the
  split unambiguous, and the stand key is recovered by taking the part before it — which then
  runs through the existing nibble rule unchanged. One mechanism gained a case; nothing already
  encoded had to be re-encoded.
*/

const STAND = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const PROVIDER = "9c858901-8a57-4791-81fe-4c455b099bc9";

describe("offeringFactId (unchanged by C.5)", () => {
  it("derives a distinct id for the same stand's standing offerings", () => {
    const offering = offeringFactId(STAND);
    expect(offering).not.toBe(STAND);
    expect(standKeyOfFactId(offering)).toBe(STAND);
  });

  it("falls back to a suffix for an id that is not a v4 uuid", () => {
    // The seeded short ids some suites use. Still one token, still collision-free.
    expect(standKeyOfFactId(offeringFactId("short-id"))).toBe("short-id");
  });
});

describe("providerFactId (F-114 C.5)", () => {
  it("gives each seller at one stand a distinct id", () => {
    const a = providerFactId(STAND, PROVIDER);
    const b = providerFactId(STAND, "11111111-2222-4333-8444-555555555555");
    expect(a).not.toBe(b);
    expect(a).not.toBe(STAND);
  });

  it("recovers the stand from a provider id", () => {
    expect(standKeyOfFactId(providerFactId(STAND, PROVIDER))).toBe(STAND);
  });

  it("recovers the stand from a provider id built on an OFFERING id", () => {
    // Both variants compose: a seller's standing offerings at a stand carry both markers, and
    // the stand must still be recoverable. This is the case a stand key that only stripped one
    // of the two would get wrong.
    const offering = offeringFactId(STAND);
    expect(standKeyOfFactId(providerFactId(offering, PROVIDER))).toBe(STAND);
  });

  it("keeps the confirmed and offering variants of one seller distinct", () => {
    const confirmed = providerFactId(STAND, PROVIDER);
    const offering = providerFactId(offeringFactId(STAND), PROVIDER);
    expect(confirmed).not.toBe(offering);
    expect(standKeyOfFactId(confirmed)).toBe(standKeyOfFactId(offering));
  });

  it("leaves a bare stand id untouched when it passes through the stand key", () => {
    // Not every fact id carries a provider: the payment and open-now pages are stand-level.
    expect(standKeyOfFactId(STAND)).toBe(STAND);
  });
});
