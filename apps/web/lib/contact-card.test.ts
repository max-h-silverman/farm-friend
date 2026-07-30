import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTACT_CARD_PATH } from "@farm-friend/core";
import { handleContactCardRequest, contactCardConfig } from "./contact-card";

// F-039 — the served contact card.
//
// The handler's whole job is to turn ONE configured value into a downloadable vCard, so the
// tests below are about the two things that can silently go wrong:
//
//   - **Drift.** If the number stops coming from `TELNYX_FROM_NUMBER`, the card on a
//     farmer's phone stops matching the number that sends. Nothing would report it — the
//     card still downloads, still opens the add-contact sheet, and is simply wrong. The
//     assertions here compare the served body against the CONFIGURED value, and require that
//     changing the configuration changes the body.
//   - **Silent unusability.** The wrong `Content-Type` makes a browser render the card as
//     text instead of handing it to the address book. There is no error; the tap just does
//     nothing useful. So the headers are asserted, not assumed.
//
// It also stays free of the database and the model by construction: `contactCardConfig` reads
// one environment variable, and the handler's dependency set is that one string.

const CONFIGURED = "+12068645326";
const OTHER = "+12065550123";

const repositoryRoot = new URL("../../../", import.meta.url);
const ROUTE_FILE = "apps/web/app/api/public/contact-card/route.ts";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, repositoryRoot), "utf8");
}

describe("contactCardConfig", () => {
  it("reads the number from TELNYX_FROM_NUMBER — the same variable the send path uses", () => {
    expect(contactCardConfig({ TELNYX_FROM_NUMBER: CONFIGURED })).toEqual({
      phoneNumber: CONFIGURED,
    });
  });

  it("fails closed when the sending number is absent or blank", () => {
    // Fail LOUDLY rather than serving a card with a placeholder in it. A card is a thing a
    // farmer keeps; a wrong one is worse than a missing one.
    expect(() => contactCardConfig({})).toThrow(/TELNYX_FROM_NUMBER/);
    expect(() => contactCardConfig({ TELNYX_FROM_NUMBER: "   " })).toThrow(
      /TELNYX_FROM_NUMBER/,
    );
  });
});

describe("handleContactCardRequest", () => {
  it("serves the configured number, and a different configuration serves a different card", async () => {
    // THE ANTI-LITERAL ASSERTION at the HTTP boundary. Anchored to the served body's
    // relationship to the configured value — a hard-coded number in the handler or the
    // renderer makes the two bodies identical and fails this.
    const first = await (await handleContactCardRequest({ phoneNumber: CONFIGURED })).text();
    const second = await (await handleContactCardRequest({ phoneNumber: OTHER })).text();

    expect(first).toContain(CONFIGURED);
    expect(first).not.toContain(OTHER);
    expect(second).toContain(OTHER);
    expect(second).not.toContain(CONFIGURED);
    expect(first).not.toBe(second);
  });

  it("answers 200 with the vCard media type and a .vcf download filename", async () => {
    const response = await handleContactCardRequest({ phoneNumber: CONFIGURED });

    expect(response.status).toBe(200);
    // `text/vcard` is what makes iOS and Android hand the payload to Contacts rather than
    // rendering it. `charset=utf-8` matters because a farm name may not be ASCII.
    expect(response.headers.get("content-type")).toBe("text/vcard; charset=utf-8");
    // `attachment` plus a `.vcf` name is the half Android relies on.
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).toMatch(/^attachment; filename="[^"]+\.vcf"$/);
  });

  it("serves a body that begins and ends as a vCard", async () => {
    const body = await (await handleContactCardRequest({ phoneNumber: CONFIGURED })).text();
    expect(body.startsWith("BEGIN:VCARD\r\nVERSION:3.0\r\n")).toBe(true);
    expect(body.endsWith("END:VCARD")).toBe(true);
  });

  it("sets no cookie and no cache header that would make the card personal", async () => {
    // A contact card is identical for every visitor and is not a session artifact. A
    // `set-cookie` here would make an anonymous download trackable for no benefit.
    const response = await handleContactCardRequest({ phoneNumber: CONFIGURED });
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

describe("the contact-card route is a config-only public surface", () => {
  it("reads no database and reaches no model or throttle", () => {
    // Anchored to the ROUTE's own imports and to the handler's dependency type, not to
    // vocabulary: the handler takes `{ phoneNumber: string }` and there is no parameter
    // through which a `Db`, a model seam, or a throttle could arrive.
    // Strip COMMENTS as well as imports before asserting. This repo has been bitten twice by
    // a source assertion satisfied by incidental text — `kick-survival.test.ts` matched its own
    // import line, and `external-scheduler.test.ts` matched a flag name in an unrelated
    // command. Here the risk runs the other way: the route's header comment legitimately
    // DISCUSSES the composition root it must not import, so a naive `not.toContain` would
    // force the explanation out of the file to keep the test green. Stripping comments makes
    // the assertion about the CODE, which is what it claims to be about.
    const route = readSource(ROUTE_FILE);
    const stripped = route
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/^\s*(?:import|export \{)[^;]*;/gm, "");

    for (const forbidden of [
      "appContext",
      "publicReadContext",
      "sharedDb",
      "createDb",
      "publicActionThrottle",
    ]) {
      expect(stripped, `${ROUTE_FILE} must not reference ${forbidden}`).not.toContain(
        forbidden,
      );
    }

    // The handler's dependency set IS the boundary. Widening it must change this line.
    const handler = readSource("apps/web/lib/contact-card.ts");
    expect(handler).toMatch(
      /export interface ContactCardDeps \{\s*(?:\/\*\*[\s\S]*?\*\/\s*)?phoneNumber: string;\s*\}/,
    );
  });

  it("is mounted at the path the public surfaces link to", () => {
    // One constant, two consumers: the route's directory and every tap target. A route moved
    // without updating the constant, or vice versa, is a dead link on the map — so the path
    // is derived from the same string in both places and pinned here.
    expect(CONTACT_CARD_PATH).toBe("/api/public/contact-card");
    expect(ROUTE_FILE).toBe(`apps/web/app${CONTACT_CARD_PATH}/route.ts`);
  });

  it("contains no phone-number literal in the route or the handler", () => {
    // The defect this whole item guards against, asserted over source rather than output.
    for (const file of [ROUTE_FILE, "apps/web/lib/contact-card.ts"]) {
      const source = readSource(file);
      const found = [...source.matchAll(/\+1\d{10}|\b\d{10}\b/g)].map((m) => m[0]);
      expect(found, `${file} must contain no phone-number literal`).toEqual([]);
    }
  });
});
