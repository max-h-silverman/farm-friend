"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { StockItemRow } from "../../farmer/stock-item-row";

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
  quantity: string;
  unit: string;
  priceText: string;
  inStock: boolean;
}

type DetailChange = number | string | null;

function rowsFromEntries(entries: CurrentEntry[]): EditorRow[] {
  return entries.map((entry) => ({
    key: entry.entryId,
    entryId: entry.entryId,
    itemName: entry.itemName,
    quantity: entry.quantity === undefined ? "" : String(entry.quantity),
    unit: entry.unit ?? "",
    priceText: entry.priceText ?? "",
    inStock: true,
  }));
}

function cleanQuantity(value: string): string {
  const kept = value.replace(/[^0-9.]/g, "");
  const firstDot = kept.indexOf(".");
  return firstDot === -1
    ? kept
    : kept.slice(0, firstDot + 1) + kept.slice(firstDot + 1).replaceAll(".", "");
}

function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function detailDelta(
  current: string,
  baseline: string,
  parse: (value: string) => number | string,
): DetailChange | undefined {
  const next = current.trim();
  const before = baseline.trim();
  if (next === before) return undefined;
  return next === "" ? null : parse(next);
}

function structuredEdit(rows: EditorRow[], baselineRows: EditorRow[]) {
  const baselineById = new Map(
    baselineRows.flatMap((row) => (row.entryId === undefined ? [] : [[row.entryId, row] as const])),
  );
  const additions: Array<{
    itemName: string;
    quantity?: number;
    unit?: string;
    priceText?: string;
  }> = [];
  const changes: Array<{
    entryId: string;
    quantity?: number | null;
    unit?: string | null;
    priceText?: string | null;
  }> = [];
  const removals: Array<{ entryId: string }> = [];

  for (const row of rows) {
    if (row.entryId === undefined) {
      if (!row.inStock) continue;
      const quantity = optionalText(row.quantity);
      const parsedQuantity = quantity === undefined ? undefined : Number(quantity);
      if (parsedQuantity !== undefined && !Number.isFinite(parsedQuantity)) return null;
      additions.push({
        itemName: row.itemName,
        ...(parsedQuantity === undefined ? {} : { quantity: parsedQuantity }),
        ...(optionalText(row.unit) === undefined ? {} : { unit: optionalText(row.unit) }),
        ...(optionalText(row.priceText) === undefined
          ? {}
          : { priceText: optionalText(row.priceText) }),
      });
      continue;
    }

    const baseline = baselineById.get(row.entryId);
    if (baseline === undefined) continue;
    if (!row.inStock) {
      removals.push({ entryId: row.entryId });
      continue;
    }

    const quantity = detailDelta(row.quantity, baseline.quantity, Number);
    if (typeof quantity === "number" && !Number.isFinite(quantity)) return null;
    const unit = detailDelta(row.unit, baseline.unit, (value) => value);
    const priceText = detailDelta(row.priceText, baseline.priceText, (value) => value);
    if (quantity !== undefined || unit !== undefined || priceText !== undefined) {
      changes.push({
        entryId: row.entryId,
        ...(quantity === undefined ? {} : { quantity: quantity as number | null }),
        ...(unit === undefined ? {} : { unit: unit as string | null }),
        ...(priceText === undefined ? {} : { priceText: priceText as string | null }),
      });
    }
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
  const [baselineRows, setBaselineRows] = useState(initialRows);
  const [rows, setRows] = useState(initialRows);
  const [draftItem, setDraftItem] = useState("");
  const [stage, setStage] = useState<Stage>({ step: "typing" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkInactive, setLinkInactive] = useState(false);
  const nextKey = useRef(0);
  const edit = structuredEdit(rows, baselineRows);

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
    nextKey.current += 1;
    setRows((current) => [
      ...current,
      {
        key: `new-${nextKey.current}`,
        itemName,
        quantity: "",
        unit: "",
        priceText: "",
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
    if (edit === null) {
      setError("Enter a valid quantity before previewing.");
      return;
    }
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
              Your stand is updated. Customers can now see this listing.
            </p>
          )}
          {stage.step === "declined" && (
            <p className="farmer-form-note" role="status">
              Nothing changed. Your listing is as it was.
            </p>
          )}

          <fieldset className="farmer-listing-inventory farmer-stock-editor">
            <legend>What is in stock today?</legend>
            <p className="farmer-listing-inventory-subtitle">
              This is a dated stock update. It does not change what your stand usually sells.
            </p>

            <div className="farmer-listing-item-add">
              <label className="sr-only" htmlFor="farmer-stock-add-item">
                Add an in-stock item
              </label>
              <input
                id="farmer-stock-add-item"
                type="text"
                value={draftItem}
                placeholder="e.g. plum jam"
                maxLength={120}
                onChange={(event) => setDraftItem(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  addDraftItem();
                }}
              />
              <button
                type="button"
                className="farmer-listing-item-add-button"
                disabled={draftItem.trim() === ""}
                onClick={addDraftItem}
              >
                Add item
              </button>
            </div>

            {rows.length === 0 ? (
              <p className="farmer-listing-inventory-empty">
                Nothing is listed in stock. Add what is available today.
              </p>
            ) : (
              <ul className="farmer-listing-items">
                {rows.map((row) => (
                  <StockItemRow
                    key={row.key}
                    name={row.itemName}
                    stock={{
                      checked: row.inStock,
                      onChange: () => updateRow(row.key, { inStock: !row.inStock }),
                    }}
                  >
                    <div className="farmer-stock-item-details">
                      <label>
                        <span>Quantity</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          aria-label={`Quantity for ${row.itemName}`}
                          value={row.quantity}
                          disabled={!row.inStock}
                          placeholder="—"
                          maxLength={12}
                          onChange={(event) =>
                            updateRow(row.key, { quantity: cleanQuantity(event.target.value) })
                          }
                        />
                      </label>
                      <label>
                        <span>Unit</span>
                        <input
                          type="text"
                          aria-label={`Unit for ${row.itemName}`}
                          value={row.unit}
                          disabled={!row.inStock}
                          placeholder="e.g. dozen"
                          maxLength={40}
                          onChange={(event) => updateRow(row.key, { unit: event.target.value })}
                        />
                      </label>
                      <label>
                        <span>Price</span>
                        <input
                          type="text"
                          aria-label={`Price for ${row.itemName}`}
                          value={row.priceText}
                          disabled={!row.inStock}
                          placeholder="e.g. $6"
                          maxLength={80}
                          onChange={(event) =>
                            updateRow(row.key, { priceText: event.target.value })
                          }
                        />
                      </label>
                    </div>
                  </StockItemRow>
                ))}
              </ul>
            )}

            <button
              type="button"
              className="farmer-stock-preview"
              disabled={busy || edit === undefined || edit === null}
              onClick={() => void propose()}
            >
              {busy ? "Checking…" : "Preview update"}
            </button>
          </fieldset>
        </>
      )}

      {stage.step === "confirming" && (
        <section className="farmer-confirmation" role="region" aria-label="Exact publication preview">
          <p className="farmer-form-note">
            <strong>This is exactly what people will see.</strong>
          </p>
          <p className="farmer-form-note">Nothing has changed yet.</p>
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
            Decline this update
          </button>
        </section>
      )}
    </>
  );
}
