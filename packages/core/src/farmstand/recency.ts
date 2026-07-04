import type { Clock } from "../clock";
import type { Provenance } from "@farm-friend/contracts";

// Freshness / recency labeling. The two-axis model means the label depends on PROVENANCE:
// farmer-confirmed inventory says "confirmed X ago"; migrated inventory says "via VIGA's map,
// updated [date]" and is NEVER rendered as "confirmed". See docs/DATA_ARCHITECTURE.md.

export interface RecencyInput {
  provenance: Provenance;
  /** When the inventory was last real-world updated (confirmation date, or migration/import date). */
  updatedAt: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function agoPhrase(fromMs: number, clock: Clock): string {
  const delta = clock.now().getTime() - fromMs;
  if (delta < HOUR_MS) return "just now";
  if (delta < DAY_MS) {
    const h = Math.floor(delta / HOUR_MS);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const d = Math.floor(delta / DAY_MS);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Produce the customer-facing recency label. A migrated pin is labeled honestly by its date and
 * provenance and NEVER says "confirmed"; a farmer-confirmed pin says "confirmed X ago".
 */
export function recencyLabel(input: RecencyInput, clock: Clock): string {
  if (input.provenance === "migrated") {
    return `via VIGA's map, updated ${isoDate(input.updatedAt)}`;
  }
  return `confirmed ${agoPhrase(input.updatedAt.getTime(), clock)}`;
}

/** Guard used in tests + the feed builder: a migrated pin must never claim confirmation. */
export function labelClaimsConfirmation(label: string): boolean {
  return /confirmed/i.test(label);
}
