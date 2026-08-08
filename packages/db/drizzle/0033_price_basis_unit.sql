-- B-041 — a bundle price does not need a unit. "$5 for 3" is a complete price for corn.
--
-- `drizzle-kit generate` was run and reported "No schema changes": it does not read `check()`
-- at all, which is why every CHECK in this directory is hand-appended and why this file has no
-- generated DDL above it. The schema snapshot is unaffected because no COLUMN changed —
-- `price_unit` was already nullable. What changes is which shapes are legal in it.
--
-- ## The asymmetry, and why it is its own constraint
--
--     amount  quantity  unit     basis     renders as
--     6       1         dozen    per       $6 / dozen
--     5       3         lb       for       3 lb for $5
--     5       3         —        for       $5 for 3        ← this is what 0032 refused
--     5       1         —        for       $5 each
--     6       1         —        per       REFUSED: "$6 / " is not a sentence
--
-- A bundle carries its own count, so the item itself is the unit — which is exactly what a corn
-- stand letters on its sign, and "3 each" or an invented word for a cob reads worse than saying
-- nothing. A unit price has no count to lean on, so `per` must still name what the amount is per.
--
-- 0032 required all four parts together and therefore dropped the corn price silently. Splitting
-- the rule in two is what keeps each constraint stating ONE thing: `price_complete` says a price
-- is stated or not, and `price_basis_unit` says when the unit is owed.
--
-- The code copy of this asymmetry is `standItemPriceNeedsUnit` in `@farm-friend/core`, which the
-- renderer and both boundary parsers import. This CHECK is the copy code cannot import, so it is
-- written to match that function and asserted against directly by the integration suite.

-- Restated WITHOUT the unit in either half. A unit with no amount is still refused, because the
-- all-NULL half requires `price_unit` to be NULL when nothing else is stated.
ALTER TABLE "stand_items"
	DROP CONSTRAINT IF EXISTS "stand_items_price_complete";--> statement-breakpoint

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
			AND "price_basis" IS NOT NULL
		)
	);--> statement-breakpoint

-- `IS DISTINCT FROM` rather than `<>`, because a CHECK *passes* on NULL and `'per' <> NULL` is
-- NULL, not false — the shape that admits exactly the case a guard meant to catch. With
-- `IS DISTINCT FROM`, an unstated basis satisfies this clause honestly and is left to
-- `price_complete`, while a stated `per` must produce a unit.
ALTER TABLE "stand_items"
	ADD CONSTRAINT "stand_items_price_basis_unit"
	CHECK ("price_basis" IS DISTINCT FROM 'per' OR "price_unit" IS NOT NULL);
