ALTER TABLE "sales_locations" ADD COLUMN "trashed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sales_locations" ADD COLUMN "trashed_by_administrator_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_locations" ADD COLUMN "retired_by_trash" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "trashed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "trashed_by_administrator_id" uuid;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "retired_by_trash" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_locations" ADD CONSTRAINT "sales_locations_trashed_by_administrator_id_administrators_id_fk" FOREIGN KEY ("trashed_by_administrator_id") REFERENCES "public"."administrators"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sellers" ADD CONSTRAINT "sellers_trashed_by_administrator_id_administrators_id_fk" FOREIGN KEY ("trashed_by_administrator_id") REFERENCES "public"."administrators"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Hand-appended: drizzle-kit does not emit check() constraints (RUNBOOK §Migrations).
--
-- Each trash pair moves together or not at all, written as a FULL disjunction rather than a
-- one-directional test, because a CHECK *passes* on NULL: asserting only "an actor is recorded"
-- would admit a record trashed by nobody, and only its mirror image would admit an actor
-- recorded against a live one.
ALTER TABLE "sales_locations" ADD CONSTRAINT "sales_locations_coherent_trash" CHECK (
  ("sales_locations"."trashed_at" is null and "sales_locations"."trashed_by_administrator_id" is null)
  or ("sales_locations"."trashed_at" is not null and "sales_locations"."trashed_by_administrator_id" is not null)
);--> statement-breakpoint
ALTER TABLE "sellers" ADD CONSTRAINT "sellers_coherent_trash" CHECK (
  ("sellers"."trashed_at" is null and "sellers"."trashed_by_administrator_id" is null)
  or ("sellers"."trashed_at" is not null and "sellers"."trashed_by_administrator_id" is not null)
);--> statement-breakpoint
-- A trashed record is always retired too (F-122). Trashing retires in the same transaction, which
-- is what lets every public read keep filtering on `retired_at` alone instead of learning a second
-- column. These CHECKs are what make that one-rule reading safe: without them a future writer
-- could trash without retiring and put a trashed record back on the public map.
ALTER TABLE "sales_locations" ADD CONSTRAINT "sales_locations_trashed_implies_retired" CHECK (
  "sales_locations"."trashed_at" is null or "sales_locations"."retired_at" is not null
);--> statement-breakpoint
ALTER TABLE "sellers" ADD CONSTRAINT "sellers_trashed_implies_retired" CHECK (
  "sellers"."trashed_at" is null or "sellers"."retired_at" is not null
);--> statement-breakpoint
-- Trashing can only be credited for a retirement that EXISTS. The flag decides whether a restore
-- clears `retired_at`, so a true flag on a live record would let a later restore blank a
-- retirement nobody made — a symptom that would otherwise appear only on the public map.
ALTER TABLE "sales_locations" ADD CONSTRAINT "sales_locations_trash_retirement_coherent" CHECK (
  "sales_locations"."retired_by_trash" = false or "sales_locations"."retired_at" is not null
);--> statement-breakpoint
ALTER TABLE "sellers" ADD CONSTRAINT "sellers_trash_retirement_coherent" CHECK (
  "sellers"."retired_by_trash" = false or "sellers"."retired_at" is not null
);
