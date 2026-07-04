import type { ReportSource } from "@farm-friend/contracts";

// Stock-out report → farmer alert. Golden Rule #1: the farmer owns published state — a customer
// report NEVER mutates inventory. This module produces (a) a report record and (b) an alert
// intent. It has no code path that writes inventory; that absence is the guarantee, tested.

export interface StockoutReportInput {
  farmStandId: string;
  /** Resolved listed item, if the report matched one. */
  inventoryItemId?: string;
  /** Normalized item text — always present (covers items not currently listed). */
  itemText: string;
  source: ReportSource;
}

export interface StockoutReportRecord {
  farmStandId: string;
  inventoryItemId?: string;
  itemText: string;
  source: ReportSource;
  status: "open";
}

export interface FarmerAlert {
  farmStandId: string;
  itemText: string;
}

export interface StockoutOutcome {
  report: StockoutReportRecord;
  alert: FarmerAlert;
  // Intentionally NO inventory mutation field: a report cannot change published state.
}

/**
 * Turn a customer stock-out report into a report record + a farmer alert. Pure and total:
 * it creates an open report and an alert intent, and — by construction — touches no inventory.
 */
export function reportStockout(input: StockoutReportInput): StockoutOutcome {
  const report: StockoutReportRecord = {
    farmStandId: input.farmStandId,
    inventoryItemId: input.inventoryItemId,
    itemText: input.itemText,
    source: input.source,
    status: "open",
  };
  return {
    report,
    alert: { farmStandId: input.farmStandId, itemText: input.itemText },
  };
}
