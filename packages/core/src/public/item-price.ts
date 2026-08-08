/**
 * F-092 — turning a stand item's four price columns into the one sentence a customer reads.
 *
 * THE ONLY RENDERER. The map card, the admin export and any SMS answer all call this, because a
 * second one is how two stands come to print the same price differently — which is precisely what
 * storing the parts instead of the farmer's typing was meant to prevent.
 *
 * It never throws and never prints half a price: every malformed shape returns `null`, and the
 * caller decides what an unpriced item looks like in its own layout.
 */

/** The `basis` column — the word that joins the parts. See `standItemPriceBasis`. */
export type StandItemPriceBasis = "per" | "for";

/**
 * A price as it arrives FROM THE DATABASE.
 *
 * `amount` and `quantity` are strings because that is what the driver hands back for `numeric` —
 * deliberately, since a float cannot hold `5.10` exactly. Parsing them here, once, is what keeps
 * that decision from leaking into every caller.
 */
export interface StandItemPrice {
  amount: string;
  quantity: string;
  unit: string;
  basis: StandItemPriceBasis;
}

/** A finite number, or null. `Number("")` is 0, which is why this cannot be a bare `Number`. */
function parseDecimal(value: string): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Money as a sign would letter it: `$6`, `$6.50`, `$6.05`.
 *
 * A trailing `.00` is dropped because "$6.00 / dozen" reads as a machine's output rather than a
 * farmer's price, while real cents are always kept — rounding them away would misstate what was
 * asked for.
 */
function renderAmount(amount: number): string {
  const cents = Math.round(amount * 100);
  const whole = Math.trunc(cents / 100);
  const remainder = Math.abs(cents % 100);
  if (remainder === 0) return `$${whole}`;
  return `$${whole}.${String(remainder).padStart(2, "0")}`;
}

/** A count, without the trailing zeros a `numeric(10,2)` carries: `3`, `0.5`. */
function renderQuantity(quantity: number): string {
  return String(Number(quantity.toFixed(2)));
}

/**
 * The sentence, or `null` when there is no complete price to state.
 *
 * `null` rather than `""` so a caller cannot accidentally render an empty element where a price
 * would go, and rather than a dash so nothing invents a placeholder on every unpriced item.
 */
export function renderStandItemPrice(
  price: StandItemPrice | null | undefined,
): string | null {
  if (price === null || price === undefined) return null;

  // Guarded field by field rather than trusting the CHECK constraint: this function is also
  // reachable from objects built in code, and half a price on the public map is worse than none.
  const unit = typeof price.unit === "string" ? price.unit.trim() : "";
  if (unit === "") return null;
  if (price.basis !== "per" && price.basis !== "for") return null;

  const amount = parseDecimal(price.amount);
  const quantity = parseDecimal(price.quantity);
  if (amount === null || quantity === null) return null;
  if (amount < 0 || quantity <= 0) return null;

  // FREE is the farmer's meaning; "$0 / dozen" is a machine's. max's call (2026-08-08) — free is
  // an amount of zero, and it reads the same however the farmer reached it, so this precedes the
  // basis branch rather than sitting inside one of them.
  if (amount === 0) return "Free";

  // A bundle of one is a unit price wearing the wrong word. Collapsing it here is what stops
  // "1 lb for $5" and "$5 / lb" being two renderings of one fact, decided by which control the
  // farmer happened to touch.
  if (price.basis === "for" && quantity !== 1) {
    return `${renderQuantity(quantity)} ${unit} for ${renderAmount(amount)}`;
  }
  return `${renderAmount(amount)} / ${unit}`;
}
