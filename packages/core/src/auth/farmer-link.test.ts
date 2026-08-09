import { describe, expect, it } from "vitest";
import {
  farmerSettingsUrl,
  isFarmerLinkToken,
  issueFarmerLinkToken,
  hashFarmerLinkToken,
} from "./farmer-link";

describe("farmer standing-link URLs", () => {
  it("opens settings under the same exact standing credential", () => {
    expect(farmerSettingsUrl("https://farmfriend.example/", "abc/def")).toBe(
      "https://farmfriend.example/stand/abc%2Fdef/settings",
    );
  });
});

// F-097 — the token a farmer receives by text, and why its LENGTH is a product property.
//
// The link is the whole message on a phone: at 64 hex characters the URL wrapped across four
// lines in the farmer's thread and read as machine output rather than as something to tap.
// base64url carries the same 128 bits of randomness in 22 characters.
//
// What must NOT change is the strength. These assert the entropy directly rather than trusting
// the encoding — a token shortened by taking fewer random bytes would pass a length check and
// silently weaken the only credential protecting a farmer's listing.
describe("farmer standing-link tokens", () => {
  it("mints a short, URL-safe token that survives a URL round trip untouched", () => {
    const token = issueFarmerLinkToken();
    // Shorter than the 64-hex token it replaces — the property the change exists for.
    expect(token.length).toBeLessThan(30);
    // base64url only. A `+`, `/` or `=` would be percent-encoded into the link, making the
    // text message LONGER than the hex it replaced and breaking a hand-retyped URL.
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(token)).toBe(token);
  });

  it("keeps at least 128 bits of randomness behind the shorter token", () => {
    // The strength claim, asserted as decoded BYTES rather than as characters: 22 base64url
    // characters could encode as few as 16 bytes or as many as 16.5, and the failure this
    // guards is someone "shortening the link" by minting fewer random bytes.
    const decoded = Buffer.from(issueFarmerLinkToken(), "base64url");
    expect(decoded.length).toBeGreaterThanOrEqual(16);
  });

  it("mints a distinct token every time", () => {
    // A constant or a low-entropy source would pass both assertions above. 500 draws with no
    // collision is what distinguishes real randomness from a stub that returns one value.
    const seen = new Set(Array.from({ length: 500 }, () => issueFarmerLinkToken()));
    expect(seen.size).toBe(500);
  });

  it("still stores a 64-hex hash, which the database CHECK constraint requires", () => {
    // `farmer_links_token_hash_shape` refuses anything else, so a token encoding change that
    // reached the hash would fail every insert in production and pass every unit test here.
    expect(hashFarmerLinkToken(issueFarmerLinkToken())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts the 64-hex tokens already in farmers' hands", () => {
    // 35 links were live in production when this changed, every one of them hex. Recognising
    // only the new shape would dead-link every farmer who had already been sent theirs — with
    // the uniform "this link is not active" refusal, which cannot be told from a revocation.
    expect(isFarmerLinkToken("a".repeat(64))).toBe(true);
    expect(isFarmerLinkToken(issueFarmerLinkToken())).toBe(true);
  });

  it("refuses shapes that are not tokens at all", () => {
    expect(isFarmerLinkToken("")).toBe(false);
    // Too short to be a credential — this is the guard that keeps a guessable value out.
    expect(isFarmerLinkToken("abc")).toBe(false);
    // Characters that cannot appear in either encoding.
    expect(isFarmerLinkToken(`${"a".repeat(21)}/`)).toBe(false);
    expect(isFarmerLinkToken(`${"a".repeat(21)}.`)).toBe(false);
    // Absurd length, kept away from the driver.
    expect(isFarmerLinkToken("a".repeat(500))).toBe(false);
  });
});
