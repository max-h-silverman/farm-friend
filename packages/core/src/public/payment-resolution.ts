// F-125 — payment belongs to the SELLER, with a stand-level override that only NARROWS.
//
// ## Why this function exists at all
//
// Payment used to live on `sales_locations`: the methods in `sales_location_payment_methods`,
// VIGA Bucks in a pair of booleans. That is the wrong owner. Whoever takes the money decides
// how they take it, and a seller selling at three stands should state it once rather than
// three times — and today she can leave the three disagreeing.
//
// The override survives because a real case needs it: a hosted seller who cannot take cash at
// a particular stand because the HOST does not support it. That is the host constraining what
// is possible at their location, not a second independent answer about the seller.
//
// ## The direction is enforced by the SHAPE, not by a guard
//
// The override is stored as EXCLUSIONS — rows naming a method the host removes. There is no
// representation for "this stand adds a method the seller does not take", so adding is not
// refused at runtime; it is unsayable. That is the difference between a rule the code checks
// and a rule the data model makes impossible, and CLAUDE.md asks for the second wherever it
// is reachable: a guard can be forgotten by the next writer, a missing column cannot.
//
// This is also the mechanism that replaces the one F-125 removes. Nothing anywhere derives a
// seller's answer from her stands — that derivation was the second mechanism, and rebuilding
// it in a helper would reintroduce exactly what this change exists to delete.

/** The ordinary payment methods shown by browser listing forms, in display order. */
export const FARMER_SELECTABLE_PAYMENT_METHODS: readonly string[] = [
  "Cash",
  "Check",
  "Venmo",
  "PayPal",
  "Cash App",
  "Zelle",
  "Credit card",
];

/** What the seller states, and what this one stand takes away. */
export interface PaymentResolutionInput {
  /** The seller's own stated methods, in her order, already canonicalized on write. */
  sellerMethods: readonly string[];
  /** Methods this stand cannot support for this seller. Removing only; never adding. */
  excludedAtStand: readonly string[];
}

/**
 * Fold for comparison ONLY — never for storage or display.
 *
 * Both sides are canonicalized by `canonicalPaymentMethods` before they are written, so a case
 * difference should not be reachable. Folding anyway costs nothing and closes the one failure
 * that would matter: a legacy or hand-written exclusion row silently doing nothing, which
 * tells a customer they can pay a way the host cannot actually accept.
 */
function foldForComparison(method: string): string {
  return method.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * What this seller actually takes at this stand.
 *
 * The seller's order is preserved rather than sorted: `FARMER_SELECTABLE_PAYMENT_METHODS` is
 * ordered as a farmer expects to read it, and alphabetizing would throw that away.
 *
 * An empty result is a real answer — a stand where this seller can take no payment at all —
 * and callers must render it as "no stated method" rather than falling back to the seller's
 * full list. Falling back would hand the customer the very method the host just removed.
 */
export function resolvePaymentMethods(input: PaymentResolutionInput): string[] {
  const excluded = new Set(input.excludedAtStand.map(foldForComparison));
  const seen = new Set<string>();
  const resolved: string[] = [];

  for (const method of input.sellerMethods) {
    const key = foldForComparison(method);
    if (key === "") continue;
    if (excluded.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push(method);
  }

  return resolved;
}
