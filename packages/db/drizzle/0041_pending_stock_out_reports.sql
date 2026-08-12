DO $$ BEGIN
 CREATE TYPE "public"."pending_stock_out_awaiting" AS ENUM('stand', 'item');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pending_stock_out_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sender_hash" text NOT NULL,
	"report_text" text NOT NULL,
	"sales_location_id" uuid,
	"awaiting" "pending_stock_out_awaiting" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pending_stock_out_reports_sender_hash_unique" UNIQUE("sender_hash")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pending_stock_out_reports" ADD CONSTRAINT "pending_stock_out_reports_location_fk" FOREIGN KEY ("sales_location_id") REFERENCES "public"."sales_locations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_stock_out_reports_sender_idx" ON "pending_stock_out_reports" USING btree ("sender_hash","expires_at");--> statement-breakpoint

-- `drizzle-kit generate` does not emit CHECK constraints, so all three are hand-written.

-- The two arms are mutually exclusive and each is incomplete without its half: waiting on an
-- ITEM means the stand is already bound, waiting on a STAND means it is not. Written as one
-- biconditional rather than an enumeration of legal combinations.
--
-- `is not null` yields true or false and never NULL, so this cannot pass by evaluating to
-- NULL the way a bare comparison would — the trap that has bitten this schema before.
ALTER TABLE "pending_stock_out_reports" ADD CONSTRAINT "pending_stock_out_reports_awaiting_shape" CHECK (
  ("awaiting" = 'item') = ("sales_location_id" is not null)
);--> statement-breakpoint

-- A blank report text is a row that remembers nothing: the follow-up would resolve a stand
-- and then hand `recordStockOutReport` an empty message, which records no item. `btrim` names
-- the whitespace characters explicitly because the bare default strips spaces only — not
-- tabs, not newlines — which is how `stand_items` once admitted "\t\n".
ALTER TABLE "pending_stock_out_reports" ADD CONSTRAINT "pending_stock_out_reports_report_text_not_blank" CHECK (
  length(btrim("report_text", E' \t\r\n')) > 0
);--> statement-breakpoint

-- A row that expires at or before its creation can never be answered.
ALTER TABLE "pending_stock_out_reports" ADD CONSTRAINT "pending_stock_out_reports_expires_after_creation" CHECK (
  "expires_at" > "created_at"
);