DO $$ BEGIN
 CREATE TYPE "public"."closure_kind" AS ENUM('temporary', 'seasonal');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."closure_result" AS ENUM('close', 'reopen');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "closure_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_farm_id" uuid NOT NULL,
	"sales_location_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"owner_authorization_id" uuid NOT NULL,
	"owner_approval_id" uuid NOT NULL,
	"result" "closure_result" NOT NULL,
	"closure_kind" "closure_kind",
	"starts_on" date,
	"closed_through" date,
	"published_at" timestamp with time zone NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "closure_revisions_id_location_unique" UNIQUE("id","sales_location_id"),
	CONSTRAINT "closure_revisions_proposal_unique" UNIQUE("proposal_id")
);
--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals" ALTER COLUMN "base_is_first_publication" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals" ADD COLUMN "has_inventory" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals" ADD COLUMN "has_closure" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals" ADD COLUMN "closure_base_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals" ADD COLUMN "closure_base_is_first_instruction" boolean;--> statement-breakpoint
-- B-032: defaults above exist only long enough to classify rows from the populated pre-change
-- schema. New writes must state all four independent facts explicitly.
ALTER TABLE "sales_locations" ALTER COLUMN "visitability" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "sales_locations" ALTER COLUMN "offering_type" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals" ALTER COLUMN "has_inventory" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals" ALTER COLUMN "has_closure" DROP DEFAULT;--> statement-breakpoint
-- Confirmation language is fixed deterministic parser behavior, not proposal data.
ALTER TABLE "inventory_publication_proposals" DROP CONSTRAINT "inventory_publication_proposals_distinct_tokens";--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals" DROP COLUMN "schema_version";--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals" DROP COLUMN "yes_token";--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals" DROP COLUMN "no_token";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "closure_revisions" ADD CONSTRAINT "closure_revisions_proposal_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."inventory_publication_proposals"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "closure_revisions" ADD CONSTRAINT "closure_revisions_location_owner_fk" FOREIGN KEY ("sales_location_id","owner_farm_id") REFERENCES "public"."sales_locations"("id","farm_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "closure_revisions" ADD CONSTRAINT "closure_revisions_authorization_owner_fk" FOREIGN KEY ("owner_authorization_id","owner_farm_id") REFERENCES "public"."farmer_authorizations"("id","farm_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "closure_revisions" ADD CONSTRAINT "closure_revisions_approval_owner_fk" FOREIGN KEY ("owner_approval_id","owner_farm_id") REFERENCES "public"."farm_approvals"("id","farm_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "closure_revisions_one_current_per_location" ON "closure_revisions" USING btree ("sales_location_id") WHERE "closure_revisions"."is_current";
--> statement-breakpoint

-- F-049: drizzle-kit 0.22.8 omits CHECK constraints from generated SQL. Every check
-- declared in schema.ts is therefore written here by hand and exercised against real
-- Postgres, including the NULL cases that would otherwise make a CHECK pass silently.
ALTER TABLE "inventory_publication_proposals"
  DROP CONSTRAINT IF EXISTS "inventory_publication_proposals_base_binding_coherent";--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals"
  ADD CONSTRAINT "inventory_publication_proposals_base_binding_coherent"
  CHECK (
    (
      "has_inventory"
      AND "base_is_first_publication" IS NOT NULL
      AND (
        ("base_is_first_publication" AND "base_revision_id" IS NULL)
        OR (NOT "base_is_first_publication" AND "base_revision_id" IS NOT NULL)
      )
    )
    OR (
      NOT "has_inventory"
      AND "base_is_first_publication" IS NULL
      AND "base_revision_id" IS NULL
    )
  );--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals"
  ADD CONSTRAINT "inventory_publication_proposals_at_least_one_section"
  CHECK ("has_inventory" OR "has_closure");--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals"
  ADD CONSTRAINT "inventory_publication_proposals_closure_base_binding_coherent"
  CHECK (
    (
      "has_closure"
      AND "closure_base_is_first_instruction" IS NOT NULL
      AND (
        (
          "closure_base_is_first_instruction"
          AND "closure_base_revision_id" IS NULL
        )
        OR (
          NOT "closure_base_is_first_instruction"
          AND "closure_base_revision_id" IS NOT NULL
        )
      )
    )
    OR (
      NOT "has_closure"
      AND "closure_base_is_first_instruction" IS NULL
      AND "closure_base_revision_id" IS NULL
    )
  );--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals"
  ADD CONSTRAINT "inventory_proposals_closure_base_revision_fk"
  FOREIGN KEY ("closure_base_revision_id", "sales_location_id")
  REFERENCES "public"."closure_revisions"("id", "sales_location_id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "closure_revisions"
  ADD CONSTRAINT "closure_revisions_result_shape"
  CHECK (
    (
      "result" = 'reopen'
      AND "closure_kind" IS NULL
      AND "starts_on" IS NULL
      AND "closed_through" IS NULL
    )
    OR (
      "result" = 'close'
      AND "closure_kind" IS NOT NULL
      AND "starts_on" IS NOT NULL
    )
  );--> statement-breakpoint
ALTER TABLE "closure_revisions"
  ADD CONSTRAINT "closure_revisions_seasonal_has_no_end"
  CHECK (
    "closure_kind" IS NULL
    OR "closure_kind" <> 'seasonal'
    OR "closed_through" IS NULL
  );--> statement-breakpoint
ALTER TABLE "closure_revisions"
  ADD CONSTRAINT "closure_revisions_end_not_before_start"
  CHECK (
    "closed_through" IS NULL
    OR ("starts_on" IS NOT NULL AND "closed_through" >= "starts_on")
  );--> statement-breakpoint
ALTER TABLE "closure_revisions"
  ADD CONSTRAINT "closure_revisions_current_state_coherent"
  CHECK (
    ("is_current" AND "superseded_at" IS NULL)
    OR (
      NOT "is_current"
      AND "superseded_at" IS NOT NULL
      AND "superseded_at" > "published_at"
    )
  );--> statement-breakpoint

CREATE FUNCTION reject_closure_history_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'published closure revisions cannot be deleted';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."owner_farm_id" IS DISTINCT FROM OLD."owner_farm_id"
    OR NEW."sales_location_id" IS DISTINCT FROM OLD."sales_location_id"
    OR NEW."proposal_id" IS DISTINCT FROM OLD."proposal_id"
    OR NEW."owner_authorization_id" IS DISTINCT FROM OLD."owner_authorization_id"
    OR NEW."owner_approval_id" IS DISTINCT FROM OLD."owner_approval_id"
    OR NEW."result" IS DISTINCT FROM OLD."result"
    OR NEW."closure_kind" IS DISTINCT FROM OLD."closure_kind"
    OR NEW."starts_on" IS DISTINCT FROM OLD."starts_on"
    OR NEW."closed_through" IS DISTINCT FROM OLD."closed_through"
    OR NEW."published_at" IS DISTINCT FROM OLD."published_at"
    OR NOT OLD."is_current"
    OR NEW."is_current"
    OR OLD."superseded_at" IS NOT NULL
    OR NEW."superseded_at" IS NULL
  THEN
    RAISE EXCEPTION 'published closure revision history is immutable';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "closure_revisions_guard_history"
  BEFORE UPDATE OR DELETE ON "closure_revisions"
  FOR EACH ROW EXECUTE FUNCTION reject_closure_history_mutation();
