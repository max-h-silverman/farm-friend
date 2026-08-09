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
 * `stock_out_reports.reviewed_by_administrator_id` and `farm_approvals` already work (F-065).
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
 * and weekly form state host farms as prose, with no handset behind them. A separate enum
 * rather than a shared one because the two tables' keys differ — participants carry one
 * authorization, revisions carry three — so one enum would imply a coherence rule it cannot
 * enforce for both.
 */
export const participantSource = pgEnum("participant_source", ["sms", "viga"]);

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
 * F-074 — phone numbers that may SEE test farms over SMS. Nothing else.
 *
 * This is the riskiest concept in the feature and the constraints on it are deliberate.
 * Administrators are otherwise an email + password account with **no phone identity at all**,
 * so this introduces a second way to be privileged, reachable from untrusted inbound SMS —
 * the exact surface the safety boundary exists to contain. What keeps it safe is that the
 * capability it grants is a single boolean at retrieval time: a listed sender sees test farms
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
    // rather than a plain unique, for the same reason `farm_approvals` uses one: re-listing a
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

export const farms = pgTable(
  "farms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    photoUrl: text("photo_url"),
    mapProjection: publicMapProjection("map_projection"),
    publicLatitude: doublePrecision("public_latitude"),
    publicLongitude: doublePrecision("public_longitude"),
    /**
     * F-074 — VIGA marked this whole farm as a TEST farm. NULL means a real farm.
     *
     * A test farm is absent from every public surface unless the viewer deliberately asked for
     * it: `?hidden=true` on the web, a listed sender hash over SMS. It is not a listing with a
     * warning on it — it is not there.
     *
     * On `farms` rather than `sales_locations` because the intent is "this whole farm is fake",
     * and one decision should cover every stand it has. Deliberately its OWN column rather than
     * folded into `sales_locations.is_public`, for the same reason `retired_at` is: `is_public`
     * is a listing attribute the farmer's own form rewrites on every save, so an operator
     * decision expressed through it would be silently cleared the next time anyone edited.
     *
     * It is an operator fact about a fake farm, NEVER a privacy control for a real one. A farmer
     * who does not want their address published is `contact_only` (B-024) — `?hidden=true` is a
     * guessable URL parameter, so this hides nothing from anyone determined to look.
     */
    testFarmAt: timestamp("test_farm_at", { withTimezone: true }),
    testFarmByAdministratorId: uuid("test_farm_by_administrator_id").references(
      (): AnyPgColumn => administrators.id,
      { onDelete: "restrict" },
    ),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    nameNotBlank: check("farms_name_not_blank", sql`length(trim(${table.name})) > 0`),
    /**
     * The two test-farm columns move together or not at all — the same shape as
     * `sales_locations_coherent_retirement`, and written as a full disjunction for the same
     * reason: a CHECK *passes* on NULL, so a one-directional test would admit a farm marked by
     * nobody, and only its mirror image would admit an actor recorded against a real farm.
     */
    coherentTestFarm: check(
      "farms_coherent_test_farm",
      sql`
        (${table.testFarmAt} is null and ${table.testFarmByAdministratorId} is null)
        or (${table.testFarmAt} is not null and ${table.testFarmByAdministratorId} is not null)
      `,
    ),
    projectionCoordinates: check(
      "farms_projection_coordinates_coherent",
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
 * **Verifying is not publishing** (max, 2026-08-06). Six farms answered "No" to putting contact
 * email on the printed map and two left it blank; their addresses still authenticate. That no
 * public read path selects from this table is a query property, proven by test — a schema
 * cannot enforce it.
 *
 * **Several rows per farm is the normal case, not an edge case.** Five of VIGA's 32 farms list
 * more than one address, and Lavender Hill lists three, spread across two columns of the form.
 *
 * The CHECK constraints and the normalized unique index live in `0024_farm_emails.sql` and are
 * proven to genuinely refuse in `farm-emails-migration.integration.test.ts` — drizzle-kit omits
 * CHECK constraints when generating SQL, so a constraint declared only here would be enforced
 * by nothing while this file read as though it were.
 */
export const farmEmails = pgTable(
  "farm_emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    farmId: uuid("farm_id")
      .notNull()
      .references(() => farms.id, { onDelete: "restrict" }),
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
      "farm_emails_address_not_blank",
      sql`length(btrim(${table.email}, E' \t\r\n')) > 0`,
    ),
    // A malformed hash is a row nothing can ever look up, and the miss would be silent.
    hashIsDigest: check(
      "farm_emails_hash_is_digest",
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
 * (`farmEmails.email`) read only by the send path (Golden Rule #5).
 *
 * The CHECK constraints and the partial unique index live in
 * `0025_farm_email_verifications.sql` and are proven to genuinely refuse in
 * `farm-email-verifications-migration.integration.test.ts` — drizzle-kit omits both when
 * generating SQL, so rules declared only here would be enforced by nothing.
 */
export const farmEmailVerifications = pgTable(
  "farm_email_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    farmId: uuid("farm_id")
      .notNull()
      .references(() => farms.id, { onDelete: "restrict" }),
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
      "farm_email_verifications_email_hash_is_digest",
      sql`${table.emailHash} ~ '^[0-9a-f]{64}$'`,
    ),
    codeHashIsDigest: check(
      "farm_email_verifications_code_hash_is_digest",
      sql`${table.codeHash} ~ '^[0-9a-f]{64}$'`,
    ),
    // Strict: a row expiring at the instant it was issued is dead on arrival.
    expiresAfterIssue: check(
      "farm_email_verifications_expires_after_issue",
      sql`${table.expiresAt} > ${table.issuedAt}`,
    ),
    // Passes on NULL DELIBERATELY — "not yet consumed" must be legal. Called out because the
    // same NULL semantics silently invert a guard when the intent is the opposite.
    consumedAfterIssue: check(
      "farm_email_verifications_consumed_after_issue",
      sql`${table.consumedAt} is null or ${table.consumedAt} >= ${table.issuedAt}`,
    ),
    attemptsNotNegative: check(
      "farm_email_verifications_attempts_not_negative",
      sql`${table.attemptCount} >= 0`,
    ),
    grantHashIsDigest: check(
      "farm_email_verifications_grant_hash_is_digest",
      sql`${table.grantHash} is null or ${table.grantHash} ~ '^[0-9a-f]{64}$'`,
    ),
    // A COHERENCE PAIR in both directions: the one-directional form passes on NULL and would
    // enforce nothing (0023's lesson). A grant with no expiry never ages out.
    grantCoherent: check(
      "farm_email_verifications_grant_coherent",
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
    farmId: uuid("farm_id").references(() => farms.id, { onDelete: "restrict" }),
    tokenHash: text("token_hash").notNull(),
    channel: farmerInviteChannel("channel").notNull(),
    createdByAdministratorId: uuid("created_by_administrator_id")
      .notNull()
      .references(() => administrators.id, { onDelete: "restrict" }),
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
  }),
);

export const farmerAuthorizations = pgTable(
  "farmer_authorizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    farmId: uuid("farm_id")
      .notNull()
      .references(() => farms.id, { onDelete: "restrict" }),
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
    idAndFarmUnique: unique("farmer_authorizations_id_farm_unique").on(
      table.id,
      table.farmId,
    ),
    oneActiveAuthorization: uniqueIndex(
      "farmer_authorizations_one_active_contact_per_farm",
    )
      .on(table.farmId, table.contactId)
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
    ownerFarmId: uuid("owner_farm_id").notNull(),
    salesLocationId: uuid("sales_location_id").notNull(),
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
    targetedAuthorizationReference: foreignKey({
      name: "farmer_links_targeted_authorization_owner_fk",
      columns: [table.authorizationId, table.ownerFarmId],
      foreignColumns: [farmerAuthorizations.id, farmerAuthorizations.farmId],
    }).onDelete("restrict"),
    targetedLocationReference: foreignKey({
      name: "farmer_links_targeted_location_owner_fk",
      columns: [table.salesLocationId, table.ownerFarmId],
      foreignColumns: [salesLocations.id, salesLocations.ownerFarmId],
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

export const farmApprovals = pgTable(
  "farm_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    farmId: uuid("farm_id")
      .notNull()
      .references(() => farms.id, { onDelete: "restrict" }),
    administratorId: uuid("administrator_id")
      .notNull()
      .references(() => administrators.id, { onDelete: "restrict" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    idAndFarmUnique: unique("farm_approvals_id_farm_unique").on(
      table.id,
      table.farmId,
    ),
    oneCurrentApproval: uniqueIndex("farm_approvals_one_current_per_farm")
      .on(table.farmId)
      .where(sql`${table.revokedAt} is null`),
    validRevocation: check(
      "farm_approvals_valid_revocation",
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.approvedAt}`,
    ),
  }),
);

export const farmLinks = pgTable(
  "farm_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    farmId: uuid("farm_id")
      .notNull()
      .references(() => farms.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    url: text("url").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => ({
    farmUrlUnique: unique("farm_links_farm_url_unique").on(
      table.farmId,
      table.url,
    ),
    labelNotBlank: check(
      "farm_links_label_not_blank",
      sql`length(trim(${table.label})) > 0`,
    ),
    absoluteHttpUrl: check(
      "farm_links_absolute_http_url",
      sql`${table.url} ~ '^https?://[^[:space:]]+$'`,
    ),
    nonnegativeSortOrder: check(
      "farm_links_nonnegative_sort_order",
      sql`${table.sortOrder} >= 0`,
    ),
  }),
);

export const salesLocations = pgTable(
  "sales_locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The farm that controls location facts. Ownership does not imply seller participation. */
    ownerFarmId: uuid("owner_farm_id")
      .notNull()
      .references(() => farms.id, { onDelete: "restrict" }),
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

    farmBucksAccepted: boolean("farm_bucks_accepted").notNull(),
    farmBucksEligible: boolean("farm_bucks_eligible").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    idAndOwnerUnique: unique("sales_locations_id_owner_unique").on(
      table.id,
      table.ownerFarmId,
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
    acceptanceRequiresEligibility: check(
      "sales_locations_farm_bucks_acceptance_requires_eligibility",
      sql`not ${table.farmBucksAccepted} or ${table.farmBucksEligible}`,
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
    selectedOwnerFarmId: uuid("selected_owner_farm_id"),
    selectedSalesLocationId: uuid("selected_sales_location_id"),
    selectedAt: timestamp("selected_at", { withTimezone: true }),
    menuIssuedAt: timestamp("menu_issued_at", { withTimezone: true }),
    menuExpiresAt: timestamp("menu_expires_at", { withTimezone: true }),
    menuPurpose: farmerTargetMenuPurpose("menu_purpose"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    selectedAuthorizationOwnerReference: foreignKey({
      name: "farmer_target_contexts_selected_authorization_owner_fk",
      columns: [table.selectedAuthorizationId, table.selectedOwnerFarmId],
      foreignColumns: [farmerAuthorizations.id, farmerAuthorizations.farmId],
    }).onDelete("cascade"),
    selectedLocationOwnerReference: foreignKey({
      name: "farmer_target_contexts_selected_location_owner_fk",
      columns: [table.selectedSalesLocationId, table.selectedOwnerFarmId],
      foreignColumns: [salesLocations.id, salesLocations.ownerFarmId],
    }).onDelete("cascade"),
    selectedAuthorizationLookup: index(
      "farmer_target_contexts_selected_authorization",
    ).on(table.selectedAuthorizationId),
    selectedLocationLookup: index(
      "farmer_target_contexts_selected_location",
    ).on(table.selectedSalesLocationId),
    selectedContextCoherent: check(
      "farmer_target_contexts_selected_context_coherent",
      sql`
        (
          ${table.selectedAuthorizationId} is null
          and ${table.selectedOwnerFarmId} is null
          and ${table.selectedSalesLocationId} is null
          and ${table.selectedAt} is null
        )
        or (
          ${table.selectedAuthorizationId} is not null
          and ${table.selectedOwnerFarmId} is not null
          and ${table.selectedSalesLocationId} is not null
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
    ownerFarmId: uuid("owner_farm_id").notNull(),
    salesLocationId: uuid("sales_location_id").notNull(),
  },
  (table) => ({
    key: primaryKey({ columns: [table.senderHash, table.optionNumber] }),
    contextReference: foreignKey({
      name: "farmer_target_menu_options_context_fk",
      columns: [table.senderHash],
      foreignColumns: [farmerTargetContexts.senderHash],
    }).onDelete("cascade"),
    authorizationOwnerReference: foreignKey({
      name: "farmer_target_menu_options_authorization_owner_fk",
      columns: [table.authorizationId, table.ownerFarmId],
      foreignColumns: [farmerAuthorizations.id, farmerAuthorizations.farmId],
    }).onDelete("cascade"),
    locationOwnerReference: foreignKey({
      name: "farmer_target_menu_options_location_owner_fk",
      columns: [table.salesLocationId, table.ownerFarmId],
      foreignColumns: [salesLocations.id, salesLocations.ownerFarmId],
    }).onDelete("cascade"),
    oneNumberPerPair: unique(
      "farmer_target_menu_options_one_number_per_pair",
    ).on(table.senderHash, table.authorizationId, table.salesLocationId),
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
    ownerFarmId: uuid("owner_farm_id").notNull(),
    salesLocationId: uuid("sales_location_id").notNull(),
    designatedAuthorizationId: uuid("designated_authorization_id").notNull(),
    cadence: inventoryPromptCadence("cadence").notNull(),
    version: integer("version").notNull(),
    nextDueAt: timestamp("next_due_at", { withTimezone: true }),
    lastDueSlotAt: timestamp("last_due_slot_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    onePerLocation: unique("inventory_prompt_preferences_location_unique").on(
      table.salesLocationId,
    ),
    locationOwnerReference: foreignKey({
      name: "inventory_prompt_preferences_location_owner_fk",
      columns: [table.salesLocationId, table.ownerFarmId],
      foreignColumns: [salesLocations.id, salesLocations.ownerFarmId],
    }).onDelete("restrict"),
    authorizationOwnerReference: foreignKey({
      name: "inventory_prompt_preferences_authorization_owner_fk",
      columns: [table.designatedAuthorizationId, table.ownerFarmId],
      foreignColumns: [farmerAuthorizations.id, farmerAuthorizations.farmId],
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
    ownerFarmId: uuid("owner_farm_id").notNull(),
    salesLocationId: uuid("sales_location_id").notNull(),
    displayName: text("display_name").notNull(),
    /**
     * F-064 — who stated this name: the farmer's own handset, or VIGA's records.
     *
     * The same split F-063 made for `inventory_revisions`, for the same reason. The launch
     * import reads host farms from VIGA's spreadsheets, which have no handset behind them, and
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
      columns: [table.salesLocationId, table.ownerFarmId],
      foreignColumns: [salesLocations.id, salesLocations.ownerFarmId],
    }).onDelete("restrict"),
    confirmingOwnerReference: foreignKey({
      name: "sales_location_participants_confirming_owner_fk",
      columns: [table.confirmedByAuthorizationId, table.ownerFarmId],
      foreignColumns: [farmerAuthorizations.id, farmerAuthorizations.farmId],
    }).onDelete("restrict"),
    retiringOwnerReference: foreignKey({
      name: "sales_location_participants_retiring_owner_fk",
      columns: [table.retiredByAuthorizationId, table.ownerFarmId],
      foreignColumns: [farmerAuthorizations.id, farmerAuthorizations.farmId],
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
    salesLocationReference: foreignKey({
      name: "stand_items_location_fk",
      columns: [table.salesLocationId],
      foreignColumns: [salesLocations.id],
    }).onDelete("cascade"),
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
     * One item per stand per name, and the first-insert arbiter for concurrent writers.
     *
     * Normalization is case and surrounding whitespace ONLY, so the profile form's "eggs" and
     * the weekly form's "Eggs" are one item. It must never fold singulars into plurals or
     * synonyms into each other — that is a produce taxonomy, and this index is not where such
     * a decision belongs.
     */
    onePerLocationName: uniqueIndex("stand_items_one_per_location_name").on(
      table.salesLocationId,
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

export const salesLocationPaymentMethods = pgTable(
  "sales_location_payment_methods",
  {
    salesLocationId: uuid("sales_location_id").notNull(),
    method: text("method").notNull(),
  },
  (table) => ({
    salesLocationReference: foreignKey({
      name: "sales_location_payment_methods_location_fk",
      columns: [table.salesLocationId],
      foreignColumns: [salesLocations.id],
    }).onDelete("cascade"),
    pk: primaryKey({
      name: "sales_location_payment_methods_pk",
      columns: [table.salesLocationId, table.method],
    }),
    methodNotBlank: check(
      "sales_location_payment_methods_method_not_blank",
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
    salesLocationReference: foreignKey({
      name: "inventory_proposals_location_fk",
      columns: [table.salesLocationId],
      foreignColumns: [salesLocations.id],
    }).onDelete("restrict"),
    activationOutboxReference: foreignKey({
      name: "inventory_proposals_activation_outbox_fk",
      columns: [table.activationOutboxId],
      foreignColumns: [outboxWork.id],
    }).onDelete("restrict"),
    oneOpenPerSender: uniqueIndex(
      "inventory_publication_proposals_one_open_per_sender",
    )
      .on(table.senderHash)
      .where(sql`${table.state} = 'open'`),
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
    farmId: uuid("farm_id").notNull(),
    salesLocationId: uuid("sales_location_id").notNull(),
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
    oneCurrentPerLocation: uniqueIndex(
      "inventory_revisions_one_current_per_location",
    )
      .on(table.salesLocationId)
      .where(sql`${table.isCurrent}`),
    locationFarmReference: foreignKey({
      name: "inventory_revisions_location_farm_fk",
      columns: [table.salesLocationId, table.farmId],
      foreignColumns: [salesLocations.id, salesLocations.ownerFarmId],
    }).onDelete("restrict"),
    authorizationFarmReference: foreignKey({
      name: "inventory_revisions_authorization_farm_fk",
      columns: [table.publishedByAuthorizationId, table.farmId],
      foreignColumns: [farmerAuthorizations.id, farmerAuthorizations.farmId],
    }).onDelete("restrict"),
    approvalFarmReference: foreignKey({
      name: "inventory_revisions_approval_farm_fk",
      columns: [table.farmApprovalId, table.farmId],
      foreignColumns: [farmApprovals.id, farmApprovals.farmId],
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
    ownerFarmId: uuid("owner_farm_id").notNull(),
    salesLocationId: uuid("sales_location_id").notNull(),
    proposalId: uuid("proposal_id").notNull(),
    ownerAuthorizationId: uuid("owner_authorization_id").notNull(),
    ownerApprovalId: uuid("owner_approval_id").notNull(),
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
      columns: [table.salesLocationId, table.ownerFarmId],
      foreignColumns: [salesLocations.id, salesLocations.ownerFarmId],
    }).onDelete("restrict"),
    authorizationOwnerReference: foreignKey({
      name: "closure_revisions_authorization_owner_fk",
      columns: [table.ownerAuthorizationId, table.ownerFarmId],
      foreignColumns: [farmerAuthorizations.id, farmerAuthorizations.farmId],
    }).onDelete("restrict"),
    approvalOwnerReference: foreignKey({
      name: "closure_revisions_approval_owner_fk",
      columns: [table.ownerApprovalId, table.ownerFarmId],
      foreignColumns: [farmApprovals.id, farmApprovals.farmId],
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
    ownerFarmId: uuid("owner_farm_id").notNull(),
    salesLocationId: uuid("sales_location_id").notNull(),
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
      columns: [table.authorizationId, table.ownerFarmId],
      foreignColumns: [farmerAuthorizations.id, farmerAuthorizations.farmId],
    }).onDelete("restrict"),
    locationOwnerReference: foreignKey({
      name: "scheduled_prompt_subjects_location_owner_fk",
      columns: [table.salesLocationId, table.ownerFarmId],
      foreignColumns: [salesLocations.id, salesLocations.ownerFarmId],
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
    unlistedItemText: text("unlisted_item_text"),
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
    exactlyOneItemReference: check(
      "stock_out_reports_exactly_one_item_reference",
      sql`
        (
          ${table.referencedInventoryEntryId} is not null
          and ${table.unlistedItemText} is null
        )
        or (
          ${table.referencedInventoryEntryId} is null
          and ${table.unlistedItemText} is not null
          and length(trim(${table.unlistedItemText})) > 0
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
    status: flagStatus("status").notNull().default("open"),
    dispositionCode: text("disposition_code"),
    disposedByAdministratorId: uuid(
      "disposed_by_administrator_id",
    ).references(() => administrators.id, { onDelete: "restrict" }),
    disposedAt: timestamp("disposed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    reasonNotBlank: check(
      "flags_reason_code_not_blank",
      sql`length(trim(${table.reasonCode})) > 0`,
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
    /** How many of `factIds` the sender has already been shown. */
    offset: integer("offset").notNull().default(0),
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
