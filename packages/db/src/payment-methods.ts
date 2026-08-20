// F-069 — payment methods as a CLOSED SET plus a free-text tail.
//
// F-067's form asked "How can people pay?" as one comma-separated box writing straight into an
// unconstrained `method text` column, so "venmo", "Venmo" and "VENMO ONLY" became three values
// no filter could join. That is the unfilterable shape Farm Friend exists to replace.
//
// ## Why canonicalizing HERE is correct and canonicalizing produce is not
//
// The rule in CLAUDE.md is that no business code hard-codes a produce taxonomy — sellers, foods
// and listings are DATA. Payment methods are not food vocabulary: they are a small, closed,
// VIGA-known set that the real map corpus already states uniformly (`Accepts Cash, Check,
// Venmo, VIGA Farm Bucks`), and the listing audit calls them "mechanical". Folding "tomatoes"
// into "tomato" decides something about the world; folding "VENMO" into "Venmo" decides
// something about spelling.
//
// ## The tail is not decoration
//
// A closed set that dropped what it did not recognize would LOSE A REAL FACT. Unrecognized
// methods are kept verbatim (trimmed only), so a farmer who takes something nobody anticipated
// can still say it. Only known methods are folded to one spelling.

/**
 * VIGA Farm Bucks, spelled the way VIGA spells it.
 *
 * Deliberately NOT in `FARMER_SELECTABLE_PAYMENT_METHODS`: it is a separate boolean fact, not
 * an ordinary payment method. Since F-125 it is `sellers.farm_bucks_accepted` — the farmer's
 * own claim about herself, with no eligibility grant gating it.
 *
 * B-054 — it is RECOGNIZED here but never STORED as a method. It used to be canonicalized into
 * the list "for legacy data", which meant a stand carried the claim in two places and the card
 * printed both ("Accepts VIGA Bucks" above "Also accepts Cash, Check, VIGA Farm Bucks, ...").
 * The spellings below still identify the term; `canonicalPaymentMethods` then drops it.
 *
 * Exported because the card, the filter, and the cleanup script all need to NAME the term even
 * though no row ever holds it.
 */
export const VIGA_FARM_BUCKS = "VIGA Farm Bucks";

/**
 * What the onboarding form may offer as checkboxes.
 *
 * Ordered as a farmer would expect to see them: the two that nearly every unattended stand
 * takes, then the phone apps, then cards. A stand taking cards at all is rare on Vashon, but
 * "rare" is not "absent" and a farmer who takes them must be able to say so.
 */
export const FARMER_SELECTABLE_PAYMENT_METHODS: readonly string[] = [
  "Cash",
  "Check",
  "Venmo",
  "PayPal",
  "Cash App",
  "Zelle",
  "Credit card",
];

/**
 * Known spellings → the one canonical value.
 *
 * Keys are compared after lowercasing and whitespace collapsing, so only genuinely different
 * WORDS need an entry here. This is a spelling table, and it must stay one: an entry that mapped
 * two different payment methods together would be deciding a fact rather than a spelling.
 */
const CANONICAL_BY_SPELLING = new Map<string, string>([
  ["cash", "Cash"],
  ["cash only", "Cash"],
  ["check", "Check"],
  ["checks", "Check"],
  ["cheque", "Check"],
  ["venmo", "Venmo"],
  ["paypal", "PayPal"],
  ["pay pal", "PayPal"],
  ["cashapp", "Cash App"],
  ["cash app", "Cash App"],
  ["zelle", "Zelle"],
  ["credit card", "Credit card"],
  ["credit cards", "Credit card"],
  ["credit", "Credit card"],
  ["card", "Credit card"],
  ["cards", "Credit card"],
  ["debit card", "Credit card"],
  ["viga farm bucks", VIGA_FARM_BUCKS],
  ["viga bucks", VIGA_FARM_BUCKS],
  ["farm bucks", VIGA_FARM_BUCKS],
  ["farmbucks", VIGA_FARM_BUCKS],
]);

/** Lowercase, trim, and collapse interior runs of whitespace, for LOOKUP ONLY. */
function spellingKey(method: string): string {
  return method.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The methods to store, canonicalized where recognized and kept verbatim where not.
 *
 * Order is the farmer's. Blanks are dropped rather than refused — a stray comma is someone
 * typing, and the column's not-blank CHECK would otherwise fail their whole submission with
 * nothing useful to say about which field caused it.
 *
 * Deduplicated on the canonical value for known methods and case-insensitively for the tail, so
 * one method cannot land twice under two spellings.
 */
export function canonicalPaymentMethods(methods: string[]): string[] {
  const stated: string[] = [];
  const seen = new Set<string>();

  for (const raw of methods) {
    const key = spellingKey(raw);
    if (key === "") continue;

    const canonical = CANONICAL_BY_SPELLING.get(key);
    /*
      B-054 — Farm Bucks is identified, then DROPPED. One fact, one home: it lives in
      `sellers.farm_bucks_accepted` since F-125, and the stand card renders it
      from that column with its own badge and filter. Storing it here too is what put the
      claim on the card twice.

      Dropped at this single seam so every writer is covered at once — the CSV ingest that
      created the duplicate, the onboarding form's free-text "other payment" box, and any
      future backfill all pass through this function.

      It deliberately does NOT set the boolean. The two are different acts: this function
      canonicalizes a LIST, and acceptance is a separate answer the farmer gives through its
      own control. Setting it from a text box would make one field quietly write two facts.
    */
    if (canonical === VIGA_FARM_BUCKS) continue;
    // The tail keeps the farmer's own capitalization: this layer knows how "Venmo" is spelled
    // and has no basis for an opinion about "Trade for Eggs".
    const value = canonical ?? raw.trim();
    // Deduplicated on the folded key either way, so "Bitcoin" and "bitcoin" are one method.
    const dedupeKey = canonical ?? key;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    stated.push(value);
  }

  return stated;
}
