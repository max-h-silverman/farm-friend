"use client";

import type { ReactNode } from "react";

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
