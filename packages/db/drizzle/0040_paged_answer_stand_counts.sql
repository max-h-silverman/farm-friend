ALTER TABLE "pending_result_lists" ADD COLUMN "broad" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_result_lists" ADD COLUMN "stand_total" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_result_lists" ADD COLUMN "stand_offset" integer DEFAULT 0 NOT NULL;