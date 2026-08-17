import { describe, expect, it } from "vitest";
import { parseWeeklyStatus } from "./weekly-status";

// F-062 — VIGA's weekly stock form, the third CSV.
//
// WHAT THIS IS FOR, in the words of the people it serves. A farmer has been filling in this
// Google Form for years and has not heard of Farm Friend. If their submission produces nothing
// on the map, the system that replaced their old one is strictly worse for them on day one and
// silently discards work they really did. A customer deciding whether to drive wants both the
// standing fact ("usually sells eggs") and a dated one ("confirmed 3 days ago") — the first sets
// expectations, the second says how much to trust it today.
//
// So a weekly submission becomes a DATED CONFIRMATION carrying `source = 'viga'` (F-063), sitting
// on top of the seeded specialties rather than replacing them. Age is handled by the machinery
// that already exists: past `STALE_AFTER_HOURS` the card shows its stale caution, which is
// exactly true. A
// farmer's own SMS supersedes their weekly row the moment they send one — that is the migration
// path off the legacy form, not a competition with it.
//
// Every fixture below is a REAL row from the 2026 season (measured 2026-08-04), not an invented
// shape.

const header =
  "Timestamp,Email Address,Farm Name," +
  '"Are other sellers or food-related businesses selling at your stand? If so, please list them.",' +
  "Are you open this week," +
  '"Is there anything else about your farm stand you\'d like listed on the VIGA Farm Stand map?",' +
  "What do you have available\n";

/** One row in the real column order, so the parser is exercised through its actual layout. */
function row(fields: {
  timestamp: string;
  farm: string;
  open?: string;
  available?: string;
  alsoSelling?: string;
}): string {
  const cell = (value: string | undefined) =>
    value === undefined ? "" : `"${value.replaceAll('"', '""')}"`;
  return [
    cell(fields.timestamp),
    cell("farmer@example.invalid"),
    cell(fields.farm),
    cell(fields.alsoSelling),
    cell(fields.open ?? "Yes"),
    cell(undefined),
    cell(fields.available),
  ].join(",");
}

describe("parseWeeklyStatus", () => {
  it("reads a submission's farm, date, and items", () => {
    const result = parseWeeklyStatus(
      header +
        row({
          timestamp: "7/24/2026 9:15:03",
          farm: "Aeggy's Farm",
          available:
            "Eggs, blueberries, tomatoes, cucumbers, salad greens, mixed bouquets, jam, basil",
        }),
    );

    expect(result.submissions).toHaveLength(1);
    const submission = result.submissions[0]!;
    expect(submission.farmName).toBe("Aeggy's Farm");
    expect(submission.statedOn).toEqual(new Date(Date.UTC(2026, 6, 24)));
    expect(submission.items).toEqual([
      "Eggs", "blueberries", "tomatoes", "cucumbers", "salad greens",
      "mixed bouquets", "jam", "basil",
    ]);
  });

  it("splits the trailing 'and' item and drops a vague tail", () => {
    // Farmers write these as sentences. "and more" is not an item a customer can look for.
    const result = parseWeeklyStatus(
      header +
        row({
          timestamp: "7/22/2026 10:00:00",
          farm: "Useful Bear Farm",
          available: "Jam, flowers, blueberries, raspberries and more.",
        }),
    );
    expect(result.submissions[0]?.items).toEqual([
      "Jam", "flowers", "blueberries", "raspberries",
    ]);
  });

  it("keeps only the LATEST submission per farm", () => {
    // A farm submits weekly all season. Only the most recent could describe what is there now;
    // an April row is history, and publishing both would show one farm twice.
    const result = parseWeeklyStatus(
      header +
        row({ timestamp: "4/16/2026 8:00:00", farm: "Plum Forest Farm", available: "eggs, kale" }) +
        "\n" +
        row({ timestamp: "7/8/2026 8:00:00", farm: "Plum Forest Farm", available: "tomatoes, basil" }),
    );

    expect(result.submissions).toHaveLength(1);
    expect(result.submissions[0]?.statedOn).toEqual(new Date(Date.UTC(2026, 6, 8)));
    expect(result.submissions[0]?.items).toEqual(["tomatoes", "basil"]);
  });

  it("treats one farm's own spelling variants as ONE farm", () => {
    // REAL 2026 rows: this farmer typed "Fruits Des Vignes Farm" in April and "Fruits des
    // Vignes Farm" in July. Keying the latest-wins race on the raw string made them two sellers,
    // so an April row survived as if it were current stock for a second, non-existent stand.
    //
    // The database layer happened to absorb it — both names resolve to the same seeded stand,
    // and the older row then lost the `skippedAsOlder` guard. That is ordering luck, not a
    // guarantee: it counted a real farm's submission as a routine skip, and the parser's own
    // contract is "latest per farm", which is what this asserts.
    const result = parseWeeklyStatus(
      header +
        row({
          timestamp: "4/20/2026 8:00:00",
          farm: "Fruits Des Vignes Farm",
          available: "Eggs, plant starts",
        }) +
        "\n" +
        row({
          timestamp: "7/8/2026 8:00:00",
          farm: "Fruits des Vignes Farm",
          available: "Raspberries, Rhubarb, Eggs, Honey",
        }),
      { season: 2026 },
    );

    expect(result.submissions).toHaveLength(1);
    const submission = result.submissions[0]!;
    // The name is stored as the farmer most recently typed it, never as the match key.
    expect(submission.farmName).toBe("Fruits des Vignes Farm");
    expect(submission.statedOn).toEqual(new Date(Date.UTC(2026, 6, 8)));
    expect(submission.items).toEqual(["Raspberries", "Rhubarb", "Eggs", "Honey"]);
  });

  it("reads only the season asked for", () => {
    // The file carries four seasons — 2020, 2024, 2025, 2026 — and a 2020 row describes a stand
    // as it was six years ago. Nothing reads past seasons (max, 2026-08-04).
    const result = parseWeeklyStatus(
      header +
        row({ timestamp: "7/1/2020 8:00:00", farm: "Old Farm", available: "kale" }) +
        "\n" +
        row({ timestamp: "7/1/2026 8:00:00", farm: "New Farm", available: "kale" }),
      { season: 2026 },
    );

    expect(result.submissions.map((s) => s.farmName)).toEqual(["New Farm"]);
  });

  describe("what is NOT a stock statement", () => {
    it("reads a closure as a closure, not as an item called 'Closed'", () => {
      // Two real 2026 rows say exactly this. Publishing them as inventory would show a closed
      // stand carrying one item named "Closed" — the same failure `extractStockUpdate` already
      // refuses for the map's dated lines.
      const result = parseWeeklyStatus(
        header +
          row({
            timestamp: "7/6/2026 8:00:00",
            farm: "Green Ears",
            open: "No",
            available: "Closed",
          }) +
          "\n" +
          row({
            timestamp: "6/30/2026 8:00:00",
            farm: "Peak Moon Nursery",
            open: "No",
            available: "Closed for the season",
          }),
      );

      expect(result.submissions).toHaveLength(0);
      expect(result.closed.map((c) => c.farmName)).toEqual([
        "Green Ears", "Peak Moon Nursery",
      ]);
    });

    it("refuses a row that is plainly a test of the form", () => {
      // 3 Brothers Outpost's only 2026 row reads "test". Seeding it would publish a stand whose
      // specialty is the word "test".
      const result = parseWeeklyStatus(
        header + row({ timestamp: "5/1/2026 8:00:00", farm: "3 Brothers Outpost", available: "test" }),
      );
      expect(result.submissions).toHaveLength(0);
      expect(result.rejected.map((r) => r.name)).toEqual(["3 Brothers Outpost"]);
    });

    it("refuses a row whose availability answer says nothing", () => {
      // Sucabella's row answers the "what do you have" question with "Yes" — an answer to a
      // different question. It names no item, so there is nothing to publish.
      const result = parseWeeklyStatus(
        header +
          row({ timestamp: "7/16/2026 8:00:00", farm: "Sucabella", available: "Yes" }) +
          "\n" +
          row({ timestamp: "7/16/2026 8:00:00", farm: "Blank Farm", available: "" }),
      );
      expect(result.submissions).toHaveLength(0);
      expect(result.rejected.map((r) => r.name).sort()).toEqual(["Blank Farm", "Sucabella"]);
    });

    it("stops at a sentence boundary, so prose does not become an item", () => {
      // Real row: "…Chard, lettuce mix, Eggs, Honey.  We also have vegetable starts - squashes,
      // cucumbers…". Splitting on commas alone made "Honey.  We also have vegetable starts -
      // squashes" one item, which would print that sentence on the card as a thing to buy.
      const result = parseWeeklyStatus(
        header +
          row({
            timestamp: "7/8/2026 8:00:00",
            farm: "Fruits des Vignes Farm",
            available:
              "Raspberries, Rhubarb, Eggs, Honey.  We also have vegetable starts - squashes, peppers",
          }),
      );
      expect(result.submissions[0]?.items).toEqual([
        "Raspberries", "Rhubarb", "Eggs", "Honey",
      ]);
    });

    it("stops at a payment sentence, which is not produce", () => {
      // Twisting Tree's real row ends "…and potatoes. Cash, checks, Venmo and Viga bucks
      // excepted". Read as items that publishes "Cash" and "Venmo" as things the stand sells —
      // and payment methods already have their own column and their own card line (F-061).
      const result = parseWeeklyStatus(
        header +
          row({
            timestamp: "7/27/2026 8:00:00",
            farm: "Twisting Tree Farm",
            available:
              "Zucchini, Carrots, garlic and potatoes. Cash, checks, Venmo and Viga bucks excepted",
          }),
      );
      expect(result.submissions[0]?.items).toEqual([
        "Zucchini", "Carrots", "garlic", "potatoes",
      ]);
    });

    it("drops an item that is a clause rather than a thing to buy", () => {
      // "More starts coming out regularly (weather dependent)" is a sentence about restocking.
      const result = parseWeeklyStatus(
        header +
          row({
            timestamp: "4/20/2026 8:00:00",
            farm: "Long Farm",
            available: "Eggs, herbs, More starts coming out regularly (weather dependent)",
          }),
      );
      expect(result.submissions[0]?.items).toEqual(["Eggs", "herbs"]);
    });

    it("lets a NEWER closure supersede an older stock row, and vice versa", () => {
      // Green Ears really does both: stocked 18 May, closed 6 July. The stand is closed, and
      // appearing in BOTH lists would let the ingest publish a closed stand as stocked.
      const result = parseWeeklyStatus(
        header +
          row({ timestamp: "5/18/2026 8:00:00", farm: "Green Ears", available: "Bouquets" }) +
          "\n" +
          row({ timestamp: "7/6/2026 8:00:00", farm: "Green Ears", open: "No", available: "Closed" }),
      );
      expect(result.submissions).toHaveLength(0);
      expect(result.closed.map((c) => c.farmName)).toEqual(["Green Ears"]);

      // And the other way: a farm that closed and then reopened is stocked, not closed.
      const reopened = parseWeeklyStatus(
        header +
          row({ timestamp: "5/1/2026 8:00:00", farm: "Reopened Farm", open: "No", available: "Closed" }) +
          "\n" +
          row({ timestamp: "7/1/2026 8:00:00", farm: "Reopened Farm", available: "Kale, eggs" }),
      );
      expect(reopened.closed).toHaveLength(0);
      expect(reopened.submissions.map((s) => s.farmName)).toEqual(["Reopened Farm"]);
    });

    it("races a closure against stock filed under the farm's FORMER name", () => {
      // The real 2026 pair, and the one that published a wrong fact in rehearsal: this farmer
      // submitted stock on 30 March as "Maggie's Farm", renamed, and closed on 6 July as
      // "Green Ears". Their profile row says "Formerly Maggie's Farm".
      //
      // Those are two keys at parse time, so the two rows never raced: the closure was reported
      // for a human (correct, closures are not written) while the STALE MARCH STOCK ROW was
      // published as current. A farmer who shut their stand for the season appeared open,
      // carrying produce from four months earlier — the exact "publish a closed stand as
      // stocked" failure the same-name test above already forbids.
      //
      // The rename is the farmer's own stated fact, never inferred from spelling.
      const result = parseWeeklyStatus(
        header +
          row({
            timestamp: "3/30/2026 8:00:00",
            farm: "Maggie's Farm",
            available: "Flower Bouquets, Bunches, Parsley",
          }) +
          "\n" +
          row({
            timestamp: "7/6/2026 8:00:00",
            farm: "Green Ears",
            open: "No",
            available: "Closed",
          }),
        { season: 2026, formerNames: new Map([["maggie's", "green ears"]]) },
      );

      expect(result.submissions).toHaveLength(0);
      expect(result.closed.map((c) => c.farmName)).toEqual(["Green Ears"]);
    });

    it("keeps a rename's stock row when it is NEWER than the closure", () => {
      // The same timeline the other way up, so the fix cannot be "a rename always loses".
      // Closed under the old name in March, stocked again under the new one in July.
      const result = parseWeeklyStatus(
        header +
          row({
            timestamp: "3/30/2026 8:00:00",
            farm: "Maggie's Farm",
            open: "No",
            available: "Closed",
          }) +
          "\n" +
          row({ timestamp: "7/6/2026 8:00:00", farm: "Green Ears", available: "Bouquets, herbs" }),
        { season: 2026, formerNames: new Map([["maggie's", "green ears"]]) },
      );

      expect(result.closed).toHaveLength(0);
      expect(result.submissions).toHaveLength(1);
      expect(result.submissions[0]?.farmName).toBe("Green Ears");
      expect(result.submissions[0]?.items).toEqual(["Bouquets", "herbs"]);
    });

    it("reads 'nothing available this week' as a closure, not as an unreadable answer", () => {
      // Morgan Hill's real row: "We don't have anything available this week". That is a farmer
      // stating a fact, not a broken submission — and it is the same fact as a closure for a
      // customer deciding whether to drive. Refusing it would silently discard a real answer.
      const result = parseWeeklyStatus(
        header +
          row({
            timestamp: "7/15/2026 8:00:00",
            farm: "Morgan Hill Community Farm Stand",
            available: "We don't have anything available this week",
          }),
      );
      expect(result.submissions).toHaveLength(0);
      expect(result.rejected).toHaveLength(0);
      expect(result.closed.map((c) => c.farmName)).toEqual([
        "Morgan Hill Community Farm Stand",
      ]);
    });

    it("reads a not-open-yet note as a closure", () => {
      // Twisting Tree's real row reads "Open mid June" — the stand is not open now.
      const result = parseWeeklyStatus(
        header +
          row({ timestamp: "5/20/2026 8:00:00", farm: "Twisting Tree Farm", available: "Open mid June" }),
      );
      expect(result.submissions).toHaveLength(0);
      expect(result.closed.map((c) => c.farmName)).toEqual(["Twisting Tree Farm"]);
    });

    it("refuses a row with no farm name at all", () => {
      const result = parseWeeklyStatus(
        header + row({ timestamp: "7/1/2026 8:00:00", farm: "", available: "kale" }),
      );
      expect(result.submissions).toHaveLength(0);
      expect(result.rejected).toHaveLength(1);
    });

    it("refuses an unreadable date rather than dating a confirmation to nothing", () => {
      // A confirmation's whole value is its date. Without a trustworthy one there is no honest
      // "confirmed X ago" to render, and a fabricated date is worse than no row.
      const result = parseWeeklyStatus(
        header +
          row({ timestamp: "not a date", farm: "Undated Farm", available: "kale" }) +
          "\n" +
          row({ timestamp: "2/31/2026 8:00:00", farm: "Impossible Farm", available: "kale" }),
      );
      expect(result.submissions).toHaveLength(0);
      expect(result.rejected.map((r) => r.name).sort()).toEqual([
        "Impossible Farm", "Undated Farm",
      ]);
    });
  });

  describe("the file itself", () => {
    it("refuses a file whose header is not this form", () => {
      // Pointing the loader at the PROFILE form would otherwise yield zero submissions, which is
      // indistinguishable from a genuinely empty season — and "ingested 0" reads like success.
      expect(() => parseWeeklyStatus("Timestamp,Farm Name,Address\n")).toThrow(/header/i);
    });

    it("handles a quoted cell containing commas and newlines", () => {
      // Real cells do both: "Current Produce Raspberries, Rhubarb, …" spans lines in the export.
      const result = parseWeeklyStatus(
        header +
          row({
            timestamp: "7/8/2026 8:00:00",
            farm: "Fruits des Vignes Farm",
            available: "Raspberries, Rhubarb\nCucumbers, Chard",
          }),
      );
      expect(result.submissions[0]?.items).toEqual([
        "Raspberries", "Rhubarb", "Cucumbers", "Chard",
      ]);
    });
  });
});
