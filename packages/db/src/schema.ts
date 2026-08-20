import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  doublePrecision,
  foreignKey,
  type AnyPgColumn,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const publicMapProjection = pgEnum("public_map_projection", [
  "exact",
  "approximate",
  "hidden",
]);
export const salesLocationKind = pgEnum("sales_location_kind", [
  "farm_stand",
  "farmers_market",
]);

// F-038 — two independent properties of a sales location, not a third `kind` value.
//
// The 2026 form export holds two members that are not ordinary stands, and they differ from
// each other in a way one enum cannot carry:
//
//   Seedrain / Garden Cycles    a street address, but sells SERVICES — nothing to browse
//   Open Gate Lamb and Grazing  NO address at all ("On island delivery for orders over $50")
//
// A single `kind` value would need one entry per combination, which is the parallel-mechanism
// creep the zen-desk rule forbids. Two orthogonal properties describe both, and every existing
// stand keeps its meaning as `visitable` + `produce`.

/** Whether there is a place to go. Decides whether an address and coordinates are required. */
export const salesLocationVisitability = pgEnum(
  "sales_location_visitability",
  ["visitable", "contact_only"],
);

/**
 * What the farm provides.
 *
 * `by_order` is a real third case, not a synonym for `services`: Open Gate Lamb sells goods
 * with genuine seasonal availability ("butchering in July and November"), which a service
 * business does not have. Whether either participates in SMS inventory is still an open
 * product question — this column records the fact, it does not decide the behaviour.
 */
export const salesLocationOfferingType = pgEnum(
  "sales_location_offering_type",
  ["produce", "services", "by_order"],
);
export const inventoryApproximation = pgEnum("inventory_approximation", [
  "some",
  "limited",
  "plentiful",
]);
/**
 * F-092 — the word that joins a price's parts. `per` is a unit price ("$6 / dozen"); `for` is a
 * bundle ("3 lb for $5"). Two values, because these are one mechanism with a different joining
 * word rather than two kinds of price — see `standItems.priceAmount`.
 */
export const standItemPriceBasis = pgEnum("stand_item_price_basis", [
  "per",
  "for",
]);

/**
 * Which half of a stock-out report Farm Friend is still waiting on (B-065).
 *
 * Two values because there are exactly two questions the stock-out path asks. A third would
 * mean a third question, and would arrive with its own copy and resolution rule.
 */
export const pendingStockOutAwaiting = pgEnum("pending_stock_out_awaiting", [
  "stand",
  "item",
]);

export const closureResult = pgEnum("closure_result", ["close", "reopen"]);
export const closureKind = pgEnum("closure_kind", ["temporary", "seasonal"]);

// F-035 — stand availability as FILTERABLE data rather than free-form text.
//
// VIGA's existing map states hours, season, and restocking in one prose blob per stand
// ("Open: March-November. 7 days a week, dawn to dusk"). That blob conflates three
// independent facts, which is why the current map cannot answer "what is open right now" —
// the unfilterable text CLAUDE.md names as a founding motivation for Farm Friend.
//
// Every value below occurs in the real VIGA export. The set is meant to GROW: when a stand
// describes itself in a way none of these capture, the answer is a new enum value plus a
// migration, never a free-text escape hatch that quietly restores the blob.

/**
 * How a stand states its time of day.
 *
 * `dawn_to_dusk` and `daylight_hours` are FIRST-CLASS values, not degraded clock times. On
 * an unattended honor-system stand they are the more truthful answer, and they are not
 * equivalent to any fixed pair of hours: dusk on Vashon moves by ~6 hours across the season,
 * so storing them as 06:00–20:00 would invent a precision the farmer never stated.
 */
export const openHoursKind = pgEnum("open_hours_kind", [
  "dawn_to_dusk",
  "daylight_hours",
  /** 24/7, "24hrs", "24 hours" — the stand is never closed within its season. */
  "all_day",
  /** Explicit clock times; `open_from` / `open_until` carry them. */
  "clock_range",
  /** A clock opening that runs until dusk ("10AM - Dusk"); `open_from` carries the start. */
  "until_dusk",
  /** Not a schedule at all — the customer must arrange a visit. */
  "by_appointment",
]);

/**
 * How a stand states its season.
 *
 * `year_round` is distinct from a null season on purpose: "open all year" and "we don't know
 * this stand's season" are different facts, and a filter must be able to tell them apart.
 */
export const seasonKind = pgEnum("season_kind", [
  "year_round",
  /** Explicit endpoints; the four `season_*_month` / `season_*_day` columns carry them. */
  "date_range",
  /** "Spring-fall", "Summer" — resolved at QUERY time from one shared constant. */
  "named_season",
  /** A stated start with no stated end ("June 1, 2026 - TBD"). */
  "open_ended",
]);

/**
 * How often a stand is restocked — what drives "best selection" answers.
 *
 * `variable`, `as_needed`, and `intermittent` are real answers, not missing data. "We restock
 * as stock runs low" is an honest description of an honor-system stand, and modelling it as
 * NULL would make it indistinguishable from a stand we simply failed to ask.
 */
export const stockingCadence = pgEnum("stocking_cadence", [
  "daily",
  /** Specific weekdays; `stocking_days` carries which. */
  "specific_days",
  "variable",
  "as_needed",
  "intermittent",
]);

/**
 * Why a seeded stand needs a human to look at it.
 *
 * The seeder never guesses. Where VIGA's source text contradicts itself or leaves a fact
 * open, it picks the more specific reading, records it, and raises one of these for an
 * operator or the farmer to settle.
 */
export const standDataFlagReason = pgEnum("stand_data_flag_reason", [
  /** Two `Open:` lines that disagree (Green Ears states both April–July and unqualified). */
  "contradictory_hours",
  /** A season with no stated end ("June 1, 2026 - TBD"). */
  "season_unresolved",
  /** The source text did not parse into any enum value; nothing was stored for it. */
  "unparsed_availability",
  /** The source's most recent note suggests the stand may not be operating. */
  "possibly_closed",
  /**
   * The farmer stated an address no geocoder could resolve ("Bank Road, East of Town").
   *
   * Its own value because filing it under `unparsed_availability` made the operator screen
   * lie: the queue rendered "Availability text could not be understood" above quoted text
   * that was plainly an address, so the label contradicted the evidence directly beneath it.
   */
  "address_unresolved",
]);
export const inboxProcessingState = pgEnum("inbox_processing_state", [
  "pending",
  "processing",
  "processed",
  "rejected",
]);
// One inbox accepts every supported provider event; the per-type minimal projection
// is enforced by check rather than by a second table or deduplication path.
export const providerEventType = pgEnum("provider_event_type", [
  "message_received",
  "message_sent",
  "message_finalized",
]);
export const deliveryStatus = pgEnum("delivery_status", [
  "sent",
  "delivered",
  "delivery_failed",
]);
export const consentState = pgEnum("consent_state", ["active", "stopped"]);
export const consentCaptureSource = pgEnum("consent_capture_source", [
  "join",
  "start",
  "farmer_onboarding",
]);
export const consentTransition = pgEnum("consent_transition", [
  "start",
  "stop",
]);
export const farmerTargetMenuPurpose = pgEnum("farmer_target_menu_purpose", [
  "update",
  "link",
  "settings",
]);
/** Reviewed location timezones. Adding a location outside Vashon requires an explicit review. */
export const salesLocationTimezone = pgEnum("sales_location_timezone", [
  "America/Los_Angeles",
]);
export const inventoryPromptCadence = pgEnum("inventory_prompt_cadence", [
  "every_2_days",
  "weekly",
  "every_2_weeks",
  "paused",
]);
export const proposalState = pgEnum("proposal_state", [
  "open",
  "accepted",
  "declined",
  "expired",
  // A revised or base-conflicted proposal is closed honestly rather than silently
  // overwritten; it consumes no token and publishes nothing.
  "invalidated",
]);
export const proposalToken = pgEnum("proposal_token", ["yes", "no"]);
// The launch message categories (F-016). These are categories INSIDE the one registered
// operational SMS program — deliberately not separate enrollments and not a program
// discriminator. The consent meaning of each lives in packages/core/src/sms/consent.ts.
export const messageCategory = pgEnum("message_category", [
  "required_reply",
  "inquiry_reply",
  "inventory_prompt",
  "inventory_confirmation",
  "stock_out_alert",
]);
export const farmerInviteChannel = pgEnum("farmer_invite_channel", ["sms", "email"]);
export const outboxState = pgEnum("outbox_state", [
  "queued",
  "dispatching",
  "sent",
  "suppressed",
  "failed",
  "ambiguous",
]);
export const dispatchAttemptState = pgEnum("dispatch_attempt_state", [
  "authorized",
  "accepted",
  "definitive_rejection",
  "ambiguous",
]);
export const reportStatus = pgEnum("report_status", [
  "open",
  "reviewed",
  "dismissed",
]);
export const flagStatus = pgEnum("flag_status", [
  "open",
  "resolved",
  "dismissed",
]);
export const modelValidationStatus = pgEnum("model_validation_status", [
  "passed",
  "repaired_then_passed",
  "rejected",
]);

/**
 * Where an `inventory_revisions` row's facts came from (F-063).
 *
 * TWO values, not three. The launch import and a later admin edit are the SAME actor — VIGA
 * recording what a farmer told them, through different doors — so they share one value.
 * Attribution for an admin edit belongs to that workflow's own action row, matching how
 * `stock_out_reports.reviewed_by_administrator_id` and `seller_approvals` already work (F-065).
 */
/**
 * Where a dated stock claim came from, and what evidence each one carries (F-063, F-090).
 *
 *   `sms`  — the farmer texted it and confirmed by reply. Names a proposal, an authorization,
 *            and a farm approval; the proposal holds the token they sent back.
 *   `web`  — the farmer stated it on the onboarding form, and their `START` proved the handset.
 *            Names an authorization and an approval, and NO proposal: there was no confirmation
 *            exchange to hold one. As strong as `sms` on who stands behind the claim.
 *   `viga` — VIGA's own records say so. Names none of them; a spreadsheet has no handset.
 *
 * `inventory_revisions_source_keys_coherent` is what makes each of those a guarantee rather
 * than a convention.
 */
export const inventoryRevisionSource = pgEnum("inventory_revision_source", [
  "sms",
  "web",
  "viga",
]);

/**
 * Where a `sales_location_participants` row's name came from (F-064).
 *
 * The same two actors, and the same reasoning, as `inventoryRevisionSource` above: VIGA's map
 * and weekly form state host sellers as prose, with no handset behind them. A separate enum
 * rather than a shared one because the two tables' keys differ — participants carry one
 * authorization, revisions carry three — so one enum would imply a coherence rule it cannot
 * enforce for both.
 */
export const participantSource = pgEnum("participant_source", ["sms", "viga"]);

/**
 * Where one seller's participation at one stand currently stands (F-114).
 *
 * THREE values, not four. `pending` is an invitation nobody has answered; `active` is public
 * and may publish; `paused` is the seller's own temporary withdrawal, which hides current
 * facts without ending the relationship.
 *
 * **Ending a relationship is `ended_at`, not a fourth state.** An unanswered invitation and an
 * ended relationship are both "not public", so a fourth value would add a case to every reader
 * without changing any public output — and the two facts a reader actually needs (may this
 * publish, is this public) are already answered by the state plus `ended_at`.
 */
export const standProviderLifecycle = pgEnum("stand_provider_lifecycle", [
  "pending",
  "active",
  "paused",
]);

/**
 * Who vouched for a seller appearing publicly at a stand (F-114).
 *
 * VIGA approval is the real gate — a hosted seller becomes visible on acceptance and approval,
 * on standing claims alone, before any confirmation exists. `host` records that an already
 * approved stand owner vouched instead, which produces a visible-but-revocable state rather
 * than silent publication. The approving actor is recorded precisely so VIGA can revoke what it did
 * not itself approve.
 *
 * **`seller` — nobody vouched; she put herself there** (F-117, max 2026-08-17). A farmer
 * onboarding on her own may say she sells at someone else's stand, and that flow has no VIGA
 * step by design: the whole point is that VIGA does no work for it. She is live immediately
 * and the host is asked afterwards, so at the moment the row is written neither existing value
 * is true — `viga` would make her indistinguishable from a seller VIGA actually approved, and
 * `host` requires a vouching authorization that does not exist yet.
 *
 * It is the WEAKEST source, and naming it is what keeps that fact legible: a row carrying it is
 * one nobody has confirmed. The host's `NO` ends it through the ordinary participation seam.
 */
export const standProviderApprovalSource = pgEnum(
  "stand_provider_approval_source",
  ["viga", "host", "seller"],
);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phoneE164: text("phone_e164").notNull(),
    phoneHash: text("phone_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    phoneHashUnique: unique("contacts_phone_hash_unique").on(table.phoneHash),
    normalizedPhone: check(
      "contacts_phone_e164_normalized",
      sql`${table.phoneE164} ~ '^\\+[1-9][0-9]{7,14}$'`,
    ),
    nonemptyHash: check(
      "contacts_phone_hash_nonempty",
      sql`length(${table.phoneHash}) >= 32`,
    ),
  }),
);

export const administrators = pgTable(
  "administrators",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // One fixed administrator identity at launch. Password verification proves the same
    // configured account; the database refuses every other identity.
    email: text("email").notNull(),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    // Revoked rows stay for audit history. A second live row for the fixed identity remains
    // impossible, while the CHECK below prevents a second identity from existing at all.
    oneActivePerEmail: uniqueIndex("administrators_one_active_per_email")
      .on(table.email)
      .where(sql`${table.revokedAt} is null`),
    emailNormalized: check(
      "administrators_email_normalized",
      // Lowercased and structurally an address: the login path lowercases before lookup,
      // so a mixed-case row would be authorization that can never be found.
      sql`${table.email} = lower(${table.email}) and ${table.email} ~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'`,
    ),
    fixedIdentity: check(
      "administrators_fixed_identity",
      sql`${table.email} = 'board@vigavashon.org'`,
    ),
    validRevocation: check(
      "administrators_valid_revocation",
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.authorizedAt}`,
    ),
  }),
);

export const adminSessions = pgTable(
  "admin_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Only the HASH of the session token is stored. A database read cannot recover a live
    // credential — the same discipline the phone hash follows (Golden Rule #5).
    tokenHash: text("token_hash").notNull(),
    administratorId: uuid("administrator_id")
      .notNull()
      .references(() => administrators.id, { onDelete: "restrict" }),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    tokenHashUnique: unique("admin_sessions_token_hash_unique").on(
      table.tokenHash,
    ),
    administratorLookup: index("admin_sessions_administrator").on(
      table.administratorId,
    ),
    // 32 random bytes hex-encoded. A short value here would mean the token was stored
    // rather than hashed, or truncated to something enumerable.
    tokenHashShape: check(
      "admin_sessions_token_hash_shape",
      sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    boundedLifetime: check(
      "admin_sessions_bounded_lifetime",
      sql`${table.expiresAt} > ${table.issuedAt}`,
    ),
    validRevocation: check(
      "admin_sessions_valid_revocation",
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.issuedAt}`,
    ),
  }),
);

/**
 * F-074 — phone numbers that may SEE test sellers over SMS. Nothing else.
 *
 * This is the riskiest concept in the feature and the constraints on it are deliberate.
 * Administrators are otherwise an email + password account with **no phone identity at all**,
 * so this introduces a second way to be privileged, reachable from untrusted inbound SMS —
 * the exact surface the safety boundary exists to contain. What keeps it safe is that the
 * capability it grants is a single boolean at retrieval time: a listed sender sees test sellers
 * in results and gains **no other power**. It cannot publish, approve, or read a farmer's data,
 * because nothing on those paths consults this table.
 *
 * `phoneHash` is the only lookup key, exactly as everywhere else (Golden Rule #5). Unlike
 * `contacts` there is deliberately **no `phone_e164` column**: the raw number exists there only
 * because the outbound send path needs something to send TO, and nothing here ever sends. The
 * four digits are the same lossy fragment the admin surface already shows operators, kept so a
 * human can tell which row to remove — they identify a row, never a subscriber.
 *
 * Removal is a REVOCATION rather than a delete, matching `administrators` and
 * `farmer_authorizations`: the row stays so the audit trail can still answer who was listed and
 * when. A revoked row stops granting visibility immediately, because every reader filters on
 * `revoked_at is null`.
 */
export const administratorPhones = pgTable(
  "administrator_phones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phoneHash: text("phone_hash").notNull(),
    /** The last four digits, so an operator can tell one row from another. Never more. */
    phoneLastFour: text("phone_last_four").notNull(),
    addedByAdministratorId: uuid("added_by_administrator_id")
      .notNull()
      .references(() => administrators.id, { onDelete: "restrict" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByAdministratorId: uuid("revoked_by_administrator_id").references(
      () => administrators.id,
      { onDelete: "restrict" },
    ),
  },
  (table) => ({
    // One LIVE listing per number; revoked rows accumulate as history. A partial unique index
    // rather than a plain unique, for the same reason `seller_approvals` uses one: re-listing a
    // number that was removed must be allowed, and must not resurrect the old row.
    oneLivePerPhone: uniqueIndex("administrator_phones_one_live")
      .on(table.phoneHash)
      .where(sql`${table.revokedAt} is null`),
    // A short value here would mean the number was stored rather than hashed.
    phoneHashShape: check(
      "administrator_phones_phone_hash_shape",
      sql`${table.phoneHash} ~ '^[0-9a-f]{64}$'`,
    ),
    // Exactly four digits — the mask `maskPhoneSuffix` refuses anything longer, and the column
    // must refuse it too rather than trusting every writer to have normalized first.
    lastFourShape: check(
      "administrator_phones_last_four_shape",
      sql`${table.phoneLastFour} ~ '^[0-9]{4}$'`,
    ),
    // Both revocation columns move together or not at all, as a full disjunction: a CHECK
    // passes on NULL, so a one-directional test would admit a row revoked by nobody.
    coherentRevocation: check(
      "administrator_phones_coherent_revocation",
      sql`
        (${table.revokedAt} is null and ${table.revokedByAdministratorId} is null)
        or (${table.revokedAt} is not null and ${table.revokedByAdministratorId} is not null)
      `,
    ),
  }),
);

/**
 * Durable failed-login budgets. Both the coarse client key and the account-wide key are
 * opaque salted hashes; no network address, email, or password material is stored.
 *
 * One table and one reservation mechanism serve both scopes. The transaction always claims
 * the account key first and the client key second, so concurrent requests cannot invent a
 * conflicting lock order.
 */
export const adminLoginFailures = pgTable(
  "admin_login_failures",
  {
    bucketHash: text("bucket_hash").primaryKey(),
    failureCount: integer("failure_count").notNull(),
    windowExpiresAt: timestamp("window_expires_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    bucketHashShape: check(
      "admin_login_failures_bucket_hash_shape",
      sql`${table.bucketHash} ~ '^[0-9a-f]{64}$'`,
    ),
    positiveCount: check(
      "admin_login_failures_positive_count",
      sql`${table.failureCount} > 0`,
    ),
    futureWindow: check(
      "admin_login_failures_future_window",
      sql`${table.windowExpiresAt} > ${table.updatedAt}`,
    ),
  }),
);

export const sellers = pgTable(
  "sellers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    photoUrl: text("photo_url"),
    mapProjection: publicMapProjection("map_projection"),
    publicLatitude: doublePrecision("public_latitude"),
    publicLongitude: doublePrecision("public_longitude"),
    /**
     * F-074 — VIGA marked this whole seller as a TEST seller. NULL means a real one.
     *
     * A test seller is absent from every public surface unless the viewer deliberately asked for
     * it: `?hidden=true` on the web, a listed sender hash over SMS. It is not a listing with a
     * warning on it — it is not there.
     *
     * On `sellers` rather than `sales_locations` because the intent is "this whole seller is fake",
     * and one decision should cover every stand it has. Deliberately its OWN column rather than
     * folded into `sales_locations.is_public`, for the same reason `retired_at` is: `is_public`
     * is a listing attribute the farmer's own form rewrites on every save, so an operator
     * decision expressed through it would be silently cleared the next time anyone edited.
     *
     * It is an operator fact about a fake farm, NEVER a privacy control for a real one. A farmer
     * who does not want their address published is `contact_only` (B-024) — `?hidden=true` is a
     * guessable URL parameter, so this hides nothing from anyone determined to look.
     */
    testSellerAt: timestamp("test_seller_at", { withTimezone: true }),
    testSellerByAdministratorId: uuid("test_seller_by_administrator_id").references(
      (): AnyPgColumn => administrators.id,
      { onDelete: "restrict" },
    ),
    /**
     * VIGA took this whole seller down. NULL means a live seller.
     *
     * **This is the ONE revocation concept** (F-114 Phase C.0). Phase B's `sellers` table carried
     * a separate `revoked_at`/`revoked_by_administrator_id` pair meaning the same thing; when the
     * identity records merged, keeping both would have been two ways to say one fact, so the
     * Phase B pair is gone and this is what "VIGA revoked a seller globally" writes.
     *
     * **This is what "delete a farm" means here**, the same choice max made for stands in
     * F-071 and for the same two reasons: `sellers` is referenced `on delete restrict` by
     * `sales_locations`, `farmer_authorizations`, `seller_approvals` and five more, so a hard
     * DELETE fails at the constraint for any farm that has ever been used; and erasing it
     * would erase the record of what its stands published and when, which is what the audit
     * trail exists to keep (Golden Rule #1).
     *
     * Its own column rather than folded into approval or `test_seller_at`, for the reason
     * `retired_at` is its own column on `sales_locations`: approval is a publication gate the
     * seller's own redemption can set, so an operator's take-down expressed through it would
     * be silently cleared the next time anyone was approved.
     */
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    retiredByAdministratorId: uuid("retired_by_administrator_id").references(
      (): AnyPgColumn => administrators.id,
      { onDelete: "restrict" },
    ),

    /**
     * VIGA put this farm in the trash: it leaves the console's list entirely (F-122).
     *
     * **A THIRD column rather than a state on `retired_at`**, because trash and off-the-map are
     * two independent decisions an operator makes for different reasons, and folding them would
     * make restoring one guess about the other. Off the map is the everyday reversible hide — the
     * farm is still VIGA's and still in the list, just not shown to customers. Trash means "this
     * should not be in my list at all", so a trashed farm is reachable only from the Trash view.
     *
     * **Reversible, and nothing else** (max, 2026-08-19, revising "off the map, plus a real
     * delete" the same day). Trashing destroys NOTHING: every revision, report and authorization
     * stays exactly as it was, which is what lets restore put back the farm that was trashed
     * rather than an approximation of it. Emptying the trash — the only act that would destroy —
     * is deliberately not built, because the referencing closure it has to answer is its own
     * piece of work.
     *
     * Public invisibility does NOT read this column. A trashed farm is invisible because
     * trashing retires it in the same transaction, so `visibleFarms` keeps one rule to state
     * rather than two to keep in step.
     */
    trashedAt: timestamp("trashed_at", { withTimezone: true }),
    trashedByAdministratorId: uuid("trashed_by_administrator_id").references(
      (): AnyPgColumn => administrators.id,
      { onDelete: "restrict" },
    ),
    /**
     * Did TRASHING cause this farm's retirement, or was it already off the map?
     *
     * Without this a restore has to guess. A farm VIGA took off the map on Monday and trashed on
     * Tuesday must come back off the map — that take-down was a separate decision and only
     * VIGA's own restore reverses it — while a farm that was live until it was trashed must come
     * back live. The two are indistinguishable from `retired_at` alone, so the fact is recorded
     * at the moment it is known rather than inferred later from timestamps.
     */
    retiredByTrash: boolean("retired_by_trash").notNull().default(false),

    /**
     * Does this seller take VIGA Farm Bucks? F-125 — it is HERS, not her stand's.
     *
     * **There is no eligibility flag** (max, 2026-08-20: "there is no 'eligible'. they either
     * take it or they don't"). `sales_locations.farm_bucks_eligible` was VIGA's grant, and it
     * created a three-state model — accepts / refuses / never reviewed — that let five
     * production stands claim acceptance with no grant at all. Two mechanisms disagreeing about
     * one fact is exactly what F-125 exists to delete, so the grant is gone rather than moved.
     *
     * **`DEFAULT true` is a deliberate product decision, not a convenience** (max, 2026-08-20).
     * Farm Bucks is near-universal among VIGA farms, so a blank row is nobody ticking a box
     * rather than a refusal, and the eleven farms carrying no answer at migration time publish
     * as accepting. The risk was named and accepted: a wrong `true` sends a customer to an
     * unattended honor-system stand holding vouchers the farmer will not take, with nobody
     * there to sort it out. If a farmer ever reports that, it is this default and not a defect.
     */
    farmBucksAccepted: boolean("farm_bucks_accepted").notNull().default(true),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    nameNotBlank: check("sellers_name_not_blank", sql`length(trim(${table.name})) > 0`),
    /**
     * The two test-farm columns move together or not at all — the same shape as
     * `sales_locations_coherent_retirement`, and written as a full disjunction for the same
     * reason: a CHECK *passes* on NULL, so a one-directional test would admit a farm marked by
     * nobody, and only its mirror image would admit an actor recorded against a real farm.
     */
    coherentTestFarm: check(
      "sellers_coherent_test_seller",
      sql`
        (${table.testSellerAt} is null and ${table.testSellerByAdministratorId} is null)
        or (${table.testSellerAt} is not null and ${table.testSellerByAdministratorId} is not null)
      `,
    ),
    /**
     * The two retirement columns move together or not at all — the same full disjunction as
     * `sellers_coherent_test_seller` above, and written that way for the same reason: a CHECK
     * *passes* on NULL, so a one-directional test would admit a farm retired by nobody and
     * only its mirror image would admit an actor recorded against a live farm.
     */
    coherentRetirement: check(
      "sellers_coherent_retirement",
      sql`
        (${table.retiredAt} is null and ${table.retiredByAdministratorId} is null)
        or (${table.retiredAt} is not null and ${table.retiredByAdministratorId} is not null)
      `,
    ),
    /**
     * The two trash columns move together or not at all — the same full disjunction as the two
     * CHECKs above, for the same reason: a CHECK *passes* on NULL, so a one-directional test
     * would admit a farm trashed by nobody.
     */
    coherentTrash: check(
      "sellers_coherent_trash",
      sql`
        (${table.trashedAt} is null and ${table.trashedByAdministratorId} is null)
        or (${table.trashedAt} is not null and ${table.trashedByAdministratorId} is not null)
      `,
    ),
    /**
     * A trashed farm is always retired too (F-122).
     *
     * Trashing retires in the same transaction, which is what lets `visibleFarms` state public
     * invisibility once over `retired_at` instead of twice. This CHECK is what makes that
     * one-rule reading safe: without it a future writer could trash without retiring and put a
     * trashed farm back on the public map, and the only symptom would be on the map itself.
     */
    trashedImpliesRetired: check(
      "sellers_trashed_implies_retired",
      sql`${table.trashedAt} is null or ${table.retiredAt} is not null`,
    ),
    /**
     * Trashing can only be credited for a retirement that exists (F-122).
     *
     * The flag decides whether a restore clears `retired_at`, so a true flag on a live farm
     * would let a later restore blank a retirement nobody made. Stated as a constraint because
     * the symptom otherwise appears only on the public map, one act later.
     */
    trashRetirementCoherent: check(
      "sellers_trash_retirement_coherent",
      sql`${table.retiredByTrash} = false or ${table.retiredAt} is not null`,
    ),
    projectionCoordinates: check(
      "sellers_projection_coordinates_coherent",
      sql`
        (
          ${table.mapProjection} is null
          and ${table.publicLatitude} is null
          and ${table.publicLongitude} is null
        )
        or (
          ${table.mapProjection} = 'hidden'
          and ${table.publicLatitude} is null
          and ${table.publicLongitude} is null
        )
        or (
          ${table.mapProjection} in ('exact', 'approximate')
          and ${table.publicLatitude} is not null
          and ${table.publicLongitude} is not null
          and ${table.publicLatitude} between -90 and 90
          and ${table.publicLongitude} between -180 and 180
        )
      `,
    ),
  }),
);

/**
 * F-078 — the email roster VIGA already holds, so a farmer can prove who they are.
 *
 * **Golden Rule #5 applied to a second kind of personal data.** These addresses are largely
 * personal (`dhusch@hotmail.com`), so the shape mirrors `contacts` rather than inventing a
 * second pattern: `email` is the raw address in EXACTLY ONE column read only by the send path,
 * and `emailHash` is the only lookup and log key. Nothing here is a display column.
 *
 * **Verifying is not publishing** (max, 2026-08-06). Six sellers answered "No" to putting contact
 * email on the printed map and two left it blank; their addresses still authenticate. That no
 * public read path selects from this table is a query property, proven by test — a schema
 * cannot enforce it.
 *
 * **Several rows per farm is the normal case, not an edge case.** Five of VIGA's 32 sellers list
 * more than one address, and Lavender Hill lists three, spread across two columns of the form.
 *
 * The CHECK constraints and the normalized unique index live in `0024_seller_emails.sql` and are
 * proven to genuinely refuse in `farm-emails-migration.integration.test.ts` — drizzle-kit omits
 * CHECK constraints when generating SQL, so a constraint declared only here would be enforced
 * by nothing while this file read as though it were.
 */
export const sellerEmails = pgTable(
  "seller_emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sellerId: uuid("seller_id")
      .notNull()
      .references(() => sellers.id, { onDelete: "restrict" }),
    /** THE ONLY column holding a raw address. Read by the send path and nothing else. */
    email: text("email").notNull(),
    /** The lookup and log key. Never a raw address in a log line or in model context. */
    emailHash: text("email_hash").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    // `btrim(text)` strips SPACES ONLY — not tabs, not newlines — so the whitespace class is
    // named explicitly. Migration 0020 shipped the naive form and a tab-only value passed it.
    addressNotBlank: check(
      "seller_emails_address_not_blank",
      sql`length(btrim(${table.email}, E' \t\r\n')) > 0`,
    ),
    // A malformed hash is a row nothing can ever look up, and the miss would be silent.
    hashIsDigest: check(
      "seller_emails_hash_is_digest",
      sql`${table.emailHash} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);

/**
 * F-079 — an issued email verification code.
 *
 * F-078 built the roster and the send path and stored nothing about what was SENT. A code has
 * to be checkable on a later request, and on Cloud Run that request routinely lands on a
 * different container — the service scales to zero while a farmer reads their mail. A code held
 * in memory would refuse a farmer who typed exactly the right digits.
 *
 * **The code is hashed at rest** under the same discipline as `farmerLinks.tokenHash`: a
 * database read cannot recover a live code. Six digits is a small space, so what makes this
 * safe is that guesses are COUNTED AND CAPPED (`attemptCount`), not that the code is long.
 *
 * **No raw address here** — `emailHash` only. The raw value lives in exactly one column
 * (`sellerEmails.email`) read only by the send path (Golden Rule #5).
 *
 * The CHECK constraints and the partial unique index live in
 * `0025_seller_email_verifications.sql` and are proven to genuinely refuse in
 * `farm-email-verifications-migration.integration.test.ts` — drizzle-kit omits both when
 * generating SQL, so rules declared only here would be enforced by nothing.
 */
export const sellerEmailVerifications = pgTable(
  "seller_email_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sellerId: uuid("seller_id")
      .notNull()
      .references(() => sellers.id, { onDelete: "restrict" }),
    /** Which address on file the code went to. The hash, never the address. */
    emailHash: text("email_hash").notNull(),
    /** HMAC of the six-digit code. The code itself exists only in the farmer's inbox. */
    codeHash: text("code_hash").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Set exactly once, on redemption. NULL means still live. */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    /** Wrong guesses against this code, capped so the digit space cannot be ground down. */
    attemptCount: integer("attempt_count").notNull().default(0),
    /**
     * Hash of the publish grant this code produced. NULL until redeemed.
     *
     * Held here rather than in a second table because this row already records which farm and
     * which instant — one mechanism, not two.
     */
    grantHash: text("grant_hash"),
    grantExpiresAt: timestamp("grant_expires_at", { withTimezone: true }),
  },
  (table) => ({
    emailHashIsDigest: check(
      "seller_email_verifications_email_hash_is_digest",
      sql`${table.emailHash} ~ '^[0-9a-f]{64}$'`,
    ),
    codeHashIsDigest: check(
      "seller_email_verifications_code_hash_is_digest",
      sql`${table.codeHash} ~ '^[0-9a-f]{64}$'`,
    ),
    // Strict: a row expiring at the instant it was issued is dead on arrival.
    expiresAfterIssue: check(
      "seller_email_verifications_expires_after_issue",
      sql`${table.expiresAt} > ${table.issuedAt}`,
    ),
    // Passes on NULL DELIBERATELY — "not yet consumed" must be legal. Called out because the
    // same NULL semantics silently invert a guard when the intent is the opposite.
    consumedAfterIssue: check(
      "seller_email_verifications_consumed_after_issue",
      sql`${table.consumedAt} is null or ${table.consumedAt} >= ${table.issuedAt}`,
    ),
    attemptsNotNegative: check(
      "seller_email_verifications_attempts_not_negative",
      sql`${table.attemptCount} >= 0`,
    ),
    grantHashIsDigest: check(
      "seller_email_verifications_grant_hash_is_digest",
      sql`${table.grantHash} is null or ${table.grantHash} ~ '^[0-9a-f]{64}$'`,
    ),
    // A COHERENCE PAIR in both directions: the one-directional form passes on NULL and would
    // enforce nothing (0023's lesson). A grant with no expiry never ages out.
    grantCoherent: check(
      "seller_email_verifications_grant_coherent",
      sql`(${table.grantHash} is null) = (${table.grantExpiresAt} is null)`,
    ),
  }),
);

/** An administrator-created, one-use path into farmer onboarding. */
export const farmerInvitations = pgTable(
  "farmer_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** NULL means the invitation starts onboarding a farm that is not in Farm Friend yet. */
    sellerId: uuid("seller_id").references(() => sellers.id, { onDelete: "restrict" }),
    /**
     * The pending hosting relationship this invitation accepts (F-114 Phase C.1).
     *
     * **The hosting invitation IS the farmer invitation.** §there is no second permission system
     * cut the access grant C.1 was once going to build, because the permission that follows
     * acceptance is an ordinary authorization for the seller who accepted. The same reasoning
     * applies here: this table already names a seller, holds the handset a redemption must arrive
     * from, carries the SMS agreement, and on a bare `START` mints the authorization and the
     * approval in one transaction. That is invitation and acceptance, already built. What it could
     * not say is WHICH pending relationship the redemption accepts, and that is this column.
     *
     * NULL on every ordinary invitation, which is what all 39 in production are.
     */
    standProviderId: uuid("stand_provider_id"),
    /**
     * The vouching stand owner, when the invitation was not VIGA's (F-114 Phase C.1).
     *
     * §hosting and approval lifecycle: a VIGA invitation counts as approval, and an already
     * approved stand owner may vouch instead — which produces a visible-but-revocable state
     * rather than silent publication.
     *
     * The vouch waits HERE rather than on the provider because
     * `stand_providers_hosting_lifecycle_coherent` refuses an approval on a `pending` row, and
     * rightly: approving a relationship nobody has accepted would publish a seller who never
     * agreed to be there. It is applied at acceptance, in the same transaction — exactly as
     * `pendingStock` and `pendingPromptCadence` already wait here for facts that cannot legally
     * exist until the authorization does.
     *
     * NULL means VIGA issued it and `createdByAdministratorId` is the actor.
     */
    invitedByAuthorizationId: uuid("invited_by_authorization_id").references(
      () => farmerAuthorizations.id,
      { onDelete: "restrict" },
    ),
    tokenHash: text("token_hash").notNull(),
    channel: farmerInviteChannel("channel").notNull(),
    /**
     * Who issued this claim — an administrator, or NOBODY (F-098).
     *
     * NULL is a SELF-ISSUED claim: the grandfathered door is the honour-system route, where a
     * farmer picks their own farm and proves an email VIGA already holds. There is no
     * administrator in that loop, and while this was `notNull` that door could not write the
     * row at all — which, once `JOIN <token>` was removed and START began matching on
     * `pending_phone_hash`, left its farmer with no way to finish onboarding.
     *
     * A self-issued row must name its farm (`farmer_invitations_self_issued_names_farm`): the
     * farm selection IS the credential there, with no token to name one later.
     */
    createdByAdministratorId: uuid("created_by_administrator_id").references(
      () => administrators.id,
      { onDelete: "restrict" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    /**
     * When the invited farmer ticked the SMS agreement on the onboarding page.
     *
     * **This records where the agreement was shown; it is not consent.** A tick on a web
     * page proves nothing about who holds the handset, so it grants nothing on its own. The
     * consent record is written only when the farmer's own message arrives from a phone,
     * which is the evidence that the person agreeing and the person being messaged are the
     * same. NULL means the box was never ticked, and that message establishes no consent.
     */
    agreedToSmsAt: timestamp("agreed_to_sms_at", { withTimezone: true }),
    /**
     * The phone the farmer stated on the onboarding form, so a bare `START` from it completes
     * their setup (max 2026-08-07). Replaces `JOIN <token>`, where the farm identity travelled
     * in the message body and a hand-copied 64-character token failed silently on any typo.
     *
     * **Golden Rule #5, the same two-column shape as `contacts`.** The raw E.164 lives in
     * exactly one column read only by the send path; the hash is the only lookup key, and it
     * is what an inbound `START` is matched against. Both nullable: an invitation minted
     * before the farmer reaches the form has neither.
     *
     * The INVITATION is still the credential. The phone says which handset to expect, never
     * who may be set up — see `0028_invitation_pending_phone.sql`.
     */
    pendingPhoneE164: text("pending_phone_e164"),
    pendingPhoneHash: text("pending_phone_hash"),
    /**
     * F-090 — what the farmer said was on the table today, HELD until their `START` proves the
     * handset. A dated claim needs someone to stand behind it, and a web form alone is not that.
     *
     * A non-empty array of `{ itemName, priceText? }`, or NULL for "said nothing about today" —
     * the difference is load-bearing and `farmer_invitations_pending_stock_shape` enforces it,
     * because an empty array would publish a revision claiming the stand was confirmed EMPTY.
     *
     * **This column was missing from this file until 2026-08-08**, having been added by
     * `0031_invitation_pending_stock.sql` and never mirrored here. `drizzle-kit generate` diffs
     * the DATABASE against THIS FILE, so the next generated migration proposed dropping it —
     * live data behind `recordFarmerInvitationPendingStock`. Caught by that DROP appearing in an
     * unrelated migration; the lesson is that a hand-written migration is only half the change.
     */
    pendingStock: jsonb("pending_stock"),
    /**
     * F-097 — how often the farmer asked to be reminded, HELD until their `START` (max
     * 2026-08-08).
     *
     * The same shape and the same reason as `pendingStock` above: the invited form publishes a
     * listing before anyone is authorized, and `inventory_prompt_preferences` carries composite
     * foreign keys to a live authorization — so the row is structurally impossible at the
     * moment the farmer chooses. The choice waits here and is applied inside the redemption
     * transaction, beside the authorization that makes it legal.
     *
     * NULL means the farmer stated nothing and takes the default (`weekly`), which is exactly
     * what every farmer got before this column existed. It is deliberately NOT defaulted to
     * `weekly` in the column: "chose weekly" and "was never asked" are different facts, and
     * only the second may be silently changed if the default ever moves.
     */
    pendingPromptCadence: inventoryPromptCadence("pending_prompt_cadence"),
  },
  (table) => ({
    tokenHashUnique: unique("farmer_invitations_token_hash_unique").on(table.tokenHash),
    tokenHashShape: check(
      "farmer_invitations_token_hash_shape",
      sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    expiryAfterCreation: check(
      "farmer_invitations_expiry_after_creation",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    validRedemption: check(
      "farmer_invitations_valid_redemption",
      sql`${table.redeemedAt} is null or ${table.redeemedAt} >= ${table.createdAt}`,
    ),
    // An agreement cannot predate the invitation that showed it. Without this a backdated
    // stamp could claim the agreement was shown at a moment the page did not exist.
    validAgreement: check(
      "farmer_invitations_valid_agreement",
      sql`${table.agreedToSmsAt} is null or ${table.agreedToSmsAt} >= ${table.createdAt}`,
    ),
    // E.164 as `normalizePhone` produces it. This column feeds the outbound send path, so a
    // malformed number here is a message that cannot be delivered with nothing saying why.
    // Passes on NULL deliberately: no stated phone is the normal starting state.
    pendingPhoneShape: check(
      "farmer_invitations_pending_phone_e164_shape",
      sql`${table.pendingPhoneE164} is null or ${table.pendingPhoneE164} ~ '^\\+1[0-9]{10}$'`,
    ),
    pendingPhoneHashIsDigest: check(
      "farmer_invitations_pending_phone_hash_is_digest",
      sql`${table.pendingPhoneHash} is null or ${table.pendingPhoneHash} ~ '^[0-9a-f]{64}$'`,
    ),
    // A COHERENCE PAIR in both directions — the one-directional form passes on NULL and would
    // enforce nothing (0023's lesson, and 0025's). A raw number with no hash can never be
    // matched; a hash with no raw number matches an invitation we then cannot text.
    pendingPhoneCoherent: check(
      "farmer_invitations_pending_phone_coherent",
      sql`(${table.pendingPhoneE164} is null) = (${table.pendingPhoneHash} is null)`,
    ),
    /**
     * The invitation's seller IS the provider's seller (F-114 Phase C.1).
     *
     * A composite key, so "this invitation accepts a relationship belonging to the seller it
     * authorizes for" is a database guarantee rather than a check some future caller might skip.
     * Without it a typo could invite Zoe to accept Gracie's Greens' participation at Kelsey's
     * stand while authorizing her for Venison Valley — the fabricated authority §migration
     * approach forbids, reached by accident rather than by inference. Same shape and same reason
     * as `stand_providers_id_location_unique`, which already does this for the stand.
     *
     * `restrict`, matching `seller_id` above: an invitation records an offer that was made, and a
     * deleted provider row must not silently erase it.
     */
    providerSellerReference: foreignKey({
      name: "farmer_invitations_provider_seller_fk",
      columns: [table.standProviderId, table.sellerId],
      foreignColumns: [standProviders.id, standProviders.sellerId],
    }).onDelete("restrict"),
    /**
     * A hosting invitation names its seller.
     *
     * **Deliberately NOT a biconditional**, unlike almost every coherence rule beside it. The
     * usual reason for one is that a CHECK passes on NULL and both directions are real failures;
     * here only one is. A provider bound with no seller would redeem straight into
     * `authorizeInvitedFarmerIn`'s "nothing to authorize" branch — invitation spent, farmer
     * consented, relationship still pending, nothing saying why. The converse is legitimate and
     * common: a seller named with no provider is what every ordinary invitation looks like.
     */
    hostingNamesSeller: check(
      "farmer_invitations_hosting_names_seller",
      sql`${table.standProviderId} is null or ${table.sellerId} is not null`,
    ),
    /**
     * One live invitation per pending relationship. Two unredeemed invitations for one provider
     * row would let two handsets each accept it, and the second would find the relationship
     * already active with no honest answer for its farmer. Partial on unredeemed, so a lapsed
     * invitation is reissuable — which is the ordinary case, since most are never redeemed.
     */
    oneOpenPerProvider: uniqueIndex("farmer_invitations_one_open_per_provider")
      .on(table.standProviderId)
      .where(sql`${table.redeemedAt} is null and ${table.standProviderId} is not null`),
  }),
);

export const farmerAuthorizations = pgTable(
  "farmer_authorizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * ONE OF TWO ARMS — a seller, or a stand, never both and never neither (F-114 Phase C.1).
     *
     * Nullable since `0043`, and the nine composite keys onto `(id, seller_id)` are unchanged:
     * a stand-armed authorization has NULL here and so cannot satisfy any of them, which is
     * correct. A person managing a venue is not thereby authorized for anyone's goods.
     */
    sellerId: uuid("seller_id").references(() => sellers.id, {
      onDelete: "restrict",
    }),
    /**
     * The other arm, for the one case the seller arm cannot express: a stand with NO seller of
     * its own. Morgan Hill Community Stand is a venue with four nested sellers and none of its
     * own, so its hours, closure, description, and who sells there can be reached through no
     * seller authorization — there is no seller to name.
     *
     * **This is not a second permission system.** "Stand owner" is not a role: it is what being
     * authorized for the seller a stand points at already gets you, derived through the
     * self-pointer at read time and never stored. This arm is only for the stand that has no
     * such seller.
     */
    salesLocationId: uuid("sales_location_id").references(
      () => salesLocations.id,
      { onDelete: "restrict" },
    ),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "restrict" }),
    phoneVerifiedAt: timestamp("phone_verified_at", {
      withTimezone: true,
    }).notNull(),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    // Renamed by `0042` with the rest of the seller vocabulary; this file was left naming the
    // old constraint. Same drift as the index below, and the same consequence — a generated
    // migration proposing to drop and recreate the target of nine composite foreign keys.
    idAndSellerUnique: unique("farmer_authorizations_id_seller_unique").on(
      table.id,
      table.sellerId,
    ),
    /**
     * Exactly one arm, always. A BICONDITIONAL rather than two independent NULL tests, because
     * **a CHECK PASSES on NULL**: "a seller is named" evaluates to NULL on the row that omits
     * it, and NULL is not false, so the row is admitted.
     *
     * Both directions are refused. BOTH named would let one authorization satisfy composite
     * keys on both sides, so a seller-level fact could be filed by a stand-armed authorization.
     * NEITHER named is an authorization for nothing at all — no reader would raise, because
     * each joins on a subject, so the row simply never matches and the person cannot act with
     * nothing saying why.
     */
    subjectArm: check(
      "farmer_authorizations_subject_arm",
      sql`(${table.sellerId} is null) <> (${table.salesLocationId} is null)`,
    ),
    // `0042` renamed this from `…_per_farm` with the rest of the seller vocabulary; this file
    // was left naming the old index, which would have made the next generated migration propose
    // dropping and recreating a live one. The name here is what the database actually holds.
    oneActiveAuthorization: uniqueIndex(
      "farmer_authorizations_one_active_contact_per_seller",
    )
      .on(table.sellerId, table.contactId)
      .where(sql`${table.revokedAt} is null`),
    /**
     * The stand arm needs its OWN uniqueness. The index above is keyed on `seller_id`, which is
     * NULL on every stand-armed row, and NULLs never collide in a unique index — so without
     * this a person could hold five live authorizations for one venue.
     */
    oneActiveStandAuthorization: uniqueIndex(
      "farmer_authorizations_one_active_contact_per_stand",
    )
      .on(table.salesLocationId, table.contactId)
      .where(sql`${table.revokedAt} is null`),
    verificationPrecedesAuthorization: check(
      "farmer_authorizations_verification_precedes_authorization",
      sql`${table.phoneVerifiedAt} <= ${table.authorizedAt}`,
    ),
    validRevocation: check(
      "farmer_authorizations_valid_revocation",
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.authorizedAt}`,
    ),
  }),
);

/**
 * A farmer's texted ask to be set up, waiting for VIGA (F-040).
 *
 * **This grants nothing, and it is shaped so it cannot.** VIGA always approves, because a
 * phone number proves possession of a phone and not ownership of a farm. A plain SIGNUP from
 * the public SMS surface deliberately has no farm and no grant column. An administrator-created
 * invitation may add an opaque invitation reference, which lets the queue suggest the farm the
 * administrator chose without making that suggestion authority. `farmer_authorizations` is
 * written by an administrator-gated writer, and this table is only ever an input to that decision.
 *
 * It carries no message text. The writer is untrusted inbound SMS, and a stored body would
 * be untrusted text parked in an operator's queue for no benefit — `FLAG` already owns
 * "a person should read this message" and has a thread viewer attached.
 */
export const farmerOnboardingRequests = pgTable(
  "farmer_onboarding_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The hash, never a raw number (Golden Rule #5). The queue masks at the query. */
    contactHash: text("contact_hash").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    /** An optional administrator-created invitation; it suggests a farm but grants nothing. */
    invitationId: uuid("invitation_id"),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    settledByAdministratorId: uuid("settled_by_administrator_id"),
    /**
     * The authorization this request produced, when it produced one. NULL for a declined or
     * still-open request. A REFERENCE to authority, never a source of it.
     */
    authorizationId: uuid("authorization_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    contactReference: foreignKey({
      name: "farmer_onboarding_requests_contact_fk",
      columns: [table.contactHash],
      foreignColumns: [contacts.phoneHash],
    }).onDelete("restrict"),
    administratorReference: foreignKey({
      name: "farmer_onboarding_requests_administrator_fk",
      columns: [table.settledByAdministratorId],
      foreignColumns: [administrators.id],
    }).onDelete("restrict"),
    authorizationReference: foreignKey({
      name: "farmer_onboarding_requests_authorization_fk",
      columns: [table.authorizationId],
      foreignColumns: [farmerAuthorizations.id],
    }).onDelete("restrict"),
    invitationReference: foreignKey({
      name: "farmer_onboarding_requests_invitation_fk",
      columns: [table.invitationId],
      foreignColumns: [farmerInvitations.id],
    }).onDelete("restrict"),
    // One OPEN request per phone: a farmer who texts the keyword five times because nothing
    // visibly happened must not produce five entries for one operator to work through.
    oneOpenPerContact: uniqueIndex(
      "farmer_onboarding_requests_one_open_per_contact",
    )
      .on(table.contactHash)
      .where(sql`${table.settledAt} is null`),
    oneRequestPerInvitation: uniqueIndex(
      "farmer_onboarding_requests_one_per_invitation",
    )
      .on(table.invitationId)
      .where(sql`${table.invitationId} is not null`),
    /**
     * A settled request must say WHO settled it — an administrator working the queue, or (F-067)
     * the authorization a farmer's own invitation redemption granted. A settlement recording
     * neither is refused, which is what keeps self-serve onboarding from erasing the trail.
     */
    coherentSettlement: check(
      "farmer_onboarding_requests_coherent_settlement",
      sql`
        (
          ${table.settledAt} is null
          and ${table.settledByAdministratorId} is null
          and ${table.authorizationId} is null
        )
        or (
          ${table.settledAt} is not null
          and ${table.settledByAdministratorId} is not null
        )
        or (
          ${table.settledAt} is not null
          and ${table.authorizationId} is not null
        )
      `,
    ),
  }),
);

/**
 * A standing link that lets a farmer reach their own listing form (F-040).
 *
 * max chose a link that **never expires until revoked**, so it can be bookmarked. That moves
 * the whole safety burden onto revocation, and this table is shaped so revocation cannot be
 * cached around: a link is a POINTER to an authorization, and the authorization carries the
 * authority. Resolution reads both rows and re-checks `farmer_authorizations.revoked_at` on
 * every request.
 *
 * Every link carries an exact location+owner pair. The owner id is deliberately
 * duplicated only to make both composite foreign keys enforce that the chosen authorization
 * and chosen location belong to the same farm; it is never read as independent authority.
 * There is still no cached "active" flag or signed claim that could survive revocation.
 *
 * This is a durable farmer capability with no session at all, which is why it is a table-backed
 * lookup rather than a self-contained signed claim.
 */
export const farmerLinks = pgTable(
  "farmer_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * SHA-256 of 32 random bytes, hex. Only the hash is stored — the same discipline as
     * `admin_sessions.token_hash` and the phone hash: a database read cannot recover a live
     * credential, so a leaked backup is not a leaked set of working links.
     */
    tokenHash: text("token_hash").notNull(),
    authorizationId: uuid("authorization_id").notNull(),
    ownerSellerId: uuid("owner_seller_id").notNull(),
    salesLocationId: uuid("sales_location_id").notNull(),
    /** Whose listing this link opens (F-114 Phase B). */
    providerId: uuid("provider_id").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    /**
     * A link may be revoked individually without withdrawing the farmer's authority — the
     * "I lost my phone" case. Withdrawing the authorization kills every link regardless;
     * this is the narrower act, not a second mechanism for the same one.
     */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    /**
     * F-114 Phase C.3 — plain, loosened from `(authorization, seller)` for the reason on
     * `farmer_target_contexts`: a host holding a link to a hosted seller's listing acts under
     * an authorization for a seller they are not. `resolveFarmerLink` enforces the live rule.
     */
    targetedAuthorizationReference: foreignKey({
      name: "farmer_links_targeted_authorization_fk",
      columns: [table.authorizationId],
      foreignColumns: [farmerAuthorizations.id],
    }).onDelete("restrict"),
    /** F-114 Phase C.3 — whose listing this link opens, rooted on the RELATIONSHIP. */
    targetedProviderSellerReference: foreignKey({
      name: "farmer_links_targeted_provider_seller_fk",
      columns: [table.providerId, table.ownerSellerId],
      foreignColumns: [standProviders.id, standProviders.sellerId],
    }).onDelete("restrict"),
    /**
     * F-114 Phase B item 2 — re-rooted to `(provider, location)`. A standing link opens ONE
     * listing form, and after Phase B a stand has several listings: the link has to name whose
     * it edits, or a hosted seller's bookmarked link would open the host's inventory.
     */
    targetedLocationProviderReference: foreignKey({
      name: "farmer_links_targeted_location_provider_fk",
      columns: [table.providerId, table.salesLocationId],
      foreignColumns: [standProviders.id, standProviders.salesLocationId],
    }).onDelete("restrict"),
    tokenHashUnique: unique("farmer_links_token_hash_unique").on(
      table.tokenHash,
    ),
    tokenHashShape: check(
      "farmer_links_token_hash_shape",
      sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    validRevocation: check(
      "farmer_links_valid_revocation",
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.issuedAt}`,
    ),
    // Re-issuing REPLACES rather than accumulates: a farmer who asks for a new link because
    // the old one was on a lost phone must not leave the old one working.
    oneLivePerAuthorization: uniqueIndex(
      "farmer_links_one_live_per_authorization",
    )
      .on(table.authorizationId)
      .where(sql`${table.revokedAt} is null`),
  }),
);

export const sellerApprovals = pgTable(
  "seller_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sellerId: uuid("seller_id")
      .notNull()
      .references(() => sellers.id, { onDelete: "restrict" }),
    /**
     * The administrator who approved this farm, or NOBODY (F-098).
     *
     * NULL means the farm published on the honour system through the self-service door, where
     * picking your farm from a dropdown and proving an email VIGA holds is the whole claim.
     * There is no approver to name, and requiring one would only be satisfiable by crediting
     * somebody who never acted.
     *
     * **VIGA's revoke is the backstop** — the same one that covers the listing such a farmer
     * can already publish. max's call, 2026-08-09.
     */
    administratorId: uuid("administrator_id").references(() => administrators.id, {
      onDelete: "restrict",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    idAndFarmUnique: unique("seller_approvals_id_farm_unique").on(
      table.id,
      table.sellerId,
    ),
    oneCurrentApproval: uniqueIndex("seller_approvals_one_current_per_farm")
      .on(table.sellerId)
      .where(sql`${table.revokedAt} is null`),
    validRevocation: check(
      "seller_approvals_valid_revocation",
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.approvedAt}`,
    ),
  }),
);

export const sellerLinks = pgTable(
  "seller_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sellerId: uuid("seller_id")
      .notNull()
      .references(() => sellers.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    url: text("url").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => ({
    farmUrlUnique: unique("seller_links_farm_url_unique").on(
      table.sellerId,
      table.url,
    ),
    labelNotBlank: check(
      "seller_links_label_not_blank",
      sql`length(trim(${table.label})) > 0`,
    ),
    absoluteHttpUrl: check(
      "seller_links_absolute_http_url",
      sql`${table.url} ~ '^https?://[^[:space:]]+$'`,
    ),
    nonnegativeSortOrder: check(
      "seller_links_nonnegative_sort_order",
      sql`${table.sortOrder} >= 0`,
    ),
  }),
);

export const salesLocations = pgTable(
  "sales_locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The one nested seller that IS this stand — the **self-pointer** (F-114 Phase C.0).
     *
     * This replaces `owner_seller_id`, and it is a different fact. Ownership asserted *who
     * controls the place*; this asserts *which of the sellers here is the stand itself*, which
     * is the question public rendering actually has to answer. The card suppresses the line this
     * column names and credits every other seller — following a recorded fact, never a name
     * match. That is what keeps `Hill Farm` hosted at `Hill Farm Stand` credited, and a farmer
     * who renames their farm still suppressed; §customer behavior rejected name matching for
     * precisely those two failures, and had no way to record the fact until this column existed.
     *
     * **NULL is a venue with no goods of its own** — Morgan Hill Community Stand, which has real
     * identity and four nested sellers, none of which is the stand. Nullable is therefore a
     * permanent shape, not a migration shim.
     *
     * The migration does NOT decide which stands are venues: it points every stand at its former
     * owner, because nothing in the data separates "venue" from "seller with one stand" and
     * guessing would be the inference §migration approach forbids. VIGA clears it by hand.
     */
    ownSellerId: uuid("own_seller_id").references(() => sellers.id, {
      onDelete: "restrict",
    }),
    kind: salesLocationKind("kind").notNull(),
    name: text("name").notNull(),
    /** No schema default: every new location must deliberately choose a reviewed zone. */
    timezone: salesLocationTimezone("timezone").notNull(),
    /** Current writers must state both independent classifications deliberately. */
    visitability: salesLocationVisitability("visitability").notNull(),
    offeringType: salesLocationOfferingType("offering_type").notNull(),

    /**
     * Present only for a `visitable` location — see `coherentVisitability` below.
     *
     * These were `NOT NULL` before F-038, which is precisely why the seeder refused Open Gate
     * Lamb: it has no stand to visit, so there is no address to record and inventing one is
     * forbidden. The column-level requirement is now a conditional constraint instead, so the
     * database still refuses a visitable stand with no address.
     */
    publicAddress: text("public_address"),
    publicLatitude: doublePrecision("public_latitude"),
    publicLongitude: doublePrecision("public_longitude"),
    /**
     * Whether the address TEXT may be shown to customers. The pin is unaffected.
     *
     * **A display decision, not a location one**, and that separation is the whole point. Some
     * Vashon stands sit at the farmer's home: they want people to find the stand, and they do
     * not want their street address printed in a public listing. Before this, those two wishes
     * were one column — the only way to hide the address was `contact_only`, which also removes
     * the pin and tells customers there is nowhere to go.
     *
     * So `coherentVisitability` is UNCHANGED and still requires an address and a coordinate pair
     * for a visitable stand. The address is always STORED; this column decides only whether it
     * is rendered. VIGA still sees it in admin, because support work needs it.
     *
     * `true` by default: an address a farmer typed into a public listing form is public unless
     * they say otherwise, and every row that existed before this column was exactly that.
     */
    addressPublic: boolean("address_public").notNull().default(true),
    /**
     * F-092 — whether this stand shows PRICES at all. The farmer's own switch, and the same shape
     * as `addressPublic` above: the fact is always stored, and one boolean decides whether it is
     * rendered.
     *
     * max's call (2026-08-08): hidden means hidden. Prices stay STORED when this is false, so
     * switching it back on restores what the farmer typed rather than making them retype it — but
     * NO CUSTOMER SURFACE MAY RENDER A PRICE while it is false. A reader that forgets this is the
     * failure mode; the projection that feeds the map is where it is enforced.
     *
     * `false` by default, unlike `addressPublic`, and deliberately. An address is information a
     * farmer supplied to a public listing; a price is a thing this system never asked for
     * before, and no existing stand has consented to showing one. Opting in is the farmer's act.
     */
    pricesPublic: boolean("prices_public").notNull().default(false),
    /**
     * The farmer's own words about when they are open, preserved verbatim.
     *
     * DISPLAY ONLY — never filtered on (F-035). Sherman Creek's "Saturday and Sunday when
     * available" and Aeggy's "mostly on Tuesdays and Saturdays" carry caveats no day set can
     * hold, and dropping them would make the map more confident than the farmer was. The
     * structured columns below answer queries; this sentence is shown beside them.
     */
    hoursText: text("hours_text"),

    // F-035 — the structured availability. Each column answers a question the prose cannot.
    seasonKind: seasonKind("season_kind"),
    /** Inclusive endpoints, set only when `season_kind = 'date_range'`. */
    seasonStartMonth: integer("season_start_month"),
    seasonStartDay: integer("season_start_day"),
    seasonEndMonth: integer("season_end_month"),
    seasonEndDay: integer("season_end_day"),
    /**
     * "spring" | "summer" | "fall" | "winter", possibly hyphenated ("spring-fall"), set only
     * when `season_kind = 'named_season'`. Resolved to months at QUERY time from one
     * documented constant, never expanded here — so a VIGA correction to what "summer" means
     * on Vashon changes one constant instead of requiring a re-seed.
     */
    seasonNames: text("season_names").array(),

    openHoursKind: openHoursKind("open_hours_kind"),
    /** Minutes past midnight; set when the kind is `clock_range` or `until_dusk`. */
    openFromMinutes: integer("open_from_minutes"),
    /** Minutes past midnight; set only when the kind is `clock_range`. */
    openUntilMinutes: integer("open_until_minutes"),
    /**
     * Which weekdays the stand is open, 0 = Sunday. NULL means "not stated" — distinct from
     * an empty array, which would claim the stand is open on no day at all.
     */
    openDays: integer("open_days").array(),

    stockingCadence: stockingCadence("stocking_cadence"),
    /** Which weekdays restocking happens, 0 = Sunday. Set with `specific_days`. */
    stockingDays: integer("stocking_days").array(),

    isPublic: boolean("is_public").notNull().default(true),

    /**
     * F-071 — VIGA has taken this stand down. NULL means live.
     *
     * Deliberately separate from `isPublic`, which is a LISTING attribute the farmer's own
     * onboarding form sets on every save. One column owned by two actors would mean an
     * operator's decision is reverted the next time the farmer edits their listing.
     *
     * A retired stand leaves every public surface and refuses publication, but keeps every
     * revision it published: the record of what a farm said it had, and when, is the thing the
     * audit trail exists to preserve (Golden Rule #1). It is reversible — see `restoreStand`.
     */
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    retiredByAdministratorId: uuid("retired_by_administrator_id").references(
      () => administrators.id,
      { onDelete: "restrict" },
    ),

    /**
     * VIGA put this stand in the trash: it leaves the console's list entirely (F-122).
     *
     * The same mechanism as `sellers.trashed_at`, and its doc comment owns the reasoning — a
     * third column because trash and off-the-map are independent decisions, reversible because
     * trashing destroys nothing, and invisible to customers through `retired_at` rather than
     * through a second public rule.
     */
    trashedAt: timestamp("trashed_at", { withTimezone: true }),
    trashedByAdministratorId: uuid("trashed_by_administrator_id").references(
      () => administrators.id,
      { onDelete: "restrict" },
    ),
    /**
     * Did TRASHING cause this stand's retirement? See `sellers.retired_by_trash`, which owns the
     * reasoning: it is what lets a restore undo only the retirement trashing itself created.
     */
    retiredByTrash: boolean("retired_by_trash").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    /**
     * The composite target every `(location, seller)` key points at. It is what stops a
     * revision, closure, link, or preference naming one stand and a different stand's seller.
     */
    idAndOwnSellerUnique: unique("sales_locations_id_own_seller_unique").on(
      table.id,
      table.ownSellerId,
    ),
    nameNotBlank: check(
      "sales_locations_name_not_blank",
      sql`length(trim(${table.name})) > 0`,
    ),
    /**
     * Still refuses a blank address — a nullable column must not turn "   " into a legal one.
     * Written `is null or …` so the NULL case is stated explicitly rather than relying on a
     * CHECK's silent pass on NULL; `coherentVisitability` is what forbids the null when the
     * location is visitable.
     */
    addressNotBlank: check(
      "sales_locations_address_not_blank",
      sql`${table.publicAddress} is null or length(trim(${table.publicAddress})) > 0`,
    ),
    validCoordinates: check(
      "sales_locations_valid_coordinates",
      sql`
        (${table.publicLatitude} is null or ${table.publicLatitude} between -90 and 90)
        and (${table.publicLongitude} is null or ${table.publicLongitude} between -180 and 180)
      `,
    ),
    /**
     * F-038, narrowed by F-088 — a location is COMPLETE or absent, whoever it belongs to.
     *
     * `visitable` still requires an address and a complete coordinate pair: without them the
     * map cannot place the stand, so "visitable" would be a promise the system cannot keep.
     *
     * **What F-088 relaxed (max, 2026-08-07): `contact_only` may now be fully placed.** It used
     * to require all three ABSENT, on the reasoning that the old map export carried real
     * coordinates for Open Gate Lamb and seeding them would send someone driving to a farm with
     * nothing to buy.
     *
     * That reasoning held while a pin was an unqualified invitation. It no longer is. A
     * contact-only farm renders with its own marker kind ("Farm, no stand" — built long ago and
     * unreachable until now, precisely because this constraint forbade the coordinate), a card
     * stating there is no stand to visit, and NO directions link. The defect was never the
     * coordinate; it was the UNLABELLED coordinate, and the label is now code with tests behind
     * it. Being findable is what a farm wants; being drivable-to is what it may decline.
     *
     * **What did NOT relax, and is the whole of what this still enforces: half a location is
     * refused in every direction.** Latitude without longitude puts a pin in the ocean, and an
     * address-less point cannot be checked by anyone — neither has anything to do with whether
     * there is a stand. That is why the rule below is stated once, over the shape of a location,
     * rather than twice over the two visitability values.
     */
    coherentVisitability: check(
      "sales_locations_coherent_visitability",
      sql`
        (
          -- Fully placed: an address AND both coordinates. Any farm may be.
          ${table.publicAddress} is not null
          and ${table.publicLatitude} is not null
          and ${table.publicLongitude} is not null
        )
        or (
          -- Not placed at all — and then it cannot claim to be visitable.
          ${table.visitability} = 'contact_only'
          and ${table.publicAddress} is null
          and ${table.publicLatitude} is null
          and ${table.publicLongitude} is null
        )
      `,
    ),
    /**
     * F-071 — the two retirement columns move together or not at all.
     *
     * A full disjunction over both shapes rather than a one-directional test, because a CHECK
     * *passes* on NULL: asserting only "an actor is recorded" would admit a stand retired by
     * nobody, and only the mirror image would admit an actor against a live stand.
     */
    coherentRetirement: check(
      "sales_locations_coherent_retirement",
      sql`
        (
          ${table.retiredAt} is null
          and ${table.retiredByAdministratorId} is null
        )
        or (
          ${table.retiredAt} is not null
          and ${table.retiredByAdministratorId} is not null
        )
      `,
    ),
    /**
     * The two trash columns move together or not at all — the same full disjunction as
     * `sales_locations_coherent_retirement`, and for the same reason: a CHECK *passes* on NULL.
     */
    coherentTrash: check(
      "sales_locations_coherent_trash",
      sql`
        (${table.trashedAt} is null and ${table.trashedByAdministratorId} is null)
        or (${table.trashedAt} is not null and ${table.trashedByAdministratorId} is not null)
      `,
    ),
    /**
     * A trashed stand is always retired too (F-122) — see `sellers_trashed_implies_retired`,
     * which owns the reasoning. It is what lets every public read keep filtering on
     * `retired_at` alone instead of learning a second column.
     */
    trashedImpliesRetired: check(
      "sales_locations_trashed_implies_retired",
      sql`${table.trashedAt} is null or ${table.retiredAt} is not null`,
    ),
    /** See `sellers_trash_retirement_coherent`, which owns the reasoning. */
    trashRetirementCoherent: check(
      "sales_locations_trash_retirement_coherent",
      sql`${table.retiredByTrash} = false or ${table.retiredAt} is not null`,
    ),
    /** Every public read filters on this; retired stands are the rare case, so partial. */
    liveIdx: index("sales_locations_live_idx")
      .on(table.id)
      .where(sql`${table.retiredAt} is null`),

    // F-035 — the enums are only worth having if the DATABASE enforces that each kind
    // carries exactly the detail it needs. Without these, a `date_range` with no dates or a
    // `clock_range` with no times would load silently and every reader would need a defensive
    // branch for a state the seeder should never have produced.
    coherentSeason: check(
      "sales_locations_coherent_season",
      sql`
        (
          ${table.seasonKind} is null
          and ${table.seasonStartMonth} is null and ${table.seasonStartDay} is null
          and ${table.seasonEndMonth} is null and ${table.seasonEndDay} is null
          and ${table.seasonNames} is null
        )
        or (
          ${table.seasonKind} = 'year_round'
          and ${table.seasonStartMonth} is null and ${table.seasonEndMonth} is null
          and ${table.seasonNames} is null
        )
        or (
          ${table.seasonKind} = 'date_range'
          and ${table.seasonStartMonth} is not null and ${table.seasonStartDay} is not null
          and ${table.seasonEndMonth} is not null and ${table.seasonEndDay} is not null
          and ${table.seasonNames} is null
        )
        or (
          ${table.seasonKind} = 'named_season'
          and ${table.seasonNames} is not null
          and coalesce(array_length(${table.seasonNames}, 1), 0) > 0
          and ${table.seasonStartMonth} is null and ${table.seasonEndMonth} is null
        )
        or (
          ${table.seasonKind} = 'open_ended'
          and ${table.seasonStartMonth} is not null and ${table.seasonStartDay} is not null
          and ${table.seasonEndMonth} is null and ${table.seasonEndDay} is null
          and ${table.seasonNames} is null
        )
      `,
    ),
    validSeasonDates: check(
      "sales_locations_valid_season_dates",
      sql`
        (${table.seasonStartMonth} is null or ${table.seasonStartMonth} between 1 and 12)
        and (${table.seasonEndMonth} is null or ${table.seasonEndMonth} between 1 and 12)
        and (${table.seasonStartDay} is null or ${table.seasonStartDay} between 1 and 31)
        and (${table.seasonEndDay} is null or ${table.seasonEndDay} between 1 and 31)
      `,
    ),
    coherentOpenHours: check(
      "sales_locations_coherent_open_hours",
      sql`
        (
          ${table.openHoursKind} is null
          and ${table.openFromMinutes} is null and ${table.openUntilMinutes} is null
        )
        or (
          ${table.openHoursKind} in ('dawn_to_dusk', 'daylight_hours', 'all_day', 'by_appointment')
          and ${table.openFromMinutes} is null and ${table.openUntilMinutes} is null
        )
        or (
          ${table.openHoursKind} = 'clock_range'
          and ${table.openFromMinutes} is not null and ${table.openUntilMinutes} is not null
        )
        or (
          ${table.openHoursKind} = 'until_dusk'
          and ${table.openFromMinutes} is not null and ${table.openUntilMinutes} is null
        )
      `,
    ),
    validOpenMinutes: check(
      "sales_locations_valid_open_minutes",
      sql`
        (${table.openFromMinutes} is null or ${table.openFromMinutes} between 0 and 1439)
        and (${table.openUntilMinutes} is null or ${table.openUntilMinutes} between 0 and 1439)
      `,
    ),
    // A day array must contain only real weekdays. An EMPTY array is refused outright: it
    // would assert "open on no day", which no stand means and which NULL already expresses.
    //
    // `coalesce` is load-bearing. `array_length(array[]::integer[], 1)` returns NULL — not 0 —
    // so a bare `between 1 and 7` evaluates to NULL on the empty array, and a CHECK constraint
    // PASSES on NULL. The first draft of this constraint admitted the exact value it was
    // written to forbid; the test caught it.
    validOpenDays: check(
      "sales_locations_valid_open_days",
      sql`
        ${table.openDays} is null
        or (
          coalesce(array_length(${table.openDays}, 1), 0) between 1 and 7
          and ${table.openDays} <@ array[0,1,2,3,4,5,6]
        )
      `,
    ),
    validStockingDays: check(
      "sales_locations_valid_stocking_days",
      sql`
        ${table.stockingDays} is null
        or (
          coalesce(array_length(${table.stockingDays}, 1), 0) between 1 and 7
          and ${table.stockingDays} <@ array[0,1,2,3,4,5,6]
        )
      `,
    ),
    // `specific_days` without the days is the one incoherent cadence: it promises a set the
    // reader then cannot find. Every other cadence carries no day list by definition.
    coherentStockingCadence: check(
      "sales_locations_coherent_stocking_cadence",
      sql`
        (${table.stockingCadence} = 'specific_days') = (${table.stockingDays} is not null)
        or (${table.stockingCadence} is null and ${table.stockingDays} is null)
      `,
    ),
  }),
);


/**
 * ONE seller's participation at ONE stand (F-114).
 *
 * ## One record, one kind
 *
 * Phase B expressed "the stand's own goods" as a **native brand slot** — this row with
 * `seller_id` NULL — and carried a second arm in every rule to describe it. Phase C.0 removed
 * the concept: a stand's own goods are simply its own seller, named like any other, and the
 * seller that IS the stand is recorded by `sales_locations.own_seller_id`, the **self-pointer**.
 *
 * So `seller_id` is `NOT NULL` and every row here is the same kind of thing. The reader surface
 * is why this stayed one record rather than becoming two: twelve production sites ask "what is
 * currently in stock here", and a second provider record would double every one of them and
 * reintroduce the agree-by-convention failure Phase A exists to end. Every guarantee —
 * one-current-per-provider, publication authority, pause, freshness — is stated once and
 * enforced by one constraint set. A newcomer holds one concept.
 *
 * ## Why the schedule and season columns are here and not shared with the stand
 *
 * **Availability is an intersection, never a union.** A provider's schedule and season are
 * clamped to the stand's: a provider may be closed while the stand is open, and can never be
 * open while the stand is closed. That supports the real case — a hosted seller who takes only
 * cash and locks their box before the stand shuts. These columns mirror `sales_locations`'
 * because both feed the SAME `openNow` reader through `StandAvailabilityFacts`; the
 * intersection is computed once, at `intersectAvailability`, never per surface.
 *
 * A provider that states nothing is `unknown`, which PERMITS — silence is not a claim that a
 * seller is shut, so a row migrated from a stand that stated its hours on the stand carries
 * none of its own and defers to it.
 */
export const standProviders = pgTable(
  "stand_providers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    salesLocationId: uuid("sales_location_id").notNull(),
    /**
     * The seller selling here. **NOT NULL — there is no native brand slot** (F-114 Phase C.0).
     *
     * A stand's own goods belong to its own seller, named like any other; which seller that is
     * lives in `sales_locations.own_seller_id`. Phase B made this nullable because `sellers` was
     * the authority root and NULL was the only way to say "the stand itself"; §the
     * stand-and-sellers correction removed that root, so NULL has nothing left to mean.
     */
    sellerId: uuid("seller_id")
      .notNull()
      .references(() => sellers.id, { onDelete: "restrict" }),
    lifecycleState: standProviderLifecycle("lifecycle_state").notNull(),

    // The hosting lifecycle. An owner invites, the seller accepts, and VIGA (or a vouching
    // approved host) approves before the relationship is public or may publish.
    invitedAt: timestamp("invited_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    approvalSource: standProviderApprovalSource("approval_source"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    /**
     * Who vouched, when `approval_source = 'host'` — the approved stand owner's authorization.
     * NULL for `viga`: VIGA's own approval names no farmer.
     */
    approvedByAuthorizationId: uuid("approved_by_authorization_id").references(
      () => farmerAuthorizations.id,
      { onDelete: "restrict" },
    ),
    /** Either side ended it. Not a lifecycle value — see `standProviderLifecycle`. */
    endedAt: timestamp("ended_at", { withTimezone: true }),

    /** One stand-specific public note, in the seller's own words. */
    publicNote: text("public_note"),

    /**
     * May this stand's own authorized phones state THIS seller's current stock? (F-114 C.1)
     *
     * **A property of the hosting relationship, not of the stand and not of the role** (max,
     * 2026-08-15). Some hosted sellers want the host restocking on their behalf: a baker who
     * drops off at dawn and would rather the host mark the last loaf gone than be texted about
     * it. Zoe at Venison Valley specifically does not. Both are legitimate, so the row that
     * binds a seller to a stand is where the answer lives.
     *
     * **Off unless the seller turns it on.** An invitation that silently conferred stock rights
     * would make acceptance mean more than it says, which §hosting and approval lifecycle
     * forbids: acceptance never grants more access than the explicit scopes attached to the
     * relationship.
     *
     * **Current stock only.** A host may never change a hosted seller's identity, prices,
     * payment, pause, or participation — those need separate authorization for that seller.
     * It is also distinct from the observation right §facts and authority already grants:
     * marking an item sold out is a physical observation of an empty cooler, available to a
     * stand owner regardless. What this adds is the ability to STATE STOCK, which is a claim
     * about someone else's goods and therefore theirs to permit.
     *
     * NOT NULL because the column is two-state, not three. An `unknown` would force every stock
     * writer to decide what silence means, and the answer would be "no" at every one of them.
     */
    hostMayUpdateStock: boolean("host_may_update_stock")
      .notNull()
      .default(false),

    // The provider's OWN stated availability, clamped to the stand's at read time. Every
    // column mirrors its `sales_locations` counterpart, and NULL throughout means "never
    // said" — which permits, rather than closes.
    seasonKind: seasonKind("season_kind"),
    seasonStartMonth: integer("season_start_month"),
    seasonStartDay: integer("season_start_day"),
    seasonEndMonth: integer("season_end_month"),
    seasonEndDay: integer("season_end_day"),
    seasonNames: text("season_names").array(),
    openHoursKind: openHoursKind("open_hours_kind"),
    openFromMinutes: integer("open_from_minutes"),
    openUntilMinutes: integer("open_until_minutes"),
    openDays: integer("open_days").array(),

    /*
     * This provider's reminder cadence is NOT here — see `inventory_prompt_preferences`.
     *
     * Phase B put a `reminder_cadence` and a `reminder_authorization_id` on this row while the
     * same migration gave that table a `provider_id` with a unique index on it, so one fact had
     * two homes and the pair never gained a reader. C.4 removed them from `0042` in place,
     * which was available because no database had applied it.
     *
     * The cadence lives beside the scheduler's cursor (`version`, `next_due_at`,
     * `last_due_slot_at`) because those advance together; splitting them would mean a listing
     * whose schedule and whose place in that schedule are two records that can disagree.
     */
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    /**
     * `cascade`, not `restrict`. A provider row has no existence apart from the stand it names
     * — it IS a seller's participation there — so a deleted stand takes it with it, exactly as
     * it already took that stand's `stand_items` and its stale targeting context.
     *
     * This is not a weakening of the hosted-seller guarantee. VIGA RETIRES stands rather than
     * deleting them (`retired_at`, F-071), precisely so the record of what a farm published
     * survives; the delete path this covers is test teardown and the seeder's own cleanup. What
     * protects a hosted seller's history is that the stand row is never deleted at all.
     */
    salesLocationReference: foreignKey({
      name: "stand_providers_location_fk",
      columns: [table.salesLocationId],
      foreignColumns: [salesLocations.id],
    }).onDelete("cascade"),
    /**
     * The target of every re-rooted composite foreign key (F-114 Phase B item 2).
     *
     * Authority used to route through `(sales_locations.id, sales_locations.owner_seller_id)`.
     * It now routes through `(stand_providers.id, stand_providers.sales_location_id)`, so
     * "this record belongs to a provider AT the stand the surface bound" is a database
     * guarantee rather than a check some future caller might skip. Same shape as
     * `inventory_entries_id_location_unique` and `stand_items_id_location_unique`.
     */
    idAndLocationUnique: unique("stand_providers_id_location_unique").on(
      table.id,
      table.salesLocationId,
    ),
    /**
     * The seller sibling of the pair above, and the target of
     * `farmer_invitations_provider_seller_fk` (F-114 Phase C.1). It exists so a hosting
     * invitation cannot name a relationship belonging to a seller other than the one it
     * authorizes for.
     */
    idAndSellerUnique: unique("stand_providers_id_seller_unique").on(
      table.id,
      table.sellerId,
    ),

    /**
     * A stand admits at most one LIVE provider row per seller, and any number of ended ones
     * (`0051`). One person selling under two brands at a single stand is not supported; a
     * person needing two brands there needs two sellers.
     *
     * **Partial on `ended_at is null`, and that is the whole rule.** Two LIVE rows for one
     * seller at one stand would be two listings under one name — the ambiguity this index
     * exists to prevent. Two ENDED rows are two episodes of a history, which is what `ended_at`
     * exists to record. It was full until F-115: an ended row went on occupying the slot
     * forever, so `inviteSellerToStand` answered `already_selling_here` to a seller who had
     * left, and a stand could never invite anyone back.
     *
     * **This is also the first-insert ARBITER.** Two writers racing to add the same seller at
     * one stand both find nothing and both insert; the winner is decided here by
     * `insert … on conflict do nothing returning …`, never by a preceding read —
     * `select … for update` cannot serialize a row that does not exist yet. The predicate does
     * not weaken that: both racers insert `ended_at` NULL, so both fall inside it.
     *
     * (The predicate is NOT the old `seller_id is not null` one C.0 removed. That one excluded
     * nothing once the native-brand slot was gone; this one excludes the ended history.)
     */
    oneRowPerSellerPerLocation: uniqueIndex(
      "stand_providers_one_per_seller_per_location",
    )
      .on(table.salesLocationId, table.sellerId)
      .where(sql`${table.endedAt} is null`),
    /** Every corpus-wide reader joins providers to their stand; the live ones are the query. */
    liveIdx: index("stand_providers_live_idx")
      .on(table.salesLocationId)
      .where(sql`${table.endedAt} is null`),

    /**
     * EVERY provider carries the whole hosting lifecycle.
     *
     * A biconditional over the whole shape rather than four independent NULL tests, because a
     * CHECK PASSES on NULL: "an invitation is recorded" alone would admit a row claiming an
     * accepted state with an invitation nobody sent, and its mirror would admit a hosted seller
     * that appeared publicly with no invitation, no acceptance and no approval — which is the
     * fabricated authority §migration forbids.
     *
     * Phase B carried a second arm exempting the native slot from all of this, on the ground
     * that a stand selling under its own name was never invited by anybody. C.0 removed that
     * arm with the slot: the stand's own seller is created as an ordinary provider by
     * `create_own_seller_provider`, which records VIGA as the approver and the stand's own
     * creation as the invitation, so nothing is invented and the arm describes nothing that
     * can exist.
     */
    hostingLifecycleCoherent: check(
      "stand_providers_hosting_lifecycle_coherent",
      sql`
        ${table.invitedAt} is not null
        and (
          (
            ${table.lifecycleState} = 'pending'
            and ${table.acceptedAt} is null
            and ${table.approvalSource} is null
            and ${table.approvedAt} is null
          )
          or (
            ${table.lifecycleState} in ('active', 'paused')
            and ${table.acceptedAt} is not null
            and ${table.acceptedAt} >= ${table.invitedAt}
            and ${table.approvalSource} is not null
            and ${table.approvedAt} is not null
          )
        )
      `,
    ),
    /**
     * A vouching host names the authorization that vouched; VIGA names none. A biconditional,
     * matching the `sourceProvenance` discipline: an independent test would admit
     * `approval_source = 'host'` with nobody recorded, which is the whole fact this column
     * exists to carry.
     */
    approvalSourceCoherent: check(
      "stand_providers_approval_source_coherent",
      sql`
        (${table.approvalSource} = 'host') = (${table.approvedByAuthorizationId} is not null)
        or (
          ${table.approvalSource} is null
          and ${table.approvedByAuthorizationId} is null
        )
      `,
    ),
    /** An ended relationship ended after it began. */
    endingCoherent: check(
      "stand_providers_ending_coherent",
      sql`
        ${table.endedAt} is null
        or (
          ${table.invitedAt} is not null
          and ${table.endedAt} >= ${table.invitedAt}
        )
      `,
    ),
    /** A stated note must say something; "" and NULL must not render identically. */
    publicNoteNotBlank: check(
      "stand_providers_public_note_not_blank",
      sql`
        ${table.publicNote} is null
        or length(btrim(${table.publicNote}, E' \t\r\n')) > 0
      `,
    ),
    // The availability columns repeat `sales_locations`' rules verbatim, because they answer
    // the same question through the same reader. A provider whose season or hours were stored
    // half-stated would load silently and make `openNow` defend against a state no writer
    // should produce.
    coherentSeason: check(
      "stand_providers_coherent_season",
      sql`
        (
          ${table.seasonKind} is null
          and ${table.seasonStartMonth} is null and ${table.seasonStartDay} is null
          and ${table.seasonEndMonth} is null and ${table.seasonEndDay} is null
          and ${table.seasonNames} is null
        )
        or (
          ${table.seasonKind} = 'year_round'
          and ${table.seasonStartMonth} is null and ${table.seasonEndMonth} is null
          and ${table.seasonNames} is null
        )
        or (
          ${table.seasonKind} = 'date_range'
          and ${table.seasonStartMonth} is not null and ${table.seasonStartDay} is not null
          and ${table.seasonEndMonth} is not null and ${table.seasonEndDay} is not null
          and ${table.seasonNames} is null
        )
        or (
          ${table.seasonKind} = 'named_season'
          and ${table.seasonNames} is not null
          and coalesce(array_length(${table.seasonNames}, 1), 0) > 0
          and ${table.seasonStartMonth} is null and ${table.seasonEndMonth} is null
        )
        or (
          ${table.seasonKind} = 'open_ended'
          and ${table.seasonStartMonth} is not null and ${table.seasonStartDay} is not null
          and ${table.seasonEndMonth} is null and ${table.seasonEndDay} is null
          and ${table.seasonNames} is null
        )
      `,
    ),
    validSeasonDates: check(
      "stand_providers_valid_season_dates",
      sql`
        (${table.seasonStartMonth} is null or ${table.seasonStartMonth} between 1 and 12)
        and (${table.seasonEndMonth} is null or ${table.seasonEndMonth} between 1 and 12)
        and (${table.seasonStartDay} is null or ${table.seasonStartDay} between 1 and 31)
        and (${table.seasonEndDay} is null or ${table.seasonEndDay} between 1 and 31)
      `,
    ),
    coherentOpenHours: check(
      "stand_providers_coherent_open_hours",
      sql`
        (
          ${table.openHoursKind} is null
          and ${table.openFromMinutes} is null and ${table.openUntilMinutes} is null
        )
        or (
          ${table.openHoursKind} in ('dawn_to_dusk', 'daylight_hours', 'all_day', 'by_appointment')
          and ${table.openFromMinutes} is null and ${table.openUntilMinutes} is null
        )
        or (
          ${table.openHoursKind} = 'clock_range'
          and ${table.openFromMinutes} is not null and ${table.openUntilMinutes} is not null
        )
        or (
          ${table.openHoursKind} = 'until_dusk'
          and ${table.openFromMinutes} is not null and ${table.openUntilMinutes} is null
        )
      `,
    ),
    validOpenMinutes: check(
      "stand_providers_valid_open_minutes",
      sql`
        (${table.openFromMinutes} is null or ${table.openFromMinutes} between 0 and 1439)
        and (${table.openUntilMinutes} is null or ${table.openUntilMinutes} between 0 and 1439)
      `,
    ),
    // `coalesce` is load-bearing: `array_length` of an empty array returns NULL, not 0, and a
    // CHECK passes on NULL — so a bare range test would admit the empty array it forbids.
    validOpenDays: check(
      "stand_providers_valid_open_days",
      sql`
        ${table.openDays} is null
        or (
          coalesce(array_length(${table.openDays}, 1), 0) between 1 and 7
          and ${table.openDays} <@ array[0,1,2,3,4,5,6]
        )
      `,
    ),
  }),
);

/**
 * The sender's current SMS stand plus their one live numbered STAND menu (F-051).
 *
 * The selected pair is convenience, never authority: every consumer joins it back through
 * the current authorization and current location ownership before use. Keeping selection
 * and the menu envelope together gives a sender one targeting context rather than parallel
 * preference and conversation mechanisms.
 */
export const farmerTargetContexts = pgTable(
  "farmer_target_contexts",
  {
    senderHash: text("sender_hash")
      .primaryKey()
      .references(() => contacts.phoneHash, { onDelete: "cascade" }),
    selectedAuthorizationId: uuid("selected_authorization_id"),
    selectedOwnerSellerId: uuid("selected_owner_seller_id"),
    selectedSalesLocationId: uuid("selected_sales_location_id"),
    /**
     * WHICH provider at the selected stand this sender is updating (F-114 Phase B item 7).
     *
     * Without it a hosted seller at four stands is untargetable: their selection routes through
     * the HOST's `owner_seller_id`, which is not their farm. The provider is the target; the
     * owner farm remains only as the pair that proves the authorization and the stand belong
     * together.
     */
    selectedProviderId: uuid("selected_provider_id"),
    selectedAt: timestamp("selected_at", { withTimezone: true }),
    menuIssuedAt: timestamp("menu_issued_at", { withTimezone: true }),
    menuExpiresAt: timestamp("menu_expires_at", { withTimezone: true }),
    menuPurpose: farmerTargetMenuPurpose("menu_purpose"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    /**
     * F-114 Phase C.3 — a PLAIN reference, deliberately loosened from the `(authorization,
     * seller)` composite. The composite said *the phone acting is authorized for the seller
     * whose goods are targeted*, which is one of the three ways to say yes and not the only
     * one: a host acting under `host_may_update_stock` targets a seller they are not authorized
     * for, and a venue's manager holds a stand-armed authorization naming no seller at all.
     * `lockLiveTargets` enforces the live rule from the same arms
     * `resolveProviderWriteAuthority` uses.
     */
    selectedAuthorizationReference: foreignKey({
      name: "farmer_target_contexts_selected_authorization_fk",
      columns: [table.selectedAuthorizationId],
      foreignColumns: [farmerAuthorizations.id],
    }).onDelete("cascade"),
    /**
     * F-114 Phase C.3 — whose goods the selection names, rooted on the RELATIONSHIP. Replaces
     * `farmer_target_contexts_selected_location_own_seller_fk`, which said the target's seller
     * is the stand's own and so forbade a hosted target at the database. `0045`'s substitution,
     * on this table.
     */
    selectedProviderSellerReference: foreignKey({
      name: "farmer_target_contexts_selected_provider_seller_fk",
      columns: [table.selectedProviderId, table.selectedOwnerSellerId],
      foreignColumns: [standProviders.id, standProviders.sellerId],
    }).onDelete("cascade"),
    /** F-114 Phase B item 2 — re-rooted to `(provider, location)`. */
    selectedLocationProviderReference: foreignKey({
      name: "farmer_target_contexts_selected_location_provider_fk",
      columns: [table.selectedProviderId, table.selectedSalesLocationId],
      foreignColumns: [standProviders.id, standProviders.salesLocationId],
    }).onDelete("cascade"),
    selectedAuthorizationLookup: index(
      "farmer_target_contexts_selected_authorization",
    ).on(table.selectedAuthorizationId),
    selectedLocationLookup: index(
      "farmer_target_contexts_selected_location",
    ).on(table.selectedSalesLocationId),
    /**
     * A selection is COMPLETE or absent — now including the provider (F-114 Phase B item 7).
     *
     * A full disjunction over all five columns rather than per-column tests, because a CHECK
     * PASSES on NULL: a selection carrying a stand and no provider would be exactly the
     * ambiguous target this item exists to remove, and it would load silently.
     */
    selectedContextCoherent: check(
      "farmer_target_contexts_selected_context_coherent",
      sql`
        (
          ${table.selectedAuthorizationId} is null
          and ${table.selectedOwnerSellerId} is null
          and ${table.selectedSalesLocationId} is null
          and ${table.selectedProviderId} is null
          and ${table.selectedAt} is null
        )
        or (
          ${table.selectedAuthorizationId} is not null
          and ${table.selectedOwnerSellerId} is not null
          and ${table.selectedSalesLocationId} is not null
          and ${table.selectedProviderId} is not null
          and ${table.selectedAt} is not null
        )
      `,
    ),
    menuContextCoherent: check(
      "farmer_target_contexts_menu_context_coherent",
      sql`
        (
          ${table.menuIssuedAt} is null
          and ${table.menuExpiresAt} is null
          and ${table.menuPurpose} is null
        )
        or (
          ${table.menuIssuedAt} is not null
          and ${table.menuExpiresAt} is not null
          and ${table.menuPurpose} is not null
          and ${table.menuExpiresAt} > ${table.menuIssuedAt}
        )
      `,
    ),
  }),
);

/** The immutable number-to-target bindings for the sender's current STAND menu. */
export const farmerTargetMenuOptions = pgTable(
  "farmer_target_menu_options",
  {
    senderHash: text("sender_hash").notNull(),
    optionNumber: integer("option_number").notNull(),
    authorizationId: uuid("authorization_id").notNull(),
    ownerSellerId: uuid("owner_seller_id").notNull(),
    salesLocationId: uuid("sales_location_id").notNull(),
    /**
     * The provider this numbered option selects (F-114 Phase B item 7). A hosted seller at four
     * stands gets four options; a stand hosting two sellers offers one option per provider, not
     * one per stand.
     */
    providerId: uuid("provider_id").notNull(),
  },
  (table) => ({
    key: primaryKey({ columns: [table.senderHash, table.optionNumber] }),
    contextReference: foreignKey({
      name: "farmer_target_menu_options_context_fk",
      columns: [table.senderHash],
      foreignColumns: [farmerTargetContexts.senderHash],
    }).onDelete("cascade"),
    /** F-114 Phase C.3 — plain, for the reason on `farmer_target_contexts` above. */
    authorizationReference: foreignKey({
      name: "farmer_target_menu_options_authorization_fk",
      columns: [table.authorizationId],
      foreignColumns: [farmerAuthorizations.id],
    }).onDelete("cascade"),
    /** F-114 Phase C.3 — whose goods this option names, rooted on the RELATIONSHIP. */
    providerSellerReference: foreignKey({
      name: "farmer_target_menu_options_provider_seller_fk",
      columns: [table.providerId, table.ownerSellerId],
      foreignColumns: [standProviders.id, standProviders.sellerId],
    }).onDelete("cascade"),
    /** F-114 Phase B item 2 — re-rooted to `(provider, location)`. */
    locationProviderReference: foreignKey({
      name: "farmer_target_menu_options_location_provider_fk",
      columns: [table.providerId, table.salesLocationId],
      foreignColumns: [standProviders.id, standProviders.salesLocationId],
    }).onDelete("cascade"),
    /**
     * One number per targetable thing. Keyed on the PROVIDER now, not the stand: a menu
     * offering a host and a hosted seller at one stand has two distinct options, which the
     * stand-keyed constraint refused.
     */
    oneNumberPerPair: unique(
      "farmer_target_menu_options_one_number_per_pair",
    ).on(table.senderHash, table.authorizationId, table.providerId),
    positiveOption: check(
      "farmer_target_menu_options_positive_option",
      sql`${table.optionNumber} > 0`,
    ),
  }),
);

/** One farmer-selected scheduled inventory prompt preference per stand (F-052). */
export const inventoryPromptPreferences = pgTable(
  "inventory_prompt_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerSellerId: uuid("owner_seller_id").notNull(),
    salesLocationId: uuid("sales_location_id").notNull(),
    /**
     * Whose reminders these are (F-114 Phase B). Each provider has one cadence and one
     * designated recipient — a hosted seller restocking weekly at a stand whose owner restocks
     * daily needs its own, and the recipient differs by construction.
     */
    providerId: uuid("provider_id").notNull(),
    designatedAuthorizationId: uuid("designated_authorization_id").notNull(),
    cadence: inventoryPromptCadence("cadence").notNull(),
    version: integer("version").notNull(),
    nextDueAt: timestamp("next_due_at", { withTimezone: true }),
    lastDueSlotAt: timestamp("last_due_slot_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    /** One cadence per PROVIDER (F-114 Phase B), replacing one per stand. */
    onePerProvider: unique("inventory_prompt_preferences_provider_unique").on(
      table.providerId,
    ),
    /** F-114 Phase B item 2 — re-rooted to `(provider, location)`. */
    locationProviderReference: foreignKey({
      name: "inventory_prompt_preferences_location_provider_fk",
      columns: [table.providerId, table.salesLocationId],
      foreignColumns: [standProviders.id, standProviders.salesLocationId],
    }).onDelete("restrict"),
    authorizationOwnerReference: foreignKey({
      name: "inventory_prompt_preferences_authorization_owner_fk",
      columns: [table.designatedAuthorizationId, table.ownerSellerId],
      foreignColumns: [farmerAuthorizations.id, farmerAuthorizations.sellerId],
    }).onDelete("restrict"),
    /**
     * Whose reminder this is is decided by the RELATIONSHIP (F-114 Phase C.4, `0048`).
     *
     * This replaces `inventory_prompt_preferences_location_own_seller_fk`, which said the
     * reminder's seller must be the seller that OWNS THE STAND — true of 38 of 38 stands when
     * `0042` wrote it, false of every hosting relationship, and impossible at a venue, where
     * `own_seller_id` is NULL and nothing can match. It forbade a hosted seller's cadence at the
     * database, and it was never in `schema.ts` at all, so only a hosted write could find it.
     *
     * Same correction `0045` made to `inventory_revisions`, in the table whose entire subject is
     * the fact C.4 makes per-provider.
     */
    providerSellerReference: foreignKey({
      name: "inventory_prompt_preferences_provider_seller_fk",
      columns: [table.providerId, table.ownerSellerId],
      foreignColumns: [standProviders.id, standProviders.sellerId],
    }).onDelete("restrict"),
    positiveVersion: check(
      "inventory_prompt_preferences_positive_version",
      sql`${table.version} > 0`,
    ),
    dueStateCoherent: check(
      "inventory_prompt_preferences_due_state_coherent",
      sql`
        (${table.cadence} = 'paused' and ${table.nextDueAt} is null)
        or (${table.cadence} <> 'paused' and ${table.nextDueAt} is not null)
      `,
    ),
    dueSlotsOrdered: check(
      "inventory_prompt_preferences_due_slots_ordered",
      sql`
        ${table.lastDueSlotAt} is null
        or ${table.nextDueAt} is null
        or ${table.nextDueAt} > ${table.lastDueSlotAt}
      `,
    ),
  }),
);

/**
 * Owner-confirmed names of other sellers active at a sales location (F-050).
 *
 * These are public display strings, not identities. There is deliberately no participant-farm
 * reference: F-050 has no confirmed linking flow, and name matching would fabricate authority.
 * Retirement is the only mutation; history is never deleted or rewritten.
 */
export const salesLocationParticipants = pgTable(
  "sales_location_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerSellerId: uuid("owner_seller_id").notNull(),
    salesLocationId: uuid("sales_location_id").notNull(),
    displayName: text("display_name").notNull(),
    /**
     * F-064 — who stated this name: the farmer's own handset, or VIGA's records.
     *
     * The same split F-063 made for `inventory_revisions`, for the same reason. The launch
     * import reads host sellers from VIGA's spreadsheets, which have no handset behind them, and
     * fabricating an authorization would make the founding corpus indistinguishable from
     * farmer-confirmed data.
     */
    source: participantSource("source").notNull(),
    confirmedByAuthorizationId: uuid("confirmed_by_authorization_id"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull(),
    retiredByAuthorizationId: uuid("retired_by_authorization_id"),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    locationOwnerReference: foreignKey({
      name: "sales_location_participants_location_owner_fk",
      columns: [table.salesLocationId, table.ownerSellerId],
      foreignColumns: [salesLocations.id, salesLocations.ownSellerId],
    }).onDelete("restrict"),
    confirmingOwnerReference: foreignKey({
      name: "sales_location_participants_confirming_owner_fk",
      columns: [table.confirmedByAuthorizationId, table.ownerSellerId],
      foreignColumns: [farmerAuthorizations.id, farmerAuthorizations.sellerId],
    }).onDelete("restrict"),
    retiringOwnerReference: foreignKey({
      name: "sales_location_participants_retiring_owner_fk",
      columns: [table.retiredByAuthorizationId, table.ownerSellerId],
      foreignColumns: [farmerAuthorizations.id, farmerAuthorizations.sellerId],
    }).onDelete("restrict"),
    oneActiveNormalizedName: uniqueIndex(
      "sales_location_participants_one_active_normalized_name",
    )
      .on(
        table.salesLocationId,
        sql`lower(regexp_replace(trim(${table.displayName}), '[[:space:]]+', ' ', 'g'))`,
      )
      .where(sql`${table.retiredAt} is null`),
    displayNameNotBlank: check(
      "sales_location_participants_display_name_not_blank",
      sql`length(trim(${table.displayName})) > 0`,
    ),
    // F-064 — the confirming key is required exactly when a farmer's handset confirmed the
    // list. A biconditional rather than an independent NULL test, because a CHECK PASSES on
    // NULL: `source = 'sms'` with no authorization would otherwise be admitted, which is the
    // fabricated-confirmation row this exists to refuse.
    sourceProvenance: check(
      "sales_location_participants_source_keys_coherent",
      sql`
        (
          ${table.source} = 'sms'
          and ${table.confirmedByAuthorizationId} is not null
        )
        or (
          ${table.source} = 'viga'
          and ${table.confirmedByAuthorizationId} is null
        )
      `,
    ),
    retirementCoherent: check(
      "sales_location_participants_retirement_coherent",
      sql`
        (
          ${table.retiredAt} is null
          and ${table.retiredByAuthorizationId} is null
        )
        or (
          ${table.retiredAt} is not null
          and ${table.retiredByAuthorizationId} is not null
          and ${table.retiredAt} >= ${table.confirmedAt}
        )
      `,
    ),
  }),
);

/**
 * The ONE vocabulary a stand talks about its own goods in (F-066).
 *
 * "Eggs" is one record per stand. The two things anyone can say about it are INDEPENDENT
 * STATES of that record, not two disjoint lists:
 *
 *   `usuallyCarried`             — a standing property of the farm, true in March and in
 *                                  September, dated by NOTHING.
 *   an entry naming it           — a statement about right now, always dated, always
 *                                  attributed by `source`.
 *
 * Either, both, or neither may hold, and the item OUTLIVES both — clearing the standing state
 * keeps the record and everything a past revision said about it.
 *
 * SHARING THE VOCABULARY IS NOT SHARING THE SLOT. The distinction F-035 protected survives
 * intact: a standing claim still cannot satisfy `one_current_per_location`, still carries no
 * confirmation time, and is still rendered under a heading that takes no timestamp. What is
 * gone is the render-time reconciliation — `standListingLines` used to case-fold and subtract
 * confirmed items from the usual list so nothing printed twice, which was this join done in
 * the view.
 *
 * NO TIMESTAMP MAY BE ADDED HERE. The "no confirmation time" property has to survive all the
 * way to the screen to mean anything; a date on this row would read as a confirmation of these
 * items and manufacture exactly the certainty an honor-system stand refuses to fake.
 *
 * An entry links to its item by (salesLocationId, normalized itemName) rather than a foreign
 * key: `inventory_entries` refuses every UPDATE, so a reference column could never have been
 * backfilled onto published rows without disabling that guard. See `0020_stand_items.sql`.
 */
export const standItems = pgTable(
  "stand_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    salesLocationId: uuid("sales_location_id").notNull(),
    /**
     * WHOSE usual item this is (F-114 Phase B item 4).
     *
     * This table could not wait for Phase C. **A hosted seller's first published fact is a
     * usual item, not a confirmation** — a seller becomes visible on acceptance and approval,
     * on standing claims alone — and usual items are the majority of what customers see: 33 of
     * 37 stands carry a usual item absent from their published inventory, and 18 publish no
     * inventory at all (measured 2026-08-11). Without this column a host and a hosted seller
     * who both usually sell eggs collide on `stand_items_one_per_location_name`.
     */
    providerId: uuid("provider_id").notNull(),
    /** The farmer's own words, verbatim: "eggs", "plant starts", "Gailan". */
    displayName: text("display_name").notNull(),
    /** The standing state. Never a date — see the note above. */
    usuallyCarried: boolean("usually_carried").notNull().default(false),
    /**
     * F-092 — what this usually costs, as FOUR PARTS that render as one sentence. All optional
     * as a group: `stand_items_price_complete` refuses a half-stated price.
     *
     *     amount  quantity  unit     basis     renders as
     *     6       1         dozen    per       $6 / dozen
     *     5       3         lb       for       3 lb for $5
     *     5       3         —        for       $5 for 3
     *
     * **The unit is the one part a stated price may omit, and only for `for`** (B-041) — the
     * item is its own unit in a bundle. `stand_items_price_basis_unit` is that rule.
     *
     * `per` is the bundle with an implied count of one, which is why these are one mechanism and
     * not two — the renderer is a single function, and a third kind of price would be a third
     * value of `basis` rather than a fifth column.
     *
     * This REPLACED a free-text `price_text` (0030). That column argued, correctly for what it
     * knew, that a roadside sign says "$6/dozen" and not a decimal — but the VIGA corpus turned
     * out to contain no per-item price at all, so there was no vocabulary to honour and nothing
     * to migrate. See `0032_structured_item_price.sql`.
     *
     * NULL across all four is "not stated" — never "free" and never "ask". FREE IS `0`: a farmer
     * giving something away states an amount of zero, which is a fact, where NULL is its absence.
     *
     * Whether any of this REACHES a customer is `salesLocations.pricesPublic`, not these columns.
     */
    priceAmount: numeric("price_amount", { precision: 10, scale: 2 }),
    priceQuantity: numeric("price_quantity", { precision: 10, scale: 2 }),
    priceUnit: text("price_unit"),
    priceBasis: standItemPriceBasis("price_basis"),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => ({
    /**
     * F-114 Phase B item 2 — re-rooted from the stand alone to `(provider, location)`, so a
     * usual item can only belong to a provider AT the stand the surface bound. `cascade` is
     * preserved from the stand reference it replaces: a provider's usual items are meaningless
     * without the provider, exactly as they were without the stand.
     */
    locationProviderReference: foreignKey({
      name: "stand_items_location_provider_fk",
      columns: [table.providerId, table.salesLocationId],
      foreignColumns: [standProviders.id, standProviders.salesLocationId],
    }).onDelete("cascade"),
    /**
     * The target of `stock_out_reports`' composite reference (B-057), matching the shape
     * `inventory_entries_id_location_unique` already provides. Referencing `(id,
     * sales_location_id)` together is what makes "this item belongs to the stand the surface
     * bound" a database guarantee rather than a check some future caller might skip.
     */
    idAndLocationUnique: unique("stand_items_id_location_unique").on(
      table.id,
      table.salesLocationId,
    ),
    /**
     * `btrim(text)` with no second argument strips SPACES ONLY — not tabs, not newlines. A
     * test asserting "\t\n" is refused caught the default admitting it. Every normalization
     * of this column names the whitespace characters explicitly, and the unique index below
     * must use the IDENTICAL expression or the two disagree about what "blank" and "same" are.
     */
    displayNameNotBlank: check(
      "stand_items_display_name_not_blank",
      sql`length(btrim(${table.displayName}, E' \t\r\n')) > 0`,
    ),
    nonnegativeSortOrder: check(
      "stand_items_nonnegative_sort_order",
      sql`${table.sortOrder} >= 0`,
    ),
    /**
     * F-092 — a price is STATED OR NOT, and a stated one carries amount, quantity and basis.
     * Half a price renders as garbage ("/ dozen"), and this is the only thing that can stop a
     * writer omitting a field. All-NULL stays legal and is what "not stated" means.
     *
     * **The unit is deliberately absent from both halves** (B-041): whether it is owed depends on
     * the basis, which `stand_items_price_basis_unit` below states on its own. A unit with no
     * amount is still refused here, because the unit must be NULL when nothing else is stated.
     */
    priceComplete: check(
      "stand_items_price_complete",
      sql`
        (
          ${table.priceAmount} is null
          and ${table.priceQuantity} is null
          and ${table.priceUnit} is null
          and ${table.priceBasis} is null
        )
        or (
          ${table.priceAmount} is not null
          and ${table.priceQuantity} is not null
          and ${table.priceBasis} is not null
        )
      `,
    ),
    /**
     * B-041 — the unit is required by `per` and optional for `for`, which is the one asymmetry
     * in this shape. A bundle carries its own count, so "$5 for 3" is a complete price with the
     * item itself as the unit — exactly what a corn stand letters on its sign. A unit price has
     * no count to lean on: "$6 / " is not a sentence.
     *
     * This is the copy of the rule that CODE CANNOT IMPORT. Every other layer imports
     * `standItemPriceNeedsUnit` from core; this CHECK is written to match it, and the integration
     * suite asserts both halves against the live constraint rather than against the parser.
     */
    priceBasisUnit: check(
      "stand_items_price_basis_unit",
      sql`${table.priceBasis} is distinct from 'per' or ${table.priceUnit} is not null`,
    ),
    /**
     * Zero is FREE and is a real answer, so the amount floor is `>= 0` — where the quantity floor
     * is `> 0`, because "0 for $5" is not a sentence. Both say `is null or` explicitly: a CHECK
     * passes on NULL, and leaving that implicit is how a guard admits the case it meant to skip.
     */
    priceAmountNonnegative: check(
      "stand_items_price_amount_nonnegative",
      sql`${table.priceAmount} is null or ${table.priceAmount} >= 0`,
    ),
    priceQuantityPositive: check(
      "stand_items_price_quantity_positive",
      sql`${table.priceQuantity} is null or ${table.priceQuantity} > 0`,
    ),
    /** The farmer's own word, so free text — but "" and NULL must not render identically. */
    priceUnitNotBlank: check(
      "stand_items_price_unit_not_blank",
      sql`${table.priceUnit} is null or length(btrim(${table.priceUnit}, E' \t\r\n')) > 0`,
    ),
    /**
     * One item per PROVIDER per name (F-114 Phase B item 4), and the first-insert arbiter for
     * concurrent writers.
     *
     * Keyed on the stand alone, a host and a hosted seller who both usually sell eggs collided:
     * the second writer was refused, and the honest answer — two providers each usually carry
     * eggs, at their own prices — could not be stored at all. The stand-wide question is now
     * asked by a reader that groups by item across the stand's providers, which is where a
     * dedupe decision belongs, rather than by an index that forbade the second fact.
     *
     * Normalization is case and surrounding whitespace ONLY, so the profile form's "eggs" and
     * the weekly form's "Eggs" are one item. It must never fold singulars into plurals or
     * synonyms into each other — that is a produce taxonomy, and this index is not where such
     * a decision belongs.
     */
    onePerProviderName: uniqueIndex("stand_items_one_per_provider_name").on(
      table.providerId,
      sql`lower(btrim(${table.displayName}, E' \t\r\n'))`,
    ),
  }),
);

/**
 * SUPERSEDED BY `standItems` (F-066) — retained only so the 0020 backfill has a source.
 *
 * Was: what a stand usually carries, as its own table because a standing claim and a dated
 * confirmation are different kinds of fact. That distinction survives; it is now the
 * `usuallyCarried` state of a stand item rather than a separate table with its own vocabulary.
 * No reader should be added here.
 */
export const salesLocationOfferings = pgTable(
  "sales_location_offerings",
  {
    salesLocationId: uuid("sales_location_id").notNull(),
    /** A single item as the farm describes it: "eggs", "lamb", "plant starts". */
    item: text("item").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => ({
    salesLocationReference: foreignKey({
      name: "sales_location_offerings_location_fk",
      columns: [table.salesLocationId],
      foreignColumns: [salesLocations.id],
    }).onDelete("cascade"),
    pk: primaryKey({
      name: "sales_location_offerings_pk",
      columns: [table.salesLocationId, table.item],
    }),
    itemNotBlank: check(
      "sales_location_offerings_item_not_blank",
      sql`length(trim(${table.item})) > 0`,
    ),
    nonnegativeSortOrder: check(
      "sales_location_offerings_nonnegative_sort_order",
      sql`${table.sortOrder} >= 0`,
    ),
  }),
);

/**
 * A seeded stand whose source data needs a human decision (F-035, B-002).
 *
 * Deliberately NOT the existing `flags` table: that one is keyed to `contact_hash` and
 * `inbox_event_id` — a customer-message safety rail with a thread viewer attached. A seed
 * flag has neither, and forcing one in would break the coherence its operator surface
 * depends on. Same idea, different subject, so a separate small table rather than a nullable
 * mess in a table that means something else.
 *
 * The seeder resolves contradictions by picking the more specific reading and raising one of
 * these — it never silently guesses, and never drops the conflict on the floor.
 */
export const standDataFlags = pgTable(
  "stand_data_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    salesLocationId: uuid("sales_location_id")
      .notNull()
      .references(() => salesLocations.id, { onDelete: "cascade" }),
    reason: standDataFlagReason("reason").notNull(),
    /** The source text that could not be resolved, so an operator can see what was meant. */
    sourceText: text("source_text").notNull(),
    /** What the seeder stored instead, in words. Null when it stored nothing. */
    resolutionNote: text("resolution_note"),
    resolvedByAdministratorId: uuid("resolved_by_administrator_id").references(
      () => administrators.id,
      { onDelete: "restrict" },
    ),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // One open flag per (location, reason): re-running the seeder must not pile up duplicate
    // copies of the same unresolved question. Resolved flags stay as history.
    oneOpenPerReason: uniqueIndex("stand_data_flags_one_open_per_reason")
      .on(table.salesLocationId, table.reason)
      .where(sql`${table.resolvedAt} is null`),
    sourceTextNotBlank: check(
      "stand_data_flags_source_text_not_blank",
      sql`length(trim(${table.sourceText})) > 0`,
    ),
    coherentResolution: check(
      "stand_data_flags_coherent_resolution",
      sql`
        (${table.resolvedAt} is null and ${table.resolvedByAdministratorId} is null)
        or (${table.resolvedAt} is not null and ${table.resolvedByAdministratorId} is not null)
      `,
    ),
  }),
);

/**
 * What a seller takes, stated ONCE (F-125).
 *
 * This replaced `sales_location_payment_methods`, which put the fact on the stand. Whoever
 * takes the money decides how they take it, and a seller selling at three stands should say it
 * once rather than three times — and, under the old shape, could leave the three disagreeing.
 *
 * Nothing derives this from her stands. That derivation was the second mechanism F-125 removes,
 * and a helper that rebuilt it would reintroduce precisely what this change deletes.
 */
export const sellerPaymentMethods = pgTable(
  "seller_payment_methods",
  {
    sellerId: uuid("seller_id").notNull(),
    method: text("method").notNull(),
  },
  (table) => ({
    sellerReference: foreignKey({
      name: "seller_payment_methods_seller_fk",
      columns: [table.sellerId],
      foreignColumns: [sellers.id],
    }).onDelete("cascade"),
    pk: primaryKey({
      name: "seller_payment_methods_pk",
      columns: [table.sellerId, table.method],
    }),
    methodNotBlank: check(
      "seller_payment_methods_method_not_blank",
      sql`length(trim(${table.method})) > 0`,
    ),
  }),
);

/**
 * The stand-level override, and the reason it is shaped as EXCLUSIONS (F-125).
 *
 * The motivating case is a hosted seller who cannot take cash at one stand because the host
 * cannot support it. That is the host constraining what is possible at their location — never a
 * second independent answer about the seller.
 *
 * **Narrowing is structural here, not checked.** A row names a method the host REMOVES; there
 * is no representation for "this stand adds a method the seller does not take", so adding is
 * unsayable rather than refused. A guard can be forgotten by the next writer; a missing column
 * cannot. `resolvePaymentMethods` in `core` is the one place the two are combined.
 *
 * **It references the stand and the seller separately, NOT `stand_providers`.** The composite
 * `(sales_location_id, seller_id)` key used elsewhere is unavailable here: that pair is unique
 * on `stand_providers` only through a PARTIAL index (`where ended_at is null`), and Postgres
 * cannot point a foreign key at a partial index. The partial index is right — a seller may hold
 * an ended row and a live row for the same stand — so the exclusion takes two plain references
 * instead of forcing a wrong constraint onto the parent. An exclusion naming a pair that never
 * sold together is inert rather than illegal: `resolvePaymentMethods` only ever sees the rows
 * for the pair it is resolving.
 */
export const salesLocationPaymentMethodExclusions = pgTable(
  "sales_location_payment_method_exclusions",
  {
    salesLocationId: uuid("sales_location_id").notNull(),
    sellerId: uuid("seller_id").notNull(),
    method: text("method").notNull(),
  },
  (table) => ({
    salesLocationReference: foreignKey({
      name: "sales_location_payment_exclusions_location_fk",
      columns: [table.salesLocationId],
      foreignColumns: [salesLocations.id],
    }).onDelete("cascade"),
    sellerReference: foreignKey({
      name: "sales_location_payment_exclusions_seller_fk",
      columns: [table.sellerId],
      foreignColumns: [sellers.id],
    }).onDelete("cascade"),
    pk: primaryKey({
      name: "sales_location_payment_method_exclusions_pk",
      columns: [table.salesLocationId, table.sellerId, table.method],
    }),
    methodNotBlank: check(
      "sales_location_payment_method_exclusions_method_not_blank",
      sql`length(trim(${table.method})) > 0`,
    ),
  }),
);

export const senderStates = pgTable(
  "sender_states",
  {
    senderHash: text("sender_hash")
      .primaryKey()
      .references(() => contacts.phoneHash, { onDelete: "restrict" }),
    conversationOccurredAt: timestamp("conversation_occurred_at", {
      withTimezone: true,
    }),
    conversationProviderEventId: text("conversation_provider_event_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    coherentWatermark: check(
      "sender_states_coherent_conversation_watermark",
      sql`
        (${table.conversationOccurredAt} is null) =
        (${table.conversationProviderEventId} is null)
      `,
    ),
  }),
);

export const smsMessages = pgTable(
  "sms_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerMessageId: text("provider_message_id").notNull(),
    senderHash: text("sender_hash")
      .notNull()
      .references(() => contacts.phoneHash, { onDelete: "restrict" }),
    body: text("body"),
    bodyExpiresAt: timestamp("body_expires_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    providerMessageUnique: unique("sms_messages_provider_message_unique").on(
      table.providerMessageId,
    ),
    retainedBodyHasExpiry: check(
      "sms_messages_retained_body_has_expiry",
      sql`
        (
          ${table.body} is null
          and ${table.bodyExpiresAt} is null
        )
        or (
          ${table.body} is not null
          and ${table.bodyExpiresAt} is not null
          and ${table.bodyExpiresAt} > ${table.receivedAt}
        )
      `,
    ),
  }),
);

export const providerInboxEvents = pgTable(
  "provider_inbox_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: providerEventType("event_type")
      .notNull()
      .default("message_received"),
    // Inbound projection: only a received event retains a message and a sender.
    messageId: uuid("message_id").references(() => smsMessages.id, {
      onDelete: "restrict",
    }),
    senderHash: text("sender_hash").references(() => contacts.phoneHash, {
      onDelete: "restrict",
    }),
    // Delivery projection: only a delivery event correlates to an outbound attempt.
    dispatchAttemptId: uuid("dispatch_attempt_id"),
    deliveryStatus: deliveryStatus("delivery_status"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    state: inboxProcessingState("state").notNull().default("pending"),
    claimToken: uuid("claim_token"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    failureCode: text("failure_code"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    providerEventUnique: unique(
      "provider_inbox_events_provider_event_unique",
    ).on(table.providerEventId),
    messageUnique: unique("provider_inbox_events_message_unique").on(
      table.messageId,
    ),
    dispatchAttemptReference: foreignKey({
      name: "provider_inbox_events_dispatch_attempt_fk",
      columns: [table.dispatchAttemptId],
      foreignColumns: [outboxDispatchAttempts.id],
    }).onDelete("restrict"),
    // Sender claiming and conversation ordering are inbound-only; delivery callbacks
    // use the same durable event mechanism without entering conversation state.
    oneProcessingClaimPerSender: uniqueIndex(
      "provider_inbox_events_one_processing_claim_per_sender",
    )
      .on(table.senderHash)
      .where(
        sql`${table.state} = 'processing' and ${table.eventType} = 'message_received'`,
      ),
    minimalProjectionPerEventType: check(
      "provider_inbox_events_minimal_projection_per_event_type",
      sql`
        (
          ${table.eventType} = 'message_received'
          and ${table.messageId} is not null
          and ${table.senderHash} is not null
          and ${table.dispatchAttemptId} is null
          and ${table.deliveryStatus} is null
        )
        or (
          ${table.eventType} in ('message_sent', 'message_finalized')
          and ${table.messageId} is null
          and ${table.senderHash} is null
          and ${table.dispatchAttemptId} is not null
          and ${table.deliveryStatus} is not null
        )
      `,
    ),
    occurredOrder: index("provider_inbox_events_sender_order").on(
      table.senderHash,
      table.occurredAt,
      table.providerEventId,
    ),
    coherentClaimState: check(
      "provider_inbox_events_coherent_claim_state",
      sql`
        (
          ${table.state} = 'pending'
          and ${table.claimToken} is null
          and ${table.claimedAt} is null
          and ${table.claimExpiresAt} is null
          and ${table.finalizedAt} is null
          and ${table.failureCode} is null
        )
        or (
          ${table.state} = 'processing'
          and ${table.claimToken} is not null
          and ${table.claimedAt} is not null
          and ${table.claimExpiresAt} > ${table.claimedAt}
          and ${table.finalizedAt} is null
          and ${table.failureCode} is null
        )
        or (
          ${table.state} = 'processed'
          and ${table.claimToken} is null
          and ${table.claimExpiresAt} is null
          and ${table.finalizedAt} is not null
          and ${table.failureCode} is null
        )
        or (
          ${table.state} = 'rejected'
          and ${table.claimToken} is null
          and ${table.claimExpiresAt} is null
          and ${table.finalizedAt} is not null
          and ${table.failureCode} is not null
        )
      `,
    ),
  }),
);

export const smsConsents = pgTable(
  "sms_consents",
  {
    recipientHash: text("recipient_hash")
      .primaryKey()
      .references(() => contacts.phoneHash, { onDelete: "restrict" }),
    state: consentState("state").notNull(),
    captureSource: consentCaptureSource("capture_source"),
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    captureEvidenceRef: text("capture_evidence_ref"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    coherentCapture: check(
      "sms_consents_coherent_capture",
      sql`
        (
          ${table.captureSource} is null
          and ${table.capturedAt} is null
          and ${table.captureEvidenceRef} is null
        )
        or (
          ${table.captureSource} is not null
          and ${table.capturedAt} is not null
          and ${table.captureEvidenceRef} is not null
          and length(trim(${table.captureEvidenceRef})) > 0
        )
      `,
    ),
    activeHasCapture: check(
      "sms_consents_active_has_capture",
      sql`${table.state} <> 'active' or ${table.captureSource} is not null`,
    ),
  }),
);

export const consentTransitionWatermarks = pgTable(
  "consent_transition_watermarks",
  {
    recipientHash: text("recipient_hash")
      .primaryKey(),
    transition: consentTransition("transition").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    providerEventId: text("provider_event_id").notNull(),
  },
  (table) => ({
    recipientReference: foreignKey({
      name: "consent_transition_recipient_fk",
      columns: [table.recipientHash],
      foreignColumns: [contacts.phoneHash],
    }).onDelete("restrict"),
    providerEventUnique: unique(
      "consent_transition_watermarks_provider_event_unique",
    ).on(table.providerEventId),
  }),
);

export const outboxWork = pgTable(
  "outbox_work",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    logicalKey: text("logical_key").notNull(),
    recipientHash: text("recipient_hash")
      .notNull()
      .references(() => contacts.phoneHash, { onDelete: "restrict" }),
    // One bounded category replaces the old free-text `message_kind` plus the
    // `is_required` boolean: two overlapping ways to say the same thing, neither of
    // which the consent gate could read as a type. The dispatch claim reads this.
    messageCategory: messageCategory("message_category").notNull(),
    body: text("body").notNull(),
    bodyExpiresAt: timestamp("body_expires_at", {
      withTimezone: true,
    }).notNull(),
    state: outboxState("state").notNull().default("queued"),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
    dispatchAuthorizedAt: timestamp("dispatch_authorized_at", {
      withTimezone: true,
    }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // Carrier delivery outcome, advanced monotonically by provider occurrence time.
    // This is reported delivery state, never an exactly-once delivery claim.
    deliveryStatus: deliveryStatus("delivery_status"),
    deliveryOccurredAt: timestamp("delivery_occurred_at", {
      withTimezone: true,
    }),
    deliveryEventId: text("delivery_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    logicalKeyUnique: unique("outbox_work_logical_key_unique").on(
      table.logicalKey,
    ),
    recipientStateQueue: index("outbox_work_recipient_state_queue").on(
      table.recipientHash,
      table.state,
      table.availableAt,
    ),
    bodyExpiresAfterCreation: check(
      "outbox_work_body_expires_after_creation",
      sql`${table.bodyExpiresAt} > ${table.createdAt}`,
    ),
    deliveryWatermarkCoherent: check(
      "outbox_work_delivery_watermark_coherent",
      sql`
        (
          ${table.deliveryStatus} is null
          and ${table.deliveryOccurredAt} is null
          and ${table.deliveryEventId} is null
        )
        or (
          ${table.deliveryStatus} is not null
          and ${table.deliveryOccurredAt} is not null
          and ${table.deliveryEventId} is not null
          and ${table.dispatchAuthorizedAt} is not null
        )
      `,
    ),
    coherentState: check(
      "outbox_work_coherent_state",
      sql`
        (
          ${table.state} = 'queued'
          and ${table.dispatchAuthorizedAt} is null
          and ${table.completedAt} is null
        )
        or (
          ${table.state} = 'dispatching'
          and ${table.dispatchAuthorizedAt} is not null
          and ${table.completedAt} is null
        )
        or (
          ${table.state} in ('sent', 'failed', 'ambiguous')
          and ${table.dispatchAuthorizedAt} is not null
          and ${table.completedAt} is not null
        )
        or (
          ${table.state} = 'suppressed'
          and ${table.dispatchAuthorizedAt} is null
          and ${table.completedAt} is not null
        )
      `,
    ),
  }),
);

export const outboxDispatchAttempts = pgTable(
  "outbox_dispatch_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    outboxWorkId: uuid("outbox_work_id")
      .notNull()
      .references(() => outboxWork.id, { onDelete: "restrict" }),
    attemptNumber: integer("attempt_number").notNull(),
    state: dispatchAttemptState("state").notNull(),
    providerMessageId: text("provider_message_id"),
    errorCode: text("error_code"),
    // B-010 — diagnostics, never dispatch inputs.
    //
    // `error_code` alone names a category and not a cause, which cost hours twice on
    // 2026-07-27: a stored '400' was really "The source phone number was deemed invalid by
    // the carrier", and a '409' was really Telnyx code 40300, "Blocked due to STOP message".
    // Both were recovered by curling the provider by hand.
    //
    // Deliberately NOT covered by `coherentResult` below: they are best-effort. A provider
    // that returns an unparseable body must still be able to record a rejection, so making
    // them mandatory would turn a malformed error into a failed write.
    //
    // `provider_error_detail` is phone-masked and length-bounded before it arrives here
    // (`summarizeProviderError`) — the raw 40300 body contains two E.164 numbers, and
    // Golden Rule #5 permits exactly one raw-phone column, which this is not.
    providerCode: text("provider_code"),
    providerErrorDetail: text("provider_error_detail"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    attemptUnique: unique("outbox_dispatch_attempts_number_unique").on(
      table.outboxWorkId,
      table.attemptNumber,
    ),
    providerMessageUnique: unique(
      "outbox_dispatch_attempts_provider_message_unique",
    ).on(table.providerMessageId),
    boundedAttemptNumber: check(
      "outbox_dispatch_attempts_bounded_number",
      sql`${table.attemptNumber} between 1 and 3`,
    ),
    coherentResult: check(
      "outbox_dispatch_attempts_coherent_result",
      sql`
        (
          ${table.state} = 'authorized'
          and ${table.completedAt} is null
          and ${table.providerMessageId} is null
          and ${table.errorCode} is null
        )
        or (
          ${table.state} = 'accepted'
          and ${table.completedAt} is not null
          and ${table.providerMessageId} is not null
          and ${table.errorCode} is null
        )
        or (
          ${table.state} in ('definitive_rejection', 'ambiguous')
          and ${table.completedAt} is not null
          and ${table.errorCode} is not null
        )
      `,
    ),
  }),
);

export const inventoryPublicationProposals = pgTable(
  "inventory_publication_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    senderHash: text("sender_hash").notNull(),
    salesLocationId: uuid("sales_location_id").notNull(),
    /**
     * WHICH provider's listing this confirmation answers for (F-114 Phase B item 6).
     *
     * The confirmation token is context-bound, and this is what it is now bound TO. Without it
     * a `YES` from someone affiliated with two sellers at one stand is ambiguous about which
     * listing it publishes.
     *
     * **NULL only for a venue's closure-only proposal** (F-114 C.2 / B-077, `0046`). Morgan Hill
     * has no provider of its own and a closure is not any provider's listing, so the token binds
     * to the STAND there — the same two-arm shape `closure_revisions` itself takes. Naming one
     * of the venue's hosted sellers instead would bind the token to goods the closure is not
     * about, and would let that seller's `YES` publish the venue's shutter.
     * `inventory_proposals_provider_arm` keeps it to exactly that case.
     */
    providerId: uuid("provider_id"),
    payload: jsonb("payload").notNull(),
    proposalVersion: integer("proposal_version").notNull(),
    state: proposalState("state").notNull().default("open"),
    // A proposal may carry inventory, closure, or both. Every writer states both sections.
    hasInventory: boolean("has_inventory").notNull(),
    hasClosure: boolean("has_closure").notNull(),
    // The complete pending snapshot is bound to the base it was computed from, so a
    // newer publication invalidates it rather than being silently overwritten.
    baseRevisionId: uuid("base_revision_id"),
    baseIsFirstPublication: boolean("base_is_first_publication"),
    closureBaseRevisionId: uuid("closure_base_revision_id"),
    closureBaseIsFirstInstruction: boolean("closure_base_is_first_instruction"),
    // Expiry is activation-relative: the 12-hour window starts only when Telnyx
    // accepts the current prompt, so an unactivated proposal has no live window.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    activationOutboxId: uuid("activation_outbox_id"),
    activatedVersion: integer("activated_version"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    /**
     * The version at which the RE-OPENING consequence was stated to the farmer (F-114 C.4).
     *
     * §facts and authority: a paused listing's update triggers a confirmation stating that
     * publishing will re-open the listing, and the farmer answers it with an ordinary `YES`
     * (max, 2026-08-16) rather than a new keyword. That makes the `YES` ambiguous on its own,
     * so the fact that the sentence was sent is stored rather than inferred.
     *
     * The VERSION, not a boolean: a revision bumps `proposal_version` and clears the
     * activation, so a boolean would let consent survive into an ordinary prompt that never
     * mentioned re-opening. NULL means it was never stated — the ordinary case.
     */
    reopeningStatedVersion: integer("reopening_stated_version"),
    consumedToken: proposalToken("consumed_token"),
    consumptionProviderEventId: text("consumption_provider_event_id"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    senderReference: foreignKey({
      name: "inventory_proposals_sender_fk",
      columns: [table.senderHash],
      foreignColumns: [contacts.phoneHash],
    }).onDelete("restrict"),
    /** F-114 Phase B item 2 — re-rooted from the stand alone to `(provider, location)`. */
    locationProviderReference: foreignKey({
      name: "inventory_proposals_location_provider_fk",
      columns: [table.providerId, table.salesLocationId],
      foreignColumns: [standProviders.id, standProviders.salesLocationId],
    }).onDelete("restrict"),
    activationOutboxReference: foreignKey({
      name: "inventory_proposals_activation_outbox_fk",
      columns: [table.activationOutboxId],
      foreignColumns: [outboxWork.id],
    }).onDelete("restrict"),
    /**
     * ONE open confirmation per person PER PROVIDER-AT-STAND (F-114 Phase B item 6).
     *
     * This fixes a defect that predates the multi-seller work. Keyed on `sender_hash` alone,
     * the limit on pending SMS changes was per PERSON, not per target: someone affiliated with
     * sellers at two stands who texted an update for one was locked out of the other until they
     * replied YES or NO. Multi-seller people are exactly the population this refactor serves.
     *
     * The golden rule is unchanged and in fact better served — a confirmation token stays
     * context- and version-bound, commits exactly once, and expires — but a token can no longer
     * be ambiguous about which listing it answers for.
     *
     * `sales_location_id` is in the key even though `provider_id` already determines it. The
     * index is what a writer's `on conflict` names, and naming the pair the caller actually
     * holds keeps the arbiter reachable without a preceding lookup.
     */
    oneOpenPerSenderPerProvider: uniqueIndex(
      "inventory_publication_proposals_one_open_per_provider",
    )
      .on(table.senderHash, table.salesLocationId, table.providerId)
      .where(sql`${table.state} = 'open'`),
    /**
     * The provider is optional only where there is genuinely none to name (F-114 C.2, `0046`).
     *
     * A proposal that refreshes inventory always has a listing, so it always names one. Only a
     * closure-only proposal may omit it, and only a venue's actually does — an ordinary stand's
     * closure still names its own listing, because it has one.
     *
     * Stated as an implication rather than a biconditional, deliberately: the converse (a
     * closure-only proposal that DOES name a provider) is the ordinary case at all 38 stands,
     * not a failure.
     */
    providerArm: check(
      "inventory_proposals_provider_arm",
      sql`${table.providerId} is not null or ${table.hasInventory} = false`,
    ),
    /**
     * A version is a version (F-114 C.4). Without this a `0` or a negative value would compare
     * equal to no `proposal_version` and silently disable the consent forever — a farmer who
     * was shown the re-opening sentence would be shown it again on every reply.
     */
    reopeningStatedVersionPositive: check(
      "inventory_proposals_reopening_stated_version_positive",
      sql`${table.reopeningStatedVersion} is null or ${table.reopeningStatedVersion} > 0`,
    ),
    activationOutboxUnique: unique(
      "inventory_publication_proposals_activation_outbox_unique",
    ).on(table.activationOutboxId),
    consumptionEventUnique: unique(
      "inventory_publication_proposals_consumption_event_unique",
    ).on(table.consumptionProviderEventId),
    positiveVersion: check(
      "inventory_publication_proposals_positive_version",
      sql`${table.proposalVersion} > 0`,
    ),
    objectPayload: check(
      "inventory_publication_proposals_object_payload",
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
    // The (base_revision_id, sales_location_id) foreign key to inventory_revisions is
    // declared in SQL by the migration rather than here: inventory_revisions already
    // references this table through proposal_id, and expressing both edges in Drizzle
    // creates a circular initializer TypeScript cannot infer.
    baseBindingCoherent: check(
      "inventory_publication_proposals_base_binding_coherent",
      sql`
        (
          ${table.hasInventory}
          and ${table.baseIsFirstPublication} is not null
          and (
            (${table.baseIsFirstPublication} and ${table.baseRevisionId} is null)
            or (not ${table.baseIsFirstPublication} and ${table.baseRevisionId} is not null)
          )
        )
        or (
          not ${table.hasInventory}
          and ${table.baseIsFirstPublication} is null
          and ${table.baseRevisionId} is null
        )
      `,
    ),
    atLeastOneSection: check(
      "inventory_publication_proposals_at_least_one_section",
      sql`${table.hasInventory} or ${table.hasClosure}`,
    ),
    closureBaseBindingCoherent: check(
      "inventory_publication_proposals_closure_base_binding_coherent",
      sql`
        (
          ${table.hasClosure}
          and ${table.closureBaseIsFirstInstruction} is not null
          and (
            (
              ${table.closureBaseIsFirstInstruction}
              and ${table.closureBaseRevisionId} is null
            )
            or (
              not ${table.closureBaseIsFirstInstruction}
              and ${table.closureBaseRevisionId} is not null
            )
          )
        )
        or (
          not ${table.hasClosure}
          and ${table.closureBaseIsFirstInstruction} is null
          and ${table.closureBaseRevisionId} is null
        )
      `,
    ),
    // A live confirmation window exists only once its current prompt is accepted.
    activationCoherent: check(
      "inventory_publication_proposals_activation_coherent",
      sql`
        (
          ${table.activationOutboxId} is null
          and ${table.activatedVersion} is null
          and ${table.activatedAt} is null
          and ${table.expiresAt} is null
        )
        or (
          ${table.activationOutboxId} is not null
          and ${table.activatedVersion} is not null
          and ${table.activatedVersion} between 1 and ${table.proposalVersion}
          and ${table.activatedAt} is not null
          and ${table.expiresAt} is not null
          and ${table.expiresAt} > ${table.activatedAt}
        )
      `,
    ),
    stateCoherent: check(
      "inventory_publication_proposals_state_coherent",
      sql`
        (
          ${table.state} = 'open'
          and ${table.consumedToken} is null
          and ${table.consumptionProviderEventId} is null
          and ${table.closedAt} is null
        )
        or (
          ${table.state} = 'accepted'
          and ${table.activatedVersion} = ${table.proposalVersion}
          and ${table.activatedAt} is not null
          and ${table.consumedToken} = 'yes'
          and ${table.consumptionProviderEventId} is not null
          and ${table.closedAt} is not null
        )
        or (
          ${table.state} = 'declined'
          and ${table.activatedVersion} = ${table.proposalVersion}
          and ${table.activatedAt} is not null
          and ${table.consumedToken} = 'no'
          and ${table.consumptionProviderEventId} is not null
          and ${table.closedAt} is not null
        )
        or (
          ${table.state} in ('expired', 'invalidated')
          and ${table.consumedToken} is null
          and ${table.consumptionProviderEventId} is null
          and ${table.closedAt} is not null
        )
      `,
    ),
  }),
);

export const inventoryRevisions = pgTable(
  "inventory_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sellerId: uuid("seller_id").notNull(),
    salesLocationId: uuid("sales_location_id").notNull(),
    /**
     * WHOSE inventory this is (F-114). Every revision belongs to exactly one provider at the
     * stand — the stand's own seller or a hosted one, which are the same kind of row since
     * Phase C.0. `NOT NULL`: an unattributed revision is the anonymous shared snapshot this
     * refactor exists to end.
     */
    providerId: uuid("provider_id").notNull(),
    /**
     * The handset chain (F-063). All three are nullable in the column definition and
     * REQUIRED-or-FORBIDDEN by `sourceProvenance` below, according to `source`. Nullability
     * here is not permissiveness: it is what lets one constraint state the whole rule, instead
     * of three per-column rules that each pass on NULL.
     */
    proposalId: uuid("proposal_id"),
    publishedByAuthorizationId: uuid("published_by_authorization_id"),
    farmApprovalId: uuid("farm_approval_id"),
    source: inventoryRevisionSource("source").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    isCurrent: boolean("is_current").notNull().default(true),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (table) => ({
    idAndLocationUnique: unique(
      "inventory_revisions_id_location_unique",
    ).on(table.id, table.salesLocationId),
    proposalUnique: unique("inventory_revisions_proposal_unique").on(
      table.proposalId,
    ),
    proposalReference: foreignKey({
      name: "inventory_revisions_proposal_fk",
      columns: [table.proposalId],
      foreignColumns: [inventoryPublicationProposals.id],
    }).onDelete("restrict"),
    /**
     * ONE current revision per PROVIDER (F-114 Phase B item 3), replacing
     * `inventory_revisions_one_current_per_location`.
     *
     * This is the specific invariant per-provider inventory invalidates: keyed on the stand
     * alone, a hosted seller publishing would supersede the host's listing and vice versa. It
     * was replaced in the SAME migration that added `provider_id`, never dropped ahead of it —
     * a window with neither index is a window in which two current revisions per stand can be
     * written and never detected afterwards.
     *
     * It is also the ARBITER of a first-inventory race. `select … for update` cannot serialize
     * a row that does not exist yet, so two concurrent first publications for one provider both
     * find nothing and both insert; `insert … on conflict do nothing returning id` lets exactly
     * one win, and the loser's empty result is how it learns it lost. Each claimant needs its
     * OWN provider row — claimants sharing a stand parent serialize at the first read and
     * measure the wrong lock.
     */
    oneCurrentPerProvider: uniqueIndex(
      "inventory_revisions_one_current_per_provider",
    )
      .on(table.providerId)
      .where(sql`${table.isCurrent}`),
    /**
     * F-114 Phase B item 2 — authority re-rooted from `(location, owner_farm)` to
     * `(location, provider)`. A revision belongs to a provider AT this stand; stand ownership
     * no longer carries publication authority, because the publisher may be a hosted seller
     * the owner does not control.
     */
    locationProviderReference: foreignKey({
      name: "inventory_revisions_location_provider_fk",
      columns: [table.providerId, table.salesLocationId],
      foreignColumns: [standProviders.id, standProviders.salesLocationId],
    }).onDelete("restrict"),
    /**
     * The seller is the PROVIDER'S seller (F-114 Phase C.2, migration `0045`).
     *
     * This replaces `inventory_revisions_location_own_seller_fk`, which keyed
     * `(sales_location_id, seller_id)` onto the stand's self-pointer and therefore said *every
     * revision's seller is the stand's own seller*. True of 38 of 38 stands when it was
     * written, and structurally forbidding the hosted publication this phase exists to build.
     *
     * Whose goods these are is decided by the RELATIONSHIP, never by who owns the roof. With
     * `locationProviderReference` beside it, a revision belongs to one real relationship at one
     * real stand for the seller that relationship names.
     */
    providerSellerReference: foreignKey({
      name: "inventory_revisions_provider_seller_fk",
      columns: [table.providerId, table.sellerId],
      foreignColumns: [standProviders.id, standProviders.sellerId],
    }).onDelete("restrict"),
    /**
     * A plain reference since `0045`, widened from `(authorization, seller)`.
     *
     * The composite form said the publisher's authorization must name the seller being
     * published — which refuses exactly the write §the Venison Valley case permits, where a
     * host states a hosted seller's stock under that seller's own opt-in. The database cannot
     * decide who may publish for whom: the answer is two LIVE facts, the relationship's
     * `host_may_update_stock` and the authorization's revocation, and a static key sees
     * neither. `resolveProviderWriteAuthority` is the one place that answers it.
     *
     * What survives is the half that was never the problem: a revision naming a publisher who
     * is not a real authorization would be an audit trail pointing at nothing.
     */
    authorizationReference: foreignKey({
      name: "inventory_revisions_authorization_fk",
      columns: [table.publishedByAuthorizationId],
      foreignColumns: [farmerAuthorizations.id],
    }).onDelete("restrict"),
    approvalFarmReference: foreignKey({
      name: "inventory_revisions_approval_farm_fk",
      columns: [table.farmApprovalId, table.sellerId],
      foreignColumns: [sellerApprovals.id, sellerApprovals.sellerId],
    }).onDelete("restrict"),
    currentStateCoherent: check(
      "inventory_revisions_current_state_coherent",
      sql`
        (
          ${table.isCurrent}
          and ${table.supersededAt} is null
        )
        or (
          not ${table.isCurrent}
          and ${table.supersededAt} > ${table.publishedAt}
        )
      `,
    ),
    // F-063 — the handset keys are all-or-nothing, according to `source`. Written as one
    // biconditional over all three because a CHECK PASSES on NULL: three independent
    // per-column rules would silently admit the half-populated row this exists to refuse.
    sourceProvenance: check(
      "inventory_revisions_source_keys_coherent",
      sql`
        (
          ${table.source} = 'sms'
          and ${table.proposalId} is not null
          and ${table.publishedByAuthorizationId} is not null
          and ${table.farmApprovalId} is not null
        )
        or (
          ${table.source} = 'web'
          and ${table.proposalId} is null
          and ${table.publishedByAuthorizationId} is not null
          and ${table.farmApprovalId} is not null
        )
        or (
          ${table.source} = 'viga'
          and ${table.proposalId} is null
          and ${table.publishedByAuthorizationId} is null
          and ${table.farmApprovalId} is null
        )
      `,
    ),
  }),
);

export const inventoryEntries = pgTable(
  "inventory_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    inventoryRevisionId: uuid("inventory_revision_id").notNull(),
    salesLocationId: uuid("sales_location_id").notNull(),
    itemName: text("item_name").notNull(),
    quantity: doublePrecision("quantity"),
    unit: text("unit"),
    priceText: text("price_text"),
    approximation: inventoryApproximation("approximation"),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => ({
    idAndLocationUnique: unique(
      "inventory_entries_id_location_unique",
    ).on(table.id, table.salesLocationId),
    revisionLocationReference: foreignKey({
      name: "inventory_entries_revision_location_fk",
      columns: [table.inventoryRevisionId, table.salesLocationId],
      foreignColumns: [
        inventoryRevisions.id,
        inventoryRevisions.salesLocationId,
      ],
    }).onDelete("restrict"),
    itemNotBlank: check(
      "inventory_entries_item_not_blank",
      sql`length(trim(${table.itemName})) > 0`,
    ),
    validQuantity: check(
      "inventory_entries_valid_quantity",
      sql`${table.quantity} is null or ${table.quantity} >= 0`,
    ),
    nonnegativeSortOrder: check(
      "inventory_entries_nonnegative_sort_order",
      sql`${table.sortOrder} >= 0`,
    ),
  }),
);

/** Append-only owner-confirmed location closure/reopening history (F-049). */
export const closureRevisions = pgTable(
  "closure_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The stand's own seller, when it has one — NULL for a venue (F-114 C.2 / B-077, `0046`).
     *
     * Closure is a STAND fact, so it is recorded the way the authority to record it is: two
     * arms, mirroring `farmer_authorizations`. All three of these columns were NOT NULL and all
     * routed through the self-pointer, so Morgan Hill Community Stand — a venue with no seller
     * of its own — could hold none of them and **could not record a closure at all**.
     *
     * Optional is not free. `closure_revisions_owner_arm` requires this and the approval
     * together, and the `closure_revisions_guard_arm` trigger makes the STAND decide which arm
     * the row takes, so a stand that has its own seller cannot pick the weaker one.
     */
    ownerSellerId: uuid("owner_seller_id"),
    salesLocationId: uuid("sales_location_id").notNull(),
    proposalId: uuid("proposal_id").notNull(),
    /**
     * NOT NULL in BOTH arms. A closure always has a person behind it, and which arm they hold
     * does not change that — the stand arm drops the seller, never the person.
     */
    ownerAuthorizationId: uuid("owner_authorization_id").notNull(),
    /**
     * VIGA's approval OF the stand's own seller — NULL for a venue, with the seller.
     *
     * A venue has no seller-approval to name because approval gates whether a SELLER may be
     * public, and a venue sells nothing. Requiring one would re-invent exactly the fabricated
     * seller §the stand-and-sellers correction removed.
     */
    ownerApprovalId: uuid("owner_approval_id"),
    result: closureResult("result").notNull(),
    closureKind: closureKind("closure_kind"),
    startsOn: date("starts_on", { mode: "string" }),
    closedThrough: date("closed_through", { mode: "string" }),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    isCurrent: boolean("is_current").notNull().default(true),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (table) => ({
    idAndLocationUnique: unique("closure_revisions_id_location_unique").on(
      table.id,
      table.salesLocationId,
    ),
    proposalUnique: unique("closure_revisions_proposal_unique").on(table.proposalId),
    proposalReference: foreignKey({
      name: "closure_revisions_proposal_fk",
      columns: [table.proposalId],
      foreignColumns: [inventoryPublicationProposals.id],
    }).onDelete("restrict"),
    oneCurrentPerLocation: uniqueIndex("closure_revisions_one_current_per_location")
      .on(table.salesLocationId)
      .where(sql`${table.isCurrent}`),
    locationOwnerReference: foreignKey({
      name: "closure_revisions_location_owner_fk",
      columns: [table.salesLocationId, table.ownerSellerId],
      foreignColumns: [salesLocations.id, salesLocations.ownSellerId],
    }).onDelete("restrict"),
    authorizationOwnerReference: foreignKey({
      name: "closure_revisions_authorization_owner_fk",
      columns: [table.ownerAuthorizationId, table.ownerSellerId],
      foreignColumns: [farmerAuthorizations.id, farmerAuthorizations.sellerId],
    }).onDelete("restrict"),
    approvalOwnerReference: foreignKey({
      name: "closure_revisions_approval_owner_fk",
      columns: [table.ownerApprovalId, table.ownerSellerId],
      foreignColumns: [sellerApprovals.id, sellerApprovals.sellerId],
    }).onDelete("restrict"),
    resultShape: check(
      "closure_revisions_result_shape",
      sql`
        (
          ${table.result} = 'reopen'
          and ${table.closureKind} is null
          and ${table.startsOn} is null
          and ${table.closedThrough} is null
        )
        or (
          ${table.result} = 'close'
          and ${table.closureKind} is not null
          and ${table.startsOn} is not null
        )
      `,
    ),
    /**
     * The seller and its approval are named together or not at all (F-114 C.2, `0046`).
     *
     * A BICONDITIONAL, because a CHECK PASSES on NULL and both directions are real failures: a
     * seller without its approval publishes a closure VIGA never approved that seller for, and
     * an approval without its seller files one under nobody named on the row.
     *
     * **Which arm the row must take is not stated here** — that rule reads
     * `sales_locations.own_seller_id`, so it is the `closure_revisions_guard_arm` trigger.
     * Without it the venue's arm would be an escape hatch: any stand could file a stand-armed
     * closure and skip the approval gate entirely.
     */
    ownerArm: check(
      "closure_revisions_owner_arm",
      sql`(${table.ownerSellerId} is null) = (${table.ownerApprovalId} is null)`,
    ),
    seasonalHasNoEnd: check(
      "closure_revisions_seasonal_has_no_end",
      sql`${table.closureKind} is null or ${table.closureKind} <> 'seasonal' or ${table.closedThrough} is null`,
    ),
    endNotBeforeStart: check(
      "closure_revisions_end_not_before_start",
      sql`${table.closedThrough} is null or (${table.startsOn} is not null and ${table.closedThrough} >= ${table.startsOn})`,
    ),
    currentStateCoherent: check(
      "closure_revisions_current_state_coherent",
      sql`
        (${table.isCurrent} and ${table.supersededAt} is null)
        or (
          not ${table.isCurrent}
          and ${table.supersededAt} is not null
          and ${table.supersededAt} > ${table.publishedAt}
        )
      `,
    ),
  }),
);

/**
 * Exact durable meaning of one scheduled prompt. Dispatch joins this row and revalidates
 * every basis; it never parses a category or logical key to reconstruct authority.
 */
export const scheduledInventoryPromptSubjects = pgTable(
  "scheduled_inventory_prompt_subjects",
  {
    proposalId: uuid("proposal_id").primaryKey(),
    proposalVersion: integer("proposal_version").notNull(),
    preferenceId: uuid("preference_id").notNull(),
    preferenceVersion: integer("preference_version").notNull(),
    authorizationId: uuid("authorization_id").notNull(),
    ownerSellerId: uuid("owner_seller_id").notNull(),
    salesLocationId: uuid("sales_location_id").notNull(),
    /** Whose listing this scheduled prompt asks about (F-114 Phase B). */
    providerId: uuid("provider_id").notNull(),
    inventoryBaseRevisionId: uuid("inventory_base_revision_id"),
    closureBaseRevisionId: uuid("closure_base_revision_id"),
    closureBaseIsFirstInstruction: boolean(
      "closure_base_is_first_instruction",
    ).notNull(),
    dueSlotAt: timestamp("due_slot_at", { withTimezone: true }).notNull(),
    outboxWorkId: uuid("outbox_work_id").notNull(),
    offersSame: boolean("offers_same").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    proposalReference: foreignKey({
      name: "scheduled_prompt_subjects_proposal_fk",
      columns: [table.proposalId],
      foreignColumns: [inventoryPublicationProposals.id],
    }).onDelete("restrict"),
    preferenceReference: foreignKey({
      name: "scheduled_prompt_subjects_preference_fk",
      columns: [table.preferenceId],
      foreignColumns: [inventoryPromptPreferences.id],
    }).onDelete("restrict"),
    authorizationOwnerReference: foreignKey({
      name: "scheduled_prompt_subjects_authorization_owner_fk",
      columns: [table.authorizationId, table.ownerSellerId],
      foreignColumns: [farmerAuthorizations.id, farmerAuthorizations.sellerId],
    }).onDelete("restrict"),
    /** F-114 Phase B item 2 — re-rooted to `(provider, location)`. */
    locationProviderReference: foreignKey({
      name: "scheduled_prompt_subjects_location_provider_fk",
      columns: [table.providerId, table.salesLocationId],
      foreignColumns: [standProviders.id, standProviders.salesLocationId],
    }).onDelete("restrict"),
    /**
     * Whose prompt this is is decided by the RELATIONSHIP (F-114 Phase C.4, `0049`).
     *
     * Replaces `scheduled_prompt_subjects_location_own_seller_fk` — *the seller a prompt is
     * about must be the seller that owns the stand* — the last of the eight
     * `*_location_own_seller_fk` keys that had to move, and the third replaced after
     * `inventory_revisions` (`0045`) and `inventory_prompt_preferences` (`0048`). Like both of
     * those it lived only in `0042` and never in this file, so a hosted write was the only way
     * to find it.
     *
     * The two keys on `closure_revisions` and `sales_location_participants` deliberately STAY:
     * they carry facts about the place, not about anyone's goods.
     */
    providerSellerReference: foreignKey({
      name: "scheduled_prompt_subjects_provider_seller_fk",
      columns: [table.providerId, table.ownerSellerId],
      foreignColumns: [standProviders.id, standProviders.sellerId],
    }).onDelete("restrict"),
    inventoryBaseReference: foreignKey({
      name: "scheduled_prompt_subjects_inventory_base_fk",
      columns: [table.inventoryBaseRevisionId, table.salesLocationId],
      foreignColumns: [inventoryRevisions.id, inventoryRevisions.salesLocationId],
    }).onDelete("restrict"),
    closureBaseReference: foreignKey({
      name: "scheduled_prompt_subjects_closure_base_fk",
      columns: [table.closureBaseRevisionId, table.salesLocationId],
      foreignColumns: [closureRevisions.id, closureRevisions.salesLocationId],
    }).onDelete("restrict"),
    outboxReference: foreignKey({
      name: "scheduled_prompt_subjects_outbox_fk",
      columns: [table.outboxWorkId],
      foreignColumns: [outboxWork.id],
    }).onDelete("restrict"),
    preferenceSlotUnique: unique(
      "scheduled_prompt_subjects_preference_due_slot_unique",
    ).on(table.preferenceId, table.dueSlotAt),
    outboxUnique: unique("scheduled_prompt_subjects_outbox_unique").on(
      table.outboxWorkId,
    ),
    positiveVersions: check(
      "scheduled_prompt_subjects_positive_versions",
      sql`${table.proposalVersion} > 0 and ${table.preferenceVersion} > 0`,
    ),
    visibleSnapshotForSame: check(
      "scheduled_prompt_subjects_visible_snapshot_for_same",
      sql`not ${table.offersSame} or ${table.inventoryBaseRevisionId} is not null`,
    ),
    closureBaseCoherent: check(
      "scheduled_prompt_subjects_closure_base_coherent",
      sql`
        (${table.closureBaseIsFirstInstruction} and ${table.closureBaseRevisionId} is null)
        or (not ${table.closureBaseIsFirstInstruction} and ${table.closureBaseRevisionId} is not null)
      `,
    ),
  }),
);

export const stockOutReports = pgTable(
  "stock_out_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    salesLocationId: uuid("sales_location_id")
      .notNull()
      .references(() => salesLocations.id, { onDelete: "restrict" }),
    referencedInventoryEntryId: uuid("referenced_inventory_entry_id"),
    /**
     * B-057 — the report matched one of the stand's USUAL offerings rather than its currently
     * published inventory.
     *
     * A separate column rather than a widening of the entry reference, because the two are
     * different facts and VIGA's queue must be able to tell them apart: an inventory entry
     * carries a farmer's confirmation time, a stand item is a standing claim with none. Which
     * one a report matched is exactly what an operator needs to judge it.
     *
     * Measured on the production corpus 2026-08-11: 33 of 37 stands carry at least one usual
     * offering absent from their published inventory, and 18 stands publish no inventory at
     * all — so this is the common case, not a fallback for stragglers.
     */
    referencedStandItemId: uuid("referenced_stand_item_id"),
    unlistedItemText: text("unlisted_item_text"),
    /**
     * The reporting EVENT this report came from, when the surface has a stable one — an
     * inbound SMS provider event id (F-104). Unique, so a redelivered message records one
     * report and texts the farmer once.
     *
     * NULLABLE, and the null is load-bearing: Postgres treats NULLs as distinct in a unique
     * index, so every keyless report (a web form, where two submissions are two people) stays
     * its own row while keyed ones deduplicate.
     */
    reportKey: text("report_key"),
    status: reportStatus("status").notNull().default("open"),
    reviewedByAdministratorId: uuid("reviewed_by_administrator_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reportedAt: timestamp("reported_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    reviewerReference: foreignKey({
      name: "stock_out_reports_reviewer_fk",
      columns: [table.reviewedByAdministratorId],
      foreignColumns: [administrators.id],
    }).onDelete("restrict"),
    entryLocationReference: foreignKey({
      name: "stock_out_reports_entry_location_fk",
      columns: [table.referencedInventoryEntryId, table.salesLocationId],
      foreignColumns: [
        inventoryEntries.id,
        inventoryEntries.salesLocationId,
      ],
    }).onDelete("restrict"),
    /**
     * B-057 — the same composite guarantee for the usual-offering reference. A report can
     * only name an item belonging to the stand the surface bound in code, so a model that
     * selected another farm's item is refused by Postgres and not merely by the caller.
     */
    standItemLocationReference: foreignKey({
      name: "stock_out_reports_stand_item_location_fk",
      columns: [table.referencedStandItemId, table.salesLocationId],
      foreignColumns: [standItems.id, standItems.salesLocationId],
    }).onDelete("restrict"),
    /**
     * One report per reporting event (F-104). This index is the ARBITER of a redelivery race,
     * not a preceding read: `select … for update` cannot serialize a row that does not exist
     * yet, so two concurrent deliveries of one inbound message would both find nothing and
     * both insert. `insert … on conflict (report_key) do nothing returning id` lets exactly
     * one win, and the loser's empty result is how it learns it lost.
     */
    reportKeyUnique: unique("stock_out_reports_report_key_unique").on(
      table.reportKey,
    ),
    /**
     * A report names its item exactly ONE way (B-057 makes it three ways, not two).
     *
     * Written as a count rather than as an enumeration of the legal combinations: three
     * columns have eight states, and spelling out the three legal ones invites a fourth
     * reference to add a branch and miss a case. The blank guard stays explicit because a
     * CHECK passes on NULL — `unlisted_item_text` of "" would otherwise satisfy "one is not
     * null" and render as an empty item.
     */
    exactlyOneItemReference: check(
      "stock_out_reports_exactly_one_item_reference",
      sql`
        (
          (${table.referencedInventoryEntryId} is not null)::int
          + (${table.referencedStandItemId} is not null)::int
          + (${table.unlistedItemText} is not null)::int
        ) = 1
        and (
          ${table.unlistedItemText} is null
          or length(trim(${table.unlistedItemText})) > 0
        )
      `,
    ),
    coherentReview: check(
      "stock_out_reports_coherent_review",
      sql`
        (
          ${table.status} = 'open'
          and ${table.reviewedByAdministratorId} is null
          and ${table.reviewedAt} is null
        )
        or (
          ${table.status} in ('reviewed', 'dismissed')
          and ${table.reviewedByAdministratorId} is not null
          and ${table.reviewedAt} is not null
        )
      `,
    ),
  }),
);

export const flags = pgTable(
  "flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contactHash: text("contact_hash").references(() => contacts.phoneHash, {
      onDelete: "restrict",
    }),
    inboxEventId: uuid("inbox_event_id").references(
      () => providerInboxEvents.id,
      { onDelete: "restrict" },
    ),
    reasonCode: text("reason_code").notNull(),
    /**
     * Where VIGA may write back, when the reporter ASKED to hear about their issue (B-091).
     *
     * Optional and reporter-supplied. Nothing sends to it automatically: it exists so a
     * coordinator reading the review item can reply, which is the only reason it was
     * collected.
     *
     * **The same discipline `seller_emails` follows** (Golden Rule #5): this is the one column
     * holding a raw address, read by a person or the send path and nothing else, with the hash
     * beside it as the lookup and log key. Never in a log line, never in model context, masked
     * in admin.
     *
     * It lives on the FLAG rather than on the contact, and that is the privacy posture: the
     * address is scoped to the one issue it was given for and disappears when the flag does.
     * A customer acquires no durable profile by reporting a problem.
     */
    reporterEmail: text("reporter_email"),
    /** The lookup and log key for `reporter_email`. Both columns move together. */
    reporterEmailHash: text("reporter_email_hash"),
    status: flagStatus("status").notNull().default("open"),
    dispositionCode: text("disposition_code"),
    disposedByAdministratorId: uuid(
      "disposed_by_administrator_id",
    ).references(() => administrators.id, { onDelete: "restrict" }),
    disposedAt: timestamp("disposed_at", { withTimezone: true }),
    /**
     * When VIGA was emailed that this flag arrived (F-123), or null if not yet.
     *
     * **The marker IS the once-only guarantee.** It is claimed in the same statement that
     * selects the flag to send — `update … where alerted_at is null returning …` — so two
     * concurrent cron passes cannot both send for one flag: the second update matches no row.
     * A preceding read plus a later write would be exactly the race that produces two emails.
     *
     * Written only after the send is ACCEPTED, so a failed send leaves it null and the next
     * pass retries. That ordering costs a possible duplicate if the process dies between the
     * mail server accepting and this committing — the right trade for an alert, where a repeat
     * is noise and a miss is a safety flag nobody reads.
     *
     * Not the SMS outbox, deliberately: that table is keyed by `recipient_hash` (a phone hash)
     * and carries SMS message categories. An email to a fixed operator address is neither.
     */
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    reasonNotBlank: check(
      "flags_reason_code_not_blank",
      sql`length(trim(${table.reasonCode})) > 0`,
    ),
    /*
      The address and its hash exist together or not at all. A raw address with no hash is
      unfindable and unloggable; a hash with no address points at something nobody can read.
      Written as one biconditional, and NOT vulnerable to the NULL trap — `is null` yields
      true or false, never NULL.
    */
    reporterEmailPaired: check(
      "flags_reporter_email_paired",
      sql`(${table.reporterEmail} is null) = (${table.reporterEmailHash} is null)`,
    ),
    reporterEmailNotBlank: check(
      "flags_reporter_email_not_blank",
      sql`
        ${table.reporterEmail} is null
        or length(btrim(${table.reporterEmail}, E' \t\r\n')) > 0
      `,
    ),
    coherentDisposition: check(
      "flags_coherent_disposition",
      sql`
        (
          ${table.status} = 'open'
          and ${table.dispositionCode} is null
          and ${table.disposedByAdministratorId} is null
          and ${table.disposedAt} is null
        )
        or (
          ${table.status} in ('resolved', 'dismissed')
          and ${table.dispositionCode} is not null
          and ${table.disposedByAdministratorId} is not null
          and ${table.disposedAt} is not null
        )
      `,
    ),
  }),
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    action: text("action").notNull(),
    actorContactHash: text("actor_contact_hash").references(
      () => contacts.phoneHash,
      { onDelete: "restrict" },
    ),
    actorAdministratorId: uuid("actor_administrator_id").references(
      () => administrators.id,
      { onDelete: "restrict" },
    ),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    actionNotBlank: check(
      "audit_events_action_not_blank",
      sql`length(trim(${table.action})) > 0`,
    ),
    subjectTypeNotBlank: check(
      "audit_events_subject_type_not_blank",
      sql`length(trim(${table.subjectType})) > 0`,
    ),
    atMostOneActor: check(
      "audit_events_at_most_one_actor",
      sql`
        ${table.actorContactHash} is null
        or ${table.actorAdministratorId} is null
      `,
    ),
  }),
);

export const modelRuns = pgTable(
  "model_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seam: text("seam").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    schemaVersion: text("schema_version").notNull(),
    validationStatus: modelValidationStatus("validation_status").notNull(),
    repairCount: integer("repair_count").notNull().default(0),
    opaqueRefs: jsonb("opaque_refs").notNull().default([]),
    latencyMs: integer("latency_ms"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costMicros: integer("cost_micros"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    repairCountValid: check(
      "model_runs_repair_count_valid",
      sql`
        ${table.repairCount} >= 0
        and (
          (${table.validationStatus} = 'repaired_then_passed' and ${table.repairCount} > 0)
          or (${table.validationStatus} <> 'repaired_then_passed' and ${table.repairCount} = 0)
        )
      `,
    ),
    nonnegativeMetrics: check(
      "model_runs_nonnegative_metrics",
      sql`
        (${table.latencyMs} is null or ${table.latencyMs} >= 0)
        and (${table.inputTokens} is null or ${table.inputTokens} >= 0)
        and (${table.outputTokens} is null or ${table.outputTokens} >= 0)
        and (${table.costMicros} is null or ${table.costMicros} >= 0)
      `,
    ),
    validTiming: check(
      "model_runs_valid_timing",
      sql`${table.completedAt} is null or ${table.completedAt} >= ${table.startedAt}`,
    ),
    opaqueRefsArray: check(
      "model_runs_opaque_refs_array",
      sql`jsonb_typeof(${table.opaqueRefs}) = 'array'`,
    ),
  }),
);

/**
 * The pending result list `MORE` pages through (F-046).
 *
 * A paged answer has to outlive the message that produced it. Max chose (2026-07-31) to
 * REPLAY the saved list rather than re-run retrieval on each `MORE`: paging is then
 * consistent — no stand appears twice or is skipped as ordering shifts — and `MORE` costs no
 * model call. The accepted tradeoff is that stock confirmed after the question was asked does
 * not appear until the customer asks again, which `expiresAt` bounds.
 *
 * **No message body and no rendered reply text.** The customer's question is untrusted inbound
 * text with a short retention life of its own; copying it here would create a second,
 * longer-lived home for it and quietly defeat that. What is stored is only what page 2 needs:
 * WHICH facts, and how far through them the sender has read. `itemsRequested` is the narrow
 * exception — the product words the interpretation seam extracted, not the sender's sentence.
 */
export const pendingResultLists = pgTable(
  "pending_result_lists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The hash, never a raw number (Golden Rule #5). Unique: one pending list per sender, so
     * a new question REPLACES the old rather than accumulating, and `MORE` is never ambiguous
     * about which list it means.
     */
    senderHash: text("sender_hash").notNull(),
    /** The ordered fact identifiers the answer selected. Opaque here; never interpreted. */
    factIds: text("fact_ids").array().notNull(),
    /** The product words the answer was about, for a later page's heading. */
    itemsRequested: text("items_requested").array().notNull(),
    /**
     * Whether the question was a general availability request rather than a search.
     *
     * Stored because the header depends on it and `MORE` must not contradict page 1. A broad
     * question names no item, so code substitutes a placeholder word into `itemsRequested` to
     * drive retrieval; a later page reading that column alone would print it as though the
     * customer had typed it. Derived state would be a guess — this is the fact.
     */
    broad: boolean("broad").notNull().default(false),
    /** How many of `factIds` the sender has already been shown. */
    offset: integer("offset").notNull().default(0),
    /**
     * How many STANDS the whole list covers, and how many have been shown (B-062).
     *
     * Both counts are in stands while `offset` and `factIds` are in facts, because one stand
     * can contribute two facts — a confirmed row and a standing offering. The customer is
     * shown stands, so the count and the window must be stands: the first live reply said
     * "1-3 of 45" over an island with 35 of them.
     */
    standTotal: integer("stand_total").notNull().default(0),
    standOffset: integer("stand_offset").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Bounds how stale a replayed list can be before the honest answer is to ask again. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    senderUnique: unique("pending_result_lists_sender_hash_unique").on(
      table.senderHash,
    ),
    /**
     * `coalesce` is required, not stylistic: `array_length` of an empty array returns NULL,
     * and a CHECK constraint PASSES on NULL — so without it this admits exactly the empty
     * array it exists to forbid. An empty list renders an empty page, which reads to a
     * customer as "no results".
     */
    notEmpty: check(
      "pending_result_lists_not_empty",
      sql`coalesce(array_length(${table.factIds}, 1), 0) > 0`,
    ),
    offsetInRange: check(
      "pending_result_lists_offset_in_range",
      sql`${table.offset} >= 0 and ${table.offset} <= coalesce(array_length(${table.factIds}, 1), 0)`,
    ),
    expiresAfterCreation: check(
      "pending_result_lists_expires_after_creation",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    senderLookup: index("pending_result_lists_sender_idx").on(
      table.senderHash,
      table.expiresAt,
    ),
  }),
);

/**
 * A stock-out report waiting on one answer from the reporter (B-065).
 *
 * **Why this exists.** Farm Friend asks "Which stand are you at?" or "What was sold out?" and
 * then, before this table, stored nothing — so the customer's answer arrived as an unrelated
 * message with half the report missing, read as a question, and dead-ended. Observed on a
 * handset 2026-08-12: a stand-out report for eggs was silently dropped after the customer
 * answered correctly.
 *
 * **It holds a QUESTION, not a conversation.** The row exists only between asking and the
 * next message from that sender. It is not general chat state, it teaches no token, and
 * nothing outside the stock-out path reads it. Two questions, two `awaiting` values; a third
 * would be a third question with its own copy.
 *
 * Deliberately NOT reachable from deterministic routing. `parseCommand` takes the body and
 * nothing else, which is what makes "no stored state can reinterpret a STOP" structural
 * rather than conventional — resolution happens inside the free-text customer branch, below
 * every compliance keyword.
 */
/**
 * A host has been asked to confirm a seller who put herself at their stand (F-117).
 *
 * ## Why this exists at all
 *
 * A seller self-selecting a stand with no way for the owner to object would let anyone list
 * goods at any stand on the island, with the owner unable to remove them. That inverts the rule
 * F-116 settled — either side may always walk away — so the host must be able to end it. Asking
 * outright is better than relying on the host noticing a stranger appeared.
 *
 * ## Answerable only while it is the LAST MESSAGE IN THE THREAD (max, 2026-08-17)
 *
 * Any other traffic in either direction — the host texting us anything, or the system sending
 * them anything — closes it. This is Golden Rule #2's requirement satisfied by CONVERSATION
 * STATE rather than by a clock: context-bound rather than global, committing exactly once, and
 * expiring. A bare `YES` can therefore never be misread against a stale question, because a
 * stale question is no longer open.
 *
 * `askedAt` is what makes that decidable: an answer counts only when nothing in `sms_messages`
 * or `outbox_work` for this host sits between it and the answer.
 *
 * **The consequence, accepted** (max): the window can be short in practice — a scheduled
 * inventory prompt sent minutes later closes it before the host has read it. That is acceptable
 * because the host's own settings screen carries the Remove control (F-101), so a closed
 * confirmation costs the host a web visit, never the ability to act.
 */
export const pendingHostConfirmations = pgTable(
  "pending_host_confirmations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The HOST's hash, never a raw number (Golden Rule #5). Unique: one open question per host,
     * so a second self-selecting seller REPLACES the first rather than leaving two rows for a
     * bare `YES` to choose between. The index is the arbiter, not a read-then-write.
     */
    hostHash: text("host_hash").notNull(),
    /** The arrangement the answer acts on. A `NO` ends exactly this one. */
    standProviderId: uuid("stand_provider_id").notNull(),
    /**
     * When the question was sent. The thread test compares against this: anything for this host
     * after it closes the question.
     */
    askedAt: timestamp("asked_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    standProviderReference: foreignKey({
      name: "pending_host_confirmations_provider_fk",
      columns: [table.standProviderId],
      foreignColumns: [standProviders.id],
    }).onDelete("cascade"),
    hostUnique: unique("pending_host_confirmations_host_hash_unique").on(
      table.hostHash,
    ),
  }),
);

export const pendingStockOutReports = pgTable(
  "pending_stock_out_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The hash, never a raw number (Golden Rule #5). Unique: one open clarification per
     * sender, so a second unfinished report REPLACES the first rather than leaving two rows
     * for the next message to choose between. The index is the arbiter, not a read-then-write.
     */
    senderHash: text("sender_hash").notNull(),
    /**
     * The reporter's ORIGINAL message — "Pinecome is out of eggs".
     *
     * This is the column that makes the eggs survive. When the follow-up supplies the stand,
     * this text supplies the item, and it flows to `recordStockOutReport`'s `taskText` —
     * exactly the untrusted-text position the first message already occupied. It is never
     * spoken back to anyone: the farmer's alert names the stand's OWN item row.
     *
     * Raw inbound customer text, and shorter-lived than the copy `sms_messages` already keeps
     * for 30 days. Deleted on resolution and on release; the retention purge is the backstop.
     */
    reportText: text("report_text").notNull(),
    /**
     * The stand, when it is the ITEM that was missing. Null when the stand is what we asked
     * for. `pending_stock_out_reports_awaiting_shape` keeps the two in step.
     */
    salesLocationId: uuid("sales_location_id"),
    /** Which question was asked, and therefore how the next message resolves. */
    awaiting: pendingStockOutAwaiting("awaiting").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * Bounds how long an answer can land. Evaluated against the MESSAGE's time, never
     * `now()` — a delayed inbound event must be judged by the clock of the message it
     * answers, the same rule `takeNextResultPage` follows.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    salesLocationReference: foreignKey({
      name: "pending_stock_out_reports_location_fk",
      columns: [table.salesLocationId],
      foreignColumns: [salesLocations.id],
    }).onDelete("cascade"),
    senderUnique: unique("pending_stock_out_reports_sender_hash_unique").on(
      table.senderHash,
    ),
    /**
     * The two arms are mutually exclusive and each is incomplete without its half: waiting on
     * an ITEM means the stand is already bound, and waiting on a STAND means it is not.
     *
     * Written as one biconditional rather than an enumeration of legal combinations, the way
     * B-057's exclusivity CHECK was rewritten. Note this is NOT vulnerable to the NULL trap:
     * `is not null` yields true or false, never NULL, so the constraint cannot pass by
     * evaluating to NULL the way a bare comparison would.
     */
    awaitingShape: check(
      "pending_stock_out_reports_awaiting_shape",
      sql`(${table.awaiting} = 'item') = (${table.salesLocationId} is not null)`,
    ),
    reportTextNotBlank: check(
      "pending_stock_out_reports_report_text_not_blank",
      sql`length(btrim(${table.reportText}, E' \t\r\n')) > 0`,
    ),
    expiresAfterCreation: check(
      "pending_stock_out_reports_expires_after_creation",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    senderLookup: index("pending_stock_out_reports_sender_idx").on(
      table.senderHash,
      table.expiresAt,
    ),
  }),
);

/**
 * The issue report waiting on the sender's YES (B-091).
 *
 * Farm Friend can now RECOGNISE that a message reports a problem with our own information —
 * a listing that misstates a stand, a map pin in the wrong place, a reply that made no sense.
 * Recognising it is a model judgement, so it commits nothing: this row holds the report while
 * a confirmation is outstanding, and code files the flag only after the sender confirms
 * (Golden Rule #3). A false positive therefore costs one question, never a false report in
 * VIGA's queue.
 *
 * **Its own table rather than a second meaning for `pending_stock_out_reports`.** That record
 * answers "which half of a stock-out is missing" and carries a bound stand and an `awaiting`
 * CHECK to prove it; an issue report has no halves and no stand. One table serving both would
 * mean a row whose columns are legal in two unrelated shapes, and the CHECK that currently
 * makes the stock-out shape provable would have to be relaxed to allow it.
 *
 * Deliberately mirrors that table's three operations — save (replacing), read, clear — and
 * its two disciplines: `sender_hash` is unique so a second recognition REPLACES the first
 * rather than leaving two rows for a YES to choose between, and expiry is evaluated against
 * the MESSAGE's time rather than `now()`.
 *
 * Holds raw inbound text, shorter-lived than the copy `sms_messages` keeps. Deleted on
 * confirmation, on refusal, and on abandonment; the retention purge is the backstop.
 */
export const pendingIssueReports = pgTable(
  "pending_issue_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The hash, never a raw number (Golden Rule #5). Unique: one open question per sender. */
    senderHash: text("sender_hash").notNull(),
    /**
     * The reporter's own message — the sentence that says what is wrong.
     *
     * This is what reaches VIGA when the sender confirms. It is never spoken back to anyone
     * else and never enters a model prompt after this point: the confirmation reply is
     * code-rendered and names no part of it.
     */
    reportText: text("report_text").notNull(),
    /**
     * The inbound event that produced the report, so the filed flag points at the message
     * DESCRIBING the problem rather than at the bare `YES`, which carries nothing readable.
     *
     * A real reference, like `flags.inbox_event_id`: a pending report naming an event that
     * does not exist would file a flag a coordinator cannot open, and `restrict` means the
     * event cannot be deleted out from under an unanswered question.
     */
    inboxEventId: uuid("inbox_event_id")
      .notNull()
      .references(() => providerInboxEvents.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * Bounds how long a YES can land. Evaluated against the MESSAGE's time, never `now()`,
     * for the same reason the stock-out record is.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    senderUnique: unique("pending_issue_reports_sender_hash_unique").on(table.senderHash),
    reportTextNotBlank: check(
      "pending_issue_reports_report_text_not_blank",
      sql`length(btrim(${table.reportText}, E' \t\r\n')) > 0`,
    ),
    expiresAfterCreation: check(
      "pending_issue_reports_expires_after_creation",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    senderLookup: index("pending_issue_reports_sender_idx").on(
      table.senderHash,
      table.expiresAt,
    ),
  }),
);
