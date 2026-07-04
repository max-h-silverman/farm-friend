import { describe, expect, it } from "vitest";
import { reportStockout } from "./stockout";

describe("stock-out report → alert (Golden Rule #1)", () => {
  it("creates an alert but does NOT mutate published inventory", () => {
    const outcome = reportStockout({
      farmStandId: "stand-1",
      itemText: "bok choy",
      source: "sms",
    });
    expect(outcome.report.status).toBe("open");
    expect(outcome.alert).toEqual({ farmStandId: "stand-1", itemText: "bok choy" });
    // The outcome shape has no inventory-mutation channel — a report can't change the map.
    expect(Object.keys(outcome)).toEqual(["report", "alert"]);
    expect("inventory" in outcome).toBe(false);
  });

  it("supports a listed item (FK) and an unlisted item (text only)", () => {
    const listed = reportStockout({
      farmStandId: "stand-1",
      inventoryItemId: "item-9",
      itemText: "tomatoes",
      source: "qr_web",
    });
    expect(listed.report.inventoryItemId).toBe("item-9");

    const unlisted = reportStockout({
      farmStandId: "stand-1",
      itemText: "rhubarb",
      source: "qr_web",
    });
    expect(unlisted.report.inventoryItemId).toBeUndefined();
    expect(unlisted.report.itemText).toBe("rhubarb");
  });
});
