DO $$ BEGIN
 CREATE TYPE "public"."inventory_prompt_cadence" AS ENUM('every_2_days', 'weekly', 'every_2_weeks', 'paused');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."sales_location_timezone" AS ENUM('America/Los_Angeles');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_prompt_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_farm_id" uuid NOT NULL,
	"sales_location_id" uuid NOT NULL,
	"designated_authorization_id" uuid NOT NULL,
	"cadence" "inventory_prompt_cadence" NOT NULL,
	"version" integer NOT NULL,
	"next_due_at" timestamp with time zone,
	"last_due_slot_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "inventory_prompt_preferences_location_unique" UNIQUE("sales_location_id")
);
ALTER TABLE "inventory_prompt_preferences" ADD CONSTRAINT "inventory_prompt_preferences_positive_version" CHECK ("version" > 0);--> statement-breakpoint
ALTER TABLE "inventory_prompt_preferences" ADD CONSTRAINT "inventory_prompt_preferences_due_state_coherent" CHECK (("cadence" = 'paused' and "next_due_at" is null) or ("cadence" <> 'paused' and "next_due_at" is not null));--> statement-breakpoint
ALTER TABLE "inventory_prompt_preferences" ADD CONSTRAINT "inventory_prompt_preferences_due_slots_ordered" CHECK ("last_due_slot_at" is null or "next_due_at" is null or "next_due_at" > "last_due_slot_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scheduled_inventory_prompt_subjects" (
	"proposal_id" uuid PRIMARY KEY NOT NULL,
	"proposal_version" integer NOT NULL,
	"preference_id" uuid NOT NULL,
	"preference_version" integer NOT NULL,
	"authorization_id" uuid NOT NULL,
	"owner_farm_id" uuid NOT NULL,
	"sales_location_id" uuid NOT NULL,
	"inventory_base_revision_id" uuid,
	"closure_base_revision_id" uuid,
	"closure_base_is_first_instruction" boolean NOT NULL,
	"due_slot_at" timestamp with time zone NOT NULL,
	"outbox_work_id" uuid NOT NULL,
	"offers_same" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scheduled_prompt_subjects_preference_due_slot_unique" UNIQUE("preference_id","due_slot_at"),
	CONSTRAINT "scheduled_prompt_subjects_outbox_unique" UNIQUE("outbox_work_id")
);
ALTER TABLE "scheduled_inventory_prompt_subjects" ADD CONSTRAINT "scheduled_prompt_subjects_positive_versions" CHECK ("proposal_version" > 0 and "preference_version" > 0);--> statement-breakpoint
ALTER TABLE "scheduled_inventory_prompt_subjects" ADD CONSTRAINT "scheduled_prompt_subjects_visible_snapshot_for_same" CHECK (not "offers_same" or "inventory_base_revision_id" is not null);--> statement-breakpoint
ALTER TABLE "scheduled_inventory_prompt_subjects" ADD CONSTRAINT "scheduled_prompt_subjects_closure_base_coherent" CHECK (("closure_base_is_first_instruction" and "closure_base_revision_id" is null) or (not "closure_base_is_first_instruction" and "closure_base_revision_id" is not null));
--> statement-breakpoint
ALTER TABLE "sales_locations" ADD COLUMN "timezone" "sales_location_timezone";--> statement-breakpoint
UPDATE "sales_locations" SET "timezone" = 'America/Los_Angeles' WHERE "timezone" IS NULL;--> statement-breakpoint
ALTER TABLE "sales_locations" ALTER COLUMN "timezone" SET NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_prompt_preferences" ADD CONSTRAINT "inventory_prompt_preferences_location_owner_fk" FOREIGN KEY ("sales_location_id","owner_farm_id") REFERENCES "public"."sales_locations"("id","owner_farm_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_prompt_preferences" ADD CONSTRAINT "inventory_prompt_preferences_authorization_owner_fk" FOREIGN KEY ("designated_authorization_id","owner_farm_id") REFERENCES "public"."farmer_authorizations"("id","farm_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_inventory_prompt_subjects" ADD CONSTRAINT "scheduled_prompt_subjects_proposal_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."inventory_publication_proposals"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_inventory_prompt_subjects" ADD CONSTRAINT "scheduled_prompt_subjects_preference_fk" FOREIGN KEY ("preference_id") REFERENCES "public"."inventory_prompt_preferences"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_inventory_prompt_subjects" ADD CONSTRAINT "scheduled_prompt_subjects_authorization_owner_fk" FOREIGN KEY ("authorization_id","owner_farm_id") REFERENCES "public"."farmer_authorizations"("id","farm_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_inventory_prompt_subjects" ADD CONSTRAINT "scheduled_prompt_subjects_location_owner_fk" FOREIGN KEY ("sales_location_id","owner_farm_id") REFERENCES "public"."sales_locations"("id","owner_farm_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_inventory_prompt_subjects" ADD CONSTRAINT "scheduled_prompt_subjects_inventory_base_fk" FOREIGN KEY ("inventory_base_revision_id","sales_location_id") REFERENCES "public"."inventory_revisions"("id","sales_location_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_inventory_prompt_subjects" ADD CONSTRAINT "scheduled_prompt_subjects_closure_base_fk" FOREIGN KEY ("closure_base_revision_id","sales_location_id") REFERENCES "public"."closure_revisions"("id","sales_location_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_inventory_prompt_subjects" ADD CONSTRAINT "scheduled_prompt_subjects_outbox_fk" FOREIGN KEY ("outbox_work_id") REFERENCES "public"."outbox_work"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
