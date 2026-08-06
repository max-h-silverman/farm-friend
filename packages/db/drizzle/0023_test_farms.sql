-- F-074 — a farm VIGA can exercise against real production without an islander ever seeing it.
--
-- Two additions, and they answer different halves of "who is allowed to see this".
--
--   * `farms.test_farm_at` marks the farm. It sits on `farms`, not `sales_locations`, because
--     the intent is "this whole farm is fake" — one decision covering every stand it has.
--     It is deliberately NOT folded into `sales_locations.is_public`: that column is a LISTING
--     attribute the farmer's own onboarding form rewrites on every save, so an operator
--     decision expressed through it would be silently cleared the next time anyone edited the
--     listing. `retired_at` is kept separate for exactly this reason and F-071's migration says
--     so; this is the same rule, not a new one.
--
--   * `administrator_phones` is who may see test farms over SMS. It stores the HASH and the
--     last four digits, and NO full number: `contacts` keeps raw E.164 only because the
--     outbound send path needs something to send to, and nothing on this path ever sends. The
--     four digits identify a row to a human being, never a subscriber.
--
-- Both are additive and nullable, so an image built before this migration keeps serving
-- correctly in the window between applying it and deploying the code that reads it.
--
-- What this table must NEVER become: a general admin-over-SMS capability. Being listed grants
-- visibility of test farms and nothing else — no publishing, no approving, no reading another
-- farmer's data. That is enforced by the fact that no path except retrieval consults it.

CREATE TABLE IF NOT EXISTS "administrator_phones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_hash" text NOT NULL,
	"phone_last_four" text NOT NULL,
	"added_by_administrator_id" uuid NOT NULL,
	"added_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_administrator_id" uuid
);
--> statement-breakpoint
ALTER TABLE "farms" ADD COLUMN "test_farm_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "farms" ADD COLUMN "test_farm_by_administrator_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "administrator_phones" ADD CONSTRAINT "administrator_phones_added_by_administrator_id_administrators_id_fk" FOREIGN KEY ("added_by_administrator_id") REFERENCES "public"."administrators"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "administrator_phones" ADD CONSTRAINT "administrator_phones_revoked_by_administrator_id_administrators_id_fk" FOREIGN KEY ("revoked_by_administrator_id") REFERENCES "public"."administrators"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Revoking a listing and re-adding the same number must both be possible, and the second must
-- not resurrect the first. A partial unique index over the LIVE rows is what says "one live
-- listing per number" while leaving revoked history alone — the same shape `farm_approvals`
-- uses, and the reason it is an index rather than a plain UNIQUE.
CREATE UNIQUE INDEX IF NOT EXISTS "administrator_phones_one_live" ON "administrator_phones" USING btree ("phone_hash") WHERE "administrator_phones"."revoked_at" is null;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "farms" ADD CONSTRAINT "farms_test_farm_by_administrator_id_administrators_id_fk" FOREIGN KEY ("test_farm_by_administrator_id") REFERENCES "public"."administrators"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- HAND-WRITTEN, and it has to be: drizzle-kit omits CHECK constraints entirely when it
-- generates SQL, so a constraint declared in schema.ts and left to the generator is enforced by
-- nothing. `migration-metadata.test.ts` guards the snapshot half of this; the constraints
-- themselves are only real if they are written here.
--
-- Each pair below is a full disjunction over both shapes rather than a one-directional test,
-- because a CHECK *passes* on NULL. Asserting only "an actor is recorded" would admit a farm
-- marked by nobody; only the mirror image would admit an actor recorded against a real farm.
ALTER TABLE "farms"
	ADD CONSTRAINT "farms_coherent_test_farm"
	CHECK (
		(
			"farms"."test_farm_at" IS NULL
			AND "farms"."test_farm_by_administrator_id" IS NULL
		)
		OR (
			"farms"."test_farm_at" IS NOT NULL
			AND "farms"."test_farm_by_administrator_id" IS NOT NULL
		)
	);--> statement-breakpoint

ALTER TABLE "administrator_phones"
	ADD CONSTRAINT "administrator_phones_coherent_revocation"
	CHECK (
		(
			"administrator_phones"."revoked_at" IS NULL
			AND "administrator_phones"."revoked_by_administrator_id" IS NULL
		)
		OR (
			"administrator_phones"."revoked_at" IS NOT NULL
			AND "administrator_phones"."revoked_by_administrator_id" IS NOT NULL
		)
	);--> statement-breakpoint

-- 32 random bytes hex-encoded, the shape every hash in this system has. A short value here
-- would mean the number was stored rather than hashed — the one failure this column exists to
-- make impossible.
ALTER TABLE "administrator_phones"
	ADD CONSTRAINT "administrator_phones_phone_hash_shape"
	CHECK ("administrator_phones"."phone_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint

-- Exactly four digits. `maskPhoneSuffix` REFUSES anything longer rather than truncating it,
-- because a caller passing a whole number has a bug and masking it silently would hide the leak
-- at the point it is most expensive. The column refuses it too, rather than trusting every
-- writer to have normalized first.
ALTER TABLE "administrator_phones"
	ADD CONSTRAINT "administrator_phones_last_four_shape"
	CHECK ("administrator_phones"."phone_last_four" ~ '^[0-9]{4}$');
