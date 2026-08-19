ALTER TABLE "flags" ADD COLUMN "reporter_email" text;--> statement-breakpoint
ALTER TABLE "flags" ADD COLUMN "reporter_email_hash" text;--> statement-breakpoint
ALTER TABLE "flags" ADD CONSTRAINT "flags_reporter_email_paired" CHECK (("flags"."reporter_email" is null) = ("flags"."reporter_email_hash" is null));--> statement-breakpoint
ALTER TABLE "flags" ADD CONSTRAINT "flags_reporter_email_not_blank" CHECK ("flags"."reporter_email" is null or length(btrim("flags"."reporter_email", E' \t\r\n')) > 0);
