CREATE TABLE IF NOT EXISTS "sales_location_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_farm_id" uuid NOT NULL,
	"sales_location_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"confirmed_by_authorization_id" uuid NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL,
	"retired_by_authorization_id" uuid,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sales_locations" RENAME COLUMN "farm_id" TO "owner_farm_id";--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_public_location_projection() RETURNS trigger AS $$
BEGIN
  IF NEW."is_public" AND EXISTS (
    SELECT 1
    FROM "farms"
    WHERE "id" = NEW."owner_farm_id" AND "map_projection" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'a farm with a public sales location cannot carry a fallback map projection';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_farm_projection_without_location() RETURNS trigger AS $$
BEGIN
  IF NEW."map_projection" IS NOT NULL AND EXISTS (
    SELECT 1
    FROM "sales_locations"
    WHERE "owner_farm_id" = NEW."id" AND "is_public"
  ) THEN
    RAISE EXCEPTION 'a fallback map projection requires no public sales location';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
ALTER TABLE "closure_revisions" DROP CONSTRAINT "closure_revisions_location_owner_fk";
--> statement-breakpoint
ALTER TABLE "inventory_revisions" DROP CONSTRAINT "inventory_revisions_location_farm_fk";
--> statement-breakpoint
ALTER TABLE "sales_locations" DROP CONSTRAINT "sales_locations_id_farm_unique";--> statement-breakpoint
ALTER TABLE "sales_locations" DROP CONSTRAINT "sales_locations_farm_id_farms_id_fk";
--> statement-breakpoint
ALTER TABLE "sales_locations" ADD CONSTRAINT "sales_locations_id_owner_unique" UNIQUE("id","owner_farm_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_location_participants" ADD CONSTRAINT "sales_location_participants_location_owner_fk" FOREIGN KEY ("sales_location_id","owner_farm_id") REFERENCES "public"."sales_locations"("id","owner_farm_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_location_participants" ADD CONSTRAINT "sales_location_participants_confirming_owner_fk" FOREIGN KEY ("confirmed_by_authorization_id","owner_farm_id") REFERENCES "public"."farmer_authorizations"("id","farm_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_location_participants" ADD CONSTRAINT "sales_location_participants_retiring_owner_fk" FOREIGN KEY ("retired_by_authorization_id","owner_farm_id") REFERENCES "public"."farmer_authorizations"("id","farm_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sales_location_participants_one_active_normalized_name" ON "sales_location_participants" USING btree ("sales_location_id",lower(regexp_replace(trim("display_name"), '[[:space:]]+', ' ', 'g'))) WHERE "sales_location_participants"."retired_at" is null;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "closure_revisions" ADD CONSTRAINT "closure_revisions_location_owner_fk" FOREIGN KEY ("sales_location_id","owner_farm_id") REFERENCES "public"."sales_locations"("id","owner_farm_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_revisions" ADD CONSTRAINT "inventory_revisions_location_farm_fk" FOREIGN KEY ("sales_location_id","farm_id") REFERENCES "public"."sales_locations"("id","owner_farm_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_locations" ADD CONSTRAINT "sales_locations_owner_farm_id_farms_id_fk" FOREIGN KEY ("owner_farm_id") REFERENCES "public"."farms"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- F-050: drizzle-kit 0.22.8 omits CHECK constraints from generated SQL. Keep both
-- public-name and retirement coherence checks in the migration that production executes.
ALTER TABLE "sales_location_participants"
  ADD CONSTRAINT "sales_location_participants_display_name_not_blank"
  CHECK (length(trim("display_name")) > 0);--> statement-breakpoint
ALTER TABLE "sales_location_participants"
  ADD CONSTRAINT "sales_location_participants_retirement_coherent"
  CHECK (
    (
      "retired_at" IS NULL
      AND "retired_by_authorization_id" IS NULL
    )
    OR (
      "retired_at" IS NOT NULL
      AND "retired_by_authorization_id" IS NOT NULL
      AND "retired_at" >= "confirmed_at"
    )
  );--> statement-breakpoint

CREATE FUNCTION reject_sales_location_participant_history_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sales-location participant history cannot be deleted';
  END IF;

  IF OLD."retired_at" IS NOT NULL
    OR NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."owner_farm_id" IS DISTINCT FROM OLD."owner_farm_id"
    OR NEW."sales_location_id" IS DISTINCT FROM OLD."sales_location_id"
    OR NEW."display_name" IS DISTINCT FROM OLD."display_name"
    OR NEW."confirmed_by_authorization_id" IS DISTINCT FROM OLD."confirmed_by_authorization_id"
    OR NEW."confirmed_at" IS DISTINCT FROM OLD."confirmed_at"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR (
      NEW."retired_at" IS NOT DISTINCT FROM OLD."retired_at"
      AND NEW."retired_by_authorization_id" IS NOT DISTINCT FROM OLD."retired_by_authorization_id"
    )
  THEN
    RAISE EXCEPTION 'sales-location participant history is immutable except for first retirement';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "sales_location_participants_guard_history"
  BEFORE UPDATE OR DELETE ON "sales_location_participants"
  FOR EACH ROW EXECUTE FUNCTION reject_sales_location_participant_history_mutation();
