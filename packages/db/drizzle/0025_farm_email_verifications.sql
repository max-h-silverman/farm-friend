-- F-079 — the issued verification code, so an emailed code is a real credential rather than a
-- number held in one container's memory.
--
-- ## Why this needs a table at all
--
-- F-078 built the roster and the send path; nothing stored what was SENT. A code has to be
-- checkable on a later request, and on Cloud Run that request routinely lands on a different
-- container: the service scales to zero between a farmer reading their mail and typing the
-- code. An in-memory code would refuse a farmer who typed exactly the right digits, with
-- nothing anywhere reporting why. So the issued code is durable state.
--
-- ## The code is HASHED AT REST, like every other credential in this schema
--
-- `code_hash` is HMAC-SHA256 of the code under the same salt discipline as
-- `farmer_links.token_hash` and `admin_sessions.token_hash`. A database read cannot recover a
-- live code, so a leaked backup is not a set of working keys to farmers' listings.
--
-- Six digits is a small space, which is exactly why the throttle below is part of the
-- credential rather than a nicety: unrationed, a million guesses is not a serious obstacle.
-- What makes this safe is that guesses are counted and capped, not that the code is long.
--
-- ## Single-use, and the database is what enforces it
--
-- `consumed_at` is set when a code is redeemed, and the partial unique index below permits
-- exactly ONE unconsumed, unexpired code per farm. Re-verifying issues a fresh row only after
-- the previous one is consumed or has expired — so a farmer who taps "send it again" twice
-- does not end up with two live codes where the older one still opens the listing.
--
-- ## Throttling is PER FARM AND PER ADDRESS, which a client-signal throttle cannot do
--
-- `packages/core/src/public/throttle.ts` rations by a coarse client bucket. That is the right
-- tool for cost, and the wrong one here: rotating the client signal would still let someone
-- flood one farmer's real inbox with codes, and still let them grind guesses against one farm.
-- Both limits are counted from THIS TABLE — issuance by counting recent rows for the farm,
-- guessing by `attempt_count` on the row itself — so they hold across containers and restarts.
--
-- ## Privacy: no raw address here, deliberately
--
-- `email_hash` and never `email`. Golden Rule #5 puts the raw address in exactly one column
-- (`farm_emails.email`) read only by the send path; this table is a lookup and audit record,
-- so it carries the hash like every other log key. Which address a code went to is answerable
-- by joining on the hash, without a second copy of personal data existing.
--
-- Additive and self-contained: an image built before this migration keeps serving correctly in
-- the window between applying it and deploying the code that reads it.
--
-- HAND-WRITTEN, and 0024's finding REPRODUCED FIRST-HAND while writing this one.
--
-- `drizzle-kit generate` was run against this same `schema.ts`. What it produced was the CREATE
-- TABLE and the foreign key — and **nothing else**. It silently dropped all SEVEN CHECK
-- constraints and all FOUR indexes, including
-- `farm_email_verifications_one_live_per_farm`, which is the entire single-live-code guarantee.
-- Its version would have created a table enforcing none of the rules `schema.ts` appears to
-- declare, with no warning anywhere. Only the generated META SNAPSHOT was kept; this SQL is the
-- authority.
--
-- That is why `farm-email-verifications-migration.integration.test.ts` proves each constraint
-- genuinely REFUSES rather than trusting either file to be accurate.

CREATE TABLE IF NOT EXISTS "farm_email_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"farm_id" uuid NOT NULL,
	-- WHICH address on file this code was sent to, as a hash. Never the address itself.
	"email_hash" text NOT NULL,
	-- HMAC of the six-digit code. The code itself exists only in the farmer's inbox.
	"code_hash" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	-- Set exactly once, when the code is redeemed. NULL means still live.
	"consumed_at" timestamp with time zone,
	-- Wrong guesses against this code. Capped, so a six-digit space cannot be ground down.
	"attempt_count" integer DEFAULT 0 NOT NULL
);--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "farm_email_verifications" ADD CONSTRAINT "farm_email_verifications_farm_id_farms_id_fk"
	FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id")
	ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- Both hashes must be 64-character LOWERCASE hex digests, the shape every hash column in this
-- schema uses. A malformed hash is a row that can never be matched: the farmer's correct code
-- would simply miss, and nothing would report an error.
ALTER TABLE "farm_email_verifications" ADD CONSTRAINT "farm_email_verifications_email_hash_is_digest"
	CHECK ("email_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint

ALTER TABLE "farm_email_verifications" ADD CONSTRAINT "farm_email_verifications_code_hash_is_digest"
	CHECK ("code_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint

-- A code must expire AFTER it was issued. Written as a strict inequality rather than `>=`: a
-- row expiring at the instant it was issued is dead on arrival, and a farmer would be refused a
-- code that the system's own records show was valid. A clock that ran backwards produces
-- exactly this row, so it is refused at the boundary rather than debugged later.
ALTER TABLE "farm_email_verifications" ADD CONSTRAINT "farm_email_verifications_expires_after_issue"
	CHECK ("expires_at" > "issued_at");--> statement-breakpoint

-- A code cannot be consumed before it was issued.
--
-- Written to pass on NULL DELIBERATELY, and this is the direction that needs stating: an
-- unconsumed code has `consumed_at IS NULL`, and a CHECK returns NULL — which Postgres treats
-- as PASSING — for the whole expression. That is correct here, because "not yet consumed" must
-- be legal. It is called out because the same NULL semantics silently INVERT a guard when the
-- intent is the opposite, which is the defect 0023's coherence pairs were written to avoid.
ALTER TABLE "farm_email_verifications" ADD CONSTRAINT "farm_email_verifications_consumed_after_issue"
	CHECK ("consumed_at" IS NULL OR "consumed_at" >= "issued_at");--> statement-breakpoint

-- Attempts are counted, never negative.
ALTER TABLE "farm_email_verifications" ADD CONSTRAINT "farm_email_verifications_attempts_not_negative"
	CHECK ("attempt_count" >= 0);--> statement-breakpoint

-- AT MOST ONE LIVE CODE PER FARM.
--
-- The partial index is what makes "one open verification per farm" a database guarantee rather
-- than a promise in application code. `select`-then-`insert` cannot serialize a row that does
-- not exist yet, so the INDEX is the arbiter: issuance does `on conflict do nothing` and an
-- empty `returning` means a live code already exists.
--
-- Scoped to the FARM and not to the address, on purpose. Five of VIGA's farms list more than
-- one address; if two live codes could exist for one farm under different addresses, redeeming
-- either would open the same listing, and "one open confirmation" would be a fiction.
--
-- NOTE the predicate is `consumed_at IS NULL` ONLY, not also an expiry comparison: an index
-- predicate must be immutable, and `now()` is not. Expiry is enforced by the read path against
-- an injected clock, which is what the tests exercise. The practical effect is that a farmer
-- whose code expired must wait for the reissue path to clear the dead row, which it does.
CREATE UNIQUE INDEX IF NOT EXISTS "farm_email_verifications_one_live_per_farm"
	ON "farm_email_verifications" ("farm_id")
	WHERE "consumed_at" IS NULL;--> statement-breakpoint

-- THE PUBLISH GRANT the redeemed code produces.
--
-- Set when a code is verified, alongside `consumed_at`. Holding the grant's hash HERE rather
-- than in a second table is what keeps this one mechanism: the row already records which farm
-- and which instant, so the grant's validity is a question about this row and nothing else.
--
-- Hashed, like every other credential in this schema — a database read cannot recover a live
-- grant. NULL until the code is redeemed, and for a code that never is.
ALTER TABLE "farm_email_verifications" ADD COLUMN IF NOT EXISTS "grant_hash" text;--> statement-breakpoint
ALTER TABLE "farm_email_verifications" ADD COLUMN IF NOT EXISTS "grant_expires_at" timestamp with time zone;--> statement-breakpoint

-- Same digest shape as every other hash column. Passes on NULL, which is correct: an
-- unredeemed code holds no grant.
ALTER TABLE "farm_email_verifications" ADD CONSTRAINT "farm_email_verifications_grant_hash_is_digest"
	CHECK ("grant_hash" IS NULL OR "grant_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint

-- A grant and its expiry travel together. Either both are set or neither is — a grant with no
-- expiry would never age out, and an expiry with no grant is a row describing nothing. This is
-- a COHERENCE PAIR written in both directions, because the one-directional form passes on NULL
-- and would enforce nothing (0023's lesson).
ALTER TABLE "farm_email_verifications" ADD CONSTRAINT "farm_email_verifications_grant_coherent"
	CHECK (("grant_hash" IS NULL) = ("grant_expires_at" IS NULL));--> statement-breakpoint

-- The grant lookup: given a hash, which row issued it.
CREATE INDEX IF NOT EXISTS "farm_email_verifications_grant_idx"
	ON "farm_email_verifications" ("grant_hash");--> statement-breakpoint

-- The issuance-throttle read: recent rows for a farm, newest first.
CREATE INDEX IF NOT EXISTS "farm_email_verifications_farm_issued_idx"
	ON "farm_email_verifications" ("farm_id", "issued_at" DESC);--> statement-breakpoint

-- The per-address issuance throttle.
CREATE INDEX IF NOT EXISTS "farm_email_verifications_email_issued_idx"
	ON "farm_email_verifications" ("email_hash", "issued_at" DESC);
