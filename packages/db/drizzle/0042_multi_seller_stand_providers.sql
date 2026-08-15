DO $$ BEGIN
 CREATE TYPE "public"."stand_provider_approval_source" AS ENUM('viga', 'host');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."stand_provider_lifecycle" AS ENUM('pending', 'active', 'paused');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sellers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"farm_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by_administrator_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stand_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sales_location_id" uuid NOT NULL,
	"seller_id" uuid,
	"lifecycle_state" "stand_provider_lifecycle" NOT NULL,
	"invited_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"approval_source" "stand_provider_approval_source",
	"approved_at" timestamp with time zone,
	"approved_by_authorization_id" uuid,
	"ended_at" timestamp with time zone,
	"public_note" text,
	"season_kind" "season_kind",
	"season_start_month" integer,
	"season_start_day" integer,
	"season_end_month" integer,
	"season_end_day" integer,
	"season_names" text[],
	"open_hours_kind" "open_hours_kind",
	"open_from_minutes" integer,
	"open_until_minutes" integer,
	"open_days" integer[],
	"reminder_cadence" "inventory_prompt_cadence",
	"reminder_authorization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stand_providers_id_location_unique" UNIQUE("id","sales_location_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sellers" ADD CONSTRAINT "sellers_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sellers" ADD CONSTRAINT "sellers_revoked_by_administrator_id_administrators_id_fk" FOREIGN KEY ("revoked_by_administrator_id") REFERENCES "public"."administrators"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stand_providers" ADD CONSTRAINT "stand_providers_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stand_providers" ADD CONSTRAINT "stand_providers_approved_by_authorization_id_farmer_authorizations_id_fk" FOREIGN KEY ("approved_by_authorization_id") REFERENCES "public"."farmer_authorizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stand_providers" ADD CONSTRAINT "stand_providers_reminder_authorization_id_farmer_authorizations_id_fk" FOREIGN KEY ("reminder_authorization_id") REFERENCES "public"."farmer_authorizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stand_providers" ADD CONSTRAINT "stand_providers_location_fk" FOREIGN KEY ("sales_location_id") REFERENCES "public"."sales_locations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sellers_one_per_farm" ON "sellers" USING btree ("farm_id") WHERE "sellers"."farm_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stand_providers_one_native_per_location" ON "stand_providers" USING btree ("sales_location_id") WHERE "stand_providers"."seller_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stand_providers_one_per_seller_per_location" ON "stand_providers" USING btree ("sales_location_id","seller_id") WHERE "stand_providers"."seller_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stand_providers_live_idx" ON "stand_providers" USING btree ("sales_location_id") WHERE "stand_providers"."ended_at" is null;--> statement-breakpoint

-- ===========================================================================================
-- F-114 Phase B — THE BACKFILL. Everything above created empty structure; everything below
-- moves EXISTING rows onto it, and the order is load-bearing.
--
-- `drizzle-kit generate` emitted `ADD COLUMN … NOT NULL` with no default and no backfill, which
-- fails outright on any table that already has a row. Against the production corpus — 37 stands
-- with inventory, usual items, links, preferences and proposals — that is every one of these
-- tables. So each column is added NULLABLE, backfilled, and only then made NOT NULL: the
-- constraint is proved by the data rather than asserted ahead of it.
--
-- **Every existing stand gets exactly one native provider row** (`seller_id is null`), carrying
-- its current inventory, usual items, prices, payment, schedule and reminder settings unchanged.
-- Every current public and SMS output is byte-identical afterwards, because the native row is
-- the stand selling as itself and nothing about what it published has moved.
--
-- The native row states NO schedule of its own. It defers to the stand's, which is what
-- `intersectAvailability` does with a provider that stated nothing: `unknown` PERMITS. Copying
-- the stand's hours onto it would be a second copy of one fact, and the two would drift.
--
-- `sales_location_participants` is deliberately NOT converted. Its rows are free-text names with
-- no confirmed linking flow behind them; name matching would fabricate authority. They stay as
-- retained history and a VIGA work queue (§migration approach).
-- ===========================================================================================

-- One native provider per stand, including retired ones: a retired stand keeps every revision it
-- published, and those revisions need a provider to point at.
INSERT INTO "stand_providers" ("sales_location_id", "seller_id", "lifecycle_state")
SELECT "id", NULL, 'active' FROM "sales_locations"
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- EVERY stand has a native slot — the ones that exist now (above) and every one created from
-- here on (below). This is a trigger rather than a line in the two writers that create stands
-- today, because a stand with no native provider can hold no inventory and no usual items at
-- all: it would be a listing that silently cannot publish, and the failure would surface far
-- from the writer that caused it. Two writers create stands today; the number of writers that
-- must remember this is now zero.
CREATE OR REPLACE FUNCTION create_native_stand_provider() RETURNS trigger AS $$
BEGIN
  INSERT INTO "stand_providers" ("sales_location_id", "seller_id", "lifecycle_state")
  VALUES (NEW."id", NULL, 'active')
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "sales_locations_create_native_provider" ON "sales_locations";--> statement-breakpoint
CREATE TRIGGER "sales_locations_create_native_provider"
  AFTER INSERT ON "sales_locations"
  FOR EACH ROW EXECUTE FUNCTION create_native_stand_provider();--> statement-breakpoint

ALTER TABLE "farmer_links" ADD COLUMN IF NOT EXISTS "provider_id" uuid;--> statement-breakpoint
ALTER TABLE "farmer_target_contexts" ADD COLUMN IF NOT EXISTS "selected_provider_id" uuid;--> statement-breakpoint
ALTER TABLE "farmer_target_menu_options" ADD COLUMN IF NOT EXISTS "provider_id" uuid;--> statement-breakpoint
ALTER TABLE "inventory_prompt_preferences" ADD COLUMN IF NOT EXISTS "provider_id" uuid;--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals" ADD COLUMN IF NOT EXISTS "provider_id" uuid;--> statement-breakpoint
ALTER TABLE "inventory_revisions" ADD COLUMN IF NOT EXISTS "provider_id" uuid;--> statement-breakpoint
ALTER TABLE "scheduled_inventory_prompt_subjects" ADD COLUMN IF NOT EXISTS "provider_id" uuid;--> statement-breakpoint
ALTER TABLE "stand_items" ADD COLUMN IF NOT EXISTS "provider_id" uuid;--> statement-breakpoint

-- Each row inherits the native provider of the stand it already named. Every one of these
-- tables carries `sales_location_id` already, so nothing is inferred and nothing is guessed.
UPDATE "farmer_links" l SET "provider_id" = p."id"
  FROM "stand_providers" p
  WHERE p."sales_location_id" = l."sales_location_id" AND p."seller_id" IS NULL;--> statement-breakpoint
UPDATE "farmer_target_menu_options" o SET "provider_id" = p."id"
  FROM "stand_providers" p
  WHERE p."sales_location_id" = o."sales_location_id" AND p."seller_id" IS NULL;--> statement-breakpoint
UPDATE "inventory_prompt_preferences" f SET "provider_id" = p."id"
  FROM "stand_providers" p
  WHERE p."sales_location_id" = f."sales_location_id" AND p."seller_id" IS NULL;--> statement-breakpoint
UPDATE "inventory_publication_proposals" r SET "provider_id" = p."id"
  FROM "stand_providers" p
  WHERE p."sales_location_id" = r."sales_location_id" AND p."seller_id" IS NULL;--> statement-breakpoint
-- `inventory_revisions` is guarded by `inventory_revisions_guard_history`, which permits exactly
-- ONE transition — superseding a current revision — and refuses every other UPDATE outright.
-- That guard is a Golden Rule #1 protection and is NOT weakened here.
--
-- This migration is the one legitimate actor that may touch a published row, and what it does is
-- not a rewrite of history: it ATTRIBUTES an existing revision to the provider that already
-- published it. No published fact changes — not the items, not the date, not the farm, not the
-- currency. So the trigger is disabled for these two statements and immediately re-enabled, and
-- the guard is then WIDENED to cover `provider_id`, so the new column is as immutable as the
-- columns beside it from this point on.
ALTER TABLE "inventory_revisions" DISABLE TRIGGER "inventory_revisions_guard_history";--> statement-breakpoint
UPDATE "inventory_revisions" v SET "provider_id" = p."id"
  FROM "stand_providers" p
  WHERE p."sales_location_id" = v."sales_location_id" AND p."seller_id" IS NULL;--> statement-breakpoint
ALTER TABLE "inventory_revisions" ENABLE TRIGGER "inventory_revisions_guard_history";--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_inventory_revision_history() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'published inventory revisions cannot be deleted';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."farm_id" IS DISTINCT FROM OLD."farm_id"
    OR NEW."sales_location_id" IS DISTINCT FROM OLD."sales_location_id"
    OR NEW."provider_id" IS DISTINCT FROM OLD."provider_id"
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
UPDATE "scheduled_inventory_prompt_subjects" s SET "provider_id" = p."id"
  FROM "stand_providers" p
  WHERE p."sales_location_id" = s."sales_location_id" AND p."seller_id" IS NULL;--> statement-breakpoint
UPDATE "stand_items" i SET "provider_id" = p."id"
  FROM "stand_providers" p
  WHERE p."sales_location_id" = i."sales_location_id" AND p."seller_id" IS NULL;--> statement-breakpoint

-- The selected SMS target is nullable by design — a sender with no selection has none — so it
-- is filled only where a stand was already selected. `selected_context_coherent` below requires
-- all five columns together, so a half-filled selection would be refused at the ALTER.
UPDATE "farmer_target_contexts" c SET "selected_provider_id" = p."id"
  FROM "stand_providers" p
  WHERE p."sales_location_id" = c."selected_sales_location_id" AND p."seller_id" IS NULL;--> statement-breakpoint

-- NOT NULL is asserted only now, against backfilled data. If any UPDATE above missed a row —
-- a stand deleted between statements, a location id with no provider — these fail LOUDLY here
-- rather than admitting an unattributed record that every later reader would mis-file.
ALTER TABLE "farmer_links" ALTER COLUMN "provider_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "farmer_target_menu_options" ALTER COLUMN "provider_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_prompt_preferences" ALTER COLUMN "provider_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals" ALTER COLUMN "provider_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_revisions" ALTER COLUMN "provider_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_inventory_prompt_subjects" ALTER COLUMN "provider_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "stand_items" ALTER COLUMN "provider_id" SET NOT NULL;--> statement-breakpoint

-- ===========================================================================================
-- Re-rooting. The old stand-keyed constraints come off and the provider-keyed ones go on, with
-- the backfill already in place so every new constraint is validated against real rows.
--
-- TWO composite keys deliberately STAY rooted on `(location, owner_farm)` (max, 2026-08-15):
-- `closure_revisions_location_owner_fk`, because stand closure is owner-only and overrides every
-- provider — it is a fact about the place, not about a seller — and
-- `sales_location_participants_location_owner_fk`, because that table is retired as display-only
-- history whose rows the migration is forbidden to link to seller identities.
-- ===========================================================================================
ALTER TABLE "farmer_links" DROP CONSTRAINT IF EXISTS "farmer_links_targeted_location_owner_fk";--> statement-breakpoint
ALTER TABLE "farmer_target_contexts" DROP CONSTRAINT IF EXISTS "farmer_target_contexts_selected_location_owner_fk";--> statement-breakpoint
ALTER TABLE "farmer_target_menu_options" DROP CONSTRAINT IF EXISTS "farmer_target_menu_options_location_owner_fk";--> statement-breakpoint
ALTER TABLE "inventory_prompt_preferences" DROP CONSTRAINT IF EXISTS "inventory_prompt_preferences_location_owner_fk";--> statement-breakpoint
ALTER TABLE "inventory_publication_proposals" DROP CONSTRAINT IF EXISTS "inventory_proposals_location_fk";--> statement-breakpoint
ALTER TABLE "inventory_revisions" DROP CONSTRAINT IF EXISTS "inventory_revisions_location_farm_fk";--> statement-breakpoint
ALTER TABLE "scheduled_inventory_prompt_subjects" DROP CONSTRAINT IF EXISTS "scheduled_prompt_subjects_location_owner_fk";--> statement-breakpoint
ALTER TABLE "stand_items" DROP CONSTRAINT IF EXISTS "stand_items_location_fk";--> statement-breakpoint
ALTER TABLE "farmer_target_menu_options" DROP CONSTRAINT IF EXISTS "farmer_target_menu_options_one_number_per_pair";--> statement-breakpoint
ALTER TABLE "inventory_prompt_preferences" DROP CONSTRAINT IF EXISTS "inventory_prompt_preferences_location_unique";--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "farmer_links" ADD CONSTRAINT "farmer_links_targeted_location_provider_fk" FOREIGN KEY ("provider_id","sales_location_id") REFERENCES "public"."stand_providers"("id","sales_location_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "farmer_target_contexts" ADD CONSTRAINT "farmer_target_contexts_selected_location_provider_fk" FOREIGN KEY ("selected_provider_id","selected_sales_location_id") REFERENCES "public"."stand_providers"("id","sales_location_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "farmer_target_menu_options" ADD CONSTRAINT "farmer_target_menu_options_location_provider_fk" FOREIGN KEY ("provider_id","sales_location_id") REFERENCES "public"."stand_providers"("id","sales_location_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_prompt_preferences" ADD CONSTRAINT "inventory_prompt_preferences_location_provider_fk" FOREIGN KEY ("provider_id","sales_location_id") REFERENCES "public"."stand_providers"("id","sales_location_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_publication_proposals" ADD CONSTRAINT "inventory_proposals_location_provider_fk" FOREIGN KEY ("provider_id","sales_location_id") REFERENCES "public"."stand_providers"("id","sales_location_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_revisions" ADD CONSTRAINT "inventory_revisions_location_provider_fk" FOREIGN KEY ("provider_id","sales_location_id") REFERENCES "public"."stand_providers"("id","sales_location_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_inventory_prompt_subjects" ADD CONSTRAINT "scheduled_prompt_subjects_location_provider_fk" FOREIGN KEY ("provider_id","sales_location_id") REFERENCES "public"."stand_providers"("id","sales_location_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stand_items" ADD CONSTRAINT "stand_items_location_provider_fk" FOREIGN KEY ("provider_id","sales_location_id") REFERENCES "public"."stand_providers"("id","sales_location_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "farmer_target_menu_options" ADD CONSTRAINT "farmer_target_menu_options_one_number_per_pair" UNIQUE("sender_hash","authorization_id","provider_id");
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_prompt_preferences" ADD CONSTRAINT "inventory_prompt_preferences_provider_unique" UNIQUE("provider_id");
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- ===========================================================================================
-- The three re-keyed unique indexes. Each old index is dropped and its successor created in
-- THIS migration, never across two: `inventory_revisions_one_current_per_location` is the
-- specific invariant per-provider inventory invalidates, and a window with neither index is a
-- window in which two current revisions per stand can be written and never detected afterwards.
-- ===========================================================================================
DROP INDEX IF EXISTS "inventory_publication_proposals_one_open_per_sender";--> statement-breakpoint
DROP INDEX IF EXISTS "inventory_revisions_one_current_per_location";--> statement-breakpoint
DROP INDEX IF EXISTS "stand_items_one_per_location_name";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_publication_proposals_one_open_per_provider" ON "inventory_publication_proposals" USING btree ("sender_hash","sales_location_id","provider_id") WHERE "inventory_publication_proposals"."state" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_revisions_one_current_per_provider" ON "inventory_revisions" USING btree ("provider_id") WHERE "inventory_revisions"."is_current";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stand_items_one_per_provider_name" ON "stand_items" USING btree ("provider_id",lower(btrim("display_name", E' \t\r\n')));--> statement-breakpoint

-- ===========================================================================================
-- CHECK constraints. `drizzle-kit generate` does not emit them, so every one is hand-written —
-- the same discipline every CHECK in this directory got here by.
--
-- EVERY nullability rule below is a BICONDITIONAL, because a CHECK PASSES on NULL. A
-- one-directional test ("an approver is recorded") admits precisely the half-populated row the
-- constraint exists to refuse, and it loads silently.
-- ===========================================================================================

-- The NATIVE slot carries no hosting lifecycle; a NAMED provider carries all of it. The native
-- arm is not a degenerate case of the named one: a stand selling under its own name was never
-- invited by anybody, so requiring the columns would only be satisfiable by inventing an event.
DO $$ BEGIN
 ALTER TABLE "stand_providers" ADD CONSTRAINT "stand_providers_hosting_lifecycle_coherent" CHECK (
  (
    "seller_id" is null
    and "invited_at" is null
    and "accepted_at" is null
    and "approval_source" is null
    and "approved_at" is null
    and "approved_by_authorization_id" is null
    and "lifecycle_state" <> 'pending'
  )
  or (
    "seller_id" is not null
    and "invited_at" is not null
    and (
      (
        "lifecycle_state" = 'pending'
        and "accepted_at" is null
        and "approval_source" is null
        and "approved_at" is null
      )
      or (
        "lifecycle_state" in ('active', 'paused')
        and "accepted_at" is not null
        and "accepted_at" >= "invited_at"
        and "approval_source" is not null
        and "approved_at" is not null
      )
    )
  )
);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- A vouching host names the authorization that vouched; VIGA names none.
DO $$ BEGIN
 ALTER TABLE "stand_providers" ADD CONSTRAINT "stand_providers_approval_source_coherent" CHECK (
  ("approval_source" = 'host') = ("approved_by_authorization_id" is not null)
  or ("approval_source" is null and "approved_by_authorization_id" is null)
);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- An ended relationship ended after it began, and the native slot never ends.
DO $$ BEGIN
 ALTER TABLE "stand_providers" ADD CONSTRAINT "stand_providers_ending_coherent" CHECK (
  "ended_at" is null
  or ("seller_id" is not null and "invited_at" is not null and "ended_at" >= "invited_at")
);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "stand_providers" ADD CONSTRAINT "stand_providers_public_note_not_blank" CHECK (
  "public_note" is null or length(btrim("public_note", E' \t\r\n')) > 0
);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- A cadence with nobody to text is a reminder that can never be sent; a recipient with no
-- cadence is a preference nobody stated.
DO $$ BEGIN
 ALTER TABLE "stand_providers" ADD CONSTRAINT "stand_providers_reminder_coherent" CHECK (
  ("reminder_cadence" is not null) = ("reminder_authorization_id" is not null)
);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- The availability rules repeat `sales_locations`' verbatim, because both feed the SAME
-- `openNow` reader through `StandAvailabilityFacts`.
DO $$ BEGIN
 ALTER TABLE "stand_providers" ADD CONSTRAINT "stand_providers_coherent_season" CHECK (
  (
    "season_kind" is null
    and "season_start_month" is null and "season_start_day" is null
    and "season_end_month" is null and "season_end_day" is null
    and "season_names" is null
  )
  or (
    "season_kind" = 'year_round'
    and "season_start_month" is null and "season_end_month" is null
    and "season_names" is null
  )
  or (
    "season_kind" = 'date_range'
    and "season_start_month" is not null and "season_start_day" is not null
    and "season_end_month" is not null and "season_end_day" is not null
    and "season_names" is null
  )
  or (
    "season_kind" = 'named_season'
    and "season_names" is not null
    and coalesce(array_length("season_names", 1), 0) > 0
    and "season_start_month" is null and "season_end_month" is null
  )
  or (
    "season_kind" = 'open_ended'
    and "season_start_month" is not null and "season_start_day" is not null
    and "season_end_month" is null and "season_end_day" is null
    and "season_names" is null
  )
);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "stand_providers" ADD CONSTRAINT "stand_providers_valid_season_dates" CHECK (
  ("season_start_month" is null or "season_start_month" between 1 and 12)
  and ("season_end_month" is null or "season_end_month" between 1 and 12)
  and ("season_start_day" is null or "season_start_day" between 1 and 31)
  and ("season_end_day" is null or "season_end_day" between 1 and 31)
);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "stand_providers" ADD CONSTRAINT "stand_providers_coherent_open_hours" CHECK (
  (
    "open_hours_kind" is null
    and "open_from_minutes" is null and "open_until_minutes" is null
  )
  or (
    "open_hours_kind" in ('dawn_to_dusk', 'daylight_hours', 'all_day', 'by_appointment')
    and "open_from_minutes" is null and "open_until_minutes" is null
  )
  or (
    "open_hours_kind" = 'clock_range'
    and "open_from_minutes" is not null and "open_until_minutes" is not null
  )
  or (
    "open_hours_kind" = 'until_dusk'
    and "open_from_minutes" is not null and "open_until_minutes" is null
  )
);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "stand_providers" ADD CONSTRAINT "stand_providers_valid_open_minutes" CHECK (
  ("open_from_minutes" is null or "open_from_minutes" between 0 and 1439)
  and ("open_until_minutes" is null or "open_until_minutes" between 0 and 1439)
);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- `coalesce` is load-bearing: `array_length` of an empty array returns NULL, not 0, and a CHECK
-- passes on NULL — so a bare range test would admit the empty array it forbids.
DO $$ BEGIN
 ALTER TABLE "stand_providers" ADD CONSTRAINT "stand_providers_valid_open_days" CHECK (
  "open_days" is null
  or (
    coalesce(array_length("open_days", 1), 0) between 1 and 7
    and "open_days" <@ array[0,1,2,3,4,5,6]
  )
);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "sellers" ADD CONSTRAINT "sellers_name_not_blank" CHECK (
  length(btrim("name", E' \t\r\n')) > 0
);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "sellers" ADD CONSTRAINT "sellers_coherent_revocation" CHECK (
  ("revoked_at" is null and "revoked_by_administrator_id" is null)
  or ("revoked_at" is not null and "revoked_by_administrator_id" is not null)
);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- The SMS target selection is COMPLETE or absent, now including the provider. A selection
-- carrying a stand and no provider is exactly the ambiguous target this removes.
ALTER TABLE "farmer_target_contexts" DROP CONSTRAINT IF EXISTS "farmer_target_contexts_selected_context_coherent";--> statement-breakpoint
ALTER TABLE "farmer_target_contexts" ADD CONSTRAINT "farmer_target_contexts_selected_context_coherent" CHECK (
  (
    "selected_authorization_id" is null
    and "selected_owner_farm_id" is null
    and "selected_sales_location_id" is null
    and "selected_provider_id" is null
    and "selected_at" is null
  )
  or (
    "selected_authorization_id" is not null
    and "selected_owner_farm_id" is not null
    and "selected_sales_location_id" is not null
    and "selected_provider_id" is not null
    and "selected_at" is not null
  )
);
