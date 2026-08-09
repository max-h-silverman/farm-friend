-- Taking a whole farm down, and an honest name for an address question.
--
-- Two changes, both operator-facing:
--
--   1. `farms` gains the retirement pair, so "delete a farm" can mean what max chose it to
--      mean — off every public surface, records kept — the same shape `sales_locations` has
--      carried since F-071.
--   2. `stand_data_flag_reason` gains `address_unresolved`. The seeder was filing address
--      questions as `unparsed_availability`, so the operator queue rendered "Availability
--      text could not be understood" directly above quoted text that was plainly an address.
--      The label contradicted the evidence beneath it.

-- The enum is RECREATED rather than extended. `ALTER TYPE … ADD VALUE` is the trap this
-- project has hit before: it cannot run inside a transaction block on the Postgres versions
-- in play, and drizzle wraps each migration in one. The rename dance below is transactional
-- and is the same one `0031` used for `inventory_revision_source`.
CREATE TYPE "public"."stand_data_flag_reason_next" AS ENUM(
	'contradictory_hours',
	'season_unresolved',
	'unparsed_availability',
	'possibly_closed',
	'address_unresolved'
);--> statement-breakpoint

ALTER TABLE "stand_data_flags"
	ALTER COLUMN "reason" TYPE "public"."stand_data_flag_reason_next"
	USING "reason"::text::"public"."stand_data_flag_reason_next";--> statement-breakpoint

DROP TYPE "public"."stand_data_flag_reason";--> statement-breakpoint

ALTER TYPE "public"."stand_data_flag_reason_next"
	RENAME TO "stand_data_flag_reason";--> statement-breakpoint

-- Re-file the rows the seeder mislabelled. The source text is the only evidence of what the
-- question actually was, and the seeder wrote it in a fixed shape ("address needs review: …"),
-- so it is the discriminator. Anchored with `like` on that exact prefix rather than a looser
-- match, because a stand whose HOURS text merely mentions an address must not be moved.
UPDATE "stand_data_flags"
	SET "reason" = 'address_unresolved'
	WHERE "reason" = 'unparsed_availability'
	  AND "source_text" LIKE 'address needs review:%';--> statement-breakpoint

ALTER TABLE "farms" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "farms" ADD COLUMN "retired_by_administrator_id" uuid;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "farms" ADD CONSTRAINT "farms_retired_by_administrator_id_administrators_id_fk" FOREIGN KEY ("retired_by_administrator_id") REFERENCES "public"."administrators"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- `drizzle-kit generate` silently drops CHECK constraints, so this is appended by hand and
-- verified by effect (see the integration suite, which proves it genuinely refuses).
--
-- Written as a full disjunction rather than a one-directional test because a CHECK PASSES on
-- NULL: `retired_by is not null` alone would admit a farm retired by nobody, and only its
-- mirror image would admit an actor recorded against a live farm. The pair moves together.
ALTER TABLE "farms" ADD CONSTRAINT "farms_coherent_retirement" CHECK (
	("farms"."retired_at" IS NULL AND "farms"."retired_by_administrator_id" IS NULL)
	OR ("farms"."retired_at" IS NOT NULL AND "farms"."retired_by_administrator_id" IS NOT NULL)
);
