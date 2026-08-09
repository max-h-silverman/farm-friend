"use client";

import type { ReactNode } from "react";
import {
  renderStandItemPrice,
  standItemPriceNeedsUnit,
  type StandItemPrice,
  type StandItemPriceBasis,
} from "@farm-friend/core/item-price";

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

export interface StockItemPriceDraft {
  amount: string;
  quantity: string;
  unit: string;
  basis: StandItemPriceBasis;
  unitMode: "menu" | "custom";
}

export const EMPTY_STOCK_ITEM_PRICE: StockItemPriceDraft = {
  amount: "",
  quantity: "1",
  unit: "",
  basis: "per",
  unitMode: "menu",
};

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

function sanitizeDecimal(value: string): string {
  const kept = value.replace(/[^0-9.]/g, "");
  const firstDot = kept.indexOf(".");
  return firstDot === -1
    ? kept
    : kept.slice(0, firstDot + 1) + kept.slice(firstDot + 1).replaceAll(".", "");
}

export function stockItemPriceDraftToPrice(
  draft: StockItemPriceDraft,
): StandItemPrice | null {
  const amount = draft.amount.trim();
  const quantity = draft.quantity.trim() === "" ? "1" : draft.quantity.trim();
  const unit = draft.unit.trim() === "" ? null : draft.unit.trim();
  if (amount === "" || (unit === null && standItemPriceNeedsUnit(draft.basis))) return null;
  const amountValue = Number(amount);
  const quantityValue = Number(quantity);
  if (!Number.isFinite(amountValue) || !Number.isFinite(quantityValue)) return null;
  if (amountValue < 0 || quantityValue <= 0) return null;
  return { amount, quantity, unit, basis: draft.basis };
}

export function renderStockItemPriceDraft(draft: StockItemPriceDraft): string | null {
  return renderStandItemPrice(stockItemPriceDraftToPrice(draft));
}

/** Conservatively recovers the code-rendered formats already stored on dated stock rows. */
export function stockItemPriceDraftFromText(priceText: string | undefined): StockItemPriceDraft {
  const text = priceText?.trim() ?? "";
  if (text === "") return { ...EMPTY_STOCK_ITEM_PRICE };
  if (/^free$/i.test(text)) {
    return { ...EMPTY_STOCK_ITEM_PRICE, amount: "0", basis: "for" };
  }

  const unitPrice = text.match(/^\$([0-9]+(?:\.[0-9]+)?)\s*\/\s*(.+)$/);
  if (unitPrice) {
    const unit = unitPrice[2]!.trim();
    return {
      amount: unitPrice[1]!,
      quantity: "1",
      unit,
      basis: "per",
      unitMode: initialStockUnitMode(unit),
    };
  }

  const bundle = text.match(/^([0-9]+(?:\.[0-9]+)?)\s+(.+?)\s+for\s+\$([0-9]+(?:\.[0-9]+)?)$/i);
  if (bundle) {
    const unit = bundle[2]!.trim();
    return {
      amount: bundle[3]!,
      quantity: bundle[1]!,
      unit,
      basis: "for",
      unitMode: initialStockUnitMode(unit),
    };
  }

  const amountForCount = text.match(/^\$([0-9]+(?:\.[0-9]+)?)\s+for\s+([0-9]+(?:\.[0-9]+)?)$/i);
  if (amountForCount) {
    return {
      ...EMPTY_STOCK_ITEM_PRICE,
      amount: amountForCount[1]!,
      quantity: amountForCount[2]!,
      basis: "for",
    };
  }

  const amountEach = text.match(/^\$([0-9]+(?:\.[0-9]+)?)(?:\s+each)?$/i);
  if (amountEach) {
    return {
      ...EMPTY_STOCK_ITEM_PRICE,
      amount: amountEach[1]!,
      basis: "for",
    };
  }

  const legacyUnit = text.match(/^\$([0-9]+(?:\.[0-9]+)?)\s*(?:\/|per|a)\s*(.+)$/i);
  if (legacyUnit) {
    const unit = legacyUnit[2]!.trim();
    return {
      amount: legacyUnit[1]!,
      quantity: "1",
      unit,
      basis: "per",
      unitMode: initialStockUnitMode(unit),
    };
  }

  return { ...EMPTY_STOCK_ITEM_PRICE };
}

export function StockItemPricingFields({
  itemName,
  controlId,
  value,
  onChange,
}: {
  itemName: string;
  controlId: string;
  value: StockItemPriceDraft;
  onChange(value: StockItemPriceDraft): void;
}) {
  const update = (change: Partial<StockItemPriceDraft>) => onChange({ ...value, ...change });

  return (
    <div className="farmer-listing-item-pricing">
      <span className="farmer-listing-price-mark" aria-hidden="true">$</span>
      <label className="sr-only" htmlFor={`item-amount-${controlId}`}>
        {`Price for ${itemName}`}
      </label>
      <input
        id={`item-amount-${controlId}`}
        className="farmer-listing-item-amount"
        type="text"
        inputMode="decimal"
        value={value.amount}
        onChange={(event) => update({ amount: sanitizeDecimal(event.target.value) })}
        placeholder="0.00"
        maxLength={12}
      />
      <label className="sr-only" htmlFor={`item-basis-${controlId}`}>
        {`Price basis for ${itemName}`}
      </label>
      <select
        id={`item-basis-${controlId}`}
        className="farmer-listing-item-basis"
        value={value.basis}
        onChange={(event) => update({ basis: event.target.value === "for" ? "for" : "per" })}
      >
        <option value="per">per</option>
        <option value="for">for</option>
      </select>
      {value.basis === "for" && (
        <>
          <label className="sr-only" htmlFor={`item-quantity-${controlId}`}>
            {`How many ${itemName}`}
          </label>
          <input
            id={`item-quantity-${controlId}`}
            className="farmer-listing-item-quantity"
            type="text"
            inputMode="decimal"
            value={value.quantity}
            onChange={(event) => update({ quantity: sanitizeDecimal(event.target.value) })}
            placeholder="1"
            maxLength={12}
          />
        </>
      )}
      <label className="sr-only" htmlFor={`item-unit-${controlId}`}>
        {`Unit for ${itemName}`}
      </label>
      {value.unitMode === "custom" ? (
        <>
          <input
            id={`item-unit-${controlId}`}
            className="farmer-listing-item-unit-other"
            type="text"
            value={value.unit}
            onChange={(event) => update({ unit: event.target.value })}
            placeholder="unit"
            maxLength={40}
          />
          <button
            type="button"
            className="farmer-listing-item-unit-back"
            onClick={() => update({ unit: "", unitMode: "menu" })}
          >
            <span className="sr-only">{`Use the unit menu for ${itemName}`}</span>
            <span aria-hidden="true">↺</span>
          </button>
        </>
      ) : (
        <select
          id={`item-unit-${controlId}`}
          className="farmer-listing-item-unit"
          value={value.unit}
          onChange={(event) => {
            if (event.target.value === OTHER_STOCK_UNIT) {
              update({ unit: "", unitMode: "custom" });
              return;
            }
            update({ unit: event.target.value });
          }}
        >
          <option value="">item</option>
          {SUGGESTED_STOCK_UNITS.map((unit) => (
            <option key={unit} value={unit}>{unit}</option>
          ))}
          <option value={OTHER_STOCK_UNIT}>other…</option>
        </select>
      )}
    </div>
  );
}

export interface StockInventoryEditorItem {
  key: string;
  name: string;
  inStock?: boolean;
  price: StockItemPriceDraft;
}

/** The one inventory editor used for onboarding and every later stock update. */
export function StockInventoryEditor({
  kind,
  items,
  pricesEnabled,
  draftItem,
  onPricesEnabledChange,
  onDraftItemChange,
  onAddItem,
  onStockChange,
  onPriceChange,
  onRemoveItem,
  action,
}: {
  kind: "usual" | "dated";
  items: StockInventoryEditorItem[];
  pricesEnabled: boolean;
  draftItem: string;
  onPricesEnabledChange(): void;
  onDraftItemChange(value: string): void;
  onAddItem(): void;
  onStockChange(key: string): void;
  onPriceChange(key: string, price: StockItemPriceDraft): void;
  onRemoveItem(key: string): void;
  action?: ReactNode;
}) {
  const legend = kind === "usual" ? "What do you usually sell?" : "Stock today";
  const empty =
    kind === "usual"
      ? "Nothing here yet. Add what your stand usually has."
      : "Nothing here yet. Add what is in stock today.";

  return (
    <fieldset className="farmer-listing farmer-listing-inventory">
      <legend className={kind === "dated" ? "sr-only" : undefined}>{legend}</legend>
      <div className="farmer-listing-inventory-prices">
        <button
          type="button"
          role="switch"
          aria-checked={pricesEnabled}
          className="farmer-listing-prices-switch"
          onClick={onPricesEnabledChange}
        >
          <span className="farmer-listing-item-stock-track" aria-hidden="true" />
          <span>Add prices</span>
        </button>
        <p className="farmer-listing-inventory-subtitle">
          {pricesEnabled
            ? "Prices show on your listing. Leave any of them blank to say nothing."
            : "Your listing shows what you sell, without prices."}
        </p>
      </div>

      <div className="farmer-listing-item-add">
        <label className="sr-only" htmlFor={`stock-items-${kind}`}>
          {legend}
        </label>
        <input
          id={`stock-items-${kind}`}
          type="text"
          value={draftItem}
          onChange={(event) => onDraftItemChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            onAddItem();
          }}
          placeholder="e.g. eggs"
          maxLength={120}
        />
        <button
          type="button"
          className="farmer-listing-item-add-button"
          onClick={onAddItem}
          disabled={draftItem.trim() === ""}
        >
          Add item
        </button>
      </div>

      {items.length === 0 ? (
        <p className="farmer-listing-inventory-empty">{empty}</p>
      ) : (
        <ul className="farmer-listing-items">
          {items.map((item) => (
            <StockItemRow
              key={item.key}
              name={item.name}
              stock={
                item.inStock === undefined
                  ? undefined
                  : {
                      checked: item.inStock,
                      onChange: () => onStockChange(item.key),
                    }
              }
              onRemove={() => onRemoveItem(item.key)}
            >
              {pricesEnabled && (
                <StockItemPricingFields
                  itemName={item.name}
                  controlId={item.key}
                  value={item.price}
                  onChange={(price) => onPriceChange(item.key, price)}
                />
              )}
            </StockItemRow>
          ))}
        </ul>
      )}

      {action}
    </fieldset>
  );
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
