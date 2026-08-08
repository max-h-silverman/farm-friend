-- F-090 — an optional price on a standing item.
--
-- A farmer setting up their stand can now say what things cost, so the form reads a little more
-- like setting up a shop and a customer can see a price before driving out. max asked for this
-- explicitly (2026-08-08), with the constraint that it stay local and communal rather than
-- commercial.
--
-- ## Free text, deliberately, and the same shape `inventory_entries` already uses
--
-- `inventory_entries.price_text` has held today's prices as free text since the launch schema.
-- This is that column one table over, and matching it is the point: two spellings of "price"
-- in one system is how a renderer ends up with a branch per table.
--
-- Free text is also the honest type for what is being stated. A roadside sign says "$6/dozen",
-- "2 for $5", "$4 ea", "pay what you can" — none of which is a decimal with a currency code. A
-- numeric column would force the farmer to pick a shape their sign does not have, and would
-- invite exactly the arithmetic (subtotals, sorting by price, "cheapest stand") that turns an
-- honor-system stand into a storefront. Nothing here parses it; nothing sums it.
--
-- ## NULLABLE, and NULL means "not stated"
--
-- Not "free", not "ask" — unstated. A farmer who prices eggs and not flowers has said something
-- specific, and the card must be able to render the difference. The blank-string case is closed
-- by the CHECK below rather than left to every writer to remember, because "" and NULL would
-- render identically while only one of them is a fact.
--
-- ## Why no price on the ITEM's confirmed state
--
-- This is the STANDING claim's price — "eggs are usually $6/dozen" — and it lives beside
-- `usually_carried` for the same reason that flag does. A dated confirmation's price already has
-- its own column on `inventory_entries`, which is what a farmer states when today's eggs are
-- priced differently. F-066's split holds: standing claim and dated confirmation stay two facts.

ALTER TABLE "stand_items" ADD COLUMN "price_text" text;--> statement-breakpoint

-- Blank is not a price. The same `btrim` whitespace set the display-name CHECK and the unique
-- index already name explicitly — spaces, tabs, carriage returns, newlines — because `btrim`
-- with no second argument strips SPACES ONLY, and a test asserting "\t\n" is refused is what
-- caught that default admitting it on the neighbouring column.
--
-- A CHECK *passes* on NULL, which is what makes this safe to state as a bare condition: unstated
-- stays legal, and only an empty-ish string is refused.
ALTER TABLE "stand_items"
	ADD CONSTRAINT "stand_items_price_text_not_blank"
	CHECK ("stand_items"."price_text" IS NULL OR length(btrim("stand_items"."price_text", E' \t\r\n')) > 0);
