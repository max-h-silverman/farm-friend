// The farmer's alert when a customer reports something sold out (F-104, GL-007).
//
// **Code-rendered from typed facts, and that is the whole point.** The customer's own
// sentence is untrusted public SMS, and the item text on an unlisted report is model output.
// Neither reaches the farmer verbatim: this renderer takes a location name and an item name
// — two typed values code resolved — and writes the message itself. A prompt-injected
// "reporter" therefore has no channel to speak to a farmer through (Golden Rule #6).
//
// **It prompts; it does not assert.** A customer's word never changes a farmer's listing
// (Golden Rule #1), so the farmer is told what someone reported and left to decide. The
// alert deliberately teaches NO new token: GL-007 requires that a reply enter the ordinary
// inventory flow rather than opening a second confirmation vocabulary with its own expiry
// and one-open rule.

export interface StockOutAlertFacts {
  /** The bound stand's own name, from `sales_locations`. */
  locationName: string;
  /**
   * What the customer reported missing — a listed entry's `item_name`, or the normalized
   * text from an unlisted report. Code passes it as a typed fact; it is never a sentence.
   */
  itemName: string;
}

/** Render the private prompt a customer's stock-out report sends to the farmer. */
export function renderStockOutAlert(facts: StockOutAlertFacts): string {
  return [
    // "Someone" is doing real work: it states the provenance honestly (a stranger said this)
    // without implying Farm Friend confirmed it or that the listing has been changed.
    `VIGA Farm Friend: someone reported that ${facts.itemName} is sold out at ` +
      `${facts.locationName}.`,
    "",
    // The ask is an ordinary update, in the same words the welcome message teaches. No token,
    // no menu, nothing that needs its own parser.
    "If that's right, text us what your stand has now and we'll update your listing.",
  ].join("\n");
}
