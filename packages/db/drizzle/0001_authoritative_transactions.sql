-- F-014 forward migration: the authoritative SMS transaction surface.
--
-- Generalizes the provider webhook inbox to message.received / message.sent /
-- message.finalized behind one event-ID deduplication path, binds pending proposals to
-- their base published revision, makes confirmation expiry activation-relative, records
-- proposal invalidation honestly, and adds the monotonic outbound delivery watermark.
--
-- `proposal_state` is recreated rather than extended with ALTER TYPE ... ADD VALUE:
-- PostgreSQL cannot use a newly added enum value in the transaction that added it, and
-- the Drizzle migrator runs all pending migrations inside one transaction. Recreating
-- the type keeps 'invalidated' a first-class state in a single migrate() run.
-- The 0000 state check references the old type, so it is dropped before the swap and
-- reinstated below in its invalidation-aware form.
ALTER TABLE "inventory_publication_proposals"
  DROP CONSTRAINT IF EXISTS "inventory_publication_proposals_state_coherent";--> statement-breakpoint
-- The one-open-per-sender index also predicates on the old type; it is recreated
-- unchanged after the swap so the single live confirmation stays enforced.
DROP INDEX IF EXISTS "inventory_publication_proposals_one_open_per_sender";--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals"
  ALTER COLUMN "state" DROP DEFAULT;--> statement-breakpoint
CREATE TYPE "public"."proposal_state_next" AS ENUM('open', 'accepted', 'declined', 'expired', 'invalidated');--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals"
  ALTER COLUMN "state" TYPE "public"."proposal_state_next"
  USING "state"::text::"public"."proposal_state_next";--> statement-breakpoint
DROP TYPE "public"."proposal_state";--> statement-breakpoint
ALTER TYPE "public"."proposal_state_next" RENAME TO "proposal_state";--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals"
  ALTER COLUMN "state" SET DEFAULT 'open';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_publication_proposals_one_open_per_sender" ON "inventory_publication_proposals" USING btree ("sender_hash") WHERE "inventory_publication_proposals"."state" = 'open';--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."delivery_status" AS ENUM('sent', 'delivered', 'delivery_failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."provider_event_type" AS ENUM('message_received', 'message_sent', 'message_finalized');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "provider_inbox_events_one_processing_claim_per_sender";--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals" ALTER COLUMN "expires_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_inbox_events" ALTER COLUMN "message_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_inbox_events" ALTER COLUMN "sender_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals" ADD COLUMN "base_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals" ADD COLUMN "base_is_first_publication" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_work" ADD COLUMN "delivery_status" "delivery_status";--> statement-breakpoint
ALTER TABLE "outbox_work" ADD COLUMN "delivery_occurred_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_work" ADD COLUMN "delivery_event_id" text;--> statement-breakpoint
ALTER TABLE "provider_inbox_events" ADD COLUMN "event_type" "provider_event_type" DEFAULT 'message_received' NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_inbox_events" ADD COLUMN "dispatch_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "provider_inbox_events" ADD COLUMN "delivery_status" "delivery_status";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_inbox_events" ADD CONSTRAINT "provider_inbox_events_dispatch_attempt_fk" FOREIGN KEY ("dispatch_attempt_id") REFERENCES "public"."outbox_dispatch_attempts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_inbox_events_one_processing_claim_per_sender" ON "provider_inbox_events" USING btree ("sender_hash") WHERE "provider_inbox_events"."state" = 'processing' and "provider_inbox_events"."event_type" = 'message_received';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_inbox_events_dispatch_attempt" ON "provider_inbox_events" USING btree ("dispatch_attempt_id");--> statement-breakpoint

-- drizzle-kit 0.22 does not serialize PostgreSQL CHECK constraints into its
-- snapshot format, so the schema-declared checks are repeated explicitly here.

-- One inbox, one deduplication path: each event type keeps its own minimal projection.
-- Only a received event retains an inbound message and sender; only a delivery event
-- carries outbound correlation and delivery status.
ALTER TABLE "provider_inbox_events"
  ADD CONSTRAINT "provider_inbox_events_minimal_projection_per_event_type"
  CHECK (
    (
      "event_type" = 'message_received'
      AND "message_id" IS NOT NULL
      AND "sender_hash" IS NOT NULL
      AND "dispatch_attempt_id" IS NULL
      AND "delivery_status" IS NULL
    )
    OR (
      "event_type" IN ('message_sent', 'message_finalized')
      AND "message_id" IS NULL
      AND "sender_hash" IS NULL
      AND "dispatch_attempt_id" IS NOT NULL
      AND "delivery_status" IS NOT NULL
    )
  );--> statement-breakpoint

-- A proposal is bound either to the base revision it was computed from or, for a first
-- publication, to the explicit absence of one. The composite foreign key lives here
-- rather than in the Drizzle table: inventory_revisions already references proposals
-- through proposal_id, and declaring both edges there is a circular initializer.
-- Binding (base_revision_id, sales_location_id) also proves the base belongs to the
-- location the proposal targets.
ALTER TABLE "inventory_publication_proposals"
  ADD CONSTRAINT "inventory_proposals_base_revision_fk"
  FOREIGN KEY ("base_revision_id", "sales_location_id")
  REFERENCES "public"."inventory_revisions"("id", "sales_location_id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals"
  ADD CONSTRAINT "inventory_publication_proposals_base_binding_coherent"
  CHECK (
    ("base_is_first_publication" AND "base_revision_id" IS NULL)
    OR (NOT "base_is_first_publication" AND "base_revision_id" IS NOT NULL)
  );--> statement-breakpoint

-- Expiry is activation-relative: the confirmation window exists only once Telnyx has
-- accepted the current prompt. Replaces the creation-relative check from 0000.
ALTER TABLE "inventory_publication_proposals"
  DROP CONSTRAINT IF EXISTS "inventory_publication_proposals_expiry_after_creation";--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals"
  DROP CONSTRAINT IF EXISTS "inventory_publication_proposals_activation_coherent";--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals"
  ADD CONSTRAINT "inventory_publication_proposals_activation_coherent"
  CHECK (
    (
      "activation_outbox_id" IS NULL
      AND "activated_version" IS NULL
      AND "activated_at" IS NULL
      AND "expires_at" IS NULL
    )
    OR (
      "activation_outbox_id" IS NOT NULL
      AND "activated_version" IS NOT NULL
      AND "activated_version" BETWEEN 1 AND "proposal_version"
      AND "activated_at" IS NOT NULL
      AND "expires_at" IS NOT NULL
      AND "expires_at" > "activated_at"
    )
  );--> statement-breakpoint

-- An invalidated proposal is closed without consuming a token and publishes nothing,
-- exactly like expiry. Replaces the 0000 state check, which had no invalidated state.
ALTER TABLE "inventory_publication_proposals"
  DROP CONSTRAINT IF EXISTS "inventory_publication_proposals_state_coherent";--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals"
  ADD CONSTRAINT "inventory_publication_proposals_state_coherent"
  CHECK (
    (
      "state" = 'open'
      AND "consumed_token" IS NULL
      AND "consumption_provider_event_id" IS NULL
      AND "closed_at" IS NULL
    )
    OR (
      "state" = 'accepted'
      AND "activated_version" = "proposal_version"
      AND "activated_at" IS NOT NULL
      AND "consumed_token" = 'yes'
      AND "consumption_provider_event_id" IS NOT NULL
      AND "closed_at" IS NOT NULL
    )
    OR (
      "state" = 'declined'
      AND "activated_version" = "proposal_version"
      AND "activated_at" IS NOT NULL
      AND "consumed_token" = 'no'
      AND "consumption_provider_event_id" IS NOT NULL
      AND "closed_at" IS NOT NULL
    )
    OR (
      "state" IN ('expired', 'invalidated')
      AND "consumed_token" IS NULL
      AND "consumption_provider_event_id" IS NULL
      AND "closed_at" IS NOT NULL
    )
  );--> statement-breakpoint

-- Reported carrier delivery state, never an exactly-once delivery claim. A status
-- implies the occurrence and event that set it, and only dispatch-authorized work.
ALTER TABLE "outbox_work"
  ADD CONSTRAINT "outbox_work_delivery_watermark_coherent"
  CHECK (
    (
      "delivery_status" IS NULL
      AND "delivery_occurred_at" IS NULL
      AND "delivery_event_id" IS NULL
    )
    OR (
      "delivery_status" IS NOT NULL
      AND "delivery_occurred_at" IS NOT NULL
      AND "delivery_event_id" IS NOT NULL
      AND "dispatch_authorized_at" IS NOT NULL
    )
  );--> statement-breakpoint

-- message.sent and message.finalized may arrive out of order or more than once. A row
-- comparison cannot express that in a CHECK, so the watermark is enforced here: a late
-- or duplicate event never regresses a terminal result.
CREATE FUNCTION guard_outbox_delivery_watermark() RETURNS trigger AS $$
BEGIN
  IF NEW."delivery_occurred_at" IS NULL THEN
    RETURN NEW;
  END IF;

  IF OLD."delivery_occurred_at" IS NOT NULL THEN
    IF NEW."delivery_event_id" = OLD."delivery_event_id" THEN
      -- A duplicate delivery event is a no-op, never an error.
      RETURN OLD;
    END IF;

    IF NEW."delivery_occurred_at" < OLD."delivery_occurred_at" THEN
      RAISE EXCEPTION 'outbound delivery state cannot regress to an earlier provider event';
    END IF;

    IF OLD."delivery_status" IN ('delivered', 'delivery_failed')
      AND NEW."delivery_status" <> OLD."delivery_status"
    THEN
      RAISE EXCEPTION 'a terminal outbound delivery result cannot be replaced';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "outbox_work_guard_delivery_watermark"
  BEFORE UPDATE OF "delivery_status", "delivery_occurred_at", "delivery_event_id"
  ON "outbox_work"
  FOR EACH ROW EXECUTE FUNCTION guard_outbox_delivery_watermark();
