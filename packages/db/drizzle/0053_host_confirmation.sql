CREATE TABLE IF NOT EXISTS "pending_host_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_hash" text NOT NULL,
	"stand_provider_id" uuid NOT NULL,
	"asked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pending_host_confirmations_host_hash_unique" UNIQUE("host_hash")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pending_host_confirmations" ADD CONSTRAINT "pending_host_confirmations_provider_fk" FOREIGN KEY ("stand_provider_id") REFERENCES "public"."stand_providers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
