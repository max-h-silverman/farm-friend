import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// Farm Friend — tenant-scoped Drizzle schema.
//
// Every top-level entity carries `tenant_id`. The two-axis freshness/provenance model
// (see docs/DATA_ARCHITECTURE.md) is load-bearing:
//   - lifecycle `status` (draft|current|superseded|hidden) → is it shown on the map
//   - provenance (migrated|farmer_confirmed) + a real/import date → honesty about age
// A migrated pin shows as `current` but renders honestly ("via VIGA's map, updated [date]"),
// never "confirmed today". Claim state lives at TWO grains (stand + snapshot) because a
// migrated-unclaimed stand has no snapshot on day one.

// ---------------------------------------------------------------------------- enums

export const farmStatus = pgEnum("farm_status", ["active", "hidden"]);
export const standVisibility = pgEnum("stand_visibility", ["public", "hidden"]);
export const claimStatus = pgEnum("claim_status", ["migrated", "claimed"]);
export const inventoryStatus = pgEnum("inventory_status", [
  "draft",
  "current",
  "superseded",
  "hidden",
]);
export const provenance = pgEnum("provenance", ["migrated", "farmer_confirmed"]);
export const approxLabel = pgEnum("approx_label", ["some", "limited", "a lot"]);
export const reportSource = pgEnum("report_source", ["sms", "qr_web"]);
export const reportStatus = pgEnum("report_status", ["open", "acted", "dismissed"]);
export const alertPref = pgEnum("alert_pref", ["immediate", "digest"]);
export const messageDirection = pgEnum("message_direction", ["inbound", "outbound"]);
export const roleName = pgEnum("role_name", ["admin", "staff", "farmer"]);
export const flagStatus = pgEnum("flag_status", ["open", "resolved"]);
export const aiValidationStatus = pgEnum("ai_validation_status", [
  "passed",
  "repaired",
  "rejected",
]);
export const signupStatus = pgEnum("signup_status", [
  "confirmed",
  "declined",
  "waitlisted",
  "cancelled",
]);

// ------------------------------------------------------------------------- tenancy

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// -------------------------------------------------------------------------- people

export const people = pgTable("people", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  displayName: text("display_name"),
  // phone is NEVER stored raw — only the normalized hash (privacy at the data layer).
  phoneHash: text("phone_hash"),
  email: text("email"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const personRoles = pgTable("person_roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  personId: uuid("person_id").notNull().references(() => people.id),
  role: roleName("role").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  personId: uuid("person_id").notNull().references(() => people.id),
  // global_sms gates all SMS; STOP clears it. Per-program opt-in is a nullable program key.
  globalSms: boolean("global_sms").notNull().default(false),
  program: text("program"), // null = the global_sms row; non-null = per-program opt-in
  optedInAt: timestamp("opted_in_at", { withTimezone: true }),
  optedOutAt: timestamp("opted_out_at", { withTimezone: true }),
});

// --------------------------------------------------------------------------- farms

export const farms = pgTable("farms", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  name: text("name").notNull(),
  status: farmStatus("status").notNull().default("active"),
  ownerPersonId: uuid("owner_person_id").references(() => people.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const farmStands = pgTable("farm_stands", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  farmId: uuid("farm_id").notNull().references(() => farms.id),
  name: text("name").notNull(),
  visibility: standVisibility("visibility").notNull().default("public"),
  // Two-axis model, stand grain: claim state + migration provenance.
  claimStatus: claimStatus("claim_status").notNull().default("migrated"),
  migratedAt: timestamp("migrated_at", { withTimezone: true }),
  migratedSource: text("migrated_source"), // e.g. "viga_google_map"
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  updateCadenceHours: integer("update_cadence_hours"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------- inventory

export const inventorySnapshots = pgTable("inventory_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  farmStandId: uuid("farm_stand_id").notNull().references(() => farmStands.id),
  // Two-axis model, snapshot grain.
  status: inventoryStatus("status").notNull().default("draft"),
  provenance: provenance("provenance").notNull().default("migrated"),
  confirmedByPersonId: uuid("confirmed_by_person_id").references(() => people.id),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  expectedFreshUntil: timestamp("expected_fresh_until", { withTimezone: true }),
});

export const inventoryItems = pgTable("inventory_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  snapshotId: uuid("snapshot_id").notNull().references(() => inventorySnapshots.id),
  name: text("name").notNull(),
  isStaple: boolean("is_staple").notNull().default(false),
  quantity: doublePrecision("quantity"),
  unit: text("unit"),
  priceText: text("price_text"),
  approxLabel: approxLabel("approx_label"),
});

// ------------------------------------------------------------------- stock-out reports

export const stockoutReports = pgTable("stockout_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  farmStandId: uuid("farm_stand_id").notNull().references(() => farmStands.id),
  // Nullable FK (a listed item) PLUS normalized text (an item not currently listed).
  inventoryItemId: uuid("inventory_item_id").references(() => inventoryItems.id),
  itemText: text("item_text").notNull(),
  source: reportSource("source").notNull(),
  status: reportStatus("status").notNull().default("open"),
  reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
});

export const farmerAlertPrefs = pgTable("farmer_alert_prefs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  personId: uuid("person_id").notNull().references(() => people.id),
  pref: alertPref("pref").notNull().default("immediate"),
});

// -------------------------------------------------------------- messages & routing

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  personId: uuid("person_id").references(() => people.id),
  direction: messageDirection("direction").notNull(),
  // raw body is TTL-bounded; phone stored hashed only.
  body: text("body"),
  bodyExpiresAt: timestamp("body_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const conversationStates = pgTable("conversation_states", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  personId: uuid("person_id").notNull().references(() => people.id),
  // The pending action a context-bound YES/OUT commits, plus its expiry (for GC).
  pendingConfirmationJson: jsonb("pending_confirmation_json"),
  pendingExpiresAt: timestamp("pending_expires_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const flags = pgTable("flags", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  personId: uuid("person_id").references(() => people.id),
  reason: text("reason"),
  status: flagStatus("status").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

// ----------------------------------------------------------------------- ai_runs
// Telemetry/provenance for one model-seam call. Stores NO model input and no
// PII-bearing output content — see the MAY-store list in docs/DATA_ARCHITECTURE.md.

export const aiRuns = pgTable("ai_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  seam: text("seam").notNull(),
  provider: text("provider").notNull(),
  model: text("model"),
  schemaVersion: text("schema_version"),
  validationStatus: aiValidationStatus("validation_status").notNull(),
  repairCount: integer("repair_count").notNull().default(0),
  // opaque id set / hashes only — never contents.
  refIds: jsonb("ref_ids"),
  latencyMs: integer("latency_ms"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// -------------------------------------------------------------- gleaning (designed, unused)
// Present so the generic commitment state machine is validated against a SECOND consumer
// (gleaning signup) and tenant scoping is proven once. Not wired into any flow in Phase 0.

export const gleaningOpportunities = pgTable("gleaning_opportunities", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  crop: text("crop").notNull(),
  location: text("location").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  volunteerMin: integer("volunteer_min"),
  volunteerMax: integer("volunteer_max"),
  organizerPersonId: uuid("organizer_person_id").references(() => people.id),
  publicNote: text("public_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const gleaningSignups = pgTable("gleaning_signups", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  opportunityId: uuid("opportunity_id").notNull().references(() => gleaningOpportunities.id),
  personId: uuid("person_id").notNull().references(() => people.id),
  status: signupStatus("status").notNull(),
  waitlistPosition: integer("waitlist_position"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
