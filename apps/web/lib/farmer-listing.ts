import type { Clock } from "@farm-friend/core";
import {
  loadFarmerInvitation,
  saveOnboardingListing,
  OPEN_HOURS_KINDS,
  SEASON_KINDS,
  STOCKING_CADENCES,
  type Db,
  type FarmerInvitationLookup,
  type ListingAvailability,
  type OnboardingListingInput,
  type OpenHoursKind,
  type SaveOnboardingListingResult,
  type SeasonKind,
  type StockingCadence,
} from "@farm-friend/db";

// F-067 — the HTTP boundary for the listing details an onboarding farmer types.
//
// This is the first farmer-facing write path for PUBLIC listing data, and everything it writes
// appears on the map VIGA links from its own site. So the boundary's job is narrow and strict:
// resolve the farm from the credential, validate every field's SHAPE, and hand a typed input
// to the writer that owns the rules.
//
// **The invitation token is the only credential, and it names the farm.** A farm id in the
// request body is ignored, never trusted — accepting one would let anyone holding any
// onboarding link overwrite any farm's address and hours on the public map. This mirrors how
// the agreement endpoint refuses to be the consent write: the link proves possession of the
// link and nothing else, so it may only reach what it names.

/** The one shape a 64-hex credential may take, checked before any database work. */
const INVITE_TOKEN_RE = /^[0-9a-f]{64}$/;

/**
 * Generous ceilings on published text, because the endpoint is reachable by anyone holding a
 * link and everything it writes is public. No real farmer meets these; a defacement attempt
 * does.
 */
const MAX_TEXT = 500;
const MAX_ADDRESS = 300;
const MAX_LIST_ENTRIES = 100;

export interface FarmerListingDeps {
  db: Db;
  clock: Clock;
  /** Injected so the boundary's contract is testable without a database. */
  loadInvitation: (
    db: Db,
    token: string,
    now: Date,
  ) => Promise<FarmerInvitationLookup>;
  saveListing: (
    db: Db,
    input: {
      farmId: string;
      standName: string;
      listing: OnboardingListingInput;
      occurredAt: Date;
    },
  ) => Promise<SaveOnboardingListingResult>;
}

/** A field that must be a string within its ceiling, or absent. */
function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > max) return undefined;
  return value;
}

/** A list of strings within its ceilings, or absent. `undefined` means malformed. */
function stringList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_LIST_ENTRIES) return undefined;
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length > MAX_TEXT) return undefined;
  }
  return value as string[];
}

/**
 * A coordinate, validated as a NUMBER rather than coerced into one.
 *
 * `Number(null)` is `0`, which is a real coordinate in the Atlantic — coercion here would turn
 * a missing pin into a confident one. Returns `undefined` for malformed so the caller can
 * refuse rather than guess.
 */
function optionalCoordinate(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

// ── F-068: the structured availability fields ─────────────────────────────────────────────
//
// These land in columns guarded by five CHECK constraints. Validated as the types they are and
// never coerced: `Number("13")` is a number and `Number(null)` is 0, so a coercing parser turns
// junk and absence alike into confident values a farmer never stated.

/** One of a fixed set of enum values, or absent. `undefined` means malformed. */
function optionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  return (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

/**
 * An INTEGER within an inclusive range, or absent.
 *
 * Integer-checked rather than merely numeric: month 3.5 is not a month, and truncating it would
 * invent a value. The range mirrors the `valid_season_dates` / `valid_open_minutes` constraints,
 * so an out-of-range value is refused here with a name instead of arriving as a violation.
 */
function optionalIntegerInRange(
  value: unknown,
  min: number,
  max: number,
): number | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return value >= min && value <= max ? value : undefined;
}

/**
 * A weekday set — 1 to 7 integers each in 0-6 — or absent.
 *
 * An EMPTY array is refused rather than normalized to null: it asserts "open on no day", which
 * no stand means, and `valid_open_days` refuses it.
 */
function optionalDaySet(value: unknown): number[] | null | undefined {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length < 1 || value.length > 7) return undefined;
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isInteger(entry)) return undefined;
    if (entry < 0 || entry > 6) return undefined;
  }
  if (new Set(value as number[]).size !== value.length) return undefined;
  return value as number[];
}

/** Marks a malformed field, distinguishing it from a legitimately absent one. */
const MALFORMED = Symbol("malformed");

/**
 * Read the availability a farmer stated, keeping only the detail its stated KIND carries.
 *
 * **The stripping is the interesting half.** A farmer who typed a date range and then switched
 * their answer to "year-round" is the ordinary case, not an attack — the browser may well still
 * hold the old dates. `coherentSeason` refuses `year_round` carrying dates, so passing them
 * through would refuse the farmer's submission over a field the form no longer shows them.
 * Each group therefore keeps exactly what its kind requires and drops the rest.
 *
 * Returns `MALFORMED` when a value is the wrong type or out of range — that is a bad request,
 * not a farmer's mistake, and it is refused rather than silently narrowed.
 */
function readAvailability(
  body: Record<string, unknown>,
): ListingAvailability | typeof MALFORMED {
  const seasonKind = optionalEnum<SeasonKind>(body.seasonKind, SEASON_KINDS);
  const openHoursKind = optionalEnum<OpenHoursKind>(body.openHoursKind, OPEN_HOURS_KINDS);
  const stockingCadence = optionalEnum<StockingCadence>(
    body.stockingCadence,
    STOCKING_CADENCES,
  );

  const seasonStartMonth = optionalIntegerInRange(body.seasonStartMonth, 1, 12);
  const seasonStartDay = optionalIntegerInRange(body.seasonStartDay, 1, 31);
  const seasonEndMonth = optionalIntegerInRange(body.seasonEndMonth, 1, 12);
  const seasonEndDay = optionalIntegerInRange(body.seasonEndDay, 1, 31);
  const seasonNames = stringList(body.seasonNames);
  const openFromMinutes = optionalIntegerInRange(body.openFromMinutes, 0, 1439);
  const openUntilMinutes = optionalIntegerInRange(body.openUntilMinutes, 0, 1439);
  const openDays = optionalDaySet(body.openDays);
  const stockingDays = optionalDaySet(body.stockingDays);

  if (
    seasonKind === undefined ||
    openHoursKind === undefined ||
    stockingCadence === undefined ||
    seasonStartMonth === undefined ||
    seasonStartDay === undefined ||
    seasonEndMonth === undefined ||
    seasonEndDay === undefined ||
    seasonNames === undefined ||
    openFromMinutes === undefined ||
    openUntilMinutes === undefined ||
    openDays === undefined ||
    stockingDays === undefined
  ) {
    return MALFORMED;
  }

  // Which season detail the stated kind carries. `date_range` takes all four endpoints,
  // `open_ended` only the start, `named_season` only the names, `year_round` and "not stated"
  // none of it.
  const keepStart = seasonKind === "date_range" || seasonKind === "open_ended";
  const keepEnd = seasonKind === "date_range";
  const keepNames = seasonKind === "named_season";
  // Blank names are dropped the way blank items are, then an empty list becomes "not stated"
  // — but only when the kind does not require names, since `named_season` with none is the
  // farmer's own incoherence and must reach them as `incoherent_availability`.
  const statedNames = seasonNames.map((name) => name.trim()).filter((name) => name !== "");

  // `clock_range` needs both clock times, `until_dusk` only the opening one. Every other kind
  // — and "not stated" — carries none.
  const keepFrom = openHoursKind === "clock_range" || openHoursKind === "until_dusk";
  const keepUntil = openHoursKind === "clock_range";

  return {
    seasonKind,
    seasonStartMonth: keepStart ? seasonStartMonth : null,
    seasonStartDay: keepStart ? seasonStartDay : null,
    seasonEndMonth: keepEnd ? seasonEndMonth : null,
    seasonEndDay: keepEnd ? seasonEndDay : null,
    seasonNames: keepNames ? statedNames : null,
    openHoursKind,
    openFromMinutes: keepFrom ? openFromMinutes : null,
    openUntilMinutes: keepUntil ? openUntilMinutes : null,
    openDays,
    stockingCadence,
    // Only `specific_days` carries a day list, in both directions.
    stockingDays: stockingCadence === "specific_days" ? stockingDays : null,
  };
}

/**
 * HTTP boundary for the onboarding listing form.
 *
 * Publishes on submit (max, 2026-08-05): the listing is live when the farmer sends the form
 * rather than waiting for the SIGNUP text.
 *
 * Expired, redeemed, and unknown invitations all get the same uniform refusal the agreement
 * endpoint gives, so neither can be used to learn whether a guessed token names anything. An
 * invitation naming no farm gets the same answer: there is nothing to write against, and that
 * path is still a human's.
 */
export async function handleFarmerListingPost(
  deps: FarmerListingDeps,
  request: Request,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const token = body.token;
  if (typeof token !== "string" || !INVITE_TOKEN_RE.test(token)) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  // The central question, and the one thing that may never be defaulted: whether there is a
  // place to drive to. Guessing it is what F-038 and B-024 exist to prevent.
  const visitability = body.visitability;
  if (visitability !== "visitable" && visitability !== "contact_only") {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const offeringType = body.offeringType;
  if (
    offeringType !== "produce" &&
    offeringType !== "services" &&
    offeringType !== "by_order"
  ) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const standName = optionalText(body.standName, MAX_TEXT);
  const address = optionalText(body.publicAddress, MAX_ADDRESS);
  const hoursText = optionalText(body.hoursText, MAX_TEXT);
  const paymentMethods = stringList(body.paymentMethods);
  const items = stringList(body.items);
  const latitude = optionalCoordinate(body.latitude);
  const longitude = optionalCoordinate(body.longitude);
  const availability = readAvailability(body);

  if (
    standName === undefined ||
    address === undefined ||
    hoursText === undefined ||
    paymentMethods === undefined ||
    items === undefined ||
    latitude === undefined ||
    longitude === undefined ||
    availability === MALFORMED
  ) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const invitation = await deps.loadInvitation(
    deps.db,
    token,
    deps.clock.now(),
  );
  // An invitation naming no farm has nothing to write against — that path still reaches VIGA.
  // Answered identically to an unknown token so this discloses no more than the page does.
  if (invitation.status !== "active" || invitation.farmId === null) {
    return Response.json(
      { error: "invitation_unavailable" },
      { status: 410 },
    );
  }

  // A contact-only stand carries NO address and NO pin, and the boundary enforces that rather
  // than trusting the form to have hidden the fields. `coherentVisitability` would refuse the
  // write anyway, but as a constraint violation the farmer cannot act on — and a farmer who
  // filled in an address and then changed their answer is the ordinary case, not an attack.
  const visitable = visitability === "visitable";

  const result = await deps.saveListing(deps.db, {
    farmId: invitation.farmId,
    // The farm's own name is the sensible default for its stand: a farmer who never renames it
    // still gets a listing titled the thing their invitation named.
    standName: standName ?? invitation.farmName ?? "",
    listing: {
      visitability,
      offeringType,
      publicAddress: visitable ? address : null,
      latitude: visitable ? latitude : null,
      longitude: visitable ? longitude : null,
      hoursText,
      availability,
      paymentMethods,
      items,
    },
    occurredAt: deps.clock.now(),
  });

  if (result.status === "saved") return Response.json({ status: "saved" });
  // `unknown_farm` is unreachable through this path — the farm came from the invitation we
  // just resolved — but is answered honestly rather than reported as a save.
  const status = result.status === "unknown_farm" ? 410 : 400;
  return Response.json({ error: result.status }, { status });
}

/** The production wiring: the real invitation lookup and writer behind the boundary above. */
export function farmerListingDeps(context: {
  db: Db;
  clock: Clock;
}): FarmerListingDeps {
  return {
    db: context.db,
    clock: context.clock,
    loadInvitation: loadFarmerInvitation,
    saveListing: saveOnboardingListing,
  };
}
