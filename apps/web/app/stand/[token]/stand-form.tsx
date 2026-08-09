"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import {
  EMPTY_STOCK_ITEM_PRICE,
  StockInventoryEditor,
  renderStockItemPriceDraft,
  stockItemPriceDraftFromText,
  type StockItemPriceDraft,
} from "../../farmer/stock-item-row";

type Stage =
  | { step: "typing" }
  | { step: "confirming"; proposalId: string; confirmationText: string }
  | { step: "published" }
  | { step: "declined" };

/** What the stand is publishing right now, for display and edit composition only. */
export interface CurrentEntry {
  entryId: string;
  itemName: string;
  quantity?: number;
  unit?: string;
  priceText?: string;
  approximation?: "some" | "limited" | "plentiful";
}

interface EditorRow {
  key: string;
  entryId?: string;
  itemName: string;
  price: StockItemPriceDraft;
  sourcePriceText: string;
  inStock: boolean;
}

function rowsFromEntries(entries: CurrentEntry[]): EditorRow[] {
  return entries.map((entry) => ({
    key: entry.entryId,
    entryId: entry.entryId,
    itemName: entry.itemName,
    price: stockItemPriceDraftFromText(entry.priceText),
    sourcePriceText: entry.priceText ?? "",
    inStock: true,
  }));
}

function rowsHavePrices(rows: EditorRow[]): boolean {
  return rows.some(
    (row) => row.sourcePriceText !== "" || renderStockItemPriceDraft(row.price) !== null,
  );
}

function samePriceDraft(left: StockItemPriceDraft, right: StockItemPriceDraft): boolean {
  return (
    left.amount === right.amount &&
    left.quantity === right.quantity &&
    left.unit === right.unit &&
    left.basis === right.basis &&
    left.unitMode === right.unitMode
  );
}

function structuredEdit(
  rows: EditorRow[],
  baselineRows: EditorRow[],
  pricesEnabled: boolean,
) {
  const baselineById = new Map(
    baselineRows.flatMap((row) => (row.entryId === undefined ? [] : [[row.entryId, row] as const])),
  );
  const additions: Array<{
    itemName: string;
    priceText?: string;
  }> = [];
  const changes: Array<{
    entryId: string;
    priceText?: string | null;
  }> = [];
  const currentEntryIds = new Set(
    rows.flatMap((row) => (row.entryId === undefined ? [] : [row.entryId])),
  );
  const removals = baselineRows.flatMap((row) =>
    row.entryId !== undefined && !currentEntryIds.has(row.entryId)
      ? [{ entryId: row.entryId }]
      : [],
  );

  for (const row of rows) {
    if (row.entryId === undefined) {
      if (!row.inStock) continue;
      const priceText = pricesEnabled ? renderStockItemPriceDraft(row.price) : null;
      additions.push({
        itemName: row.itemName,
        ...(priceText === null ? {} : { priceText }),
      });
      continue;
    }

    const baseline = baselineById.get(row.entryId);
    if (baseline === undefined) continue;
    if (!row.inStock) {
      removals.push({ entryId: row.entryId });
      continue;
    }

    const priceText = !pricesEnabled
      ? baseline.sourcePriceText === ""
        ? undefined
        : null
      : samePriceDraft(row.price, baseline.price)
        ? undefined
        : renderStockItemPriceDraft(row.price);
    if (priceText !== undefined) changes.push({ entryId: row.entryId, priceText });
  }

  return additions.length === 0 && changes.length === 0 && removals.length === 0
    ? undefined
    : { additions, changes, removals };
}

function isCurrentEntry(value: unknown): value is CurrentEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.entryId === "string" && typeof entry.itemName === "string";
}

export function StandForm({
  token,
  currentEntries,
}: {
  token: string;
  currentEntries: CurrentEntry[];
}) {
  const initialRows = rowsFromEntries(currentEntries);
  const initialPricesEnabled = rowsHavePrices(initialRows);
  const [baselineRows, setBaselineRows] = useState(initialRows);
  const [rows, setRows] = useState(initialRows);
  const [pricesEnabled, setPricesEnabled] = useState(initialPricesEnabled);
  const [draftItem, setDraftItem] = useState("");
  const [stage, setStage] = useState<Stage>({ step: "typing" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkInactive, setLinkInactive] = useState(false);
  const nextKey = useRef(0);
  const edit = structuredEdit(rows, baselineRows, pricesEnabled);

  function addDraftItem() {
    const itemName = draftItem.trim();
    if (itemName === "") return;
    const existing = rows.find(
      (row) => row.itemName.trim().toLowerCase() === itemName.toLowerCase(),
    );
    if (existing !== undefined) {
      setRows((current) =>
        current.map((row) => (row.key === existing.key ? { ...row, inStock: true } : row)),
      );
      setDraftItem("");
      return;
    }
    const baseline = baselineRows.find(
      (row) => row.itemName.trim().toLowerCase() === itemName.toLowerCase(),
    );
    if (baseline !== undefined) {
      setRows((current) => [...current, baseline]);
      setDraftItem("");
      return;
    }
    nextKey.current += 1;
    setRows((current) => [
      ...current,
      {
        key: `new-${nextKey.current}`,
        itemName,
        price: { ...EMPTY_STOCK_ITEM_PRICE },
        sourcePriceText: "",
        inStock: true,
      },
    ]);
    setDraftItem("");
  }

  function updateRow(key: string, update: Partial<EditorRow>) {
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, ...update } : row)),
    );
  }

  function removeRow(key: string) {
    setRows((current) => current.filter((row) => row.key !== key));
  }

  async function post(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError(null);
    setLinkInactive(false);
    try {
      const response = await fetch("/api/farmer/stand", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, ...body }),
      });
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        if (response.status === 403) setLinkInactive(true);
        setError(
          response.status === 403
            ? "This link is no longer active. Your listing is unchanged."
            : typeof payload.message === "string"
              ? payload.message
              : "That did not go through. Your listing is unchanged — try again.",
        );
        return null;
      }
      return payload;
    } catch {
      setError("That did not go through. Your listing is unchanged — try again.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function propose() {
    if (edit === undefined) return;
    setStage({ step: "typing" });
    const payload = await post({ action: "propose", edit });
    if (payload === null) return;
    if (payload.outcome !== "proposed") {
      setError("That update could not be prepared. Your listing is unchanged — try again.");
      return;
    }
    setStage({
      step: "confirming",
      proposalId: payload.proposalId as string,
      confirmationText: payload.confirmationText as string,
    });
  }

  async function settle(accept: boolean) {
    if (stage.step !== "confirming") return;
    const payload = await post({
      action: accept ? "confirm" : "decline",
      proposalId: stage.proposalId,
      confirmationText: stage.confirmationText,
    });
    if (payload === null) return;
    setStage({ step: accept ? "published" : "declined" });
    if (accept && Array.isArray(payload.currentEntries) && payload.currentEntries.every(isCurrentEntry)) {
      const publishedRows = rowsFromEntries(payload.currentEntries);
      setRows(publishedRows);
      setBaselineRows(publishedRows);
      setPricesEnabled(rowsHavePrices(publishedRows));
      setDraftItem("");
    }
  }

  const editing = stage.step !== "confirming";

  return (
    <>
      {error !== null && (
        <p className="farmer-form-error" role="alert">
          {error} {linkInactive && <Link href="#new-link-help">How to get a new link</Link>}
        </p>
      )}

      {editing && (
        <>
          {stage.step === "published" && (
            <p className="farmer-form-published" role="status">
              Your stand is updated.
            </p>
          )}
          {stage.step === "declined" && (
            <p className="farmer-form-note" role="status">
              Nothing changed.
            </p>
          )}

          <StockInventoryEditor
            kind="dated"
            items={rows.map((row) => ({
              key: row.key,
              name: row.itemName,
              inStock: row.inStock,
              price: row.price,
            }))}
            pricesEnabled={pricesEnabled}
            draftItem={draftItem}
            onPricesEnabledChange={() => setPricesEnabled(!pricesEnabled)}
            onDraftItemChange={setDraftItem}
            onAddItem={addDraftItem}
            onStockChange={(key) => {
              const row = rows.find((candidate) => candidate.key === key);
              if (row !== undefined) updateRow(key, { inStock: !row.inStock });
            }}
            onPriceChange={(key, price) => updateRow(key, { price })}
            onRemoveItem={removeRow}
            action={
              <button
                type="button"
                className="farmer-stock-update"
                disabled={busy || edit === undefined}
                onClick={() => void propose()}
              >
                {busy ? "Checking…" : "Update"}
              </button>
            }
          />
        </>
      )}

      {stage.step === "confirming" && (
        <section className="farmer-confirmation" role="region" aria-label="Exact publication preview">
          <p className="farmer-form-note">
            <strong>Exact preview — nothing has changed yet.</strong>
          </p>
          <pre className="farmer-form-snapshot">{stage.confirmationText}</pre>
          <button
            className="farmer-form-affirmative"
            type="button"
            disabled={busy}
            onClick={() => void settle(true)}
          >
            {busy ? "Publishing…" : "Confirm and publish"}
          </button>
          <button type="button" disabled={busy} onClick={() => void settle(false)}>
            Don&apos;t publish
          </button>
        </section>
      )}
    </>
  );
}
