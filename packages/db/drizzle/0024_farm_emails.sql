-- F-078 — the email roster VIGA already holds, so a farmer can prove who they are without a
-- volunteer vouching for them.
--
-- ## Why this table exists
--
-- Farmer onboarding was either an administrator minting an invitation, or `/farmer/start` on the
-- honour system — VIGA supplied no roster to verify anyone against. Their farm-stand form does
-- carry one: measured against the real 2026 responses, **32 of 32 rows have an email, no address
-- is shared between two farms, and five farms list more than one**. So an emailed code proves
-- something real: *you control an address VIGA has on file for this farm.*
--
-- It is EMAIL and not phone for a reason that is not preference. A texted code to an unconsented
-- number is forbidden by the consent architecture and by the registered 10DLC campaign — Farm
-- Friend may not send first. Email carries no such restriction.
--
-- ## Privacy: Golden Rule #5, applied to a second kind of personal data
--
-- These addresses are largely PERSONAL (`dhusch@hotmail.com`), so they carry the same weight as
-- phone numbers. The shape mirrors `contacts` deliberately rather than inventing a second
-- pattern:
--
--   * `email` is the raw address in EXACTLY ONE column, read only by the send path.
--   * `email_hash` is the ONLY lookup and log key. It never appears in model context.
--
-- **Verifying is not publishing** (max, 2026-08-06). Six farms answered "No" to putting contact
-- email on the printed map and two left it blank. Their addresses are still stored and still
-- authenticate — nothing here is a display column, and no public read path selects from this
-- table. That is a query property, proven by test, not something a schema can enforce.
--
-- ## What this table must NEVER become
--
-- A contact list. It answers exactly one question — "is this address on file for this farm?" —
-- and holds no name, no role, no preferences, and no rich personal profile.
--
-- ## This file is HAND-WRITTEN, and here is the proof it has to be
--
-- `drizzle-kit generate` was run against the same `schema.ts` while writing this. What it
-- produced was the CREATE TABLE and the foreign key — and **nothing else**. Both CHECK
-- constraints and the normalized unique index were silently dropped, so its version would have
-- created a table enforcing none of the rules `schema.ts` appears to declare, with no warning
-- anywhere. Only the generated META SNAPSHOT was kept; this SQL is the authority.
--
-- That is why `farm-emails-migration.integration.test.ts` proves each constraint REFUSES rather
-- than trusting either file to be accurate.
--
-- Additive and nullable-free but self-contained, so an image built before this migration keeps
-- serving correctly in the window between applying it and deploying the code that reads it.

CREATE TABLE IF NOT EXISTS "farm_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"farm_id" uuid NOT NULL,
	-- The raw address. THE ONLY column holding it, read only by the send path.
	"email" text NOT NULL,
	-- The lookup and log key. Everything except sending uses this and never the column above.
	"email_hash" text NOT NULL,
	"added_at" timestamp with time zone NOT NULL
);--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "farm_emails" ADD CONSTRAINT "farm_emails_farm_id_farms_id_fk"
	FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id")
	ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- NOT BLANK, with the whitespace class named EXPLICITLY.
--
-- `btrim(text)` with no second argument strips SPACES ONLY — not tabs, not newlines. A naive
-- `length(btrim("email")) > 0` therefore ADMITS a tab-only or newline-only value: blank to every
-- human and every reader, stored as though it were an address. Migration 0020 hit exactly this
-- and its comment says so; this is the same rule, not a new one.
ALTER TABLE "farm_emails" ADD CONSTRAINT "farm_emails_address_not_blank"
	CHECK (length(btrim("email", E' \t\r\n')) > 0);--> statement-breakpoint

-- The hash must be a 64-character LOWERCASE hex digest — the shape every other hash column in
-- this schema uses. A malformed hash is a row that can never be looked up, so the farmer it
-- belongs to can never verify, and nothing would report an error: the lookup would simply miss.
-- Lowercase is enforced rather than folded, so there is exactly one spelling of a given digest.
ALTER TABLE "farm_emails" ADD CONSTRAINT "farm_emails_hash_is_digest"
	CHECK ("email_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint

-- ONE row per (farm, normalized address).
--
-- Normalized, because re-running the ingest must not double the roster, and because
-- "Info@Lavender..." and "info@lavender..." are one address — a farmer verifying with either
-- spelling has to reach the same row. The same `E' \t\r\n'` class as the CHECK above, so the
-- index and the constraint agree about what "blank" and "same" mean.
--
-- Deliberately scoped to the FARM, not global: the corpus has no address shared between two
-- farms today, but a couple farming two plots from one inbox is a real thing, and a global
-- unique index would refuse it. What must never happen is one address verifying the WRONG
-- farm — that is enforced by scoping the verification query, not by this index.
CREATE UNIQUE INDEX IF NOT EXISTS "farm_emails_one_per_farm_address"
	ON "farm_emails" ("farm_id", lower(btrim("email", E' \t\r\n')));--> statement-breakpoint

-- The lookup path: given a hash, which farm rows carry it.
CREATE INDEX IF NOT EXISTS "farm_emails_hash_idx" ON "farm_emails" ("email_hash");
