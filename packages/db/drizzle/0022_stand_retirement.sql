-- F-071 — VIGA can take a stand down without erasing what it published.
--
-- max asked for the ability to "delete" a farm/stand and chose "take it off the map, keep
-- records". That is the only option the schema permits and the only one the product should
-- want:
--
--   * `sales_locations` is referenced `on delete restrict` by `inventory_revisions`,
--     `inventory_entries`, `stand_items` and `stock_out_reports`. A hard DELETE fails at the
--     constraint for any stand that has ever published — which is nearly all of them.
--   * Golden Rule #1 says the farmer owns published state. Erasing a revision would erase the
--     answer to "what did this stand say it had, and when", which the audit trail exists to
--     keep.
--
-- Retirement is therefore a state on the location, not a deletion of it. It is deliberately
-- NOT `is_public`: that column is a LISTING attribute the farmer's own onboarding form sets
-- (`onboarding-listing.ts` writes `is_public = true` on every save), so an operator decision
-- expressed through it would be silently reverted the next time the farmer edited their
-- listing. Two actors owning one column is exactly the "two ways to do one thing" the zen desk
-- forbids.

ALTER TABLE "sales_locations" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sales_locations" ADD COLUMN "retired_by_administrator_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_locations" ADD CONSTRAINT "sales_locations_retired_by_administrator_id_administrators_id_fk" FOREIGN KEY ("retired_by_administrator_id") REFERENCES "public"."administrators"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_locations_live_idx" ON "sales_locations" USING btree ("id") WHERE "sales_locations"."retired_at" is null;--> statement-breakpoint

-- HAND-WRITTEN, and it has to be: drizzle-kit omits CHECK constraints entirely when it
-- generates SQL, so a constraint declared in schema.ts and left to the generator is enforced
-- by nothing. `migration-metadata.test.ts` is the guard that catches it — it caught this one.
--
-- The two retirement columns move together or not at all. Written as a full disjunction over
-- both shapes rather than a one-directional test, because a CHECK *passes* on NULL: asserting
-- only "an actor is recorded" would admit a stand retired by nobody, and only the mirror image
-- would admit an actor recorded against a live stand.
ALTER TABLE "sales_locations"
	ADD CONSTRAINT "sales_locations_coherent_retirement"
	CHECK (
		(
			"sales_locations"."retired_at" IS NULL
			AND "sales_locations"."retired_by_administrator_id" IS NULL
		)
		OR (
			"sales_locations"."retired_at" IS NOT NULL
			AND "sales_locations"."retired_by_administrator_id" IS NOT NULL
		)
	);
