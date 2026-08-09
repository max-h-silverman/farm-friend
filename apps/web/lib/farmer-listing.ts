import {
  hashPhone,
  normalizePhone,
  standItemPriceNeedsUnit,
  type Clock,
} from "@farm-friend/core";
import {
  loadFarmerInvitation,
  recordFarmerInvitationPendingPhone,
  recordFarmerInvitationPendingCadence,
  recordFarmerInvitationPendingStock,
  type PendingPromptCadence,
  saveOnboardingListing,
  OPEN_HOURS_KINDS,
  SEASON_KINDS,
  STOCKING_CADENCES,
  type Db,
  type FarmerInvitationLookup,
  type ListingAvailability,
  type OnboardingListingInput,
  type OpenHoursKind,
  type SaveOnboardingListingInput,
  type SaveOnboardingListingResult,
  type SeasonKind,
  type StandingItem,
  type StandingItemPrice,
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
/**
 * The farm's own paragraph, which is the one field carrying whole sentences.
 *
 * 2000 rather than `MAX_TEXT`, measured against the real corpus: the longest stored description
 * in production is 1144 characters. A 500-character ceiling would refuse a farmer who opened
 * their own listing and saved it back untouched.
 */
const MAX_DESCRIPTION = 2000;
const MAX_LIST_ENTRIES = 100;

export interface FarmerListingDeps {
  db: Db;
  clock: Clock;
  /**
   * The HMAC salt the phone hash is built under (Golden Rule #5).
   *
   * Required rather than optional: a missing salt would silently produce a hash no inbound
   * `START` could ever match, so the farmer would wait for a text that never came and nothing
   * would report a fault.
   */
  phoneSalt: string;
  /** Injected so the boundary's contract is testable without a database. */
  loadInvitation: (
    db: Db,
    token: string,
    now: Date,
  ) => Promise<FarmerInvitationLookup>;
  saveListing: (
    db: Db,
    input: SaveOnboardingListingInput,
  ) => Promise<SaveOnboardingListingResult>;
  /**
   * Record the phone this farmer will text `START` from (max 2026-08-07).
   *
   * Replaces `JOIN <token>`, which asked the farmer to hand-copy 64 hex characters into a text
   * message and failed silently on any typo. **Not consent and not a grant** — it records which
   * handset to expect, so a later inbound `START` can be attributed to this invitation.
   */
  recordPendingPhone?: (
    db: Db,
    input: { token: string; phoneE164: string; phoneHash: string; occurredAt: Date },
  ) => Promise<{ status: "recorded" } | { status: "invalid" }>;
  /**
   * Hold what is on the table right now until the farmer's `START` proves the handset (F-090).
   *
   * **This publishes nothing.** It writes to the invitation, which no public reader touches;
   * the redemption composes it into a real, attributed confirmation. A dated claim needs
   * somebody to stand behind it, and a web form proves only that VIGA sent a link to somebody.
   */
  recordPendingStock?: (
    db: Db,
    input: {
      token: string;
      entries: { itemName: string; priceText?: string }[];
      occurredAt: Date;
    },
  ) => Promise<{ status: "recorded" } | { status: "invalid" }>;
  /**
   * Hold the reminder cadence the farmer chose until their `START` (F-097).
   *
   * Same holding pattern as the stock above, and for a structural reason rather than a policy
   * one: `inventory_prompt_preferences` carries a composite foreign key to a live
   * authorization, which an invited farmer does not have until they text.
   */
  recordPendingCadence?: (
    db: Db,
    input: {
      token: string;
      cadence: PendingPromptCadence;
      occurredAt: Date;
    },
  ) => Promise<{ status: "recorded" } | { status: "invalid" }>;
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
 * What the farmer says is on the table RIGHT NOW (F-090).
 *
 * Narrower than the standing items above: a name and an optional price, no quantity and no
 * approximation, because that is exactly what the form asks. Absent means the farmer said
 * nothing about today; an EMPTY array is refused rather than treated as silence, since
 * publishing it would be the stand confirming it has nothing — the opposite claim.
 */
function currentStockList(
  value: unknown,
): { itemName: string; priceText?: string }[] | null | undefined {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (value.length > MAX_LIST_ENTRIES) return undefined;

  const entries: { itemName: string; priceText?: string }[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return undefined;
    }
    const { itemName, priceText } = entry as { itemName?: unknown; priceText?: unknown };
    if (typeof itemName !== "string" || itemName.length > MAX_TEXT) return undefined;
    if (priceText === undefined || priceText === null) {
      entries.push({ itemName });
      continue;
    }
    if (typeof priceText !== "string" || priceText.length > MAX_TEXT) return undefined;
    entries.push({ itemName, priceText });
  }
  return entries;
}

/**
 * One item's price, as the four parts the writer stores (F-092).
 *
 * **Malformed is UNPRICED, never a 400.** A price is optional, so a body whose price object is
 * the wrong shape has still stated an item — refusing the whole listing over it would lose the
 * farmer's other answers to a field they were free to omit. The writer's `normalizePrice` makes
 * the same call for the same reason.
 *
 * Amount and quantity arrive as STRINGS and stay strings: they are `numeric` columns, and
 * routing money through a JS number is how `5.10` becomes `5.0999999999999996`. They are checked
 * for numeric CONTENT here without being converted.
 */
function itemPrice(value: unknown): StandingItemPrice | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const { amount, quantity, unit, basis } = value as {
    amount?: unknown;
    quantity?: unknown;
    unit?: unknown;
    basis?: unknown;
  };
  if (typeof amount !== "string" || typeof quantity !== "string") return null;
  if (basis !== "per" && basis !== "for") return null;

  // B-041 — the unit is OPTIONAL for a bundle and required for a unit price, and
  // `standItemPriceNeedsUnit` is that rule for the whole system rather than a copy of it here.
  // Absent, null and blank all mean the same thing and all normalize to `null`, which is what
  // the column holds; "" would render identically while only one of them is a fact.
  if (unit !== undefined && unit !== null && typeof unit !== "string") return null;
  if (typeof unit === "string" && unit.length > MAX_TEXT) return null;
  const statedUnit = typeof unit === "string" && unit.trim() !== "" ? unit : null;
  if (statedUnit === null && standItemPriceNeedsUnit(basis)) return null;

  // Numeric content, checked without coercing the value that gets stored. `Number("")` is `0`,
  // so a blank amount would otherwise arrive as FREE — a price the farmer never stated.
  if (amount.trim() === "" || quantity.trim() === "") return null;
  const amountValue = Number(amount);
  const quantityValue = Number(quantity);
  if (!Number.isFinite(amountValue) || !Number.isFinite(quantityValue)) return null;
  if (amountValue < 0 || quantityValue <= 0) return null;

  return { amount, quantity, unit: statedUnit, basis };
}

/**
 * The standing items a farmer stated, each with its optional price (F-090, F-092).
 *
 * **A bare string is still accepted, and means "no price".** Three doors post this body, and a
 * farmer with a tab open across a deploy would otherwise get a 400 they cannot act on for a
 * body that is perfectly unambiguous. This is a widening, not a second format: everything is
 * normalized to the pair before it leaves here, so exactly one shape reaches the writer.
 *
 * Validated as the types they are and never coerced. `String(6)` is `"6"`, which would turn a
 * malformed price into a plausible-looking one the farmer never typed — the same reasoning
 * `optionalCoordinate` spells out below.
 *
 * `undefined` means malformed, matching every other parser here.
 */
function itemList(value: unknown): StandingItem[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_LIST_ENTRIES) return undefined;

  const items: StandingItem[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      if (entry.length > MAX_TEXT) return undefined;
      items.push({ name: entry, price: null });
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return undefined;
    }
    const { name, price } = entry as { name?: unknown; price?: unknown };
    if (typeof name !== "string" || name.length > MAX_TEXT) return undefined;
    items.push({ name, price: itemPrice(price) });
  }
  return items;
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

// ── F-069: the structured availability fields ─────────────────────────────────────────────
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
 * What a farmer stated about their stand, read from a request body and validated.
 *
 * Carries no farm and no credential — deliberately. **Who may write, and to which farm, is the
 * credential's question; WHAT may be written is this one**, and the two are separated so a
 * second credential (F-072's grandfather claim) reuses every field rule here rather than
 * restating it. Two statements of "what a listing may contain" is how the two paths would drift
 * into publishing different things onto the same map.
 */
export interface ParsedListingSubmission {
  /** The stand name the farmer typed, or null to fall back to the farm's own name. */
  standName: string | null;
  listing: OnboardingListingInput;
  /**
   * What is on the table RIGHT NOW, when the farmer said (F-090). `null` means they did not.
   *
   * BESIDE the listing rather than inside it, because it is not a listing fact: the listing is
   * a standing description, and this is a dated confirmation that publishes only when the
   * farmer's `START` proves the handset. `saveOnboardingListing` must never see it — collapsing
   * the two is what would let "we usually sell eggs" become "eggs are on the table today".
   */
  currentStock: { itemName: string; priceText?: string }[] | null;
  /**
   * F-097 — how often the farmer asked to be reminded. `null` means they said nothing.
   *
   * Beside the listing for the same reason `currentStock` is: it is not a listing fact. It is
   * a messaging preference, held on the invitation until `START` proves the handset, because
   * the preference row needs an authorization that does not exist yet.
   */
  promptCadence: PendingPromptCadence | null;
}

/** The four cadences the form may state. Anything else is a malformed body, not a default. */
const PROMPT_CADENCES = ["every_2_days", "weekly", "every_2_weeks", "paused"] as const;

/**
 * The stated cadence, `null` for absent, or `undefined` for malformed.
 *
 * Three outcomes rather than two, matching every other reader in this file: a body that states
 * a cadence we do not recognise is a BUG in the caller, and quietly falling back to the default
 * would hide it while silently changing how often a farmer is texted.
 */
function promptCadence(
  value: unknown,
): PendingPromptCadence | null | undefined {
  if (value === undefined || value === null) return null;
  return PROMPT_CADENCES.includes(value as PendingPromptCadence)
    ? (value as PendingPromptCadence)
    : undefined;
}

/**
 * Read and validate every listing field, without deciding anything about authority.
 *
 * Returns `null` for a malformed body, which every caller answers as `invalid_request`.
 */
export function parseListingSubmission(
  body: Record<string, unknown>,
): ParsedListingSubmission | null {
  // The central question, and the one thing that may never be defaulted: whether there is a
  // place to drive to. Guessing it is what F-038 and B-024 exist to prevent.
  const visitability = body.visitability;
  if (visitability !== "visitable" && visitability !== "contact_only") return null;
  const offeringType = body.offeringType;
  if (
    offeringType !== "produce" &&
    offeringType !== "services" &&
    offeringType !== "by_order"
  ) {
    return null;
  }

  const standName = optionalText(body.standName, MAX_TEXT);
  const address = optionalText(body.publicAddress, MAX_ADDRESS);
  const hoursText = optionalText(body.hoursText, MAX_TEXT);
  // The farm's own paragraph. A LONGER ceiling than the other free text, because it is the one
  // field holding whole sentences — VIGA's stored prose reaches 1144 characters on the real
  // corpus, and a limit under that would silently refuse a farmer re-saving their own listing.
  const description = optionalText(body.description, MAX_DESCRIPTION);
  const paymentMethods = stringList(body.paymentMethods);
  const items = itemList(body.items);
  const currentStock = currentStockList(body.currentStock);
  const cadence = promptCadence(body.promptCadence);
  const latitude = optionalCoordinate(body.latitude);
  const longitude = optionalCoordinate(body.longitude);
  const availability = readAvailability(body);

  if (
    standName === undefined ||
    address === undefined ||
    hoursText === undefined ||
    description === undefined ||
    paymentMethods === undefined ||
    items === undefined ||
    currentStock === undefined ||
    cadence === undefined ||
    latitude === undefined ||
    longitude === undefined ||
    availability === MALFORMED
  ) {
    return null;
  }

  return {
    currentStock,
    promptCadence: cadence,
    standName,
    listing: {
      visitability,
      offeringType,
      // F-088 — the location is kept for EVERY farm. This used to null it out for a
      // contact-only stand because `coherentVisitability` refused to store it; that constraint
      // was relaxed, so stripping it here would now discard a fact the farmer gave us and the
      // map wants. Whether the farm is a DESTINATION is `visitability`, carried separately.
      publicAddress: address,
      /*
        F-088 — hiding the address is a DISPLAY choice, and only an explicit `false` makes it.

        Read as an identity check rather than a truthiness one, deliberately. `"false"` is a
        truthy string and `0` is falsy, so a coerced read would hide addresses on some malformed
        bodies and publish them on others — and defaulting to PUBLISHED is the safe direction
        only because it matches what every pre-F-088 row and every other door already means. The
        unsafe direction, hiding on a value nobody chose, would silently blank the map.
      */
      addressPublic: body.addressPublic !== false,
      /*
        F-092 — showing prices is OPT-IN, so this is the mirror image of the line above: only an
        explicit `true` turns it on, where the address needs an explicit `false` to turn off.

        The safe direction is reversed because the defaults are. An address on a public listing
        form is already public information, so silence means "published". A price is a thing this
        system never asked for before and no stand has consented to showing, so silence has to
        mean "not shown" — a malformed body must not put a farmer's prices on the map.
      */
      pricesPublic: body.pricesPublic === true,
      // F-088 — kept for every farm too. The location travels whole or not at all, which is
      // what the database still enforces; `visitability` decides what the map does with it.
      latitude,
      longitude,
      hoursText,
      availability,
      paymentMethods,
      items,
      // An absent field parses as `null`, which the writer stores as "no paragraph". That is
      // the right reading HERE because every door sends this field on every save — the writer
      // replaces the whole listing, so silence has to mean cleared rather than unchanged.
      description,
    },
  };
}

/**
 * HTTP boundary for the onboarding listing form.
 *
 * Publishes on submit (max, 2026-08-05): the listing is live when the farmer sends the form
 * rather than waiting for the JOIN text.
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

  const submission = parseListingSubmission(body);
  if (submission === null) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  /*
    THE PHONE, normalized and hashed BEFORE anything is written.

    Validated up here, ahead of the save, because the listing and the phone commit together: a
    farmer who mistyped their number must not end up with a published listing and no way to
    finish it. Refusing the whole request leaves them on the form with the number to fix, which
    is the only state they can act on.

    `invalid_phone` rather than the uniform `invalid_request`: this one IS actionable, and the
    form shows it against the field. Nothing here discloses anything about the invitation.
  */
  const rawPhone = body.phone;
  let pendingPhone: { phoneE164: string; phoneHash: string } | null = null;
  if (rawPhone !== undefined && rawPhone !== null && rawPhone !== "") {
    if (typeof rawPhone !== "string" || rawPhone.length > MAX_TEXT) {
      return Response.json({ error: "invalid_phone" }, { status: 400 });
    }
    try {
      pendingPhone = {
        phoneE164: normalizePhone(rawPhone),
        phoneHash: hashPhone(rawPhone, deps.phoneSalt),
      };
    } catch {
      // `normalizePhone` throws on anything that is not a 10/11-digit US/CA number. The raw
      // value is deliberately NOT echoed back or logged.
      return Response.json({ error: "invalid_phone" }, { status: 400 });
    }
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

  const result = await deps.saveListing(deps.db, {
    farmId: invitation.farmId,
    // The farm's own name is the sensible default for its stand: a farmer who never renames it
    // still gets a listing titled the thing their invitation named.
    standName: submission.standName ?? invitation.farmName ?? "",
    listing: submission.listing,
    occurredAt: deps.clock.now(),
  });

  if (result.status === "saved") {
    /*
      Recorded AFTER the listing saved, and deliberately not inside its transaction.

      The two are not one commitment. A listing that saved is real and publishable; a phone that
      failed to record leaves the farmer needing to re-submit the form, which they can do. The
      reverse order would be worse — a recorded phone whose listing failed would have `START`
      complete onboarding for a farm with nothing on it.

      A `recordPendingPhone` failure is NOT reported as a failed save, because the save
      succeeded. What it costs is the automatic phone match, and the farmer's next submit fixes
      it: the writer overwrites rather than keeping the first value.
    */
    if (pendingPhone !== null && deps.recordPendingPhone !== undefined) {
      await deps.recordPendingPhone(deps.db, {
        token,
        phoneE164: pendingPhone.phoneE164,
        phoneHash: pendingPhone.phoneHash,
        occurredAt: deps.clock.now(),
      });
    }
    /*
      Today's stock, held for the same reason and in the same order (F-090).

      AFTER the phone, which is not incidental: `recordFarmerInvitationPendingStock` refuses an
      invitation with no `pending_phone_hash`, because held stock with no phone would never
      publish — nothing would ever match it to an inbound START. Recording the phone first is
      what makes this write land.

      A failure here is not a failed save either. The listing is real and publishable; what the
      farmer loses is the head start on today's stock, which one text replaces.
    */
    if (submission.currentStock !== null && deps.recordPendingStock !== undefined) {
      await deps.recordPendingStock(deps.db, {
        token,
        entries: submission.currentStock,
        occurredAt: deps.clock.now(),
      });
    }
    /*
      The reminder cadence the farmer chose, held on the same invitation (F-097).

      Unlike the stock above it, this does NOT depend on the phone having been recorded: a
      cadence with no handset simply never applies. It is still written last, so a failure here
      cannot cost the farmer their listing or their held stock — and a farmer whose cadence did
      not land keeps the default, which is what they had before the form asked.
    */
    if (submission.promptCadence !== null && deps.recordPendingCadence !== undefined) {
      await deps.recordPendingCadence(deps.db, {
        token,
        cadence: submission.promptCadence,
        occurredAt: deps.clock.now(),
      });
    }
    return Response.json({ status: "saved" });
  }
  // `unknown_farm` is unreachable through this path — the farm came from the invitation we
  // just resolved — but is answered honestly rather than reported as a save.
  const status = result.status === "unknown_farm" ? 410 : 400;
  return Response.json({ error: result.status }, { status });
}

/**
 * The production wiring: the real invitation lookup and writers behind the boundary above.
 *
 * The salt is read from the environment here rather than taken from `publicReadContext`, the
 * same way `farmerLinkRequestConfig` does it — which keeps this public path free of the model
 * graph. It THROWS when absent rather than defaulting: a missing salt would produce a hash no
 * inbound `START` could match, so the farmer would wait forever for a text with nothing
 * reporting a fault.
 */
export function farmerListingDeps(context: {
  db: Db;
  clock: Clock;
  env?: Record<string, string | undefined>;
}): FarmerListingDeps {
  const phoneSalt = (context.env ?? process.env).PHONE_HASH_SALT?.trim();
  if (phoneSalt === undefined || phoneSalt === "") {
    throw new Error("PHONE_HASH_SALT is required");
  }
  return {
    db: context.db,
    clock: context.clock,
    phoneSalt,
    loadInvitation: loadFarmerInvitation,
    saveListing: saveOnboardingListing,
    recordPendingPhone: recordFarmerInvitationPendingPhone,
    recordPendingStock: recordFarmerInvitationPendingStock,
    recordPendingCadence: recordFarmerInvitationPendingCadence,
  };
}
