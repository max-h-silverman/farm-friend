CREATE TABLE IF NOT EXISTS "pending_issue_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sender_hash" text NOT NULL,
	"report_text" text NOT NULL,
	"inbox_event_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pending_issue_reports_sender_hash_unique" UNIQUE("sender_hash")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_issue_reports_sender_idx" ON "pending_issue_reports" USING btree ("sender_hash","expires_at");--> statement-breakpoint
ALTER TABLE "pending_issue_reports" ADD CONSTRAINT "pending_issue_reports_report_text_not_blank" CHECK (length(btrim("pending_issue_reports"."report_text", E' \t\r\n')) > 0);--> statement-breakpoint
ALTER TABLE "pending_issue_reports" ADD CONSTRAINT "pending_issue_reports_expires_after_creation" CHECK ("pending_issue_reports"."expires_at" > "pending_issue_reports"."created_at");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pending_issue_reports" ADD CONSTRAINT "pending_issue_reports_inbox_event_id_provider_inbox_events_id_fk" FOREIGN KEY ("inbox_event_id") REFERENCES "public"."provider_inbox_events"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
