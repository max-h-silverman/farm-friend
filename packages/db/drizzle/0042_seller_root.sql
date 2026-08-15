-- ===========================================================================================
-- F-114 Phase C.0 — THE SELLER ROOT.
--
-- This file REPLACES the earlier `0042_multi_seller_stand_providers`. That migration backfilled
-- native brand slots and re-rooted eight composite keys onto a model §the stand-and-sellers
-- correction replaces. **No database anywhere has applied it** — verified 2026-08-14 against the
-- Neon production ledger (42 rows, `0000`–`0041`, no `stand_providers`, no `sellers`, no
-- `inventory_revisions.provider_id`) and against every local database (max applied count 40). So
-- it is replaced rather than applied and then reversed: migrating production onto a model and
-- straight off it again would put 38 live stands through two structural reshapes to reach a
-- state they can reach in one.
--
-- ## What this does
--
-- A stand has a name, metadata, and NESTED SELLERS. `farms` becomes `sellers`, because that is
-- what the record truthfully is once bakeries and makers are first-class; stand ownership goes
-- away and is replaced by the SELF-POINTER, the one nested seller that IS the stand.
--
-- ## Why `farms` is renamed rather than split
--
-- Measured against production 2026-08-14: all 38 stands have an owner farm whose name is
-- byte-identical to the stand's, and no farm owns two stands. The farm/stand split carries no
-- information — it exists because `owner_farm_id` was NOT NULL and every stand had to name an
-- owner. Renaming preserves every id, so all 7 direct foreign keys and 9 composite keys keep
-- pointing at the same rows; a split would have had to re-point them and re-key 249 usual items
-- and 27 revisions for nothing.
--
-- Morgan Hill Community Farm Stand is why stand and seller stay TWO records. It is a venue with
-- its own identity and four nested sellers, none of which is the stand. Its "owner farm" today
-- is a row invented to satisfy NOT NULL, asserting something false — the fabricated authority
-- §migration approach forbids, already sitting in production. This migration removes it.
-- ===========================================================================================

-- ---- 1. `farms` becomes `sellers` -----------------------------------------------------------
-- RENAME, never create-and-copy: every id survives, so every foreign key onto it stays valid and
-- no downstream table needs re-pointing. The constraint and index names are renamed with it so
-- the schema reads consistently rather than carrying `farms_*` names on a `sellers` table.
-- Every rename is guarded, because `ALTER TABLE … RENAME` has no `IF EXISTS` form and the
-- integration suite applies every file TWICE, requiring the second run to be a no-op. An
-- unguarded rename raises `relation "farms" does not exist` on the second pass — which the
-- idempotency test caught here, not in review.
DO $$ BEGIN
  IF to_regclass('public.farms') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE "farms" RENAME TO "sellers"';
  END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sellers' AND column_name='test_farm_at') THEN
    EXECUTE 'ALTER TABLE "sellers" RENAME COLUMN "test_farm_at" TO "test_seller_at"';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sellers' AND column_name='test_farm_by_administrator_id') THEN
    EXECUTE 'ALTER TABLE "sellers" RENAME COLUMN "test_farm_by_administrator_id" TO "test_seller_by_administrator_id"';
  END IF;
END $$;--> statement-breakpoint

DO $$
DECLARE
  pair text[];
BEGIN
  FOREACH pair SLICE 1 IN ARRAY ARRAY[
    ['farms_pkey', 'sellers_pkey'],
    ['farms_name_not_blank', 'sellers_name_not_blank'],
    ['farms_coherent_test_farm', 'sellers_coherent_test_seller'],
    ['farms_coherent_retirement', 'sellers_coherent_retirement'],
    ['farms_test_farm_by_administrator_id_administrators_id_fk', 'sellers_test_seller_by_administrator_id_administrators_id_fk'],
    ['farms_retired_by_administrator_id_administrators_id_fk', 'sellers_retired_by_administrator_id_administrators_id_fk']
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = pair[1] AND conrelid = 'public.sellers'::regclass
    ) THEN
      EXECUTE format('ALTER TABLE "sellers" RENAME CONSTRAINT %I TO %I', pair[1], pair[2]);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

-- ---- 2. the self-pointer replaces stand ownership -------------------------------------------
-- Added NULLABLE and backfilled before any constraint is asserted, for the reason the Phase B
-- header gave: `ADD COLUMN … NOT NULL` with no default passes on an empty database and raises
-- 23502 against a populated one. Here it stays PERMANENTLY nullable — NULL is Morgan Hill, a
-- venue with no goods of its own — but the backfill still has to precede the foreign key.
ALTER TABLE "sales_locations" ADD COLUMN IF NOT EXISTS "own_seller_id" uuid;--> statement-breakpoint

-- Each stand points at the seller that was its owner farm. This is not a name match and not an
-- inference: `owner_farm_id` already names exactly one row, and that row is now a seller.
--
-- **EVERY stand gets a self-pointer, including Morgan Hill.** The migration deliberately does NOT
-- try to detect venue-only stands, even though Morgan Hill is the case that motivated making the
-- column nullable. Measured 2026-08-15: its "invented" owner farm carries a description, a farm
-- email, and a published inventory revision — VIGA has been using that row as the venue's own
-- record, so it is not purely fabricated and nulling the pointer here would orphan real data.
--
-- More importantly there is NO signal in the data separating "a venue with no goods of its own"
-- from "a seller with one stand". Any rule that tried would be the inference §migration approach
-- forbids. Clearing the pointer is a VIGA decision made in the C.1 work queue, beside resolving
-- the 11 hosted names; the schema permits NULL so a person can record it, and code never guesses.
-- Guarded for the same idempotency reason as the renames: on a second run `owner_farm_id` is
-- already gone, and an unguarded UPDATE naming it fails at parse.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='sales_locations' AND column_name='owner_farm_id'
  ) THEN
    EXECUTE 'UPDATE "sales_locations" SET "own_seller_id" = "owner_farm_id"';
  END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "sales_locations" ADD CONSTRAINT "sales_locations_own_seller_fk" FOREIGN KEY ("own_seller_id") REFERENCES "public"."sellers"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object OR duplicate_table THEN null;
END $$;--> statement-breakpoint

-- The composite target `(id, own_seller_id)` must EXIST before anything references it. A
-- populated-schema run caught this ordering: `sales_location_participants`' re-rooted key below
-- fails outright without it, and an empty-database run would have failed identically — this one
-- is simply a mistake the migration had to make once.
DO $$ BEGIN
 ALTER TABLE "sales_locations" ADD CONSTRAINT "sales_locations_id_own_seller_unique" UNIQUE("id","own_seller_id");
EXCEPTION
 WHEN duplicate_object OR duplicate_table THEN null;
END $$;--> statement-breakpoint

-- ---- 3. the nine composite keys re-root onto `(authorization, seller)` -----------------------
-- Every one of these said *this actor acts for this farm*. They now say *this actor acts for
-- this seller*. The columns are renamed rather than replaced, so the pairing — which is what
-- makes an authorization unable to act for a stand it was never granted — survives intact.
-- One guarded loop rather than fifteen guarded statements: the rename is the same operation
-- fifteen times, and stating it once means a sixteenth column is a data row here, not new code.
DO $$
DECLARE
  target text[];
BEGIN
  FOREACH target SLICE 1 IN ARRAY ARRAY[
    ['farmer_authorizations', 'farm_id', 'seller_id'],
    ['farmer_links', 'owner_farm_id', 'owner_seller_id'],
    ['farmer_target_contexts', 'selected_owner_farm_id', 'selected_owner_seller_id'],
    ['farmer_target_menu_options', 'owner_farm_id', 'owner_seller_id'],
    ['inventory_prompt_preferences', 'owner_farm_id', 'owner_seller_id'],
    ['sales_location_participants', 'owner_farm_id', 'owner_seller_id'],
    ['inventory_revisions', 'farm_id', 'seller_id'],
    ['closure_revisions', 'owner_farm_id', 'owner_seller_id'],
    ['scheduled_inventory_prompt_subjects', 'owner_farm_id', 'owner_seller_id'],
    -- The remaining direct references onto the identity table.
    ['farm_approvals', 'farm_id', 'seller_id'],
    ['farm_email_verifications', 'farm_id', 'seller_id'],
    ['farm_emails', 'farm_id', 'seller_id'],
    ['farm_links', 'farm_id', 'seller_id'],
    ['farmer_invitations', 'farm_id', 'seller_id']
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=target[1] AND column_name=target[2]
    ) THEN
      EXECUTE format('ALTER TABLE %I RENAME COLUMN %I TO %I', target[1], target[2], target[3]);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'farmer_authorizations_id_farm_unique'
      AND conrelid = 'public.farmer_authorizations'::regclass
  ) THEN
    EXECUTE 'ALTER TABLE "farmer_authorizations" RENAME CONSTRAINT "farmer_authorizations_id_farm_unique" TO "farmer_authorizations_id_seller_unique"';
  END IF;
END $$;--> statement-breakpoint
ALTER INDEX IF EXISTS "farmer_authorizations_one_active_contact_per_farm" RENAME TO "farmer_authorizations_one_active_contact_per_seller";--> statement-breakpoint

-- The four `farm_*` tables become `seller_*`. Leaving them named for farms while their root is
-- `sellers` would be the two-vocabularies problem the zen desk forbids — a newcomer would have
-- to learn that `farm_emails` holds a bakery's address.
DO $$
DECLARE
  pair text[];
BEGIN
  FOREACH pair SLICE 1 IN ARRAY ARRAY[
    ['farm_approvals', 'seller_approvals'],
    ['farm_email_verifications', 'seller_email_verifications'],
    ['farm_emails', 'seller_emails'],
    ['farm_links', 'seller_links']
  ] LOOP
    IF to_regclass('public.' || pair[1]) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I RENAME TO %I', pair[1], pair[2]);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

-- Renaming a table does NOT rename its constraints or indexes, so 25 constraints and 13 indexes
-- were left asserting `farm_*` names on `seller_*` tables — including
-- `farms_projection_coordinates_coherent`, which a sabotage test surfaced by name. Left alone
-- they are not merely untidy: the next author reading an error message is told a table exists
-- that does not, and `schema.integration.test.ts` scans artifact text for exactly this kind of
-- stale vocabulary.
--
-- Driven off the catalog rather than a hand-written list, because a hand list is what missed
-- them the first time. Every `farm`-prefixed name on a renamed table becomes its `seller`
-- equivalent; `farmer_*` names are deliberately untouched — see the note at section 3.
DO $$
DECLARE
  target record;
  renamed text;
BEGIN
  FOR target IN
    SELECT c.conname AS name, c.conrelid::regclass::text AS table_name
    FROM pg_constraint c
    WHERE c.connamespace = 'public'::regnamespace
      AND c.conname LIKE 'farm%'
      AND c.conname NOT LIKE 'farmer%'
      AND c.conrelid::regclass::text IN (
        'sellers', 'seller_approvals', 'seller_email_verifications', 'seller_emails', 'seller_links'
      )
  LOOP
    -- TWO rules, not one. `farms_*` names belong to the identity table and become `sellers_*`;
    -- `farm_emails_*` and friends name satellite tables and become `seller_emails_*`. A single
    -- `^farms?_` → `seller_` collapsed both and produced
    -- `seller_projection_coordinates_coherent` on a table called `sellers`, which
    -- `migration-metadata.test.ts` caught by name.
    renamed := regexp_replace(target.name, '^farms_', 'sellers_');
    renamed := regexp_replace(renamed, '^farm_', 'seller_');
    renamed := replace(renamed, '_farm_id_farms_id_fk', '_seller_id_sellers_id_fk');
    renamed := replace(renamed, '_farm_', '_seller_');
    renamed := regexp_replace(renamed, '_farm$', '_seller');
    IF renamed <> target.name THEN
      EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', target.table_name, target.name, renamed);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

DO $$
DECLARE
  target record;
  renamed text;
BEGIN
  FOR target IN
    SELECT indexname AS name
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname LIKE 'farm%'
      AND indexname NOT LIKE 'farmer%'
  LOOP
    -- TWO rules, not one. `farms_*` names belong to the identity table and become `sellers_*`;
    -- `farm_emails_*` and friends name satellite tables and become `seller_emails_*`. A single
    -- `^farms?_` → `seller_` collapsed both and produced
    -- `seller_projection_coordinates_coherent` on a table called `sellers`, which
    -- `migration-metadata.test.ts` caught by name.
    renamed := regexp_replace(target.name, '^farms_', 'sellers_');
    renamed := regexp_replace(renamed, '^farm_', 'seller_');
    renamed := replace(renamed, '_farm_', '_seller_');
    renamed := regexp_replace(renamed, '_farm$', '_seller');
    IF renamed <> target.name AND to_regclass('public.' || renamed) IS NULL THEN
      EXECUTE format('ALTER INDEX %I RENAME TO %I', target.name, renamed);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

-- ---- 4. `sales_location_participants` re-roots, and keeps its history ------------------------
-- The 11 live hosted names stay EXACTLY as they are. §migration approach forbids linking a
-- display name to a seller identity, and the corpus proves why: it holds `Fernhorn Bakery` at
-- Pacific Crest Farm and `Fern Horn Bakery` at Tian Tian Farm — almost certainly one bakery,
-- spelled two ways. Matching would either merge two stands' relationships on a guess or split
-- one bakery in two. Both fabricate authority. These rows migrate as retained history and a
-- VIGA work queue; a person resolves each one in Phase C.1.
ALTER TABLE "sales_location_participants" DROP CONSTRAINT IF EXISTS "sales_location_participants_location_owner_fk";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_location_participants" ADD CONSTRAINT "sales_location_participants_location_own_seller_fk" FOREIGN KEY ("sales_location_id","owner_seller_id") REFERENCES "public"."sales_locations"("id","own_seller_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object OR duplicate_table THEN null;
END $$;--> statement-breakpoint

-- ---- 5. the six keys rooted on `(location, owner_farm)` move to `(location, own_seller)` ------
-- A populated-schema run caught these: dropping `owner_farm_id` fails outright while they exist,
-- and each one is a real guarantee — it is what stops an authorization acting for a stand it was
-- never granted. Each is dropped and recreated against the self-pointer in THIS migration, never
-- across two, so no window exists in which the pairing is unenforced.
ALTER TABLE "closure_revisions" DROP CONSTRAINT IF EXISTS "closure_revisions_location_owner_fk";--> statement-breakpoint
ALTER TABLE "farmer_links" DROP CONSTRAINT IF EXISTS "farmer_links_targeted_location_owner_fk";--> statement-breakpoint
ALTER TABLE "farmer_target_contexts" DROP CONSTRAINT IF EXISTS "farmer_target_contexts_selected_location_owner_fk";--> statement-breakpoint
ALTER TABLE "farmer_target_menu_options" DROP CONSTRAINT IF EXISTS "farmer_target_menu_options_location_owner_fk";--> statement-breakpoint
ALTER TABLE "inventory_prompt_preferences" DROP CONSTRAINT IF EXISTS "inventory_prompt_preferences_location_owner_fk";--> statement-breakpoint
ALTER TABLE "inventory_revisions" DROP CONSTRAINT IF EXISTS "inventory_revisions_location_farm_fk";--> statement-breakpoint
ALTER TABLE "scheduled_inventory_prompt_subjects" DROP CONSTRAINT IF EXISTS "scheduled_prompt_subjects_location_owner_fk";--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "closure_revisions" ADD CONSTRAINT "closure_revisions_location_own_seller_fk" FOREIGN KEY ("sales_location_id","owner_seller_id") REFERENCES "public"."sales_locations"("id","own_seller_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object OR duplicate_table THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "farmer_links" ADD CONSTRAINT "farmer_links_targeted_location_own_seller_fk" FOREIGN KEY ("sales_location_id","owner_seller_id") REFERENCES "public"."sales_locations"("id","own_seller_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object OR duplicate_table THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "farmer_target_contexts" ADD CONSTRAINT "farmer_target_contexts_selected_location_own_seller_fk" FOREIGN KEY ("selected_sales_location_id","selected_owner_seller_id") REFERENCES "public"."sales_locations"("id","own_seller_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object OR duplicate_table THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "farmer_target_menu_options" ADD CONSTRAINT "farmer_target_menu_options_location_own_seller_fk" FOREIGN KEY ("sales_location_id","owner_seller_id") REFERENCES "public"."sales_locations"("id","own_seller_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object OR duplicate_table THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_prompt_preferences" ADD CONSTRAINT "inventory_prompt_preferences_location_own_seller_fk" FOREIGN KEY ("sales_location_id","owner_seller_id") REFERENCES "public"."sales_locations"("id","own_seller_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object OR duplicate_table THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_revisions" ADD CONSTRAINT "inventory_revisions_location_own_seller_fk" FOREIGN KEY ("sales_location_id","seller_id") REFERENCES "public"."sales_locations"("id","own_seller_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object OR duplicate_table THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_inventory_prompt_subjects" ADD CONSTRAINT "scheduled_prompt_subjects_location_own_seller_fk" FOREIGN KEY ("sales_location_id","owner_seller_id") REFERENCES "public"."sales_locations"("id","own_seller_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object OR duplicate_table THEN null;
END $$;--> statement-breakpoint

-- ---- 6. the two map-projection guards move onto the self-pointer ----------------------------
-- A populated-schema run caught these too: `sales_locations_guard_farm_projection` depends on
-- `owner_farm_id` and blocks the drop. They are a REAL invariant, not incidental — a seller's
-- fallback map pin exists only for a seller with no public stand of its own, so the pin and the
-- stand are mutually exclusive and each trigger enforces one direction of that. They are
-- rewritten onto the self-pointer rather than dropped, and both keep their exact behavior.
CREATE OR REPLACE FUNCTION guard_public_location_projection() RETURNS trigger AS $$
BEGIN
  IF NEW."is_public" AND NEW."own_seller_id" IS NOT NULL AND EXISTS (
    SELECT 1
    FROM "sellers"
    WHERE "id" = NEW."own_seller_id" AND "map_projection" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'a seller with a public sales location cannot carry a fallback map projection';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- A venue with no seller of its own (Morgan Hill) trips neither direction: there is no seller
-- whose pin could conflict, which is why the `own_seller_id IS NOT NULL` test above is not
-- merely defensive — without it, a NULL self-pointer would compare against nothing and the
-- EXISTS would silently return false anyway, but stating it makes the venue case legible.
CREATE OR REPLACE FUNCTION guard_farm_projection_without_location() RETURNS trigger AS $$
BEGIN
  IF NEW."map_projection" IS NOT NULL AND EXISTS (
    SELECT 1
    FROM "sales_locations"
    WHERE "own_seller_id" = NEW."id" AND "is_public"
  ) THEN
    RAISE EXCEPTION 'a fallback map projection requires no public sales location';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS "sales_locations_guard_farm_projection" ON "sales_locations";--> statement-breakpoint
DROP TRIGGER IF EXISTS "sales_locations_guard_seller_projection" ON "sales_locations";
CREATE TRIGGER "sales_locations_guard_seller_projection"
  BEFORE INSERT OR UPDATE OF "own_seller_id", "is_public" ON "sales_locations"
  FOR EACH ROW EXECUTE FUNCTION guard_public_location_projection();--> statement-breakpoint

DROP TRIGGER IF EXISTS "farms_guard_public_sales_location" ON "sellers";--> statement-breakpoint
DROP TRIGGER IF EXISTS "sellers_guard_public_sales_location" ON "sellers";
CREATE TRIGGER "sellers_guard_public_sales_location"
  BEFORE UPDATE OF "map_projection" ON "sellers"
  FOR EACH ROW EXECUTE FUNCTION guard_farm_projection_without_location();--> statement-breakpoint

-- ---- 6b. the two history guards follow the renamed column ------------------------------------
-- `reject_closure_history_mutation` and `reject_sales_location_participant_history_mutation` both
-- name `owner_farm_id` in their immutability checks. A renamed column does NOT rewrite a trigger
-- body, so both would raise `record "new" has no field "owner_farm_id"` on the first UPDATE — the
-- integration suite caught exactly that.
--
-- These are Golden Rule #1 protections (published history is immutable), so they are rewritten
-- rather than dropped, and the column list is otherwise untouched.
CREATE OR REPLACE FUNCTION reject_closure_history_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'published closure revisions cannot be deleted';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."owner_seller_id" IS DISTINCT FROM OLD."owner_seller_id"
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

CREATE OR REPLACE FUNCTION reject_sales_location_participant_history_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sales-location participant history cannot be deleted';
  END IF;

  IF OLD."retired_at" IS NOT NULL
    OR NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."owner_seller_id" IS DISTINCT FROM OLD."owner_seller_id"
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

-- ---- 7. stand ownership is removed ----------------------------------------------------------
-- Dropped only AFTER `own_seller_id` is backfilled, constrained, and every dependent key has
-- moved onto it, so no window exists in which a stand names neither.
ALTER TABLE "sales_locations" DROP CONSTRAINT IF EXISTS "sales_locations_owner_farm_id_farms_id_fk";--> statement-breakpoint
ALTER TABLE "sales_locations" DROP CONSTRAINT IF EXISTS "sales_locations_id_owner_unique";--> statement-breakpoint
ALTER TABLE "sales_locations" DROP COLUMN IF EXISTS "owner_farm_id";--> statement-breakpoint

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

CREATE TABLE IF NOT EXISTS "stand_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sales_location_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
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
CREATE UNIQUE INDEX IF NOT EXISTS "stand_providers_one_per_seller_per_location" ON "stand_providers" USING btree ("sales_location_id","seller_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stand_providers_live_idx" ON "stand_providers" USING btree ("sales_location_id") WHERE "stand_providers"."ended_at" is null;--> statement-breakpoint

-- ===========================================================================================
-- PART TWO — NESTED SELLERS.
--
-- Part one made the identity record honest. This part gives a stand its nested sellers, which is
-- the structure §the stand-and-sellers correction describes: a stand has a name, metadata, and
-- nested sellers, and one of them may be the stand itself.
--
-- Most of what follows is Phase B's provider work, kept because it is the mechanism the corrected
-- model needs — inventory, usual items, proposals, links, preferences, scheduled prompts and SMS
-- targeting all keyed per seller-at-stand rather than per stand. **Two things changed:**
--
--   1. `seller_id` is NOT NULL. There is no native brand slot. A stand's own goods belong to its
--      own seller, named like any other, and the self-pointer in part one records which one that
--      is. NULL had meaning only while `farms` was the authority root.
--   2. The hosting-lifecycle CHECK loses its native arm. Every provider row is now a real
--      seller-at-stand relationship with an invitation behind it, so the arm that exempted the
--      native slot describes nothing that can exist.
--
-- `create_native_stand_provider` is NOT recreated. Phase B made it a trigger so no stand could
-- exist without a slot to hold inventory; with the self-pointer that guarantee moves to the
-- writer, because a stand with no seller of its own is now a legitimate state (Morgan Hill) and a
-- trigger would have to invent a seller to satisfy it — the exact fabrication part one removes.
-- ===========================================================================================

-- A stand that NAMES its own seller gets that seller as an ordinary provider, on insert and on
-- any later change of the self-pointer. This is NOT the trigger Phase B had and C.0 removed:
-- that one fired for every stand and would have to invent a seller for a venue that has none.
-- This one fires only when the stand has already said which seller is itself, so it fabricates
-- nothing — a venue like Morgan Hill sets `own_seller_id` to NULL and no row is created.
--
-- It exists because the guarantee is real and belongs next to the data: a stand naming its own
-- seller but holding no provider row for it can publish no inventory at all, and the failure
-- surfaces far from the writer that caused it. The two production writers set it explicitly as
-- well; this makes the number of writers that must remember it zero.
CREATE OR REPLACE FUNCTION create_own_seller_provider() RETURNS trigger AS $$
BEGIN
  IF NEW."own_seller_id" IS NOT NULL THEN
    INSERT INTO "stand_providers" (
      "sales_location_id", "seller_id", "lifecycle_state",
      "invited_at", "accepted_at", "approval_source", "approved_at"
    )
    VALUES (
      NEW."id", NEW."own_seller_id", 'active',
      NEW."created_at", NEW."created_at", 'viga', NEW."created_at"
    )
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS "sales_locations_create_own_seller_provider" ON "sales_locations";--> statement-breakpoint
CREATE TRIGGER "sales_locations_create_own_seller_provider"
  AFTER INSERT OR UPDATE OF "own_seller_id" ON "sales_locations"
  FOR EACH ROW EXECUTE FUNCTION create_own_seller_provider();--> statement-breakpoint

-- Every stand's own seller becomes an ordinary provider at that stand. Guarded on the
-- self-pointer, so a venue with none (Morgan Hill, once VIGA clears it) simply gets no row here
-- rather than a fabricated one.
INSERT INTO "stand_providers" ("sales_location_id", "seller_id", "lifecycle_state", "invited_at", "accepted_at", "approval_source", "approved_at")
SELECT "id", "own_seller_id", 'active', "created_at", "created_at", 'viga', "created_at"
FROM "sales_locations"
WHERE "own_seller_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint

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
  FROM "stand_providers" p, "sales_locations" loc
  WHERE loc."id" = l."sales_location_id" AND p."sales_location_id" = loc."id" AND p."seller_id" = loc."own_seller_id";--> statement-breakpoint
UPDATE "farmer_target_menu_options" o SET "provider_id" = p."id"
  FROM "stand_providers" p, "sales_locations" loc
  WHERE loc."id" = o."sales_location_id" AND p."sales_location_id" = loc."id" AND p."seller_id" = loc."own_seller_id";--> statement-breakpoint
UPDATE "inventory_prompt_preferences" f SET "provider_id" = p."id"
  FROM "stand_providers" p, "sales_locations" loc
  WHERE loc."id" = f."sales_location_id" AND p."sales_location_id" = loc."id" AND p."seller_id" = loc."own_seller_id";--> statement-breakpoint
UPDATE "inventory_publication_proposals" r SET "provider_id" = p."id"
  FROM "stand_providers" p, "sales_locations" loc
  WHERE loc."id" = r."sales_location_id" AND p."sales_location_id" = loc."id" AND p."seller_id" = loc."own_seller_id";--> statement-breakpoint
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
  FROM "stand_providers" p, "sales_locations" loc
  WHERE loc."id" = v."sales_location_id" AND p."sales_location_id" = loc."id" AND p."seller_id" = loc."own_seller_id";--> statement-breakpoint
ALTER TABLE "inventory_revisions" ENABLE TRIGGER "inventory_revisions_guard_history";--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_inventory_revision_history() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'published inventory revisions cannot be deleted';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."seller_id" IS DISTINCT FROM OLD."seller_id"
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
  FROM "stand_providers" p, "sales_locations" loc
  WHERE loc."id" = s."sales_location_id" AND p."sales_location_id" = loc."id" AND p."seller_id" = loc."own_seller_id";--> statement-breakpoint
UPDATE "stand_items" i SET "provider_id" = p."id"
  FROM "stand_providers" p, "sales_locations" loc
  WHERE loc."id" = i."sales_location_id" AND p."sales_location_id" = loc."id" AND p."seller_id" = loc."own_seller_id";--> statement-breakpoint

-- The selected SMS target is nullable by design — a sender with no selection has none — so it
-- is filled only where a stand was already selected. `selected_context_coherent` below requires
-- all five columns together, so a half-filled selection would be refused at the ALTER.
UPDATE "farmer_target_contexts" c SET "selected_provider_id" = p."id"
  FROM "stand_providers" p, "sales_locations" loc
  WHERE loc."id" = c."selected_sales_location_id" AND p."sales_location_id" = loc."id" AND p."seller_id" = loc."own_seller_id";--> statement-breakpoint

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
 WHEN duplicate_object OR duplicate_table THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "farmer_target_contexts" ADD CONSTRAINT "farmer_target_contexts_selected_location_provider_fk" FOREIGN KEY ("selected_provider_id","selected_sales_location_id") REFERENCES "public"."stand_providers"("id","sales_location_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object OR duplicate_table THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "farmer_target_menu_options" ADD CONSTRAINT "farmer_target_menu_options_location_provider_fk" FOREIGN KEY ("provider_id","sales_location_id") REFERENCES "public"."stand_providers"("id","sales_location_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object OR duplicate_table THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_prompt_preferences" ADD CONSTRAINT "inventory_prompt_preferences_location_provider_fk" FOREIGN KEY ("provider_id","sales_location_id") REFERENCES "public"."stand_providers"("id","sales_location_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object OR duplicate_table THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_publication_proposals" ADD CONSTRAINT "inventory_proposals_location_provider_fk" FOREIGN KEY ("provider_id","sales_location_id") REFERENCES "public"."stand_providers"("id","sales_location_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object OR duplicate_table THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_revisions" ADD CONSTRAINT "inventory_revisions_location_provider_fk" FOREIGN KEY ("provider_id","sales_location_id") REFERENCES "public"."stand_providers"("id","sales_location_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object OR duplicate_table THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_inventory_prompt_subjects" ADD CONSTRAINT "scheduled_prompt_subjects_location_provider_fk" FOREIGN KEY ("provider_id","sales_location_id") REFERENCES "public"."stand_providers"("id","sales_location_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object OR duplicate_table THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stand_items" ADD CONSTRAINT "stand_items_location_provider_fk" FOREIGN KEY ("provider_id","sales_location_id") REFERENCES "public"."stand_providers"("id","sales_location_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object OR duplicate_table THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "farmer_target_menu_options" ADD CONSTRAINT "farmer_target_menu_options_one_number_per_pair" UNIQUE("sender_hash","authorization_id","provider_id");
EXCEPTION
 WHEN duplicate_object OR duplicate_table THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_prompt_preferences" ADD CONSTRAINT "inventory_prompt_preferences_provider_unique" UNIQUE("provider_id");
EXCEPTION
 WHEN duplicate_object OR duplicate_table THEN null;
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
  "invited_at" is not null
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
);
EXCEPTION
 WHEN duplicate_object OR duplicate_table THEN null;
END $$;--> statement-breakpoint

-- A vouching host names the authorization that vouched; VIGA names none.
DO $$ BEGIN
 ALTER TABLE "stand_providers" ADD CONSTRAINT "stand_providers_approval_source_coherent" CHECK (
  ("approval_source" = 'host') = ("approved_by_authorization_id" is not null)
  or ("approval_source" is null and "approved_by_authorization_id" is null)
);
EXCEPTION
 WHEN duplicate_object OR duplicate_table THEN null;
END $$;--> statement-breakpoint

-- An ended relationship ended after it began, and the native slot never ends.
DO $$ BEGIN
 ALTER TABLE "stand_providers" ADD CONSTRAINT "stand_providers_ending_coherent" CHECK (
  "ended_at" is null or ("invited_at" is not null and "ended_at" >= "invited_at")
);
EXCEPTION
 WHEN duplicate_object OR duplicate_table THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "stand_providers" ADD CONSTRAINT "stand_providers_public_note_not_blank" CHECK (
  "public_note" is null or length(btrim("public_note", E' \t\r\n')) > 0
);
EXCEPTION
 WHEN duplicate_object OR duplicate_table THEN null;
END $$;--> statement-breakpoint

-- A cadence with nobody to text is a reminder that can never be sent; a recipient with no
-- cadence is a preference nobody stated.
DO $$ BEGIN
 ALTER TABLE "stand_providers" ADD CONSTRAINT "stand_providers_reminder_coherent" CHECK (
  ("reminder_cadence" is not null) = ("reminder_authorization_id" is not null)
);
EXCEPTION
 WHEN duplicate_object OR duplicate_table THEN null;
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
 WHEN duplicate_object OR duplicate_table THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "stand_providers" ADD CONSTRAINT "stand_providers_valid_season_dates" CHECK (
  ("season_start_month" is null or "season_start_month" between 1 and 12)
  and ("season_end_month" is null or "season_end_month" between 1 and 12)
  and ("season_start_day" is null or "season_start_day" between 1 and 31)
  and ("season_end_day" is null or "season_end_day" between 1 and 31)
);
EXCEPTION
 WHEN duplicate_object OR duplicate_table THEN null;
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
 WHEN duplicate_object OR duplicate_table THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "stand_providers" ADD CONSTRAINT "stand_providers_valid_open_minutes" CHECK (
  ("open_from_minutes" is null or "open_from_minutes" between 0 and 1439)
  and ("open_until_minutes" is null or "open_until_minutes" between 0 and 1439)
);
EXCEPTION
 WHEN duplicate_object OR duplicate_table THEN null;
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
 WHEN duplicate_object OR duplicate_table THEN null;
END $$;--> statement-breakpoint

-- `sellers_name_not_blank` already exists: it is the renamed `farms_name_not_blank`.

-- Phase B's `sellers_coherent_revocation` is NOT recreated. It paired
-- `revoked_at`/`revoked_by_administrator_id` on Phase B's separate `sellers` table; when that
-- table merged into the renamed identity record, `retired_at` already meant exactly this — "VIGA
-- took this seller down" — and `sellers_coherent_retirement` already enforces the same
-- biconditional over the same pair of columns. Keeping both would be two ways to state one fact.

-- The SMS target selection is COMPLETE or absent, now including the provider. A selection
-- carrying a stand and no provider is exactly the ambiguous target this removes.
ALTER TABLE "farmer_target_contexts" DROP CONSTRAINT IF EXISTS "farmer_target_contexts_selected_context_coherent";--> statement-breakpoint
ALTER TABLE "farmer_target_contexts" ADD CONSTRAINT "farmer_target_contexts_selected_context_coherent" CHECK (
  (
    "selected_authorization_id" is null
    and "selected_owner_seller_id" is null
    and "selected_sales_location_id" is null
    and "selected_provider_id" is null
    and "selected_at" is null
  )
  or (
    "selected_authorization_id" is not null
    and "selected_owner_seller_id" is not null
    and "selected_sales_location_id" is not null
    and "selected_provider_id" is not null
    and "selected_at" is not null
  )
);
