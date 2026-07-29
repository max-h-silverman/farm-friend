// F-038 — classifying WHAT a farm sells, at seed time, from the farmer's own words.
//
// Two of the 32 farms in the corpus are not produce stands, and this is where that fact enters
// the database. `offering_type` and `visitability` are INDEPENDENT (F-038): Seedrain has a street
// address and sells services; Open Gate Lamb has no address and sells by order. One enum could
// not carry both, which is why there are two columns and two classifiers.
//
// NO FARM NAME APPEARS HERE. The rule matches the farmer's own description, so a farm that
// renames itself keeps its classification and a new service business gets one without a code
// change. That is Golden Rule "no business code hard-codes what the model can understand"
// applied to the seed path: farms and their offerings are DATA.
//
// This is a ONE-TIME seed concern, and it runs on the seeder's side of the architecture
// tripwire — `architecture.test.ts` excludes the seeder from its no-farm-type-branch scan
// precisely because classifying a farm BY type at seed time is what F-038 is for. What that
// tripwire forbids is branching PUBLICATION behaviour on the result: any farm may publish
// inventory regardless of what this returns.

/** The farmer's free-text answers this classifier reads. */
export interface OfferingTypeSource {
  generalInformation?: string;
  extraNotes?: string;
  stockingText?: string;
}

/**
 * A business selling expertise or labour rather than goods.
 *
 * Anchored to the noun a farmer uses for the thing being sold ("services", "consulting"), not to
 * the topic. "Advice" alone is too weak — a produce stand may well offer growing advice.
 */
const SERVICES = /\b(services?|consult(?:ing|ation)s?|advice and services)\b/i;

/**
 * Goods that exist only once a customer asks for them.
 *
 * Requires ORDERING to be how you obtain the goods — "send an email to order", "reservations",
 * "shares" — rather than a passing mention. "Bulk orders welcome" alongside a self-serve stand
 * is an ordinary produce stand offering a convenience, and must stay `produce`; that is why the
 * bare word "order" is not enough on its own.
 */
const BY_ORDER = [
  /\b(?:email|call|contact|text|message)\s+\w*\s*to\s+order\b/i,
  /\b(?:reservations?|pre-?orders?|whole and half shares|shares?)\s+(?:open|available|only|required)\b/i,
  /\border\s+(?:only|in advance|ahead)\b/i,
  /\bby\s+(?:the\s+)?order\b/i,
];

/**
 * Decide what a farm sells from what the farmer wrote.
 *
 * Defaults to `produce`, which is right for 30 of the 32 farms and is the safe direction: a
 * mislabelled produce stand still shows a customer somewhere to buy vegetables, whereas wrongly
 * marking a real stand as services or by-order would tell people they cannot just turn up.
 */
export function classifyOfferingType(
  source: OfferingTypeSource,
): "produce" | "services" | "by_order" {
  const text = [source.generalInformation, source.extraNotes, source.stockingText]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(" \n ");

  // Services wins when a farm states both: a service business that takes bookings is still a
  // service business. Stating the precedence beats depending on the order of two ifs.
  if (SERVICES.test(text)) return "services";
  if (BY_ORDER.some((pattern) => pattern.test(text))) return "by_order";
  return "produce";
}
