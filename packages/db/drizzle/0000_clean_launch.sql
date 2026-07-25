DO $$ BEGIN
 CREATE TYPE "public"."consent_capture_source" AS ENUM('join', 'start', 'farmer_onboarding');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."consent_state" AS ENUM('active', 'stopped');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."consent_transition" AS ENUM('start', 'stop');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."dispatch_attempt_state" AS ENUM('authorized', 'accepted', 'definitive_rejection', 'ambiguous');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."flag_status" AS ENUM('open', 'resolved', 'dismissed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."inbox_processing_state" AS ENUM('pending', 'processing', 'processed', 'rejected');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."inventory_approximation" AS ENUM('some', 'limited', 'plentiful');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."model_validation_status" AS ENUM('passed', 'repaired_then_passed', 'rejected');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."outbox_state" AS ENUM('queued', 'dispatching', 'sent', 'suppressed', 'failed', 'ambiguous');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."proposal_state" AS ENUM('open', 'accepted', 'declined', 'expired');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."proposal_token" AS ENUM('yes', 'no');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."public_map_projection" AS ENUM('exact', 'approximate', 'hidden');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."report_status" AS ENUM('open', 'reviewed', 'dismissed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."sales_location_kind" AS ENUM('farm_stand', 'farmers_market');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "administrators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"authorized_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" text NOT NULL,
	"actor_contact_hash" text,
	"actor_administrator_id" uuid,
	"subject_type" text NOT NULL,
	"subject_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "consent_transition_watermarks" (
	"recipient_hash" text PRIMARY KEY NOT NULL,
	"transition" "consent_transition" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"provider_event_id" text NOT NULL,
	CONSTRAINT "consent_transition_watermarks_provider_event_unique" UNIQUE("provider_event_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_e164" text NOT NULL,
	"phone_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_phone_hash_unique" UNIQUE("phone_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "farm_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"farm_id" uuid NOT NULL,
	"administrator_id" uuid NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "farm_approvals_id_farm_unique" UNIQUE("id","farm_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "farm_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"farm_id" uuid NOT NULL,
	"label" text NOT NULL,
	"url" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "farm_links_farm_url_unique" UNIQUE("farm_id","url")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "farmer_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"farm_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"phone_verified_at" timestamp with time zone NOT NULL,
	"authorized_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "farmer_authorizations_id_farm_unique" UNIQUE("id","farm_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "farms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"photo_url" text,
	"map_projection" "public_map_projection",
	"public_latitude" double precision,
	"public_longitude" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_hash" text,
	"inbox_event_id" uuid,
	"reason_code" text NOT NULL,
	"status" "flag_status" DEFAULT 'open' NOT NULL,
	"disposition_code" text,
	"disposed_by_administrator_id" uuid,
	"disposed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inventory_revision_id" uuid NOT NULL,
	"sales_location_id" uuid NOT NULL,
	"item_name" text NOT NULL,
	"quantity" double precision,
	"unit" text,
	"price_text" text,
	"approximation" "inventory_approximation",
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "inventory_entries_id_location_unique" UNIQUE("id","sales_location_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_publication_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sender_hash" text NOT NULL,
	"sales_location_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"schema_version" text NOT NULL,
	"proposal_version" integer NOT NULL,
	"yes_token" text NOT NULL,
	"no_token" text NOT NULL,
	"state" "proposal_state" DEFAULT 'open' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"activation_outbox_id" uuid,
	"activated_version" integer,
	"activated_at" timestamp with time zone,
	"consumed_token" "proposal_token",
	"consumption_provider_event_id" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_publication_proposals_activation_outbox_unique" UNIQUE("activation_outbox_id"),
	CONSTRAINT "inventory_publication_proposals_consumption_event_unique" UNIQUE("consumption_provider_event_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"farm_id" uuid NOT NULL,
	"sales_location_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"published_by_authorization_id" uuid NOT NULL,
	"farm_approval_id" uuid NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "inventory_revisions_id_location_unique" UNIQUE("id","sales_location_id"),
	CONSTRAINT "inventory_revisions_proposal_unique" UNIQUE("proposal_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seam" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"schema_version" text NOT NULL,
	"validation_status" "model_validation_status" NOT NULL,
	"repair_count" integer DEFAULT 0 NOT NULL,
	"opaque_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"latency_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_micros" integer,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outbox_dispatch_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outbox_work_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"state" "dispatch_attempt_state" NOT NULL,
	"provider_message_id" text,
	"error_code" text,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "outbox_dispatch_attempts_number_unique" UNIQUE("outbox_work_id","attempt_number"),
	CONSTRAINT "outbox_dispatch_attempts_provider_message_unique" UNIQUE("provider_message_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outbox_work" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"logical_key" text NOT NULL,
	"recipient_hash" text NOT NULL,
	"message_kind" text NOT NULL,
	"body" text NOT NULL,
	"body_expires_at" timestamp with time zone NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL,
	"state" "outbox_state" DEFAULT 'queued' NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"dispatch_authorized_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_work_logical_key_unique" UNIQUE("logical_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_inbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_event_id" text NOT NULL,
	"message_id" uuid NOT NULL,
	"sender_hash" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"state" "inbox_processing_state" DEFAULT 'pending' NOT NULL,
	"claim_token" uuid,
	"claimed_at" timestamp with time zone,
	"claim_expires_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"failure_code" text,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_inbox_events_provider_event_unique" UNIQUE("provider_event_id"),
	CONSTRAINT "provider_inbox_events_message_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales_location_payment_methods" (
	"sales_location_id" uuid NOT NULL,
	"method" text NOT NULL,
	CONSTRAINT "sales_location_payment_methods_pk" PRIMARY KEY("sales_location_id","method")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"farm_id" uuid NOT NULL,
	"kind" "sales_location_kind" NOT NULL,
	"name" text NOT NULL,
	"public_address" text NOT NULL,
	"public_latitude" double precision NOT NULL,
	"public_longitude" double precision NOT NULL,
	"hours_text" text,
	"is_public" boolean DEFAULT true NOT NULL,
	"farm_bucks_accepted" boolean NOT NULL,
	"farm_bucks_eligible" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_locations_id_farm_unique" UNIQUE("id","farm_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sender_states" (
	"sender_hash" text PRIMARY KEY NOT NULL,
	"conversation_occurred_at" timestamp with time zone,
	"conversation_provider_event_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sms_consents" (
	"recipient_hash" text PRIMARY KEY NOT NULL,
	"state" "consent_state" NOT NULL,
	"capture_source" "consent_capture_source",
	"captured_at" timestamp with time zone,
	"capture_evidence_ref" text,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sms_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_message_id" text NOT NULL,
	"sender_hash" text NOT NULL,
	"body" text,
	"body_expires_at" timestamp with time zone,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sms_messages_provider_message_unique" UNIQUE("provider_message_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_out_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sales_location_id" uuid NOT NULL,
	"referenced_inventory_entry_id" uuid,
	"unlisted_item_text" text,
	"status" "report_status" DEFAULT 'open' NOT NULL,
	"reviewed_by_administrator_id" uuid,
	"reviewed_at" timestamp with time zone,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "administrators" ADD CONSTRAINT "administrators_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_contact_hash_contacts_phone_hash_fk" FOREIGN KEY ("actor_contact_hash") REFERENCES "public"."contacts"("phone_hash") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_administrator_id_administrators_id_fk" FOREIGN KEY ("actor_administrator_id") REFERENCES "public"."administrators"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "consent_transition_watermarks" ADD CONSTRAINT "consent_transition_recipient_fk" FOREIGN KEY ("recipient_hash") REFERENCES "public"."contacts"("phone_hash") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "farm_approvals" ADD CONSTRAINT "farm_approvals_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "farm_approvals" ADD CONSTRAINT "farm_approvals_administrator_id_administrators_id_fk" FOREIGN KEY ("administrator_id") REFERENCES "public"."administrators"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "farm_links" ADD CONSTRAINT "farm_links_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "farmer_authorizations" ADD CONSTRAINT "farmer_authorizations_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "farmer_authorizations" ADD CONSTRAINT "farmer_authorizations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flags" ADD CONSTRAINT "flags_contact_hash_contacts_phone_hash_fk" FOREIGN KEY ("contact_hash") REFERENCES "public"."contacts"("phone_hash") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flags" ADD CONSTRAINT "flags_inbox_event_id_provider_inbox_events_id_fk" FOREIGN KEY ("inbox_event_id") REFERENCES "public"."provider_inbox_events"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flags" ADD CONSTRAINT "flags_disposed_by_administrator_id_administrators_id_fk" FOREIGN KEY ("disposed_by_administrator_id") REFERENCES "public"."administrators"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_entries" ADD CONSTRAINT "inventory_entries_revision_location_fk" FOREIGN KEY ("inventory_revision_id","sales_location_id") REFERENCES "public"."inventory_revisions"("id","sales_location_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_publication_proposals" ADD CONSTRAINT "inventory_proposals_sender_fk" FOREIGN KEY ("sender_hash") REFERENCES "public"."contacts"("phone_hash") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_publication_proposals" ADD CONSTRAINT "inventory_proposals_location_fk" FOREIGN KEY ("sales_location_id") REFERENCES "public"."sales_locations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_publication_proposals" ADD CONSTRAINT "inventory_proposals_activation_outbox_fk" FOREIGN KEY ("activation_outbox_id") REFERENCES "public"."outbox_work"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_revisions" ADD CONSTRAINT "inventory_revisions_proposal_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."inventory_publication_proposals"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_revisions" ADD CONSTRAINT "inventory_revisions_location_farm_fk" FOREIGN KEY ("sales_location_id","farm_id") REFERENCES "public"."sales_locations"("id","farm_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_revisions" ADD CONSTRAINT "inventory_revisions_authorization_farm_fk" FOREIGN KEY ("published_by_authorization_id","farm_id") REFERENCES "public"."farmer_authorizations"("id","farm_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_revisions" ADD CONSTRAINT "inventory_revisions_approval_farm_fk" FOREIGN KEY ("farm_approval_id","farm_id") REFERENCES "public"."farm_approvals"("id","farm_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outbox_dispatch_attempts" ADD CONSTRAINT "outbox_dispatch_attempts_outbox_work_id_outbox_work_id_fk" FOREIGN KEY ("outbox_work_id") REFERENCES "public"."outbox_work"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outbox_work" ADD CONSTRAINT "outbox_work_recipient_hash_contacts_phone_hash_fk" FOREIGN KEY ("recipient_hash") REFERENCES "public"."contacts"("phone_hash") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_inbox_events" ADD CONSTRAINT "provider_inbox_events_message_id_sms_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."sms_messages"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_inbox_events" ADD CONSTRAINT "provider_inbox_events_sender_hash_contacts_phone_hash_fk" FOREIGN KEY ("sender_hash") REFERENCES "public"."contacts"("phone_hash") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_location_payment_methods" ADD CONSTRAINT "sales_location_payment_methods_location_fk" FOREIGN KEY ("sales_location_id") REFERENCES "public"."sales_locations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_locations" ADD CONSTRAINT "sales_locations_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sender_states" ADD CONSTRAINT "sender_states_sender_hash_contacts_phone_hash_fk" FOREIGN KEY ("sender_hash") REFERENCES "public"."contacts"("phone_hash") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sms_consents" ADD CONSTRAINT "sms_consents_recipient_hash_contacts_phone_hash_fk" FOREIGN KEY ("recipient_hash") REFERENCES "public"."contacts"("phone_hash") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_sender_hash_contacts_phone_hash_fk" FOREIGN KEY ("sender_hash") REFERENCES "public"."contacts"("phone_hash") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_out_reports" ADD CONSTRAINT "stock_out_reports_sales_location_id_sales_locations_id_fk" FOREIGN KEY ("sales_location_id") REFERENCES "public"."sales_locations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_out_reports" ADD CONSTRAINT "stock_out_reports_reviewer_fk" FOREIGN KEY ("reviewed_by_administrator_id") REFERENCES "public"."administrators"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_out_reports" ADD CONSTRAINT "stock_out_reports_entry_location_fk" FOREIGN KEY ("referenced_inventory_entry_id","sales_location_id") REFERENCES "public"."inventory_entries"("id","sales_location_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "administrators_one_active_per_contact" ON "administrators" USING btree ("contact_id") WHERE "administrators"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "farm_approvals_one_current_per_farm" ON "farm_approvals" USING btree ("farm_id") WHERE "farm_approvals"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "farmer_authorizations_one_active_contact_per_farm" ON "farmer_authorizations" USING btree ("farm_id","contact_id") WHERE "farmer_authorizations"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_publication_proposals_one_open_per_sender" ON "inventory_publication_proposals" USING btree ("sender_hash") WHERE "inventory_publication_proposals"."state" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_revisions_one_current_per_location" ON "inventory_revisions" USING btree ("sales_location_id") WHERE "inventory_revisions"."is_current";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbox_work_recipient_state_queue" ON "outbox_work" USING btree ("recipient_hash","state","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_inbox_events_one_processing_claim_per_sender" ON "provider_inbox_events" USING btree ("sender_hash") WHERE "provider_inbox_events"."state" = 'processing';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_inbox_events_sender_order" ON "provider_inbox_events" USING btree ("sender_hash","occurred_at","provider_event_id");--> statement-breakpoint

-- drizzle-kit 0.22 does not serialize PostgreSQL CHECK constraints into its
-- snapshot format, so the schema-declared checks are repeated explicitly here.
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_phone_e164_normalized"
  CHECK ("phone_e164" ~ '^\+[1-9][0-9]{7,14}$');--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_phone_hash_nonempty"
  CHECK (length("phone_hash") >= 32);--> statement-breakpoint
ALTER TABLE "administrators" ADD CONSTRAINT "administrators_valid_revocation"
  CHECK ("revoked_at" IS NULL OR "revoked_at" >= "authorized_at");--> statement-breakpoint
ALTER TABLE "farms" ADD CONSTRAINT "farms_name_not_blank"
  CHECK (length(trim("name")) > 0);--> statement-breakpoint
ALTER TABLE "farms" ADD CONSTRAINT "farms_projection_coordinates_coherent"
  CHECK (
    ("map_projection" IS NULL AND "public_latitude" IS NULL AND "public_longitude" IS NULL)
    OR ("map_projection" = 'hidden' AND "public_latitude" IS NULL AND "public_longitude" IS NULL)
    OR (
      "map_projection" IN ('exact', 'approximate')
      AND "public_latitude" IS NOT NULL
      AND "public_longitude" IS NOT NULL
      AND "public_latitude" BETWEEN -90 AND 90
      AND "public_longitude" BETWEEN -180 AND 180
    )
  );--> statement-breakpoint
ALTER TABLE "farmer_authorizations"
  ADD CONSTRAINT "farmer_authorizations_verification_precedes_authorization"
  CHECK ("phone_verified_at" <= "authorized_at");--> statement-breakpoint
ALTER TABLE "farmer_authorizations"
  ADD CONSTRAINT "farmer_authorizations_valid_revocation"
  CHECK ("revoked_at" IS NULL OR "revoked_at" >= "authorized_at");--> statement-breakpoint
ALTER TABLE "farm_approvals" ADD CONSTRAINT "farm_approvals_valid_revocation"
  CHECK ("revoked_at" IS NULL OR "revoked_at" >= "approved_at");--> statement-breakpoint
ALTER TABLE "farm_links" ADD CONSTRAINT "farm_links_label_not_blank"
  CHECK (length(trim("label")) > 0);--> statement-breakpoint
ALTER TABLE "farm_links" ADD CONSTRAINT "farm_links_absolute_http_url"
  CHECK ("url" ~ '^https?://[^[:space:]]+$');--> statement-breakpoint
ALTER TABLE "farm_links" ADD CONSTRAINT "farm_links_nonnegative_sort_order"
  CHECK ("sort_order" >= 0);--> statement-breakpoint
ALTER TABLE "sales_locations" ADD CONSTRAINT "sales_locations_name_not_blank"
  CHECK (length(trim("name")) > 0);--> statement-breakpoint
ALTER TABLE "sales_locations" ADD CONSTRAINT "sales_locations_address_not_blank"
  CHECK (length(trim("public_address")) > 0);--> statement-breakpoint
ALTER TABLE "sales_locations" ADD CONSTRAINT "sales_locations_valid_coordinates"
  CHECK (
    "public_latitude" BETWEEN -90 AND 90
    AND "public_longitude" BETWEEN -180 AND 180
  );--> statement-breakpoint
ALTER TABLE "sales_locations"
  ADD CONSTRAINT "sales_locations_farm_bucks_acceptance_requires_eligibility"
  CHECK (NOT "farm_bucks_accepted" OR "farm_bucks_eligible");--> statement-breakpoint
ALTER TABLE "sales_location_payment_methods"
  ADD CONSTRAINT "sales_location_payment_methods_method_not_blank"
  CHECK (length(trim("method")) > 0);--> statement-breakpoint
ALTER TABLE "sender_states"
  ADD CONSTRAINT "sender_states_coherent_conversation_watermark"
  CHECK (
    ("conversation_occurred_at" IS NULL) =
    ("conversation_provider_event_id" IS NULL)
  );--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_retained_body_has_expiry"
  CHECK (
    ("body" IS NULL AND "body_expires_at" IS NULL)
    OR (
      "body" IS NOT NULL
      AND "body_expires_at" IS NOT NULL
      AND "body_expires_at" > "received_at"
    )
  );--> statement-breakpoint
ALTER TABLE "provider_inbox_events"
  ADD CONSTRAINT "provider_inbox_events_coherent_claim_state"
  CHECK (
    (
      "state" = 'pending'
      AND "claim_token" IS NULL
      AND "claimed_at" IS NULL
      AND "claim_expires_at" IS NULL
      AND "finalized_at" IS NULL
      AND "failure_code" IS NULL
    )
    OR (
      "state" = 'processing'
      AND "claim_token" IS NOT NULL
      AND "claimed_at" IS NOT NULL
      AND "claim_expires_at" > "claimed_at"
      AND "finalized_at" IS NULL
      AND "failure_code" IS NULL
    )
    OR (
      "state" = 'processed'
      AND "claim_token" IS NULL
      AND "claim_expires_at" IS NULL
      AND "finalized_at" IS NOT NULL
      AND "failure_code" IS NULL
    )
    OR (
      "state" = 'rejected'
      AND "claim_token" IS NULL
      AND "claim_expires_at" IS NULL
      AND "finalized_at" IS NOT NULL
      AND "failure_code" IS NOT NULL
    )
  );--> statement-breakpoint
ALTER TABLE "sms_consents" ADD CONSTRAINT "sms_consents_coherent_capture"
  CHECK (
    (
      "capture_source" IS NULL
      AND "captured_at" IS NULL
      AND "capture_evidence_ref" IS NULL
    )
    OR (
      "capture_source" IS NOT NULL
      AND "captured_at" IS NOT NULL
      AND "capture_evidence_ref" IS NOT NULL
      AND length(trim("capture_evidence_ref")) > 0
    )
  );--> statement-breakpoint
ALTER TABLE "sms_consents" ADD CONSTRAINT "sms_consents_active_has_capture"
  CHECK ("state" <> 'active' OR "capture_source" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "outbox_work" ADD CONSTRAINT "outbox_work_body_expires_after_creation"
  CHECK ("body_expires_at" > "created_at");--> statement-breakpoint
ALTER TABLE "outbox_work" ADD CONSTRAINT "outbox_work_coherent_state"
  CHECK (
    (
      "state" = 'queued'
      AND "dispatch_authorized_at" IS NULL
      AND "completed_at" IS NULL
    )
    OR (
      "state" = 'dispatching'
      AND "dispatch_authorized_at" IS NOT NULL
      AND "completed_at" IS NULL
    )
    OR (
      "state" IN ('sent', 'failed', 'ambiguous')
      AND "dispatch_authorized_at" IS NOT NULL
      AND "completed_at" IS NOT NULL
    )
    OR (
      "state" = 'suppressed'
      AND "dispatch_authorized_at" IS NULL
      AND "completed_at" IS NOT NULL
    )
  );--> statement-breakpoint
ALTER TABLE "outbox_dispatch_attempts"
  ADD CONSTRAINT "outbox_dispatch_attempts_bounded_number"
  CHECK ("attempt_number" BETWEEN 1 AND 3);--> statement-breakpoint
ALTER TABLE "outbox_dispatch_attempts"
  ADD CONSTRAINT "outbox_dispatch_attempts_coherent_result"
  CHECK (
    (
      "state" = 'authorized'
      AND "completed_at" IS NULL
      AND "provider_message_id" IS NULL
      AND "error_code" IS NULL
    )
    OR (
      "state" = 'accepted'
      AND "completed_at" IS NOT NULL
      AND "provider_message_id" IS NOT NULL
      AND "error_code" IS NULL
    )
    OR (
      "state" IN ('definitive_rejection', 'ambiguous')
      AND "completed_at" IS NOT NULL
      AND "error_code" IS NOT NULL
    )
  );--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals"
  ADD CONSTRAINT "inventory_publication_proposals_positive_version"
  CHECK ("proposal_version" > 0);--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals"
  ADD CONSTRAINT "inventory_publication_proposals_object_payload"
  CHECK (jsonb_typeof("payload") = 'object');--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals"
  ADD CONSTRAINT "inventory_publication_proposals_distinct_tokens"
  CHECK ("yes_token" <> "no_token");--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals"
  ADD CONSTRAINT "inventory_publication_proposals_activation_coherent"
  CHECK (
    (
      "activation_outbox_id" IS NULL
      AND "activated_version" IS NULL
      AND "activated_at" IS NULL
    )
    OR (
      "activation_outbox_id" IS NOT NULL
      AND "activated_version" IS NOT NULL
      AND "activated_version" BETWEEN 1 AND "proposal_version"
      AND "activated_at" IS NOT NULL
    )
  );--> statement-breakpoint
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
      "state" = 'expired'
      AND "consumed_token" IS NULL
      AND "consumption_provider_event_id" IS NULL
      AND "closed_at" IS NOT NULL
    )
  );--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals"
  ADD CONSTRAINT "inventory_publication_proposals_expiry_after_creation"
  CHECK ("expires_at" > "created_at");--> statement-breakpoint
ALTER TABLE "inventory_revisions"
  ADD CONSTRAINT "inventory_revisions_current_state_coherent"
  CHECK (
    ("is_current" AND "superseded_at" IS NULL)
    OR (NOT "is_current" AND "superseded_at" > "published_at")
  );--> statement-breakpoint
ALTER TABLE "inventory_entries" ADD CONSTRAINT "inventory_entries_item_not_blank"
  CHECK (length(trim("item_name")) > 0);--> statement-breakpoint
ALTER TABLE "inventory_entries" ADD CONSTRAINT "inventory_entries_valid_quantity"
  CHECK ("quantity" IS NULL OR "quantity" >= 0);--> statement-breakpoint
ALTER TABLE "inventory_entries"
  ADD CONSTRAINT "inventory_entries_nonnegative_sort_order"
  CHECK ("sort_order" >= 0);--> statement-breakpoint
ALTER TABLE "stock_out_reports"
  ADD CONSTRAINT "stock_out_reports_exactly_one_item_reference"
  CHECK (
    ("referenced_inventory_entry_id" IS NOT NULL AND "unlisted_item_text" IS NULL)
    OR (
      "referenced_inventory_entry_id" IS NULL
      AND "unlisted_item_text" IS NOT NULL
      AND length(trim("unlisted_item_text")) > 0
    )
  );--> statement-breakpoint
ALTER TABLE "stock_out_reports" ADD CONSTRAINT "stock_out_reports_coherent_review"
  CHECK (
    (
      "status" = 'open'
      AND "reviewed_by_administrator_id" IS NULL
      AND "reviewed_at" IS NULL
    )
    OR (
      "status" IN ('reviewed', 'dismissed')
      AND "reviewed_by_administrator_id" IS NOT NULL
      AND "reviewed_at" IS NOT NULL
    )
  );--> statement-breakpoint
ALTER TABLE "flags" ADD CONSTRAINT "flags_reason_code_not_blank"
  CHECK (length(trim("reason_code")) > 0);--> statement-breakpoint
ALTER TABLE "flags" ADD CONSTRAINT "flags_coherent_disposition"
  CHECK (
    (
      "status" = 'open'
      AND "disposition_code" IS NULL
      AND "disposed_by_administrator_id" IS NULL
      AND "disposed_at" IS NULL
    )
    OR (
      "status" IN ('resolved', 'dismissed')
      AND "disposition_code" IS NOT NULL
      AND "disposed_by_administrator_id" IS NOT NULL
      AND "disposed_at" IS NOT NULL
    )
  );--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_action_not_blank"
  CHECK (length(trim("action")) > 0);--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_subject_type_not_blank"
  CHECK (length(trim("subject_type")) > 0);--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_at_most_one_actor"
  CHECK ("actor_contact_hash" IS NULL OR "actor_administrator_id" IS NULL);--> statement-breakpoint
ALTER TABLE "model_runs" ADD CONSTRAINT "model_runs_repair_count_valid"
  CHECK (
    "repair_count" >= 0
    AND (
      ("validation_status" = 'repaired_then_passed' AND "repair_count" > 0)
      OR ("validation_status" <> 'repaired_then_passed' AND "repair_count" = 0)
    )
  );--> statement-breakpoint
ALTER TABLE "model_runs" ADD CONSTRAINT "model_runs_nonnegative_metrics"
  CHECK (
    ("latency_ms" IS NULL OR "latency_ms" >= 0)
    AND ("input_tokens" IS NULL OR "input_tokens" >= 0)
    AND ("output_tokens" IS NULL OR "output_tokens" >= 0)
    AND ("cost_micros" IS NULL OR "cost_micros" >= 0)
  );--> statement-breakpoint
ALTER TABLE "model_runs" ADD CONSTRAINT "model_runs_valid_timing"
  CHECK ("completed_at" IS NULL OR "completed_at" >= "started_at");--> statement-breakpoint
ALTER TABLE "model_runs" ADD CONSTRAINT "model_runs_opaque_refs_array"
  CHECK (jsonb_typeof("opaque_refs") = 'array');--> statement-breakpoint

CREATE FUNCTION guard_inventory_revision_history() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'published inventory revisions cannot be deleted';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."farm_id" IS DISTINCT FROM OLD."farm_id"
    OR NEW."sales_location_id" IS DISTINCT FROM OLD."sales_location_id"
    OR NEW."proposal_id" IS DISTINCT FROM OLD."proposal_id"
    OR NEW."published_by_authorization_id" IS DISTINCT FROM OLD."published_by_authorization_id"
    OR NEW."farm_approval_id" IS DISTINCT FROM OLD."farm_approval_id"
    OR NEW."published_at" IS DISTINCT FROM OLD."published_at"
    OR NOT OLD."is_current"
    OR NEW."is_current"
    OR OLD."superseded_at" IS NOT NULL
    OR NEW."superseded_at" IS NULL
  THEN
    RAISE EXCEPTION 'published inventory revision history is immutable';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "inventory_revisions_guard_history"
  BEFORE UPDATE OR DELETE ON "inventory_revisions"
  FOR EACH ROW EXECUTE FUNCTION guard_inventory_revision_history();--> statement-breakpoint
CREATE FUNCTION guard_inventory_entry_history() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'published inventory entries are immutable';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "inventory_entries_guard_history"
  BEFORE UPDATE OR DELETE ON "inventory_entries"
  FOR EACH ROW EXECUTE FUNCTION guard_inventory_entry_history();--> statement-breakpoint
CREATE FUNCTION guard_public_location_projection() RETURNS trigger AS $$
BEGIN
  IF NEW."is_public" AND EXISTS (
    SELECT 1
    FROM "farms"
    WHERE "id" = NEW."farm_id" AND "map_projection" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'a farm with a public sales location cannot carry a fallback map projection';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "sales_locations_guard_farm_projection"
  BEFORE INSERT OR UPDATE OF "farm_id", "is_public" ON "sales_locations"
  FOR EACH ROW EXECUTE FUNCTION guard_public_location_projection();--> statement-breakpoint
CREATE FUNCTION guard_farm_projection_without_location() RETURNS trigger AS $$
BEGIN
  IF NEW."map_projection" IS NOT NULL AND EXISTS (
    SELECT 1
    FROM "sales_locations"
    WHERE "farm_id" = NEW."id" AND "is_public"
  ) THEN
    RAISE EXCEPTION 'a fallback map projection requires no public sales location';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "farms_guard_public_sales_location"
  BEFORE UPDATE OF "map_projection" ON "farms"
  FOR EACH ROW EXECUTE FUNCTION guard_farm_projection_without_location();
