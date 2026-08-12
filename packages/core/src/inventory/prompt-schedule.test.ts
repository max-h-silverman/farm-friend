import { describe, expect, it } from "vitest";
import {
  nextPromptDueSlot,
  renderScheduledInventoryPrompt,
  renderScheduledInventoryUpdateRequest,
  type PromptCadence,
} from "./prompt-schedule";

const TZ = "America/Los_Angeles";

describe("scheduled inventory prompt cadence", () => {
  it.each<[PromptCadence, string]>([
    ["every_2_days", "2026-03-09T17:00:00.000Z"],
    ["weekly", "2026-03-14T17:00:00.000Z"],
    ["every_2_weeks", "2026-03-21T17:00:00.000Z"],
  ])("places %s at 10:00 local across spring DST", (cadence, expected) => {
    expect(
      nextPromptDueSlot({
        cadence,
        timeZone: TZ,
        laterOf: new Date("2026-03-07T18:00:00.000Z"),
      })?.toISOString(),
    ).toBe(expected);
  });

  it("places the fall transition at 10:00 local rather than adding elapsed hours", () => {
    expect(
      nextPromptDueSlot({
        cadence: "every_2_days",
        timeZone: TZ,
        laterOf: new Date("2026-10-31T17:00:00.000Z"),
      })?.toISOString(),
    ).toBe("2026-11-02T18:00:00.000Z");
  });

  it("returns no due slot for a paused preference", () => {
    expect(
      nextPromptDueSlot({
        cadence: "paused",
        timeZone: TZ,
        laterOf: new Date("2026-03-07T18:00:00.000Z"),
      }),
    ).toBeNull();
  });

  it("names the stand and shows every exact current item before offering SAME", () => {
    const body = renderScheduledInventoryPrompt({
      locationName: "North Stand",
      entries: [
        { entryId: "one", itemName: "Eggs", quantity: 6, unit: "dozen" },
        { entryId: "two", itemName: "Kale", approximation: "limited", priceText: "$4" },
      ],
      publishedAt: new Date("2026-08-05T10:00:00.000Z"),
      now: new Date("2026-08-12T10:00:00.000Z"),
    });
    expect(body).toContain("Items listed for North Stand");
    expect(body).toContain("- Eggs (6 dozen)");
    expect(body).toContain("- Kale (limited, $4)");
    expect(body).toContain("Reply SAME");
    expect(body).not.toContain("one");
  });

  it("stamps the prompt with how old the listing it is showing actually is", () => {
    // The farmer's first question is whether this is stale enough to be worth a reply, and the
    // publication date answers it. Same arithmetic as every other surface (`renderShortElapsed`),
    // so a listing cannot read as a week old over SMS and a fortnight old on the web.
    //
    // Several DIFFERENT ages on purpose: a single case is satisfied by a hard-coded phrase, which
    // is exactly what a sabotage run proved (the constant "7d ago" passed a 7-day-only test).
    const now = new Date("2026-08-12T10:00:00.000Z");
    for (const [publishedAt, expected] of [
      ["2026-08-12T09:30:00.000Z", "updated now"],
      ["2026-08-12T05:00:00.000Z", "updated 5h ago"],
      ["2026-08-11T10:00:00.000Z", "updated 1d ago"],
      ["2026-08-05T10:00:00.000Z", "updated 7d ago"],
      ["2026-06-12T10:00:00.000Z", "updated 61d ago"],
    ] as const) {
      expect(
        renderScheduledInventoryPrompt({
          locationName: "North Stand",
          entries: [{ entryId: "one", itemName: "Eggs" }],
          publishedAt: new Date(publishedAt),
          now,
        }),
      ).toContain(`Items listed for North Stand (${expected}):`);
    }
  });

  it("states no claim about the age of a listing whose publication time is unknown", () => {
    // Every first-publication path has a date, but a null must not silently render as "now" —
    // a fabricated freshness is the one thing worse than an absent one.
    const body = renderScheduledInventoryPrompt({
      locationName: "North Stand",
      entries: [{ entryId: "one", itemName: "Eggs" }],
      publishedAt: null,
      now: new Date("2026-08-12T10:00:00.000Z"),
    });
    expect(body).toContain("Items listed for North Stand:");
    expect(body).not.toContain("ago");
    expect(body).not.toContain("updated");
  });

  it("does not claim the listing will change, being a record of what is already published", () => {
    // The proposal renderer says "Your stand will show:" because something is about to publish.
    // Nothing publishes here — this is what IS live, and the farmer is being asked to correct it.
    const body = renderScheduledInventoryPrompt({
      locationName: "North Stand",
      entries: [{ entryId: "one", itemName: "Eggs" }],
      publishedAt: new Date("2026-08-05T10:00:00.000Z"),
      now: new Date("2026-08-12T10:00:00.000Z"),
    });
    expect(body).not.toContain("will show");
  });

  it("offers the web editor when the farmer is asked to retype their whole listing", () => {
    // The fallback is the one place LINK earns its characters: no snapshot is shown, so the
    // farmer faces a full retype. The SAME prompt omits it — LINK is taught at onboarding, and
    // repeating it there costs an item of snapshot capacity against the two-segment ceiling.
    expect(renderScheduledInventoryUpdateRequest({ locationName: "Empty Stand" })).toContain(
      "text LINK",
    );
  });

  it("carries the opt-out reminder, being the one recurring proactive stream (F-096)", () => {
    // Where a periodic footer is actually earned. Farm Friend speaks first here, on a cadence,
    // for as long as the farmer stays enrolled — so a farmer months in must have seen the exit
    // recently. Every other footer was dropped: the reply-shaped messages answer something the
    // farmer just sent, where it reads as boilerplate.
    for (const body of [
      renderScheduledInventoryPrompt({
        locationName: "North Stand",
        entries: [{ entryId: "one", itemName: "Eggs", quantity: 6, unit: "dozen" }],
        publishedAt: new Date("2026-08-05T10:00:00.000Z"),
        now: new Date("2026-08-12T10:00:00.000Z"),
      }),
      renderScheduledInventoryUpdateRequest({ locationName: "Empty Stand" }),
    ]) {
      expect(body).toContain("STOP");
    }
  });

  it("keeps the opt-out reminder off the line offering SAME", () => {
    // The farmer's one-word reply and the compliance footer must not read as one instruction.
    const body = renderScheduledInventoryPrompt({
      locationName: "North Stand",
      entries: [{ entryId: "one", itemName: "Eggs", quantity: 6, unit: "dozen" }],
      publishedAt: new Date("2026-08-05T10:00:00.000Z"),
      now: new Date("2026-08-12T10:00:00.000Z"),
    });
    const sameLine = body.split("\n").find((line) => line.includes("SAME"));
    expect(sameLine).toBeDefined();
    expect(sameLine).not.toContain("STOP");
  });

  it("asks for an ordinary update without exposing a caller-controlled SAME switch", () => {
    const body = renderScheduledInventoryUpdateRequest({
      locationName: "Empty Stand",
    });
    expect(body).toContain("Empty Stand");
    expect(body).toContain("text what is available now");
    expect(body).not.toContain("SAME");
  });
});
