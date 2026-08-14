// Customer inquiry: typed public facts → code-rendered authoritative answers.
//
// There is deliberately no path by which a model-supplied string becomes customer-facing
// factual text.

/**
 * What kind of claim a retrieved fact supports (F-045).
 *
 * `confirmed` — a farmer published this inventory at `asOf`. Carries recency, and goes
 * stale.
 * `offering` — a standing description of what the stand typically stocks. Nobody confirmed
 * anything, so it carries NO timestamp and never goes stale: attaching an elapsed phrase
 * would manufacture a confirmation that never happened.
 *
 * The distinction is the same one the public map draws between its confirmed line and its
 * "Usually sells" line (F-042). Two surfaces, one rule.
 */
export type FactBasis = "confirmed" | "offering";

/**
 * One retrieved sales location with the authoritative values the renderer needs.
 *
 * There is exactly ONE fact type, deliberately (F-046). Selection validation and page
 * rendering used to take near-identical shapes differing only in whether the address could be
 * null — and the nullable half was the true one, which is how F-045 shipped the literal word
 * "null" to customers past a compiler that was satisfied.
 */
export interface RetrievedFact {
  /** Opaque stable identifier used by code-owned paging. */
  factId: string;
  locationName: string;
  farmName: string;
  /**
   * Nullable, because the column is: two real stands carry no public address. A stand with no
   * address is still a real answer to "who has lamb?" — it just cannot be navigated to.
   */
  publicAddress: string | null;
  /** The matched items this location publishes, in published order. */
  matchedItems: RetrievedItem[];
  /**
   * When the farmer last confirmed this location's inventory. For an `offering` this
   * orders candidates but is never rendered — nothing was confirmed.
   */
  asOf: Date;
  basis: FactBasis;
}

export interface RetrievedItem {
  itemName: string;
  quantity?: number;
  unit?: string;
  priceText?: string;
  approximation?: "some" | "limited" | "plentiful";
}

/**
 * Inventory older than this is shown with a prominent staleness warning rather than
 * disappearing: unattended honor-system stands are usually right but never certain, and
 * hiding an old listing serves the customer worse than labelling it (PRODUCT_BRIEF).
 *
 * FOUR DAYS (max, 2026-08-11; raised from 48 hours). Nearly every stand is unattended and
 * honor-system, with stable staples and variable stock — a farmer who confirms on Saturday is
 * not wrong by Monday morning, and two days marked ordinary weekend listings as suspect. The
 * threshold is a judgement about how fast an island farm stand actually changes, not a
 * property of the data.
 *
 * **One number for both surfaces**, deliberately: it decides the public map's stale warning
 * AND whether an SMS entry reads "In stock" or "Last seen" (B-063). Two numbers would let the
 * same row read as current stock in a text message and as stale on the web.
 *
 * `answer.test.ts` pins the VALUE as well as the boundary — a test written against the
 * constant passes at any number, which is no test of a product commitment at all.
 */
export const STALE_AFTER_HOURS = 96;

/**
 * Render the bare elapsed phrase — "4 hours ago", "just now" — from typed values.
 *
 * The verb is the CALLER's, because two surfaces say it differently: the SMS answer says
 * "updated 4 hours ago" and the public map's confirmed line says "Confirmed 4 hours ago"
 * (F-042). The arithmetic behind both is stated once, here, so web and SMS cannot come to
 * disagree about how fresh the same row is.
 */
export function renderElapsed(asOf: Date, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - asOf.getTime()) / 60_000));
  if (minutes < 60) {
    return minutes <= 1 ? "just now" : `${minutes} minutes ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** Render "updated X ago" from typed values. Never approximated by a model. */
export function renderRecency(asOf: Date, now: Date): string {
  return `updated ${renderElapsed(asOf, now)}`;
}

/**
 * The abbreviated elapsed phrase the SMS answer prints inside its IN STOCK line (F-107).
 *
 * "(2d ago)" against "2 days ago" — six characters against ten, on a line that repeats for
 * every stand on the page. SMS is the one surface that pays per character, so it is the one
 * surface that abbreviates: **the public map deliberately keeps `renderElapsed`'s full
 * wording**, and that divergence is intentional rather than drift to be tidied away.
 *
 * Granularity stops at the hour (max, 2026-08-11): nothing a customer decides changes inside
 * one, so anything under an hour reads "now" rather than rounding to "0h ago" or reintroducing
 * minutes nobody acts on.
 */
export function renderShortElapsed(asOf: Date, now: Date): string {
  const hours = Math.max(0, Math.floor((now.getTime() - asOf.getTime()) / 3_600_000));
  if (hours < 1) return "now";
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * How long the public card keeps counting before it stops claiming a date at all (F-097).
 *
 * Four weeks, max's call (2026-08-08). Past it the card says "No recent update" rather than
 * "Last updated 63 days ago": a two-month-old confirmation is not a fresher or staler fact
 * than a three-month-old one, and printing the arithmetic invites a customer to reason about
 * a number that has stopped meaning anything. This is a DISPLAY threshold and is deliberately
 * NOT `STALE_AFTER_HOURS` — staleness (48 hours) is when the warning starts; this is when the
 * count itself stops being worth stating.
 */
export const NO_RECENT_UPDATE_AFTER_DAYS = 28;

/** What a card with no useful date left says instead of one. */
export const NO_RECENT_UPDATE = "No recent update";

/**
 * When an SMS stock line stops printing an exact age and says the age in words (max,
 * 2026-08-14).
 *
 * ONE WEEK, and it governs WORDING ONLY — never ranking, never the map's warning, never
 * whether the claim is shown. `STALE_AFTER_HOURS` (96h) still decides all three of those, and
 * the two thresholds are deliberately different jobs: at four days a confirmation stops
 * leading the page, and at a week it stops being worth counting in days.
 *
 * B-063 was a present-tense IN STOCK over a 16-day-old confirmation. The fix there swapped the
 * LABEL; max's call is that the label should never change — a customer learns one vocabulary —
 * and that the parenthesis carries the warning instead, in words a customer reads rather than
 * a number they have to judge. "9d ago" asks the reader to decide whether nine days is a lot;
 * "over a week ago" has already decided.
 */
export const EXACT_AGE_UNTIL_DAYS = 7;

/** What the SMS stock line says in place of an exact age once a confirmation is over a week old. */
export const OVER_A_WEEK_AGO = "over a week ago";

/**
 * The parenthesised age on an SMS stock line — "(2h ago)", "(over a week ago)".
 *
 * Shared by the single-stand listing, the item verdict, and the multi-stand page, so one
 * confirmation cannot be described three ways across three routes. The exact-age half is
 * `renderShortElapsed`; this adds only the point at which counting stops.
 */
export function renderStockAge(asOf: Date, now: Date): string {
  const days = Math.floor(Math.max(0, now.getTime() - asOf.getTime()) / 86_400_000);
  return days >= EXACT_AGE_UNTIL_DAYS ? OVER_A_WEEK_AGO : renderShortElapsed(asOf, now);
}

/**
 * The public card's recency phrase — "Last updated 3 days ago", or the no-date sentence.
 *
 * **Separate from `renderElapsed` because the two surfaces answer different questions.** An
 * SMS answer is about right now, so it counts in minutes and hours and never needs a week; a
 * map card is browsed and its listings run to months, where "45 days ago" is a number nobody
 * converts. So this adds weeks above a day and gives up entirely at four of them.
 *
 * It still DELEGATES everything under a week to `renderElapsed`, rather than restating the
 * arithmetic: web and SMS must not come to disagree about how fresh the same row is, which is
 * the whole reason that function is shared.
 */
export function renderCardRecency(asOf: Date, now: Date): string {
  const days = Math.floor(
    Math.max(0, now.getTime() - asOf.getTime()) / 86_400_000,
  );
  if (days >= NO_RECENT_UPDATE_AFTER_DAYS) return NO_RECENT_UPDATE;
  if (days < 7) return `Last updated ${renderElapsed(asOf, now)}`;
  const weeks = Math.floor(days / 7);
  return weeks === 1 ? "Last updated 1 week ago" : `Last updated ${weeks} weeks ago`;
}

/**
 * True when a confirmation is too old for the card to keep claiming stock from it.
 *
 * THE DISTINCTION THIS HOLDS (max, 2026-08-10). `isStale` (48 hours) says *show the listing
 * with a warning* — a nine-day-old confirmation is real information on an island of unattended
 * stands, and hiding it would be the dishonesty in the other direction. This says something
 * stronger: the confirmation has stopped being evidence of anything, so the card must stop
 * printing an "In stock" heading over it entirely rather than hedge with a caption.
 *
 * It shares `NO_RECENT_UPDATE_AFTER_DAYS` with `renderCardRecency` DELIBERATELY, and that is
 * the whole design: the moment the card gives up on stating a date is the moment it may no
 * longer assert stock. Two thresholds would open a window where the heading reads "In stock"
 * above the caption "No recent update" — the exact contradiction this exists to close.
 *
 * A stand whose confirmation has expired is not blanked. It falls through to the same lines a
 * never-confirmed stand renders: its specialties, and "Nothing confirmed recently."
 */
export function isConfirmationExpired(asOf: Date, now: Date): boolean {
  const days = Math.floor(
    Math.max(0, now.getTime() - asOf.getTime()) / 86_400_000,
  );
  return days >= NO_RECENT_UPDATE_AFTER_DAYS;
}

/** True when a fact is old enough that the answer must carry a staleness warning. */
export function isStale(asOf: Date, now: Date): boolean {
  return now.getTime() - asOf.getTime() >= STALE_AFTER_HOURS * 3_600_000;
}

/**
 * Render one published item — "Kale (6 bunches, $4)" — from typed values.
 *
 * Exported so the page renderer shares it (F-046). A second copy in `paging.ts` would be two
 * places a quantity could come to be formatted differently for the same row.
 */
export function renderItem(item: RetrievedItem): string {
  const detail =
    item.quantity !== undefined && item.unit !== undefined
      ? `${item.quantity} ${item.unit}`
      : item.quantity !== undefined
        ? `${item.quantity}`
        : item.approximation;

  const parts = [detail, item.priceText].filter(
    (part): part is string => typeof part === "string" && part !== "",
  );
  return parts.length > 0 ? `${item.itemName} (${parts.join(", ")})` : item.itemName;
}

/**
 * The code-rendered honest response when retrieval found nothing. Reached WITHOUT a
 * grounded-selection model call: there is nothing to select from, so asking a model could
 * only invent.
 */
export function renderNoCurrentListing(itemsRequested: string[]): string {
  const subject =
    itemsRequested.length > 0 ? itemsRequested.join(", ") : "that";
  return (
    `No stand has a current listing for ${subject}. ` +
    `Listings show what farmers last confirmed, so something may still be available.`
  );
}

/**
 * The code-rendered question asked when the model signals it could not pin down what the
 * customer wants. The model contributes the SIGNAL; this supplies the words (F-018).
 *
 * Model-authored prose used to travel here in an `ambiguous.question` field, which made
 * this the one path where a model could put arbitrary text — a recipe, canning advice, a
 * link — in front of a customer with every check passing. Rendering it in code removes the
 * channel rather than inspecting what flows through it.
 */
export function renderClarificationRequest(): string {
  return (
    "Sorry, I did not catch which item or farm you meant. " +
    "Reply with what you are looking for and I will check what stands have it."
  );
}

/**
 * The reply when Farm Friend could not reach its interpreter at all (B-049).
 *
 * A separate sentence from `renderClarificationRequest` because it reports a DIFFERENT fact.
 * Telling a customer whose question was never seen that we "did not catch which item" blames
 * their wording for our outage and asks them to retype something that was already fine.
 *
 * It claims nothing about any stand — an unanswered question is not evidence of absence — and
 * it points at the map, which does not depend on the interpreter being up.
 */
export function renderInterpreterUnavailable(): string {
  return (
    "Sorry, I could not look that up just now. Please try again in a minute. " +
    `The map at ${PUBLIC_MAP_URL} is always up to date.`
  );
}

/**
 * The code-rendered response to a request outside what launch answers — recipes, cooking
 * or preservation instructions, and food-safety guidance (F-018).
 *
 * Farm Friend answers the grounded availability half of such a request from typed facts and
 * then states this boundary. It is a scope statement, not a disclaimer attached to generated
 * content: no recipe or safety text is produced anywhere for it to qualify.
 */
export const RECIPE_SCOPE_STATEMENT =
  "Farm Friend does not provide recipes, cooking or preservation instructions, " +
  "or food-safety guidance.";

/**
 * The public web map. The one place a customer is sent for anything needing their position.
 *
 * It is a constant rather than configuration because it is a product fact stated in customer
 * copy, and a wrong or empty value would be delivered as an SMS to a real person.
 *
 * **The `#map` fragment is load-bearing, not decoration** (max, 2026-08-12). VIGA's page carries
 * its own content above the embed, so the bare URL opens above the map and a customer who texted
 * for the map has to scroll to find it. The anchor is a real `id` on that page. Dropping it is a
 * silent regression — the link still resolves, nothing errors, and the reader simply lands in the
 * wrong place — which is why a test pins the fragment rather than only the origin.
 */
export const PUBLIC_MAP_URL = "https://www.vigavashon.org/farm-stand-map#map";

/**
 * The code-rendered response to a request that needs the customer's own position (F-017).
 *
 * Launch resolves no arbitrary origin over SMS — no geocoder, no address lookup, no
 * device location in a text message. The approved boundary keeps origin-aware proximity on
 * the public web, where the browser can offer a transient position with permission.
 *
 * So this says what Farm Friend cannot do and where the customer can do it, and it claims
 * NO distance, direction, or travel time. The alternative failure modes this exists to
 * prevent are both dishonest: inventing a proximity answer, or silently returning an
 * unranked list as though it had answered "which is closest?".
 *
 * Like the recipe scope statement, the model contributes only a boolean signal; every word
 * here is code's.
 */
export const ORIGIN_LIMITATION_STATEMENT =
  "Farm Friend cannot work out which stand is closest to you over text. " +
  `The map at ${PUBLIC_MAP_URL} can sort stands by distance if you allow location access.`;
