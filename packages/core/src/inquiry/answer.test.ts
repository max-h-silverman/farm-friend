import { describe, expect, it } from "vitest";
import {
  isConfirmationExpired,
  isStale,
  ORIGIN_LIMITATION_STATEMENT,
  PUBLIC_MAP_URL,
  renderNoCurrentListing,
  renderCardRecency,
  renderElapsed,
  renderRecency,
  NO_RECENT_UPDATE,
  NO_RECENT_UPDATE_AFTER_DAYS,
  EXACT_AGE_UNTIL_DAYS,
  OVER_A_WEEK_AGO,
  renderStockAge,
  STALE_AFTER_HOURS,
} from "./answer";

const NOW = new Date("2026-07-25T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe("recency rendering — code states how fresh a fact is", () => {
  it("renders minutes, hours, and days from typed values", () => {
    expect(renderRecency(new Date(NOW.getTime() - 30_000), NOW)).toBe("updated just now");
    expect(renderRecency(hoursAgo(0.5), NOW)).toBe("updated 30 minutes ago");
    expect(renderRecency(hoursAgo(1), NOW)).toBe("updated 1 hour ago");
    expect(renderRecency(hoursAgo(5), NOW)).toBe("updated 5 hours ago");
    expect(renderRecency(hoursAgo(24), NOW)).toBe("updated 1 day ago");
    expect(renderRecency(hoursAgo(72), NOW)).toBe("updated 3 days ago");
  });

  it("marks a fact stale at the threshold, not before", () => {
    expect(isStale(hoursAgo(STALE_AFTER_HOURS - 1), NOW)).toBe(false);
    expect(isStale(hoursAgo(STALE_AFTER_HOURS), NOW)).toBe(true);
  });

  it("holds the threshold at four days (max, 2026-08-11)", () => {
    /*
      The VALUE, pinned separately from the boundary behaviour above.

      That test is written against the constant, so it passes at any number and cannot notice
      the threshold moving — which is exactly what a product commitment needs a test for. This
      one fails if the number changes, so a change has to be deliberate and has to update
      PRODUCT_BRIEF alongside it.

      Four days, not two: nearly every stand is unattended and honor-system, with stable
      staples and variable stock, and a farmer who confirms on Saturday is not wrong by Monday
      morning. 48 hours marked ordinary weekend listings as suspect.
    */
    expect(STALE_AFTER_HOURS).toBe(96);
  });

  it("counts an exact age up to a week, then says it in words", () => {
    // The boundary: six days still counts, seven stops counting.
    expect(renderStockAge(hoursAgo(24 * 6), NOW)).toBe("6d ago");
    expect(renderStockAge(hoursAgo(24 * 7), NOW)).toBe(OVER_A_WEEK_AGO);
    expect(renderStockAge(hoursAgo(24 * 16), NOW)).toBe(OVER_A_WEEK_AGO);
    // Below the boundary it is exactly `renderShortElapsed` — one arithmetic, not two.
    expect(renderStockAge(hoursAgo(2), NOW)).toBe("2h ago");
    expect(renderStockAge(hoursAgo(0.2), NOW)).toBe("now");
  });

  it("holds the wording threshold at one week (max, 2026-08-14)", () => {
    // Pinned as a VALUE, like the staleness threshold above and for the same reason: the
    // boundary test passes at any number.
    expect(EXACT_AGE_UNTIL_DAYS).toBe(7);
  });

  it("keeps the wording threshold clear of the two ageing thresholds", () => {
    /*
      THREE numbers now, doing three different jobs, and the order between them is the product
      rule: a confirmation stops leading the page (4 days), then stops being counted in days
      (1 week), then stops being shown at all (4 weeks).

      Crossing any pair would produce a contradiction a customer can see — an exact age on a
      claim that has already been dropped, or a vague age on one still ranked as fresh.
    */
    expect(STALE_AFTER_HOURS).toBeLessThan(EXACT_AGE_UNTIL_DAYS * 24);
    expect(EXACT_AGE_UNTIL_DAYS).toBeLessThan(NO_RECENT_UPDATE_AFTER_DAYS);
  });

  it("keeps the two ageing thresholds distinct and correctly ordered", () => {
    // Staleness (warn, keep the claim) must come well before expiry (drop the claim). If they
    // ever crossed, a listing would lose its stock claim before it was ever labelled stale.
    expect(STALE_AFTER_HOURS).toBeLessThan(NO_RECENT_UPDATE_AFTER_DAYS * 24);
  });

  // F-042 — the public map's confirmed line reads "Confirmed 4 hours ago", the SMS answer
  // reads "updated 4 hours ago". Two voices, and the elapsed phrase must be computed ONCE:
  // a second copy of this arithmetic is how web and SMS start disagreeing about how fresh
  // the same row is.
  it("renders the bare elapsed phrase, with no leading verb of its own", () => {
    expect(renderElapsed(new Date(NOW.getTime() - 30_000), NOW)).toBe("just now");
    expect(renderElapsed(hoursAgo(0.5), NOW)).toBe("30 minutes ago");
    expect(renderElapsed(hoursAgo(1), NOW)).toBe("1 hour ago");
    expect(renderElapsed(hoursAgo(5), NOW)).toBe("5 hours ago");
    expect(renderElapsed(hoursAgo(24), NOW)).toBe("1 day ago");
    expect(renderElapsed(hoursAgo(72), NOW)).toBe("3 days ago");
  });

  // F-097 — the PUBLIC CARD's phrasing, which is a different question from the SMS answer's.
  // An SMS reply is about right now and counts in hours; a card is browsed, its listings run
  // to months, and "45 days ago" is a number nobody converts.
  it("counts the card's recency in weeks once a listing is over a week old", () => {
    const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
    // Under a week it DELEGATES to renderElapsed, so the two surfaces cannot disagree.
    expect(renderCardRecency(hoursAgo(2), NOW)).toBe("Last updated 2 hours ago");
    expect(renderCardRecency(daysAgo(3), NOW)).toBe("Last updated 3 days ago");
    expect(renderCardRecency(daysAgo(6), NOW)).toBe("Last updated 6 days ago");
    // Then weeks, singular at exactly one.
    expect(renderCardRecency(daysAgo(7), NOW)).toBe("Last updated 1 week ago");
    expect(renderCardRecency(daysAgo(13), NOW)).toBe("Last updated 1 week ago");
    expect(renderCardRecency(daysAgo(14), NOW)).toBe("Last updated 2 weeks ago");
    expect(renderCardRecency(daysAgo(27), NOW)).toBe("Last updated 3 weeks ago");
  });

  it("stops claiming a date at four weeks rather than counting into months", () => {
    // max's call (2026-08-08). A two-month-old confirmation is not meaningfully fresher than a
    // three-month-old one, and printing the arithmetic invites a customer to reason about a
    // number that has stopped carrying information.
    //
    // The boundary is asserted on BOTH sides: an off-by-one here would either cut a listing
    // off a day early or let "Last updated 4 weeks ago" ship, and neither is visible from one
    // assertion.
    const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
    expect(renderCardRecency(daysAgo(27), NOW)).toBe("Last updated 3 weeks ago");
    expect(renderCardRecency(daysAgo(28), NOW)).toBe(NO_RECENT_UPDATE);
    expect(renderCardRecency(daysAgo(400), NOW)).toBe(NO_RECENT_UPDATE);
    // And it never renders the word "ago" once it has given up on the date.
    expect(renderCardRecency(daysAgo(60), NOW)).not.toContain("ago");
  });

  it("treats a confirmation past four weeks as EXPIRED, not merely undated", () => {
    // The card used to print a bordered "In stock" heading with an item list under it for a
    // confirmation of any age, conceding only that the parenthetical read "(No recent update)".
    // "In stock (No recent update)" asserts stock while admitting it has no idea how old the
    // claim is — the manufactured certainty the honor-system product refuses to fake.
    //
    // Shares ONE threshold with `renderCardRecency` rather than introducing a second tunable:
    // the moment the card stops being willing to state a date is the moment it must stop
    // claiming stock. Asserted on both sides of the boundary, like the render test above.
    const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
    expect(isConfirmationExpired(daysAgo(27), NOW)).toBe(false);
    expect(isConfirmationExpired(daysAgo(28), NOW)).toBe(true);
    expect(isConfirmationExpired(daysAgo(400), NOW)).toBe(true);
  });

  it("expires exactly when the card gives up on the date — one threshold, not two", () => {
    // Anchored to AGREEMENT between the two functions rather than to the literal number 28, so
    // moving the threshold cannot silently leave a window where the card claims stock under a
    // "No recent update" caption. That window is the entire bug.
    const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
    for (const days of [0, 1, 6, 7, 13, 27, 28, 29, 60, 400]) {
      const asOf = daysAgo(days);
      expect(isConfirmationExpired(asOf, NOW)).toBe(
        renderCardRecency(asOf, NOW) === NO_RECENT_UPDATE,
      );
    }
  });

  it("does not expire a fresh confirmation on a skewed clock", () => {
    // A future `asOf` must not read as "very old" through a sign error in the subtraction.
    expect(isConfirmationExpired(new Date(NOW.getTime() + 86_400_000), NOW)).toBe(false);
  });

  it("never renders a negative or future age as a count", () => {
    // A clock skew between the writer and the reader must not produce "Last updated -2 days
    // ago". `renderElapsed` already floors at zero; this proves the card's wrapper inherits it.
    expect(renderCardRecency(new Date(NOW.getTime() + 86_400_000), NOW)).toBe(
      "Last updated just now",
    );
  });

  it("states the elapsed phrase once — renderRecency is that phrase, prefixed", () => {
    // Anchored to agreement between the two renderers rather than to either one's literal
    // output, so a change to the duration wording cannot drift the two apart silently.
    for (const asOf of [
      new Date(NOW.getTime() - 30_000),
      hoursAgo(0.5),
      hoursAgo(1),
      hoursAgo(5),
      hoursAgo(24),
      hoursAgo(72),
    ]) {
      expect(renderRecency(asOf, NOW)).toBe(`updated ${renderElapsed(asOf, NOW)}`);
    }
  });
});

describe("the honest no-listing response", () => {
  it("says nothing is currently listed without asserting absence as fact", () => {
    const answer = renderNoCurrentListing(["kale"]);
    expect(answer).toContain("No stand has a current listing for kale");
    // Honest about what a listing means, rather than claiming the item is unavailable.
    expect(answer).toContain("may still be available");
  });
});

describe("the origin limitation statement (F-017)", () => {
  it("says plainly that SMS cannot rank by distance, and points at the web map", () => {
    // The acceptance criterion: an origin-dependent SMS request gets an HONEST code-rendered
    // limitation plus a public-map link — never a fabricated distance and never a silently
    // origin-free ranking presented as if it answered the question.
    expect(ORIGIN_LIMITATION_STATEMENT).toMatch(/text|sms/i);
    expect(ORIGIN_LIMITATION_STATEMENT).toContain(PUBLIC_MAP_URL);
  });

  it("promises no distance, direction, or travel time", () => {
    // Written to fail if someone later softens this into an implied capability. If the
    // constant ever claims to measure or route, these fail.
    expect(ORIGIN_LIMITATION_STATEMENT).not.toMatch(/\d+(\.\d+)?\s*(mi|mile|km|min)/i);
    expect(ORIGIN_LIMITATION_STATEMENT).not.toMatch(/turn|head (north|south|east|west)/i);
  });

  it("is a real https URL rather than a placeholder", () => {
    const url = new URL(PUBLIC_MAP_URL);
    expect(url.protocol).toBe("https:");
    expect(url.hostname).not.toMatch(/example|localhost|todo/i);
  });

  it("lands the reader ON the map rather than at the top of the page", () => {
    // VIGA's page carries other content above the embed, so the bare URL opens above the map
    // and the customer has to scroll to reach the thing they texted for. The `#map` anchor is
    // a real `id` on that page (max, 2026-08-12) — dropping it is a silent regression, because
    // the link still resolves and nothing else fails.
    expect(new URL(PUBLIC_MAP_URL).hash).toBe("#map");
  });
});
