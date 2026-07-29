DO $$ BEGIN
 CREATE TYPE "public"."sales_location_offering_type" AS ENUM('produce', 'services', 'by_order');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."sales_location_visitability" AS ENUM('visitable', 'contact_only');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "sales_locations" ALTER COLUMN "public_address" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_locations" ALTER COLUMN "public_latitude" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_locations" ALTER COLUMN "public_longitude" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_locations" ADD COLUMN "visitability" "sales_location_visitability" DEFAULT 'visitable' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_locations" ADD COLUMN "offering_type" "sales_location_offering_type" DEFAULT 'produce' NOT NULL;--> statement-breakpoint

-- F-038 — the CHECK constraints. drizzle-kit 0.22.8 does not diff checks, so these are hand
-- written here exactly as migration 0005 did for the availability constraints.

-- The two pre-existing checks become CONDITIONAL. Dropping and recreating (rather than adding a
-- second, narrower check) keeps ONE statement of each rule: two overlapping constraints named
-- for the same property is the "two ways to do one thing" the zen-desk rule forbids.
--
-- Each is rewritten to state the NULL case EXPLICITLY (`is null or ...`) rather than leaning on
-- a CHECK's silent pass on NULL. That silent pass is the documented trap in this repo, and a
-- constraint made nullable by accident is how a rule stops applying without anything reporting it.
ALTER TABLE "sales_locations" DROP CONSTRAINT "sales_locations_address_not_blank";--> statement-breakpoint
ALTER TABLE "sales_locations" ADD CONSTRAINT "sales_locations_address_not_blank" CHECK (
  "public_address" is null or length(trim("public_address")) > 0
);--> statement-breakpoint

ALTER TABLE "sales_locations" DROP CONSTRAINT "sales_locations_valid_coordinates";--> statement-breakpoint
ALTER TABLE "sales_locations" ADD CONSTRAINT "sales_locations_valid_coordinates" CHECK (
  ("public_latitude" is null or "public_latitude" between -90 and 90)
  and ("public_longitude" is null or "public_longitude" between -180 and 180)
);--> statement-breakpoint

-- The load-bearing invariant. All-or-nothing in BOTH directions.
--
-- `visitable` requires an address and a COMPLETE coordinate pair — half a pair puts a pin in the
-- ocean, and without coordinates "visitable" is a promise the map cannot keep.
--
-- `contact_only` requires all three ABSENT, which is the direction that protects customers. The
-- legacy map export carries real coordinates for Open Gate Lamb despite it having no stand;
-- seeding those would place a pin that sends someone driving to a farm with nothing to buy.
-- Enforced here rather than trusted to every future loader and admin screen.
ALTER TABLE "sales_locations" ADD CONSTRAINT "sales_locations_coherent_visitability" CHECK (
  (
    "visitability" = 'visitable'
    and "public_address" is not null
    and "public_latitude" is not null
    and "public_longitude" is not null
  )
  or (
    "visitability" = 'contact_only'
    and "public_address" is null
    and "public_latitude" is null
    and "public_longitude" is null
  )
);
