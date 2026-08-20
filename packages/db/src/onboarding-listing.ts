import {
  ISLAND_BOUNDS,
  standItemKey,
  trimItem,
  nextPromptDueSlot,
  renderHostConfirmationRequest,
  standItemPriceNeedsUnit,
  type PromptCadence,
} from "@farm-friend/core";
import { readNativeProviderId } from "./current-inventory";
import type { Db } from "./index";
import {
  coherentAvailability,
  NO_AVAILABILITY_STATED,
  type ListingAvailability,
} from "./listing-availability";
import { canonicalPaymentMethods } from "./payment-methods";

// `standItemKey` is core's (B-092): the draft snapshot path needs the same rule with no
// database in reach, and two definitions of "same item" is exactly the disagreement it warns
// about. Re-exported here so this module stays the name every caller already imports it by.
export { standItemKey };
import type { Sql, Tx } from "./sql";

// F-067 — the first farmer-facing writer of PUBLIC LISTING FACTS.
//
// Until this, `sales_locations` had exactly one non-test writer: the seeder. Addresses, hours,
// payment methods and offerings were read everywhere and only ever loaded from VIGA's CSV, so
// a farmer whose listing was wrong could not correct it and a farm created by an invitation
// reached the public map with a name and nothing else.
//
// ## The branch that is the form's real structure
//
// `sales_locations_coherent_visitability` is all-or-nothing in BOTH directions: a `visitable`
// stand requires an address AND a complete coordinate pair; a `contact_only` stand requires
// all three to be ABSENT. That is F-038 and B-024 — inventing an address for a farm with no
// stand to visit puts a pin on the map that sends someone driving to a place with nothing to
// buy, and the database refuses it rather than trusting every writer to remember.
//
// So this writer cannot infer visitability, and neither can the form: it has to ASK.
//
// ## Why the checks are here AND in the database
//
// The constraint is the guarantee; these checks are how a farmer gets an answer instead of a
// 500. A constraint violation escaping to the browser tells them nothing about which field to
// fix. Neither layer is redundant — remove the constraint and a future writer reintroduces the
// defect, remove these and the farmer hits an opaque error.
//
// ## What this deliberately does NOT do
//
// It writes no inventory. What a farmer usually sells is F-066's STANDING state
// (`stand_items.usually_carried`), which carries no confirmation time and can never occupy the
// one-current-per-location slot. "I usually sell eggs" is not "eggs were on the table today",
// and collapsing the two would manufacture exactly the certainty an honor-system stand refuses
// to fake. This module is the farmer-facing writer F-066 said it lacked; SMS still writes only
// confirmations.

function driver(db: Db): Sql {
  return db.sql;
}

/**
 * What one item costs, as the four parts that render as one sentence (F-092).
 *
 * **All four or none** — `stand_items_price_complete` refuses anything between, because half a
 * price renders as garbage on a public card. `null` on `StandingItem.price` is "not stated";
 * an `amount` of `0` is FREE, which is a fact rather than its absence.
 *
 * `amount` and `quantity` are strings, matching what the driver hands back for `numeric` and
 * keeping money out of binary floating point end to end. `renderStandItemPrice` in
 * `@farm-friend/core` is the only thing that turns these into words.
 */
export interface StandingItemPrice {
  amount: string;
  quantity: string;
  /** Optional, and only for a bundle — see `standItemPriceNeedsUnit` (B-041). */
  unit: string | null;
  basis: "per" | "for";
}

/**
 * One thing a stand usually sells, and optionally what it costs (F-090, F-092).
 *
 * **A pair rather than two parallel arrays**, so a price cannot drift onto the wrong item — the
 * failure a `prices: string[]` beside `items: string[]` invites the first time one list is
 * filtered and the other is not.
 */
export interface StandingItem {
  name: string;
  price: StandingItemPrice | null;
}

/** What the farmer stated about their listing. */
export interface OnboardingListingInput {
  /** Whether there is a place to go. Decides whether an address and pin are required. */
  visitability: "visitable" | "contact_only";
  offeringType: "produce" | "services" | "by_order";
  publicAddress: string | null;
  /**
   * F-088 — whether the address TEXT may be shown to customers. The pin is unaffected.
   *
   * Written on every save alongside the address, for the same B-037 reason the availability
   * columns are: this writer replaces the whole listing, so a field it did not set would be
   * reset to the column default on every edit — silently republishing an address a farmer had
   * deliberately hidden.
   */
  addressPublic: boolean;
  /**
   * F-092 — whether this stand shows PRICES at all. The prices themselves are unaffected.
   *
   * Written on every save for the same B-037 reason as `addressPublic` above: a field this
   * writer did not set would reset to the column default on every edit, so a farmer who turned
   * prices on would find them off again after changing their hours.
   *
   * max's call (2026-08-08): hidden means hidden. The four price columns keep their values when
   * this is false — so switching it back on restores what the farmer typed — but no customer
   * surface may render a price while it is false.
   */
  pricesPublic: boolean;
  /** From the farmer's pin drop on the drawn island — there is no geocoder (a non-goal). */
  latitude: number | null;
  longitude: number | null;
  /** The farmer's own words about when they are open, preserved verbatim (display only). */
  hoursText: string | null;
  /**
   * F-069 — the FILTERABLE season / hours / stocking facts, beside `hoursText` rather than
   * instead of it. Optional: a form that states none of it writes the same NULLs as before.
   */
  availability?: ListingAvailability;
  paymentMethods: string[];
  /**
   * Whether the SELLER takes VIGA Farm Bucks (F-125) — her claim, applying everywhere she
   * sells. There is no eligibility grant to gate it: max settled on 2026-08-20 that a farm
   * either takes them or does not.
   *
   * Optional, and absent means "this door says nothing", leaving her stored answer alone. It
   * must never read as a refusal — the same rule the column's `true` default encodes.
   */
  farmBucksAccepted?: boolean;
  /** What they usually sell, in their own words and their own order. */
  items: StandingItem[];
  /**
   * The farm's own prose, as it renders on the public card under "Additional information".
   *
   * **`undefined` and `""` mean different things, and the difference is load-bearing.**
   * `undefined` is "this door has nothing to say about the prose" and leaves the stored
   * paragraph untouched; `""` is "the farmer cleared the box" and erases it. Collapsing the two
   * reintroduces B-037 one column over — a door that saves hours would silently delete a farm's
   * land acknowledgement as a side effect.
   *
   * It lives on `sellers` rather than `sales_locations` because it describes the FARM, which may
   * have more than one stand. Same record `renameFarm` writes, for the same reason.
   */
  description?: string | null;
}

/**
 * What every listing door supplies to publish a listing.
 *
 * **Stated once, on purpose.** Each of the three doors (invited, grandfathered, edit) injects
 * this writer and previously restated its input shape inline, so the same four fields existed
 * in four places and drifted independently — adding `authorizationId` to the writer left all
 * three boundaries silently describing a writer that no longer existed. One statement means a
 * new field reaches every door or none.
 */
export interface SaveOnboardingListingInput {
  farmId: string;
  /** What the stand is called on the map. Defaults to the farm's name at the boundary. */
  standName: string;
  listing: OnboardingListingInput;
  /**
   * The publishing farmer's live authorization, when the door knows one (F-081). It becomes
   * the designated recipient of the default weekly reminder. Absent from a door that has no
   * farmer yet — the grandfathered claim, and the invited form, which publishes before the
   * farmer texts JOIN — and those seed no schedule rather than inventing a recipient.
   */
  authorizationId?: string | null;
  /**
   * A stand she also sells at, chosen from the picker (F-117).
   *
   * Written in THIS transaction, beside her own stand's provider row. It needs no authorization
   * — `stand_providers` names a SELLER, and the seller exists the moment the invitation names
   * her farm — which is why it does not wait on the invitation the way `pendingStock` and
   * `pendingPromptCadence` do. Those two wait because a dated confirmation needs somebody to
   * stand behind it and a reminder needs a recipient; an arrangement needs neither.
   *
   * **Secondary to the listing.** A stand that vanished between loading the form and submitting
   * it must not cost the farmer her whole onboarding — see the write below.
   */
  hostStandId?: string | null;
  occurredAt: Date;
}

export type SaveOnboardingListingResult =
  | { status: "saved"; salesLocationId: string }
  | { status: "unknown_farm" }
  | { status: "invalid_name" }
  /** The visitability branch is contradicted: see `coherentVisitability`. */
  | { status: "incomplete_location" }
  | { status: "off_island" }
  /** The stated season / hours / stocking contradict themselves: see `coherentAvailability`. */
  | { status: "incoherent_availability" };

export type RenameFarmResult =
  | { status: "saved" }
  | { status: "unknown_farm" }
  | { status: "invalid_name" };

/**
 * Rename a farm.
 *
 * **The farm's name was previously immutable.** It was written when the invitation was
 * created and no path — farmer or administrator — could change it afterwards, yet it is
 * shown to customers on the map beside the stand. A name mistyped at invitation time was
 * therefore permanent and public. The farmer owns their published state, so the farmer is
 * who corrects it.
 *
 * Deliberately NOT part of `saveOnboardingListing`: the stand name and the farm name are
 * different facts about different records, and folding them into one writer is what made
 * them easy to confuse in the first place. The caller supplies a `farmId` it already
 * resolved from a credential — this function performs no authorization of its own, exactly
 * like its neighbours here.
 *
 * The `returning` clause is what distinguishes "renamed" from "matched no row": an update
 * against a missing id affects nothing and would otherwise report success.
 */
export async function renameFarm(
  db: Db,
  input: { farmId: string; name: string },
): Promise<RenameFarmResult> {
  const name = input.name.trim();
  if (name === "") return { status: "invalid_name" };

  const rows = await driver(db)`
    update sellers set name = ${name} where id = ${input.farmId} returning id
  `;
  return rows.length === 0 ? { status: "unknown_farm" } : { status: "saved" };
}

/**
 * Write the listing an onboarding farmer typed, as their farm's stand.
 *
 * Publishes on submit (max, 2026-08-05): the listing is live when the form is sent rather than
 * waiting for the SIGNUP text, and "the admin can fix anything erroneous".
 *
 * **The farm's EXISTING stand is updated rather than joined by a second one.** A farmer invited
 * against a farm VIGA already seeded has a stand already, so a fresh insert would show that
 * farm twice on the map — once with the old CSV data and once with the farmer's own. The same
 * property makes a resubmitted form idempotent.
 */
export async function saveOnboardingListing(
  db: Db,
  input: SaveOnboardingListingInput,
): Promise<SaveOnboardingListingResult> {
  const listing = input.listing;
  const standName = input.standName.trim();
  const address = listing.publicAddress?.trim() ?? null;
  const hoursText = listing.hoursText?.trim() ?? null;

  // Trimmed before every test below, so padding decides nothing — `"  "` is blank, and a
  // padded real name is stored clean rather than reaching the public map with its whitespace.
  if (standName === "") return { status: "invalid_name" };

  const hasAddress = address !== null && address !== "";
  const hasLatitude = listing.latitude !== null;
  const hasLongitude = listing.longitude !== null;
  const hasCompleteLocation = hasAddress && hasLatitude && hasLongitude;
  const hasNoLocation = !hasAddress && !hasLatitude && !hasLongitude;

  // Mirror `coherentVisitability` at the writer boundary so a farmer gets a useful refusal
  // rather than a constraint violation. Any farm may be fully placed (F-088); only a
  // contact-only farm may remain entirely unplaced. Every half-filled shape is refused.
  if (
    !hasCompleteLocation &&
    !(listing.visitability === "contact_only" && hasNoLocation)
  ) {
    return { status: "incomplete_location" };
  }

  // A pin outside the drawn island cannot be rendered on it. `ISLAND_BOUNDS` is the authority
  // rather than a second envelope of this module's own: the file that owns the projection
  // warns that two independent statements about where the island is will drift, and a farm on
  // the wrong side of that drift is a pin in Puget Sound.
  if (hasCompleteLocation) {
    const latitude = listing.latitude!;
    const longitude = listing.longitude!;
    if (
      latitude < ISLAND_BOUNDS.south ||
      latitude > ISLAND_BOUNDS.north ||
      longitude < ISLAND_BOUNDS.west ||
      longitude > ISLAND_BOUNDS.east
    ) {
      return { status: "off_island" };
    }
  }

  // F-069. Refused BEFORE the transaction opens, and named as its own status: the five F-035
  // CHECK constraints would refuse the write anyway, but as a violation the farmer cannot act
  // on. `coherentAvailability` is the same rule stated where an error message can reach them.
  const availability = listing.availability ?? NO_AVAILABILITY_STATED;
  if (!coherentAvailability(availability)) {
    return { status: "incoherent_availability" };
  }

  return driver(db).begin(async (tx) => {
    // Locked, so two submissions from one farmer — a double-tapped button, a reload — cannot
    // both observe "no stand" and insert one each.
    const sellers = await tx`
      select id from sellers where id = ${input.farmId} for update
    `;
    if (sellers.length === 0) return { status: "unknown_farm" as const };

    const existing = await tx`
      select id from sales_locations
      where own_seller_id = ${input.farmId}
      order by created_at asc
      limit 1
    `;
    const existingId = existing[0]?.id as string | undefined;

    // Acceptance is the farmer's own operational fact and publishes on their word (max,
    // 2026-08-10), and F-125 made it a fact about HER rather than about this stand. Nothing
    // gates it: the eligibility grant that once did is deleted, not moved.

    const salesLocationId =
      existingId === undefined
        ? await insertStand(tx, { ...input, standName, address, hoursText, availability })
        : await updateStand(tx, {
            salesLocationId: existingId,
            ...input,
            standName,
            address,
            hoursText,
            availability,
          });

    // The farm's prose, when this door states one. Omitted → the stored paragraph survives.
    if (listing.description !== undefined) {
      const description = listing.description?.trim() ?? "";
      await tx`
        update sellers set description = ${description === "" ? null : description}
        where id = ${input.farmId}
      `;
    }

    // F-125 — keyed by the FARM, not the stand. A seller states this once and it applies
    // everywhere she sells; onboarding her second stand must not ask again or overwrite it
    // with a fresh answer for one location.
    if (listing.paymentMethods !== undefined) {
      await writePaymentMethods(tx, input.farmId, listing.paymentMethods);
    }

    // Farm Bucks travels with the rest of her payment answer, on the same row and the same
    // condition: stated → saved, omitted → whatever she already said stands. An absent field
    // must not be read as a refusal, which is the same rule the column's `true` default
    // encodes for a seller who has never been asked.
    if (listing.farmBucksAccepted !== undefined) {
      await tx`
        update sellers
        set farm_bucks_accepted = ${listing.farmBucksAccepted === true},
            updated_at = ${input.occurredAt.toISOString()}
        where id = ${input.farmId}
      `;
    }
    await writeStandingItems(tx, salesLocationId, listing.items);

    /*
      F-117 — the stand she also sells at, if she named one.

      **Deliberately not fatal.** The arrangement is a secondary fact about a listing that is
      otherwise complete, and the realistic failure is a stand retired between the form loading
      and her pressing Submit. Losing an entire onboarding form over the optional half of one
      question is a far worse outcome than a missing arrangement she can add later from her own
      settings screen — so a stand that no longer qualifies is skipped, not raised.

      `on conflict do nothing` for the same reason it guards her native row above: a resubmitted
      form must not fail, and the partial unique index is the arbiter.
    */
    if (input.hostStandId != null && input.hostStandId !== salesLocationId) {
      const hosted = await tx`
        insert into stand_providers (
          sales_location_id, seller_id, lifecycle_state,
          invited_at, accepted_at, approval_source, approved_at
        )
        select ${input.hostStandId}, ${input.farmId}, 'active',
               ${input.occurredAt.toISOString()}, ${input.occurredAt.toISOString()},
               'seller', ${input.occurredAt.toISOString()}
        where exists (
          select 1 from sales_locations
          where id = ${input.hostStandId}
            and own_seller_id is distinct from ${input.farmId}
        )
        on conflict (sales_location_id, seller_id) where ended_at is null do nothing
        returning id
      `;
      const hostedProviderId = hosted[0]?.id as string | undefined;
      if (hostedProviderId !== undefined) {
        await askHostToConfirm(tx, {
          standProviderId: hostedProviderId,
          salesLocationId: input.hostStandId,
          sellerId: input.farmId,
          occurredAt: input.occurredAt,
        });
      }
    }
    await seedDefaultPromptPreference(tx, {
      salesLocationId,
      farmId: input.farmId,
      authorizationId: input.authorizationId ?? null,
      occurredAt: input.occurredAt,
    });

    return { status: "saved" as const, salesLocationId };
  }) as Promise<SaveOnboardingListingResult>;
}

/**
 * Ask the stand's owner to confirm a seller who put herself there (F-117).
 *
 * ## Why it can only ask a host Farm Friend already knows
 *
 * **Farm Friend cannot text first.** A number with no consent row has every non-reply send
 * suppressed by `authorizeDispatch`, so there is no way to reach a stand whose owner has never
 * onboarded — a VIGA-seeded stand nobody has claimed. Those stands still accept the seller: the
 * alternative is refusing a real arrangement over a message we could not have sent, and the
 * public map would simply be wrong instead. The host keeps every other way to act, including
 * Remove on their own settings screen once they do onboard.
 *
 * ## What is asked, and how
 *
 * `stock_out_alert` is the category, not `inquiry_reply`: this is an unsolicited notice to a
 * farmer about their own stand, exactly like a customer's stock-out flag, and it must therefore
 * require ACTIVE consent rather than riding the carrier's reply allowance. A host who has
 * stopped hears nothing, which is correct — they have said not to text them.
 *
 * The body is CODE-RENDERED from a seller name (Golden Rule #6): a cross-actor message may
 * never carry model prose. `validatePublicStrings` has already refused a name carrying contact
 * details before it could reach a stand_providers row.
 */
async function askHostToConfirm(
  tx: Tx,
  input: {
    standProviderId: string;
    salesLocationId: string;
    sellerId: string;
    occurredAt: Date;
  },
): Promise<void> {
  /*
    The host's own phone, through the stand's own seller — the same arm
    `resolveStandWriteAuthority` calls the seller arm, and the stand arm beside it for a venue
    whose manager is authorized against the place rather than a seller of its own.

    `limit 1` with a stable order: a stand with two authorized handsets gets ONE question, not
    two, because `pending_host_confirmations` holds one open question per host and two rows
    would mean the second silently replaced the first.
  */
  const hosts = await tx`
    select contacts.phone_hash as host_hash
    from sales_locations as location
    join farmer_authorizations as auth
      on (
        (auth.seller_id is not null and auth.seller_id = location.own_seller_id)
        or (auth.sales_location_id is not null and auth.sales_location_id = location.id)
      )
    join contacts on contacts.id = auth.contact_id
    where location.id = ${input.salesLocationId}
      and auth.revoked_at is null
      and auth.phone_verified_at is not null
    order by auth.authorized_at asc, auth.id asc
    limit 1
  `;
  const hostHash = hosts[0]?.host_hash as string | undefined;
  // Nobody to ask. She stays listed — see the header.
  if (hostHash === undefined) return;

  const sellers = await tx`select name from sellers where id = ${input.sellerId}`;
  const sellerName = sellers[0]?.name as string | undefined;
  if (sellerName === undefined) return;

  await tx`
    insert into outbox_work (
      logical_key, recipient_hash, message_category, body, body_expires_at,
      available_at, created_at
    ) values (
      ${`host-confirm-${input.standProviderId}`}, ${hostHash}, 'stock_out_alert',
      ${renderHostConfirmationRequest(sellerName)},
      ${new Date(input.occurredAt.getTime() + HOST_CONFIRMATION_BODY_TTL_MS).toISOString()},
      ${input.occurredAt.toISOString()}, ${input.occurredAt.toISOString()}
    )
    on conflict (logical_key) do nothing
  `;

  /*
    The question, opened with the same `asked_at` the message carries.

    ONE open question per host: a second self-selecting seller replaces the first rather than
    leaving two rows for a bare YES to choose between. The unique index is the arbiter.
  */
  await tx`
    insert into pending_host_confirmations (host_hash, stand_provider_id, asked_at)
    values (${hostHash}, ${input.standProviderId}, ${input.occurredAt.toISOString()})
    on conflict (host_hash) do update
      set stand_provider_id = excluded.stand_provider_id,
          asked_at = excluded.asked_at
  `;
}

/** How long the host's question keeps its body before the retention purge takes it. */
const HOST_CONFIRMATION_BODY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The cadence an approved farmer starts on (F-081, max's choice 2026-08-07). */
const DEFAULT_PROMPT_CADENCE = "weekly" as const;

/**
 * Put a newly publishing farmer on the default reminder schedule (F-081).
 *
 * F-052 built the scheduled-prompt machinery and it was correct and reached NOBODY:
 * `inventory_prompt_preferences` had one writer, `setInventoryPromptPreference`, behind the
 * farmer settings surfaces. A farmer who never went looking for a setting they had no reason
 * to know existed was never prompted — the stale-map failure this product exists to solve,
 * reintroduced one layer down.
 *
 * **This is the seed's home because the schema put it here.** A preference carries composite
 * foreign keys to BOTH `sales_locations` and `farmer_authorizations`, so the row is
 * structurally impossible before a stand exists — and `authorizeFarmer` and the invited
 * redemption both run before any stand does. Every listing door already converges on
 * `saveOnboardingListing`, so one write site covers the invited, grandfathered, edit and
 * F-079 migration paths, and a fifth door inherits the default rather than remembering it.
 *
 * **A farmer's own choice is never overwritten.** `on conflict do nothing` against
 * `inventory_prompt_preferences_location_unique` makes this a FIRST-WRITE ONLY: a farmer who
 * paused their reminders and later edits their hours stays paused. The index is the arbiter
 * rather than a preceding read, for the reason F-067 and B-011 both needed — `select … for
 * update` cannot serialize a row that does not exist yet.
 *
 * **No authorization means no row, never a guessed one.** The grandfathered door publishes for
 * a farm with no farmer yet; a preference needs a designated recipient, and inventing one
 * would schedule texts to somebody who was never set up. Publishing still succeeds — the
 * listing is the point, and the farmer gets their schedule when they are authorized and
 * publish.
 *
 * `next_due_at` comes from `nextPromptDueSlot`, never a hand-computed date: it owns the
 * 10:00-local rule across daylight-saving, and the schema's `due_state_coherent` CHECK pairs
 * a non-paused cadence with a non-null slot.
 */
export async function seedDefaultPromptPreference(
  tx: Tx,
  input: {
    /** The stand to schedule. `null` asks this function to find the farm's own. */
    salesLocationId: string | null;
    farmId: string;
    authorizationId: string | null;
    occurredAt: Date;
    /**
     * F-097 — the cadence the farmer CHOSE on the onboarding form, when they stated one.
     *
     * Omitted or `null` means they were never asked, and the default applies exactly as it
     * did before the form offered the choice. The two are deliberately distinguishable: a
     * farmer who picked `weekly` and a farmer who was never asked look identical in the
     * preferences table, and only the second may be silently moved if the default changes.
     */
    cadence?: PromptCadence | null;
  },
): Promise<void> {
  if (input.authorizationId === null) return;

  // The authorization must be a LIVE farmer OF THIS FARM. The composite foreign key would
  // refuse a mismatch anyway; checking here means a caller passing a stale or foreign id gets
  // a listing saved without a schedule, rather than a constraint violation that loses the
  // whole publication.
  const authorizations = await tx`
    select id from farmer_authorizations
    where id = ${input.authorizationId} and seller_id = ${input.farmId}
      and revoked_at is null
  `;
  if (authorizations.length === 0) return;

  // The authorization doors call this without a stand in hand: a farmer publishes their listing
  // from the web form and is authorized LATER, by texting a bare `START` from the phone they
  // stated there (`JOIN <token>` was removed 2026-08-07). So the stand is resolved from the farm
  // when the caller has no id — and a farm with no stand yet simply gets no schedule, rather
  // than this inventing one.
  const locations =
    input.salesLocationId === null
      ? await tx`
          select id, timezone from sales_locations
          where own_seller_id = ${input.farmId} and retired_at is null
          order by created_at asc
          limit 1
        `
      : await tx`
          select id, timezone from sales_locations where id = ${input.salesLocationId}
        `;
  const salesLocationId = locations[0]?.id as string | undefined;
  const timeZone = locations[0]?.timezone as string | undefined;
  if (salesLocationId === undefined || timeZone === undefined) return;

  const cadence = input.cadence ?? DEFAULT_PROMPT_CADENCE;

  // `paused` carries NO due slot, and the schema's `due_state_coherent` CHECK enforces that
  // pair in both directions. `nextPromptDueSlot` already answers null for it, which is why
  // this is one call rather than a branch — the rule lives in the function that owns the
  // 10:00-local arithmetic, not restated here.
  const nextDueAt = nextPromptDueSlot({ cadence, timeZone, laterOf: input.occurredAt });

  // F-114 Phase B — a cadence belongs to a provider. Onboarding sets up the farmer's own
  // stand, so the native slot; the conflict target moves to the provider with it.
  const preferenceProviderId = await readNativeProviderId(tx, { salesLocationId });
  await tx`
    insert into inventory_prompt_preferences (
      owner_seller_id, sales_location_id, provider_id, designated_authorization_id,
      cadence, version, next_due_at, updated_at
    ) values (
      ${input.farmId}, ${salesLocationId}, ${preferenceProviderId}, ${input.authorizationId},
      ${cadence}, 1, ${nextDueAt}, ${input.occurredAt}
    )
    on conflict (provider_id) do nothing
  `;
}

/**
 * The three columns the schema refuses to default are all supplied deliberately.
 *
 * `timezone` has no default because "every new location must deliberately choose a reviewed
 * zone", and `America/Los_Angeles` is the only reviewed one — Farm Friend is one island.
 * `kind` is `farm_stand`: the other value is `farmers_market`, which is not a thing a farmer
 * creates for themselves during onboarding.
 */
async function insertStand(
  tx: Tx,
  input: {
    farmId: string;
    standName: string;
    address: string | null;
    hoursText: string | null;
    availability: ListingAvailability;
    listing: OnboardingListingInput;
    occurredAt: Date;
  },
): Promise<string> {
  const available = input.availability;
  const rows = await tx`
    insert into sales_locations (
      own_seller_id, kind, name, timezone, visitability, offering_type,
      public_address, address_public, prices_public,
      public_latitude, public_longitude, hours_text,
      season_kind, season_start_month, season_start_day,
      season_end_month, season_end_day, season_names,
      open_hours_kind, open_from_minutes, open_until_minutes, open_days,
      stocking_cadence, stocking_days,
      is_public,
      created_at, updated_at
    ) values (
      ${input.farmId}, 'farm_stand', ${input.standName}, 'America/Los_Angeles',
      ${input.listing.visitability}, ${input.listing.offeringType},
      ${input.address}, ${input.listing.addressPublic}, ${input.listing.pricesPublic},
      ${input.listing.latitude}, ${input.listing.longitude},
      ${input.hoursText},
      ${available.seasonKind}, ${available.seasonStartMonth}, ${available.seasonStartDay},
      ${available.seasonEndMonth}, ${available.seasonEndDay},
      ${available.seasonNames as string[] | null},
      ${available.openHoursKind}, ${available.openFromMinutes},
      ${available.openUntilMinutes}, ${available.openDays as number[] | null},
      ${available.stockingCadence}, ${available.stockingDays as number[] | null},
      -- F-125 — VIGA Bucks is no longer a stand fact at all. It is one boolean on the SELLER,
      -- written below with the rest of her payment answer, and there is no eligibility grant
      -- left to withhold here.
      true,
      ${input.occurredAt.toISOString()}, ${input.occurredAt.toISOString()}
    )
    returning id
  `;
  const locationId = rows[0]!.id as string;

  // The stand's own seller becomes an ordinary provider at it (F-114 Phase C.0). Phase B created
  // this with a trigger; C.0 removed the trigger because a stand may legitimately have no seller
  // of its own, and a trigger would have to invent one. This is the second of the two writers
  // that create a stand, and both create the provider explicitly.
  //
  // The timestamps are the onboarding moment and the source is `viga`: a farmer creating their
  // own stand was not invited to it by anybody, and the lifecycle CHECK requires an invitation
  // and an approval on every row.
  await tx`
    insert into stand_providers (
      sales_location_id, seller_id, lifecycle_state,
      invited_at, accepted_at, approval_source, approved_at
    ) values (
      ${locationId}, ${input.farmId}, 'active',
      ${input.occurredAt.toISOString()}, ${input.occurredAt.toISOString()},
      'viga', ${input.occurredAt.toISOString()}
    )
    on conflict do nothing
  `;

  return locationId;
}

/**
 * Update the farm's existing stand in place.
 *
 * Farm Bucks acceptance is a farmer-stated fact; eligibility remains VIGA-controlled and is
 * checked before this writer reaches the update.
 */
async function updateStand(
  tx: Tx,
  input: {
    salesLocationId: string;
    standName: string;
    address: string | null;
    hoursText: string | null;
    availability: ListingAvailability;
    listing: OnboardingListingInput;
    occurredAt: Date;
  },
): Promise<string> {
  // The availability columns are written as ONE STATEMENT, every column named — including the
  // NULLs. A farmer who moves from "March-November" to "year-round" must clear the old dates,
  // and a partial update that set `season_kind` while leaving them would violate
  // `coherentSeason` in the database. Twelve columns, always all twelve.
  const available = input.availability;
  await tx`
    update sales_locations
    set name = ${input.standName},
        visitability = ${input.listing.visitability},
        offering_type = ${input.listing.offeringType},
        public_address = ${input.address},
        address_public = ${input.listing.addressPublic},
        prices_public = ${input.listing.pricesPublic},
        public_latitude = ${input.listing.latitude},
        public_longitude = ${input.listing.longitude},
        hours_text = ${input.hoursText},
        season_kind = ${available.seasonKind},
        season_start_month = ${available.seasonStartMonth},
        season_start_day = ${available.seasonStartDay},
        season_end_month = ${available.seasonEndMonth},
        season_end_day = ${available.seasonEndDay},
        season_names = ${available.seasonNames as string[] | null},
        open_hours_kind = ${available.openHoursKind},
        open_from_minutes = ${available.openFromMinutes},
        open_until_minutes = ${available.openUntilMinutes},
        open_days = ${available.openDays as number[] | null},
        stocking_cadence = ${available.stockingCadence},
        stocking_days = ${available.stockingDays as number[] | null},
        is_public = true,
        updated_at = ${input.occurredAt.toISOString()}
    where id = ${input.salesLocationId}
  `;
  return input.salesLocationId;
}

/**
 * Replace the SELLER's payment methods with what the farmer stated (F-125).
 *
 * A full replace rather than an upsert, because removing a method is a thing the farmer must
 * be able to do: an upsert-only write would make "we stopped taking checks" unsayable.
 *
 * F-069 — canonicalized on the way in (`canonicalPaymentMethods`), so "venmo" and "VENMO" are
 * one filterable value rather than two the map cannot join. Unrecognized methods are kept as
 * the farmer's own words; the fold applies only to the known closed set.
 */
async function writePaymentMethods(
  tx: Tx,
  sellerId: string,
  methods: string[],
): Promise<void> {
  // Blanks are dropped rather than refused: a stray comma is a farmer typing, and the not-blank
  // CHECK would otherwise turn one stray space into a failed submission with nothing useful to
  // say about which field caused it.
  const stated = canonicalPaymentMethods(methods);

  // F-125 — the SELLER's row set. Delete-then-insert still scopes to one seller, so a farmer
  // restating her methods replaces her own answer and touches nobody else's.
  await tx`
    delete from seller_payment_methods
    where seller_id = ${sellerId}
  `;
  for (const method of stated) {
    await tx`
      insert into seller_payment_methods (seller_id, method)
      values (${sellerId}, ${method})
      on conflict do nothing
    `;
  }
}

/**
 * Write what the stand usually sells as F-066's STANDING state.
 *
 * **The item outlives its states.** An item the farmer removed from the mix has
 * `usually_carried` cleared but keeps its row, so a past dated confirmation of it still
 * resolves to the same vocabulary entry — that is F-066's whole shape, and deleting the row
 * instead would orphan published history the entries table refuses to let anyone rewrite.
 *
 * **Normalization is case and surrounding whitespace ONLY.** "tomato", "tomatoes" and "love
 * apple" stay three items. Folding them is a produce taxonomy, which no business code may
 * hard-code — a test asserts this and must be deleted before anyone can loosen it.
 */
/**
 * A price the database will accept, or NULL (F-092).
 *
 * **Incomplete means UNSTATED, never a refusal.** A farmer who cleared the amount, or picked a
 * unit and typed no number, has said "no price" — and asking the database to refuse their whole
 * listing over it would be this writer inviting a rejection it can resolve itself. The CHECK
 * exists to catch a WRITER's bug, not to police a half-filled form.
 *
 * Everything the CHECK would reject is turned into NULL here: a missing part, a blank unit, an
 * unparseable or negative amount, a quantity of zero. `Number("")` is `0`, so the amount is
 * tested for finiteness rather than truthiness — a blank box must not become "free".
 */
function normalizePrice(
  price: StandingItemPrice | null | undefined,
): StandingItemPrice | null {
  if (price === null || price === undefined) return null;

  const unit = typeof price.unit === "string" ? trimItem(price.unit) : "";
  if (price.basis !== "per" && price.basis !== "for") return null;
  // B-041 — a bundle carries its own count, so "$5 for 3" is complete with no unit; a unit price
  // is not. `standItemPriceNeedsUnit` is that asymmetry for the whole system, imported rather
  // than restated, and the CHECK says the same thing one layer further out.
  if (unit === "" && standItemPriceNeedsUnit(price.basis)) return null;

  const amount = Number(
    typeof price.amount === "string" ? price.amount.trim() : NaN,
  );
  const quantity = Number(
    typeof price.quantity === "string" ? price.quantity.trim() : NaN,
  );
  if (!Number.isFinite(amount) || !Number.isFinite(quantity)) return null;
  if (String(price.amount).trim() === "" || String(price.quantity).trim() === "") {
    return null;
  }
  if (amount < 0 || quantity <= 0) return null;

  // Stored to the scale the column carries, so what comes back out reads the way it went in.
  return {
    amount: amount.toFixed(2),
    quantity: quantity.toFixed(2),
    // `null`, never "": the column refuses a blank unit, and the two would render identically
    // while only one of them is a fact the farmer stated.
    unit: unit === "" ? null : unit,
    basis: price.basis,
  };
}

async function writeStandingItems(
  tx: Tx,
  salesLocationId: string,
  items: StandingItem[],
): Promise<void> {
  const stated: StandingItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const trimmed = trimItem(item.name);
    if (trimmed === "") continue;
    const key = standItemKey(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    stated.push({ name: trimmed, price: normalizePrice(item.price) });
  }

  // F-114 Phase B — usual items belong to a provider. This is the farmer editing their own
  // stand's listing, so the native slot. Scoping the clear to the PROVIDER rather than the
  // stand is load-bearing: clearing by stand would silently drop a hosted seller's standing
  // claims every time the host saved their own listing.
  const itemProviderId = await readNativeProviderId(tx, { salesLocationId });
  await tx`
    update stand_items set usually_carried = false
    where sales_location_id = ${salesLocationId} and provider_id = ${itemProviderId}
  `;

  for (const [index, item] of stated.entries()) {
    // THE INDEX IS THE ARBITER, never a preceding read: `stand_items_one_per_provider_name` is
    // what makes "eggs exists once here" structural, and `select … for update` cannot
    // serialize a row that does not exist yet. `do update` rather than `do nothing` is
    // load-bearing — an item that exists only because a revision confirmed it must BECOME a
    // standing claim when the farmer lists it, and a sabotage proved `do nothing` drops that
    // silently with no error anywhere.
    //
    // The display name is NOT overwritten on conflict: the farmer's first spelling is the
    // item's words, and F-066 has no rename operation by design.
    //
    // **THE PRICE IS OVERWRITTEN, INCLUDING BACK TO NULL** (F-090, F-092). This writer replaces
    // the whole listing, so a price column left out of the `do update` would survive every save
    // that dropped it — a farmer who removed their price would keep publishing it with nothing
    // on screen saying so. That is B-037's shape, and the integration suite asserts the clear.
    //
    // ALL FOUR COLUMNS MOVE TOGETHER, which is the same rule one table further out: writing
    // three of them and forgetting the fourth is exactly what `stand_items_price_complete`
    // refuses, so a partial `do update` here fails loudly rather than storing half a price.
    const price = item.price;
    await tx`
      insert into stand_items (
        sales_location_id, provider_id, display_name, usually_carried,
        price_amount, price_quantity, price_unit, price_basis, sort_order
      )
      values (
        ${salesLocationId}, ${itemProviderId}, ${item.name}, true,
        ${price?.amount ?? null}, ${price?.quantity ?? null},
        ${price?.unit ?? null}, ${price?.basis ?? null}, ${index}
      )
      on conflict (provider_id, lower(btrim(display_name, E' \t\r\n')))
      do update set
        usually_carried = true,
        price_amount = ${price?.amount ?? null},
        price_quantity = ${price?.quantity ?? null},
        price_unit = ${price?.unit ?? null},
        price_basis = ${price?.basis ?? null},
        sort_order = ${index}
    `;
  }
}

/**
 * A stand's current listing, in the exact shape the form writes back (F-073).
 *
 * **This exists so an edit form can prefill.** `saveOnboardingListing` writes the WHOLE listing
 * every time — that is what makes it idempotent and what lets a farmer drop a payment method or
 * an item by leaving it out. The same property makes a blank edit form destructive: a farmer who
 * opened it to change their hours would erase their address, payments, and items by omission.
 * So the read and the write are deliberately the same shape, and a round trip changes nothing.
 *
 * Returns `null` for a stand that does not exist.
 */
export interface StandListing {
  standName: string;
  /**
   * The FARM's name, which is a different record from the stand's and is shown to customers
   * beside it. Both are returned because the editor prefills each from its own source —
   * passing the stand's name into a farm-name field is exactly the conflation that left the
   * farm name looking editable when nothing could change it.
   */
  farmName: string;
  visitability: "visitable" | "contact_only";
  offeringType: "produce" | "services" | "by_order";
  publicAddress: string | null;
  /**
   * F-088 — B-037's rule applied to the newest field. The edit form prefills from this reader
   * and the writer replaces every column, so a flag the reader could not see would be reset to
   * `true` by the next save — republishing an address the farmer had hidden, with nothing shown
   * and nothing failing.
   */
  addressPublic: boolean;
  /**
   * F-092 — whether this stand shows prices, read for the same B-037 reason as `addressPublic`
   * above: the writer sets this column on every save, so a flag the reader could not see would
   * be reset to the column default by the next otherwise-untouched edit — silently switching a
   * farmer's prices back off.
   */
  pricesPublic: boolean;
  /**
   * Whether this stand's SELLER takes VIGA Farm Bucks (F-125). Hers, not the stand's, and
   * there is no eligibility grant gating it any more.
   */
  farmBucksAccepted: boolean;
  latitude: number | null;
  longitude: number | null;
  hoursText: string | null;
  availability: ListingAvailability;
  /**
   * What the SELLER states she takes (F-125) — her whole answer, not narrowed to this stand.
   *
   * The edit form prefills from this and the writer replaces her seller-wide rows from it, so
   * it has to be her unnarrowed statement or the round trip loses methods at her other stands.
   * `paymentMethodsExcludedHere` carries the narrowing separately.
   */
  paymentMethods: string[];
  /**
   * What this stand cannot support for her (F-125) — read-only on every farmer-facing door.
   *
   * The host owns it, so no farmer form writes it back. Surfaces show the concept ONLY when
   * this is non-empty: a farmer with no override should never be shown the idea at all.
   */
  paymentMethodsExcludedHere: string[];
  /**
   * What the stand usually sells, each with its optional price (F-090).
   *
   * B-037's rule for the newest column: the writer replaces every item row on every save, so a
   * price this reader could not see would be deleted by the next otherwise-untouched edit.
   */
  items: StandingItem[];
  /**
   * The farm's own prose. Returned so the edit form can prefill it — a description the reader
   * could not see would be erased by the next save of an otherwise untouched form.
   */
  description: string | null;
}

/**
 * The listing VIGA already holds for a farm, for an onboarding form to prefill (F-090).
 *
 * **The same reader, reached by farm rather than by stand**, because that is the only handle
 * the invited and grandfathered doors have — neither knows a `salesLocationId`, and both are
 * about to write against whichever stand `saveOnboardingListing` picks.
 *
 * It resolves the stand exactly as that writer does — the farm's oldest live one — so the
 * form prefills from the row the save will replace. Choosing differently here would show the
 * farmer one stand and overwrite another.
 *
 * `null` for a farm with no stand yet, which is a genuinely new farm: the form starts blank,
 * and prefilling must never invent a value.
 */
export async function readFarmListingForOnboarding(
  db: Db,
  input: { farmId: string },
): Promise<StandListing | null> {
  /*
    THE SAME SELECTION `saveOnboardingListing` MAKES, character for character — including its
    lack of a `retired_at` filter.

    Adding one here looked obviously right and is a silent data-loss bug: for a farm whose
    oldest stand is retired, a filtered read would prefill from stand B while the save
    replaced stand A, wiping A's address, hours and items with B's values. The two queries
    have to agree about which stand this farm IS, and the writer is the one that decides.

    If that selection ever gains a filter, it gains it in both places or the pair is broken.
  */
  const locations = await driver(db)`
    select id from sales_locations
    where own_seller_id = ${input.farmId}
    order by created_at asc
    limit 1
  `;
  const salesLocationId = locations[0]?.id as string | undefined;
  if (salesLocationId === undefined) return null;
  return readStandListing(db, { salesLocationId });
}

export async function readStandListing(
  db: Db,
  input: { salesLocationId: string },
): Promise<StandListing | null> {
  const rows = await driver(db)`
    select
      location.name, location.visitability, location.offering_type,
      location.public_address, location.address_public, location.prices_public,
      -- F-125 — hers, read off the farm this stand belongs to.
      farm.farm_bucks_accepted,
      location.public_latitude, location.public_longitude,
      location.hours_text,
      location.season_kind, location.season_start_month, location.season_start_day,
      location.season_end_month, location.season_end_day, location.season_names,
      location.open_hours_kind, location.open_from_minutes, location.open_until_minutes,
      location.open_days, location.stocking_cadence, location.stocking_days,
      -- F-125 -- what she STATES, deliberately NOT narrowed by this stand's exclusions.
      --
      -- This reader prefills the farmer's own edit form, and the payment writer replaces her
      -- whole seller-wide row set from the same field. Returning the narrowed list here would
      -- make the round trip lossy: a farmer opening the form at a stand whose host cannot take
      -- cash would see cash already unticked, save something unrelated, and silently drop cash
      -- at every OTHER stand she sells at. The override is the host's fact, not hers, and it
      -- must never be laundered into her answer by a form save.
      --
      -- payment_methods_excluded_here below carries the override separately, for surfaces
      -- that need to show what actually applies at this stand.
      -- (No backticks in here: this is a JS template literal and one would end the string.)
      coalesce(
        (
          select array_agg(payment.method order by payment.method)
          from seller_payment_methods as payment
          where payment.seller_id = location.own_seller_id
        ),
        '{}'
      ) as payment_methods,
      -- F-090 — name AND price together, as objects rather than two arrays. Two separate
      -- aggregates would be two independently ordered lists that a reader has to zip by index,
      -- which is exactly how a price lands on the wrong item.
      --
      -- F-092 — the price is now its own nested object, or NULL. Built with a CASE on the
      -- amount rather than always emitting an object of four nulls: "not stated" has to arrive
      -- at the form as an absent price, not as a price whose every field happens to be empty.
      -- price_amount is the witness because stand_items_price_complete makes all four
      -- present or all four absent together. (No backticks in here: this is a JS template
      -- literal, and one would end the string mid-query.)
      coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'name', item.display_name,
              'price', case
                when item.price_amount is null then null
                else jsonb_build_object(
                  'amount', item.price_amount::text,
                  'quantity', item.price_quantity::text,
                  'unit', item.price_unit,
                  'basis', item.price_basis
                )
              end
            )
            order by item.sort_order, item.display_name
          )
          from stand_items as item
          where item.sales_location_id = location.id and item.usually_carried
        ),
        '[]'::jsonb
      ) as items
      , farm.name as farm_name, farm.description as farm_description
      -- F-125 — the host's narrowing, carried separately so no farmer save can write it back.
      , coalesce(
          (
            select array_agg(excluded.method order by excluded.method)
            from sales_location_payment_method_exclusions as excluded
            where excluded.sales_location_id = location.id
              and excluded.seller_id = location.own_seller_id
          ),
          '{}'
        ) as payment_methods_excluded_here
    from sales_locations as location
    join sellers as farm on farm.id = location.own_seller_id
    where location.id = ${input.salesLocationId}
  `;

  const row = rows[0];
  if (row === undefined) return null;
  return {
    standName: row.name as string,
    farmName: row.farm_name as string,
    visitability: row.visitability as "visitable" | "contact_only",
    offeringType: row.offering_type as "produce" | "services" | "by_order",
    publicAddress: (row.public_address as string | null) ?? null,
    addressPublic: row.address_public !== false,
    // `=== true` rather than `!== false`, mirroring the column's own opposite default: a stand
    // that predates this column shows no prices until its farmer says otherwise.
    pricesPublic: row.prices_public === true,
    farmBucksAccepted: row.farm_bucks_accepted === true,
    latitude: (row.public_latitude as number | null) ?? null,
    longitude: (row.public_longitude as number | null) ?? null,
    hoursText: (row.hours_text as string | null) ?? null,
    availability: {
      seasonKind: row.season_kind as ListingAvailability["seasonKind"],
      seasonStartMonth: (row.season_start_month as number | null) ?? null,
      seasonStartDay: (row.season_start_day as number | null) ?? null,
      seasonEndMonth: (row.season_end_month as number | null) ?? null,
      seasonEndDay: (row.season_end_day as number | null) ?? null,
      seasonNames: (row.season_names as string[] | null) ?? null,
      openHoursKind: row.open_hours_kind as ListingAvailability["openHoursKind"],
      openFromMinutes: (row.open_from_minutes as number | null) ?? null,
      openUntilMinutes: (row.open_until_minutes as number | null) ?? null,
      openDays: (row.open_days as number[] | null) ?? null,
      stockingCadence: row.stocking_cadence as ListingAvailability["stockingCadence"],
      stockingDays: (row.stocking_days as number[] | null) ?? null,
    },
    paymentMethods: row.payment_methods as string[],
    paymentMethodsExcludedHere: row.payment_methods_excluded_here as string[],
    items: row.items as StandingItem[],
    description: (row.farm_description as string | null) ?? null,
  };
}
