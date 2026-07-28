-- F-035 — stand availability and specialties as FILTERABLE data.
--
-- VIGA's map states each stand's season, hours, restocking and typical produce as one prose
-- blob ("Open: March-November. 7 days a week, dawn to dusk"). That blob conflates three
-- independent facts, which is why the existing map cannot answer "what is open right now" —
-- the "free-form largely unfilterable text" CLAUDE.md names as a reason Farm Friend exists.
-- Seeding it into a description column would import the problem under a new name.
--
-- Every enum value below occurs in the real VIGA export of 31 stands. The sets are meant to
-- GROW: a stand that describes itself in a way none of these capture earns a new value and a
-- migration, never a free-text escape hatch that quietly restores the blob.
--
-- WHY `dawn_to_dusk` AND `daylight_hours` ARE VALUES, NOT MISSING CLOCK TIMES. On unattended
-- honor-system stands they are the more truthful answer, and they are not equivalent to any
-- fixed pair of hours — dusk on Vashon moves by roughly six hours across the season. Storing
-- them as 06:00–20:00 would invent a precision the farmer never stated, the same class of
-- fabrication as inventing a coordinate.
--
-- WHY `variable` / `as_needed` / `intermittent` ARE VALUES, NOT NULL. "We restock as stock
-- runs low" is an honest description, not absent data. As NULL it would be indistinguishable
-- from a stand nobody asked.

CREATE TYPE "open_hours_kind" AS ENUM (
  'dawn_to_dusk', 'daylight_hours', 'all_day', 'clock_range', 'until_dusk', 'by_appointment'
);--> statement-breakpoint
CREATE TYPE "season_kind" AS ENUM (
  'year_round', 'date_range', 'named_season', 'open_ended'
);--> statement-breakpoint
CREATE TYPE "stocking_cadence" AS ENUM (
  'daily', 'specific_days', 'variable', 'as_needed', 'intermittent'
);--> statement-breakpoint
CREATE TYPE "stand_data_flag_reason" AS ENUM (
  'contradictory_hours', 'season_unresolved', 'unparsed_availability', 'possibly_closed'
);--> statement-breakpoint

-- Structured availability. `hours_text` survives beside these, DISPLAY ONLY and never
-- filtered on: Sherman Creek's "Saturday and Sunday when available" carries a caveat no day
-- set can hold, and dropping it would make the map more confident than the farmer was.
ALTER TABLE "sales_locations" ADD COLUMN "season_kind" "season_kind";--> statement-breakpoint
ALTER TABLE "sales_locations" ADD COLUMN "season_start_month" integer;--> statement-breakpoint
ALTER TABLE "sales_locations" ADD COLUMN "season_start_day" integer;--> statement-breakpoint
ALTER TABLE "sales_locations" ADD COLUMN "season_end_month" integer;--> statement-breakpoint
ALTER TABLE "sales_locations" ADD COLUMN "season_end_day" integer;--> statement-breakpoint
ALTER TABLE "sales_locations" ADD COLUMN "season_names" text[];--> statement-breakpoint
ALTER TABLE "sales_locations" ADD COLUMN "open_hours_kind" "open_hours_kind";--> statement-breakpoint
ALTER TABLE "sales_locations" ADD COLUMN "open_from_minutes" integer;--> statement-breakpoint
ALTER TABLE "sales_locations" ADD COLUMN "open_until_minutes" integer;--> statement-breakpoint
ALTER TABLE "sales_locations" ADD COLUMN "open_days" integer[];--> statement-breakpoint
ALTER TABLE "sales_locations" ADD COLUMN "stocking_cadence" "stocking_cadence";--> statement-breakpoint
ALTER TABLE "sales_locations" ADD COLUMN "stocking_days" integer[];--> statement-breakpoint

-- The enums are only worth having if the DATABASE enforces that each kind carries exactly
-- the detail it needs. Without these, a `date_range` with no dates or a `clock_range` with no
-- times loads silently and every reader needs a defensive branch for a state that should
-- never have been written.
ALTER TABLE "sales_locations" ADD CONSTRAINT "sales_locations_coherent_season" CHECK (
  (
    "sales_locations"."season_kind" is null
    and "sales_locations"."season_start_month" is null and "sales_locations"."season_start_day" is null
    and "sales_locations"."season_end_month" is null and "sales_locations"."season_end_day" is null
    and "sales_locations"."season_names" is null
  )
  or (
    "sales_locations"."season_kind" = 'year_round'
    and "sales_locations"."season_start_month" is null and "sales_locations"."season_end_month" is null
    and "sales_locations"."season_names" is null
  )
  or (
    "sales_locations"."season_kind" = 'date_range'
    and "sales_locations"."season_start_month" is not null and "sales_locations"."season_start_day" is not null
    and "sales_locations"."season_end_month" is not null and "sales_locations"."season_end_day" is not null
    and "sales_locations"."season_names" is null
  )
  or (
    "sales_locations"."season_kind" = 'named_season'
    and "sales_locations"."season_names" is not null
    and coalesce(array_length("sales_locations"."season_names", 1), 0) > 0
    and "sales_locations"."season_start_month" is null and "sales_locations"."season_end_month" is null
  )
  or (
    "sales_locations"."season_kind" = 'open_ended'
    and "sales_locations"."season_start_month" is not null and "sales_locations"."season_start_day" is not null
    and "sales_locations"."season_end_month" is null and "sales_locations"."season_end_day" is null
    and "sales_locations"."season_names" is null
  )
);--> statement-breakpoint
ALTER TABLE "sales_locations" ADD CONSTRAINT "sales_locations_valid_season_dates" CHECK (
  ("sales_locations"."season_start_month" is null or "sales_locations"."season_start_month" between 1 and 12)
  and ("sales_locations"."season_end_month" is null or "sales_locations"."season_end_month" between 1 and 12)
  and ("sales_locations"."season_start_day" is null or "sales_locations"."season_start_day" between 1 and 31)
  and ("sales_locations"."season_end_day" is null or "sales_locations"."season_end_day" between 1 and 31)
);--> statement-breakpoint
ALTER TABLE "sales_locations" ADD CONSTRAINT "sales_locations_coherent_open_hours" CHECK (
  (
    "sales_locations"."open_hours_kind" is null
    and "sales_locations"."open_from_minutes" is null and "sales_locations"."open_until_minutes" is null
  )
  or (
    "sales_locations"."open_hours_kind" in ('dawn_to_dusk', 'daylight_hours', 'all_day', 'by_appointment')
    and "sales_locations"."open_from_minutes" is null and "sales_locations"."open_until_minutes" is null
  )
  or (
    "sales_locations"."open_hours_kind" = 'clock_range'
    and "sales_locations"."open_from_minutes" is not null and "sales_locations"."open_until_minutes" is not null
  )
  or (
    "sales_locations"."open_hours_kind" = 'until_dusk'
    and "sales_locations"."open_from_minutes" is not null and "sales_locations"."open_until_minutes" is null
  )
);--> statement-breakpoint
ALTER TABLE "sales_locations" ADD CONSTRAINT "sales_locations_valid_open_minutes" CHECK (
  ("sales_locations"."open_from_minutes" is null or "sales_locations"."open_from_minutes" between 0 and 1439)
  and ("sales_locations"."open_until_minutes" is null or "sales_locations"."open_until_minutes" between 0 and 1439)
);--> statement-breakpoint

-- An EMPTY day array is refused, not just an invalid one: it would assert "open on no day",
-- which no stand means and which NULL ("not stated") already expresses.
--
-- The `coalesce` is load-bearing, not defensive noise. `array_length(array[]::integer[], 1)`
-- returns NULL rather than 0, so a bare `between 1 and 7` evaluates to NULL on an empty
-- array — and a CHECK constraint PASSES on NULL. The first draft admitted the exact value it
-- was written to forbid, and only the test caught it.
ALTER TABLE "sales_locations" ADD CONSTRAINT "sales_locations_valid_open_days" CHECK (
  "sales_locations"."open_days" is null
  or (
    coalesce(array_length("sales_locations"."open_days", 1), 0) between 1 and 7
    and "sales_locations"."open_days" <@ array[0,1,2,3,4,5,6]
  )
);--> statement-breakpoint
ALTER TABLE "sales_locations" ADD CONSTRAINT "sales_locations_valid_stocking_days" CHECK (
  "sales_locations"."stocking_days" is null
  or (
    coalesce(array_length("sales_locations"."stocking_days", 1), 0) between 1 and 7
    and "sales_locations"."stocking_days" <@ array[0,1,2,3,4,5,6]
  )
);--> statement-breakpoint

-- `specific_days` without the days is the one incoherent cadence: it promises a set the
-- reader cannot then find. Every other cadence carries no day list by definition.
ALTER TABLE "sales_locations" ADD CONSTRAINT "sales_locations_coherent_stocking_cadence" CHECK (
  ("sales_locations"."stocking_cadence" = 'specific_days') = ("sales_locations"."stocking_days" is not null)
  or ("sales_locations"."stocking_cadence" is null and "sales_locations"."stocking_days" is null)
);--> statement-breakpoint

-- What a stand USUALLY has — specialties, NOT current stock.
--
-- These are two different facts in two different tables on purpose. `inventory_revisions` is
-- current stock: it requires `published_by_authorization_id` and `farm_approval_id`, so
-- writing one demands a verified farmer and a VIGA approval. The seeder has neither and
-- structurally CANNOT fabricate them. That is why specialties needed their own table rather
-- than a `kind` column on the revision table — a flag there would have let seeded rows
-- satisfy `inventory_revisions_one_current_per_location` and render as though a farmer had
-- just confirmed them, collapsing the very distinction this separation exists to keep.
CREATE TABLE IF NOT EXISTS "sales_location_offerings" (
  "sales_location_id" uuid NOT NULL,
  "item" text NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "sales_location_offerings_pk" PRIMARY KEY ("sales_location_id", "item"),
  CONSTRAINT "sales_location_offerings_item_not_blank" CHECK (length(trim("item")) > 0),
  CONSTRAINT "sales_location_offerings_nonnegative_sort_order" CHECK ("sort_order" >= 0)
);--> statement-breakpoint
ALTER TABLE "sales_location_offerings"
  ADD CONSTRAINT "sales_location_offerings_location_fk"
  FOREIGN KEY ("sales_location_id") REFERENCES "sales_locations"("id") ON DELETE cascade;--> statement-breakpoint

-- A seeded stand whose source data needs a human decision.
--
-- Deliberately NOT the existing `flags` table: that one is keyed to `contact_hash` and
-- `inbox_event_id` — a customer-message safety rail with a thread viewer attached. A seed
-- flag has neither, and forcing one in would break the coherence its operator surface relies
-- on. Same idea, different subject, so a separate small table rather than nullable columns in
-- a table that means something else.
--
-- The seeder resolves a contradiction by picking the more specific reading and raising one of
-- these. It never silently guesses and never drops the conflict on the floor.
CREATE TABLE IF NOT EXISTS "stand_data_flags" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sales_location_id" uuid NOT NULL,
  "reason" "stand_data_flag_reason" NOT NULL,
  "source_text" text NOT NULL,
  "resolution_note" text,
  "resolved_by_administrator_id" uuid,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "stand_data_flags_source_text_not_blank" CHECK (length(trim("source_text")) > 0),
  CONSTRAINT "stand_data_flags_coherent_resolution" CHECK (
    ("resolved_at" is null and "resolved_by_administrator_id" is null)
    or ("resolved_at" is not null and "resolved_by_administrator_id" is not null)
  )
);--> statement-breakpoint
ALTER TABLE "stand_data_flags"
  ADD CONSTRAINT "stand_data_flags_location_fk"
  FOREIGN KEY ("sales_location_id") REFERENCES "sales_locations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "stand_data_flags"
  ADD CONSTRAINT "stand_data_flags_administrator_fk"
  FOREIGN KEY ("resolved_by_administrator_id") REFERENCES "administrators"("id") ON DELETE restrict;--> statement-breakpoint

-- One OPEN flag per (location, reason): re-running the seeder must not pile up duplicate
-- copies of the same unresolved question. Resolved flags stay as history.
CREATE UNIQUE INDEX IF NOT EXISTS "stand_data_flags_one_open_per_reason"
  ON "stand_data_flags" ("sales_location_id", "reason") WHERE "resolved_at" is null;
