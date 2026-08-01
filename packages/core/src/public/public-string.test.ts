import { describe, expect, it } from "vitest";
import { renderPublicStringRefusal, validatePublicStrings } from "./public-string";

describe("public strings that can reach a customer", () => {
  it.each([
    ["phone_number", "Call 206-555-0134"],
    ["phone_number", "Text (206) 555 0134"],
    ["phone_number", "2065550134"],
    ["email_address", "orders@example.com"],
    ["email_address", "Order from Farm.Team+stand@example.coop"],
    ["web_link", "https://example.com/order"],
    ["web_link", "www.example.org/farm"],
    ["web_link", "example.farm/stand"],
    ["direct_contact_instruction", "call the farmer to order"],
    ["direct_contact_instruction", "text us for availability"],
    ["direct_contact_instruction", "contact the owner"],
    ["direct_contact_instruction", "email me to reserve one"],
  ] as const)("rejects %s by effect: %s", (prohibited, value) => {
    expect(validatePublicStrings([value])).toEqual({ ok: false, prohibited: [prohibited] });
  });

  it("reports every prohibited kind once, in deterministic reply order", () => {
    expect(
      validatePublicStrings([
        "text 206-555-0134",
        "orders@example.com",
        "https://example.farm",
        "call the farmer",
        "another 206-555-0134",
      ]),
    ).toEqual({
      ok: false,
      prohibited: [
        "phone_number",
        "email_address",
        "web_link",
        "direct_contact_instruction",
      ],
    });
  });

  it.each([
    "2 dozen eggs",
    "18 lbs",
    "$1.50/lb",
    "2-inch tomato starts",
    "Grade A eggs, 12-count",
  ])("accepts legitimate digit-bearing inventory: %s", (value) => {
    expect(validatePublicStrings([value])).toEqual({ ok: true });
  });

  it("renders a deterministic refusal naming exactly what must be removed", () => {
    expect(
      renderPublicStringRefusal([
        "phone_number",
        "email_address",
        "web_link",
        "direct_contact_instruction",
      ]),
    ).toBe(
      "I couldn't publish that. Remove a phone number, an email address, a web link, and " +
        "a direct-contact instruction, then send the update again.",
    );
  });
});
