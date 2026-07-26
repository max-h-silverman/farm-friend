-- F-025a forward migration: administrator identity is email, and sessions are durable.
--
-- Two defects this closes, both found by reading the code on 2026-07-26:
--
-- 1. `administrators` identified an operator ONLY by `contact_id` — a phone contact — while
--    the magic-link login path identifies people by EMAIL. Nothing connected the two, so an
--    authenticated operator could never be resolved to an administrator row, and therefore
--    `hasRole` could never return true. The identity column and the login path must agree.
--
-- 2. There was no session record at all, so authorization could only ever have been a
--    self-contained token: unrevocable until it expired. Approving farms is a standing
--    capability; it must be withdrawable the moment VIGA withdraws it.

ALTER TABLE "administrators" ADD COLUMN "email" text;--> statement-breakpoint

-- Greenfield build (see CLAUDE.md "no legacy-migration provenance model"): any existing row
-- is development or test data with no email in it and no way to invent one. Rather than
-- fabricate an identity that would be a real authorization grant, such a row is REVOKED —
-- fail closed. Bootstrapping real administrators is the seed script's job, which records a
-- genuine email. A revoked row keeps the audit trail and cannot authorize anything.
UPDATE "administrators"
  SET "email" = 'retired-' || "id"::text || '@invalid.local',
      "revoked_at" = COALESCE("revoked_at", now())
  WHERE "email" IS NULL;--> statement-breakpoint

ALTER TABLE "administrators" ALTER COLUMN "email" SET NOT NULL;--> statement-breakpoint

-- The phone side is no longer the identity, so it is no longer required: an operator who
-- never texts is still an operator.
ALTER TABLE "administrators" ALTER COLUMN "contact_id" DROP NOT NULL;--> statement-breakpoint

ALTER TABLE "administrators" ADD CONSTRAINT "administrators_email_normalized"
  CHECK (
    "administrators"."email" = lower("administrators"."email")
    AND "administrators"."email" ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  );--> statement-breakpoint

-- The login lookup is by email, so at most one LIVE administrator may hold an address.
-- Revoked rows stay for the audit trail and are excluded.
CREATE UNIQUE INDEX "administrators_one_active_per_email"
  ON "administrators" ("email") WHERE "revoked_at" IS NULL;--> statement-breakpoint

-- A durable session: a database record, not a signed claim. Roles are looked up against the
-- session's administrator on every request, so a revocation takes effect immediately.
CREATE TABLE "admin_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- Only the HASH of the token is stored; the browser holds the opaque material. A database
  -- read cannot recover a live credential (Golden Rule #5 discipline).
  "token_hash" text NOT NULL,
  "administrator_id" uuid NOT NULL,
  "issued_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "admin_sessions_token_hash_unique" UNIQUE("token_hash"),
  -- 32 random bytes, hex. A short value would mean the token was stored rather than hashed,
  -- or truncated to something enumerable.
  CONSTRAINT "admin_sessions_token_hash_shape"
    CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "admin_sessions_bounded_lifetime"
    CHECK ("expires_at" > "issued_at"),
  CONSTRAINT "admin_sessions_valid_revocation"
    CHECK ("revoked_at" IS NULL OR "revoked_at" >= "issued_at")
);--> statement-breakpoint

ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_administrator_id_administrators_id_fk"
  FOREIGN KEY ("administrator_id") REFERENCES "public"."administrators"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "admin_sessions_administrator" ON "admin_sessions" ("administrator_id");
