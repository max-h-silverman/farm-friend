import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
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
export const inventoryApproximation = pgEnum("inventory_approximation", [
  "some",
  "limited",
  "plentiful",
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
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "restrict" }),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    oneActiveAuthorization: uniqueIndex(
      "administrators_one_active_per_contact",
    )
      .on(table.contactId)
      .where(sql`${table.revokedAt} is null`),
    validRevocation: check(
      "administrators_valid_revocation",
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.authorizedAt}`,
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    nameNotBlank: check("farms_name_not_blank", sql`length(trim(${table.name})) > 0`),
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
    farmId: uuid("farm_id")
      .notNull()
      .references(() => farms.id, { onDelete: "restrict" }),
    kind: salesLocationKind("kind").notNull(),
    name: text("name").notNull(),
    publicAddress: text("public_address").notNull(),
    publicLatitude: doublePrecision("public_latitude").notNull(),
    publicLongitude: doublePrecision("public_longitude").notNull(),
    hoursText: text("hours_text"),
    isPublic: boolean("is_public").notNull().default(true),
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
    idAndFarmUnique: unique("sales_locations_id_farm_unique").on(
      table.id,
      table.farmId,
    ),
    nameNotBlank: check(
      "sales_locations_name_not_blank",
      sql`length(trim(${table.name})) > 0`,
    ),
    addressNotBlank: check(
      "sales_locations_address_not_blank",
      sql`length(trim(${table.publicAddress})) > 0`,
    ),
    validCoordinates: check(
      "sales_locations_valid_coordinates",
      sql`${table.publicLatitude} between -90 and 90 and ${table.publicLongitude} between -180 and 180`,
    ),
    acceptanceRequiresEligibility: check(
      "sales_locations_farm_bucks_acceptance_requires_eligibility",
      sql`not ${table.farmBucksAccepted} or ${table.farmBucksEligible}`,
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
    schemaVersion: text("schema_version").notNull(),
    proposalVersion: integer("proposal_version").notNull(),
    yesToken: text("yes_token").notNull(),
    noToken: text("no_token").notNull(),
    state: proposalState("state").notNull().default("open"),
    // The complete pending snapshot is bound to the base it was computed from, so a
    // newer publication invalidates it rather than being silently overwritten.
    baseRevisionId: uuid("base_revision_id"),
    baseIsFirstPublication: boolean("base_is_first_publication").notNull(),
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
    distinctTokens: check(
      "inventory_publication_proposals_distinct_tokens",
      sql`${table.yesToken} <> ${table.noToken}`,
    ),
    // The (base_revision_id, sales_location_id) foreign key to inventory_revisions is
    // declared in SQL by the migration rather than here: inventory_revisions already
    // references this table through proposal_id, and expressing both edges in Drizzle
    // creates a circular initializer TypeScript cannot infer.
    baseBindingCoherent: check(
      "inventory_publication_proposals_base_binding_coherent",
      sql`
        (
          ${table.baseIsFirstPublication}
          and ${table.baseRevisionId} is null
        )
        or (
          not ${table.baseIsFirstPublication}
          and ${table.baseRevisionId} is not null
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
    proposalId: uuid("proposal_id").notNull(),
    publishedByAuthorizationId: uuid(
      "published_by_authorization_id",
    ).notNull(),
    farmApprovalId: uuid("farm_approval_id").notNull(),
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
      foreignColumns: [salesLocations.id, salesLocations.farmId],
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
