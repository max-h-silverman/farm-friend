"use client";

import type { ReactNode } from "react";

/** Shared shortcuts; "other" always opens a free-text unit field. */
export const SUGGESTED_STOCK_UNITS = [
  "each",
  "dozen",
  "lb",
  "bunch",
  "pint",
  "quart",
  "bag",
  "jar",
] as const;

export const OTHER_STOCK_UNIT = "__other__";

export function initialStockUnitMode(
  unit: string | null | undefined,
): "menu" | "custom" {
  if (typeof unit !== "string" || unit.trim() === "") return "menu";
  return SUGGESTED_STOCK_UNITS.includes(
    unit as (typeof SUGGESTED_STOCK_UNITS)[number],
  )
    ? "menu"
    : "custom";
}

/**
 * The shared item-row shell used during onboarding and for dated stock updates.
 *
 * The two surfaces persist different facts, but the farmer should not have to relearn the
 * row: item identity first, an explicit in-stock switch at the end, optional details below.
 */
export function StockItemRow({
  name,
  stock,
  children,
  onRemove,
}: {
  name: string;
  stock?: { checked: boolean; onChange(): void };
  children?: ReactNode;
  onRemove?: () => void;
}) {
  return (
    <li className="farmer-listing-item-row">
      <div className="farmer-listing-item">
        <div className="farmer-listing-item-identity">
          <span className="farmer-listing-item-name">{name}</span>
          {stock !== undefined && (
            <button
              type="button"
              role="switch"
              aria-checked={stock.checked}
              aria-label={`${name} in stock`}
              className="farmer-listing-item-stock"
              onClick={stock.onChange}
            >
              <span className="farmer-listing-item-stock-track" aria-hidden="true" />
              <span className="farmer-listing-item-stock-text" aria-hidden="true">
                in stock
              </span>
            </button>
          )}
        </div>
        {children}
      </div>
      {onRemove !== undefined && (
        <button
          type="button"
          className="farmer-listing-item-remove"
          aria-label={`Remove ${name}`}
          onClick={onRemove}
        >
          <span aria-hidden="true">×</span>
        </button>
      )}
    </li>
  );
}
