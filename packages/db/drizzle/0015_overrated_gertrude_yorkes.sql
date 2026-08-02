CREATE TABLE IF NOT EXISTS "admin_login_failures" (
	"bucket_hash" text PRIMARY KEY NOT NULL,
	"failure_count" integer NOT NULL,
	"window_expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "admin_login_failures_bucket_hash_shape"
		CHECK ("admin_login_failures"."bucket_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "admin_login_failures_positive_count"
		CHECK ("admin_login_failures"."failure_count" > 0),
	CONSTRAINT "admin_login_failures_future_window"
		CHECK ("admin_login_failures"."window_expires_at" > "admin_login_failures"."updated_at")
);
--> statement-breakpoint
-- The fixed launch identity is data-owned. NULL is separately refused by the existing NOT NULL.
ALTER TABLE "administrators" ADD CONSTRAINT "administrators_fixed_identity"
	CHECK ("administrators"."email" = 'board@vigavashon.org');--> statement-breakpoint
-- A pre-cutover cookie proved a magic link, not the configured password. Revoke every old
-- session before removing that provenance so none can authenticate under the new architecture.
UPDATE "admin_sessions"
	SET "revoked_at" = greatest("issued_at", now())
	WHERE "revoked_at" IS NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "admin_sessions_one_per_magic_nonce";--> statement-breakpoint
ALTER TABLE "admin_sessions" DROP CONSTRAINT IF EXISTS "admin_sessions_magic_nonce_hash_shape";--> statement-breakpoint
ALTER TABLE "admin_sessions" DROP COLUMN IF EXISTS "magic_nonce_hash";
