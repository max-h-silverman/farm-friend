ALTER TABLE "stock_out_reports" ADD COLUMN "report_key" text;--> statement-breakpoint
ALTER TABLE "stock_out_reports" ADD CONSTRAINT "stock_out_reports_report_key_unique" UNIQUE("report_key");