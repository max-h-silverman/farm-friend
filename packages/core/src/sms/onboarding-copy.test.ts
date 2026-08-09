import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CUSTOMER_WELCOME,
  renderContactCardOffer,
  renderFarmerAuthorizedNotification,
  FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT,
  FARMER_JOIN_INSTRUCTION,
  FARMER_TAUGHT_KEYWORDS,
  renderFarmerLinkMessage,
} from "./onboarding-copy";

// F-040 — the two things Farm Friend says to a farmer during onboarding, plus the link text.
//
// These are ORDINARY code-rendered copy, not registered carrier auto-responses. The
// distinction is load-bearing and `auto-responses.ts` states it: the three registered bodies
// are transcribed from live Telnyx console state and pinned character-for-character, so
// anything that drifts into that block silently claims carrier registration it does not have.
// The assertions below are what keep these three out of it.

const registeredFieldValues = resolve(
  __dirname,
  "../../../../docs/TELNYX_10DLC_FIELD_VALUES.txt",
);

describe("farmer onboarding copy", () => {
  it("gives a newly joined customer a usable introduction without exposing farmer controls", () => {
    const welcome = CUSTOMER_WELCOME;
    expect(welcome.toLowerCase()).toContain("ask what is available");
    for (const keyword of ["MAP", "HELP", "STOP"]) {
      expect(welcome).toContain(keyword);
    }
    for (const farmerOnly of ["SIGNUP", "LINK", "STAND", "SETTINGS", "SAME", "YES", "NO"]) {
      expect(welcome).not.toContain(farmerOnly);
    }
  });

  it("offers the contact card as its OWN message, saying what the link does", () => {
    // F-039 built `/api/public/contact-card` and wired it ONLY to a link on the public web
    // map. A customer who arrived by text — the whole point of an SMS product — was never
    // told the card existed, so the number stayed unnamed in their phone and every later
    // message came from a stranger. Data present with no consumer is invisible.
    //
    // max 2026-08-08: it was not clear WHAT the link was. It used to be "Save us:" plus a raw
    // API path, trailing the welcome after the opt-out instruction. Now it is a message.
    const offer = renderContactCardOffer("https://farmfriend.example");
    const [instruction, url, ...rest] = offer.split("\n");
    expect(instruction?.toLowerCase()).toContain("save");
    expect(instruction?.toLowerCase()).toContain("contacts");
    expect(url).toBe("https://farmfriend.example/api/public/contact-card");
    expect(rest).toEqual([]);
    // Saving a contact asks for nothing and records nothing, so it carries no footer.
    expect(offer).not.toContain("STOP");
  });

  it("keeps the contact card OUT of the welcome, which had no room to explain it", () => {
    const welcome = CUSTOMER_WELCOME;
    expect(welcome).not.toContain("contact-card");
  });

  it("fits ONE segment again, now that the card link has moved out", () => {
    // It was two segments while it carried the contact-card URL (71 characters at the
    // production host), which max accepted on 2026-08-07. Moving the card to its own message
    // gave that budget back, so the bound tightens rather than being left where it was.
    //
    // Concatenated GSM-7 is 153 characters per segment, not 160 — the header costs 7. The real
    // segment arithmetic lives in `packages/sms`, which measures encoding too; this is the
    // cheap bound core can assert without a workspace dependency.
    expect(CUSTOMER_WELCOME.length).toBeLessThanOrEqual(153);
  });

  it("acknowledges a request without promising authorization", () => {
    // A request grants nothing — VIGA always approves — so the acknowledgement must not read
    // as a yes. A farmer told "you're set up" who then cannot publish has been lied to by
    // the system, and will not try again.
    const body = FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT;
    expect(body).toContain("VIGA");
    // No language that claims the outcome.
    expect(body.toLowerCase()).not.toContain("you're set up");
    expect(body.toLowerCase()).not.toContain("you are set up");
    expect(body.toLowerCase()).not.toContain("approved");
    // The opt-out is always reachable.
    expect(body).toContain("STOP");
  });

  it("tells an authorized farmer they can update by text or open their private web form", () => {
    // The reason this message exists: a farmer approved on Tuesday otherwise has no idea
    // until they guess.
    const body = renderFarmerAuthorizedNotification(
      "https://farmfriend.example/stand/" + "c".repeat(64),
    );
    expect(body).toContain("VIGA");
    // It must actually tell them what to do next — an announcement with no instruction
    // leaves the farmer exactly where they were.
    expect(body).toContain("LINK");
    expect(body.length).toBeGreaterThan(40);
  });

  it("SENDS the farmer their link rather than only naming the word that fetches it", () => {
    // F-094. The message used to say "text LINK for your private web form" and send no link,
    // so a farmer told they were live had to send a SECOND text before they could see
    // anything. Some fraction never send it.
    const link = "https://farmfriend.example/stand/" + "d".repeat(64);
    expect(renderFarmerAuthorizedNotification(link)).toContain(link);
  });

  it("still names LINK, because a farmer will lose the text that carried the link", () => {
    // max 2026-08-08: deliver AND teach the recovery word. `issueFarmerLink` already revokes
    // the previous link and mints a new one, so the mechanism exists — what was missing is
    // the farmer knowing the word.
    const body = renderFarmerAuthorizedNotification(
      "https://farmfriend.example/stand/" + "e".repeat(64),
    );
    expect(body).toContain("LINK");
  });

  it("falls back to naming LINK when the farmer has no stand to link to", () => {
    // The admin authorization path can run before a `sales_locations` row exists, and
    // `issueFarmerLinkIn` cannot mint a link without one. (The invited path always has a
    // stand — that farmer published the listing on the form.) The farmer is still told they
    // are live and still told how to reach their form.
    const body = renderFarmerAuthorizedNotification(null);
    expect(body).toContain("LINK");
    // It must still say they are set up — and must NOT claim they are on the map, which is
    // false for a farmer whose farm has no stand yet.
    expect(body.toLowerCase()).toContain("all set");
    expect(body.toLowerCase()).not.toContain("on the map");
    // No invented URL, and no dangling label for a link that is not there.
    expect(body).not.toContain("http");
    expect(body).not.toContain(":\n");
  });

  it("teaches every farmer keyword whether or not a link was minted", () => {
    // The keywords are the point of the message; a farmer without a stand needs them MORE,
    // not less. A branch that quietly drops them is the omission F-093 exists to close.
    for (const link of [null, "https://farmfriend.example/stand/" + "9".repeat(64)]) {
      const body = renderFarmerAuthorizedNotification(link);
      for (const keyword of FARMER_TAUGHT_KEYWORDS) {
        expect(body).toContain(keyword);
      }
      expect(body).not.toContain("STOP");
    }
  });

  it("teaches the farmer keywords it is the only channel for", () => {
    // F-093. STAND and SETTINGS appeared in NO farmer-facing SMS copy at all, and the farmer
    // finished onboarding knowing exactly one word: START. After that the interface was
    // undiscoverable except by texting prose and hoping.
    const body = renderFarmerAuthorizedNotification(
      "https://farmfriend.example/stand/" + "f".repeat(64),
    );
    for (const keyword of FARMER_TAUGHT_KEYWORDS) {
      expect(body).toContain(keyword);
    }
  });

  it("names the primary interface, which is not a keyword at all", () => {
    // "Text what you have" is the whole point. A farmer who learns three keywords and not
    // this one has learned the accessories and missed the product.
    const body = renderFarmerAuthorizedNotification(
      "https://farmfriend.example/stand/" + "0".repeat(64),
    ).toLowerCase();
    expect(body).toContain("text");
    expect(body).toMatch(/what (you have|is|you'?re selling|is on)/);
  });

  it("drops the STOP footer from the setup message, which is not where it is owed", () => {
    // F-096. Nothing requires opt-out language on every message: the requirement is the
    // opt-in confirmation, the HELP response, and that STOP always works — all enforced
    // elsewhere. This message competes for a segment budget that now carries a real link,
    // and the farmer saw the footer on the carrier receipt that arrives beside it.
    const body = renderFarmerAuthorizedNotification(
      "https://farmfriend.example/stand/" + "1".repeat(64),
    );
    expect(body).not.toContain("STOP");
  });

  it("tells a farmer with no consent basis the one word that establishes it", () => {
    // The dead end this closes: SIGNUP alone establishes no consent, so the "your farm is
    // ready" text is suppressed and the farmer is never told. When the web agreement is not
    // available to lean on — a bare SIGNUP, or an invitation whose box was never ticked —
    // this is the only route left, and it must name the word that works.
    const body = FARMER_JOIN_INSTRUCTION;
    // **START, not JOIN** (max 2026-08-07). Onboarding is completed by matching a bare START
    // against the phone the farmer stated on the form; JOIN completes nothing, so naming it
    // would enroll them for messages and still leave them unset-up with nothing saying why.
    // START is also the only word that clears the carrier's own opt-out list (B-011).
    expect(body).toContain("START");
    expect(body).not.toContain("JOIN");
    expect(body).toContain("STOP");
    // It must not claim the request itself did anything about messaging.
    expect(body.toLowerCase()).not.toContain("you are subscribed");
    expect(body.toLowerCase()).not.toContain("you have agreed");
  });

  it("renders a link message carrying the link and nothing invented", () => {
    const link = "https://farmfriend.example/stand/" + "a".repeat(64);
    const body = renderFarmerLinkMessage(link);
    expect(body).toContain(link);
  });

  it("puts the link on its own line in every message that carries one", () => {
    // F-096. A URL run together with prose and a footer is the least readable thing we send,
    // and it is the thing the farmer most needs to tap. `paging.ts` already established the
    // convention — one idea per line — for customer ANSWERS; transactional copy ignored it.
    const link = "https://farmfriend.example/stand/" + "2".repeat(64);
    for (const body of [
      renderFarmerLinkMessage(link),
      renderFarmerAuthorizedNotification(link),
    ]) {
      const lineWithLink = body.split("\n").find((line) => line.includes(link));
      expect(lineWithLink?.trim()).toBe(link);
    }
  });

  it("drops the STOP footer from the LINK reply, which answers the farmer's own text", () => {
    // F-096 — reply-shaped messages lose the footer. The farmer sent LINK seconds ago; the
    // compliance boilerplate is noise on a message they triggered themselves.
    const link = "https://farmfriend.example/stand/" + "3".repeat(64);
    expect(renderFarmerLinkMessage(link)).not.toContain("STOP");
  });

  it("never claims a link expires, because it does not", () => {
    // max chose a link that never expires until revoked. Copy promising a window would be
    // false, and would teach farmers to re-request links they do not need.
    const link = "https://farmfriend.example/stand/" + "b".repeat(64);
    const body = renderFarmerLinkMessage(link).toLowerCase();
    for (const claim of ["expires", "expire", "minutes", "hours", "24"]) {
      expect(body).not.toContain(claim);
    }
  });

  it("keeps all three OUT of the registered auto-response block", () => {
    // The tripwire. `auto-responses.test.ts` pins the registered bodies to this file in both
    // directions; if one of these were transcribed in, it would become carrier-registered
    // copy that nobody registered.
    const registered = readFileSync(registeredFieldValues, "utf8");
    for (const body of [
      FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT,
      renderFarmerAuthorizedNotification("https://farmfriend.example/stand/" + "4".repeat(64)),
      FARMER_JOIN_INSTRUCTION,
    ]) {
      expect(registered).not.toContain(body);
    }
  });

  // The one-segment assertion lives in `packages/sms/src/onboarding-segments.test.ts`,
  // beside the estimator that can actually measure it. `core` declares no workspace
  // dependencies (the architecture tripwire enforces it), so it cannot import one here —
  // and a hand-rolled `.length <= 160` in this file would be a second, wrong answer to a
  // question the real estimator already answers: a curly quote forces UCS-2 and drops the
  // budget to 70, which a character count cannot see.
});
