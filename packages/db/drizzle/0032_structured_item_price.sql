DO $$ BEGIN
 CREATE TYPE "public"."stand_item_price_basis" AS ENUM('per', 'for');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "sales_locations" ADD COLUMN "prices_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stand_items" ADD COLUMN "price_amount" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "stand_items" ADD COLUMN "price_quantity" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "stand_items" ADD COLUMN "price_unit" text;--> statement-breakpoint
ALTER TABLE "stand_items" ADD COLUMN "price_basis" "stand_item_price_basis";--> statement-breakpoint
ALTER TABLE "stand_items" DROP COLUMN IF EXISTS "price_text";--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- F-092 — the constraints, which drizzle-kit does not emit for `check()` and which are the
-- whole reason this shape is safe. Hand-appended to the generated DDL above, the same way
-- every other CHECK in this directory is.
--
-- ## Why this reverses 0030, which argued the opposite two weeks ago
--
-- 0030 made the price free text, and its reasoning was sound for what it knew: a roadside sign
-- says "$6/dozen", not a decimal with a currency code. What settles it is the DATA. The VIGA
-- corpus — 285 stands, every description VIGA has collected — holds exactly one dollar sign,
-- and it belongs to a delivery threshold ("orders over $50"), not to an item. The local
-- database agrees: 37 stand items, zero priced. There was nothing to migrate and no farmer
-- vocabulary to honour, so max chose the structured shape on that evidence (2026-08-08).
--
-- ## The four columns are ONE mechanism
--
--     amount  quantity  unit     basis     renders as
--     6       1         dozen    per       $6 / dozen
--     5       3         lb       for       3 lb for $5
--
-- `per` is the bundle with an implied count of one. One shape keeps the renderer a single
-- function instead of a branch per sentence.

-- A price is ALL FOUR PARTS OR NONE. Half a price renders as garbage — "$6 /" or "/ dozen" —
-- and this is the only thing that can stop a writer omitting one field. All-NULL stays legal
-- and is what "not stated" means.
ALTER TABLE "stand_items"
	ADD CONSTRAINT "stand_items_price_complete"
	CHECK (
		(
			"price_amount" IS NULL
			AND "price_quantity" IS NULL
			AND "price_unit" IS NULL
			AND "price_basis" IS NULL
		)
		OR (
			"price_amount" IS NOT NULL
			AND "price_quantity" IS NOT NULL
			AND "price_unit" IS NOT NULL
			AND "price_basis" IS NOT NULL
		)
	);--> statement-breakpoint

-- Zero is FREE and is a real answer, so the amount floor is `>= 0`. The quantity floor is
-- `> 0`: "0 for $5" is not a sentence. Both say `IS NULL OR` explicitly, because a CHECK
-- *passes* on NULL and leaving that implicit is how a guard admits the case it meant to skip.
ALTER TABLE "stand_items"
	ADD CONSTRAINT "stand_items_price_amount_nonnegative"
	CHECK ("price_amount" IS NULL OR "price_amount" >= 0);--> statement-breakpoint

ALTER TABLE "stand_items"
	ADD CONSTRAINT "stand_items_price_quantity_positive"
	CHECK ("price_quantity" IS NULL OR "price_quantity" > 0);--> statement-breakpoint

-- The unit is the farmer's own word, so it is text rather than an enum — the form offers a
-- menu and an "other" box, and a stand selling by the half-flat or the cord must be able to
-- say so. `inventory_entries.unit` is free text for the same reason. Blank is not a unit,
-- though: "" and NULL would render identically while only one of them is a fact.
ALTER TABLE "stand_items"
	ADD CONSTRAINT "stand_items_price_unit_not_blank"
	CHECK ("price_unit" IS NULL OR length(btrim("price_unit", E' \t\r\n')) > 0);
