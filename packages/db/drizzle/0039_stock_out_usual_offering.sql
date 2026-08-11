-- B-057 — a stock-out report may name one of the stand's USUAL offerings.
--
-- Order matters here and `drizzle-kit generate` got it wrong: the composite foreign key
-- below references `stand_items (id, sales_location_id)`, which is not referenceable until
-- the unique constraint on those columns exists. The generated file added the key first.
ALTER TABLE "stand_items" ADD CONSTRAINT "stand_items_id_location_unique" UNIQUE("id","sales_location_id");--> statement-breakpoint

ALTER TABLE "stock_out_reports" ADD COLUMN "referenced_stand_item_id" uuid;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "stock_out_reports" ADD CONSTRAINT "stock_out_reports_stand_item_location_fk" FOREIGN KEY ("referenced_stand_item_id","sales_location_id") REFERENCES "public"."stand_items"("id","sales_location_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- `drizzle-kit generate` does not emit CHECK constraints, so the item-reference rule is
-- hand-written. It widens from two references to three: exactly one of an inventory entry,
-- a stand item, or unlisted text. Counted rather than enumerated — three columns have eight
-- states, and listing the legal combinations is how a fourth reference later misses a case.
--
-- The blank guard stays explicit because a CHECK passes on NULL: without it, an
-- `unlisted_item_text` of "" satisfies "exactly one is not null" and renders as no item.
ALTER TABLE "stock_out_reports" DROP CONSTRAINT "stock_out_reports_exactly_one_item_reference";--> statement-breakpoint

ALTER TABLE "stock_out_reports" ADD CONSTRAINT "stock_out_reports_exactly_one_item_reference" CHECK (
  (
    ("referenced_inventory_entry_id" is not null)::int
    + ("referenced_stand_item_id" is not null)::int
    + ("unlisted_item_text" is not null)::int
  ) = 1
  and (
    "unlisted_item_text" is null
    or length(trim("unlisted_item_text")) > 0
  )
);
