-- F-066 — one item vocabulary per stand, with two independent states.
--
-- "Eggs" was two facts in two tables that shared no vocabulary: a row in
-- `sales_location_offerings` (what a stand usually carries) and a row in `inventory_entries`
-- (what was confirmed present on a date). Nothing normalized names between them, so three
-- separate readers case-folded their way to agreement — most visibly the subtraction in
-- `standListingLines`, which removed confirmed items from the usual list at RENDER TIME so
-- one item would not print under two headings. That subtraction was the reconciliation the
-- data model never did.
--
-- `stand_items` is now the single home for "eggs" at a stand. The two claims become two
-- INDEPENDENT STATES of that one record:
--
--   usually_carried = true          → a standing property of the farm, dated by NOTHING
--   an inventory entry naming it    → a statement about right now, always dated, always
--                                     attributed by `source`
--
-- Either, both, or neither may hold. Sharing the VOCABULARY is not sharing the SLOT: a
-- standing claim still cannot occupy `one_current_per_location`, still carries no confirmation
-- time, and is still rendered under a heading that takes no timestamp.
--
-- WHY NO `stand_item_id` COLUMN ON `inventory_entries`. Measured against real Postgres, not
-- assumed: `inventory_entries_guard_history` raises on EVERY update, unconditionally — there
-- is no permitted update shape at all. Backfilling a reference onto published rows would mean
-- disabling the immutability guarantee inside a migration, which sets the precedent that the
-- guarantee is switchable. It is also unnecessary. An entry already carries the farmer's words
-- and belongs to a stand, so (sales_location_id, normalized item_name) resolves it to its item
-- — the very key the unique index below enforces. Published history is not touched by this
-- migration at all.
--
-- NORMALIZATION IS CASE AND SURROUNDING WHITESPACE, AND NOTHING ELSE. It exists so the profile
-- form's "eggs" and the weekly stock form's "Eggs" are one item. It must never fold singulars
-- into plurals or synonyms into each other: that would be a produce taxonomy as policy, which
-- CLAUDE.md forbids, and no database index is the place to decide that a love apple is a
-- tomato. The farmer's own casing is kept in `display_name` for the screen.

CREATE TABLE "stand_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sales_location_id" uuid NOT NULL,
	-- The farmer's own words, kept verbatim for display: "plant starts", "Gailan".
	"display_name" text NOT NULL,
	-- The standing state. NOT a timestamp, deliberately and permanently — see the header.
	"usually_carried" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);--> statement-breakpoint

ALTER TABLE "stand_items"
	ADD CONSTRAINT "stand_items_location_fk"
	FOREIGN KEY ("sales_location_id") REFERENCES "sales_locations"("id")
	ON DELETE cascade;--> statement-breakpoint

-- `btrim(text)` strips SPACES ONLY — not tabs, not newlines. Caught by a test asserting that
-- "\t\n" is refused: it was accepted, because the default trim left it non-empty. Every
-- normalization here therefore names the whitespace characters explicitly, and the index below
-- must use the identical expression or the two disagree about what "blank" and "same" mean.
ALTER TABLE "stand_items"
	ADD CONSTRAINT "stand_items_display_name_not_blank"
	CHECK (length(btrim("display_name", E' \t\r\n')) > 0);--> statement-breakpoint

ALTER TABLE "stand_items"
	ADD CONSTRAINT "stand_items_nonnegative_sort_order"
	CHECK ("sort_order" >= 0);--> statement-breakpoint

-- The guarantee, and the FIRST-INSERT ARBITER.
--
-- Two concurrent confirmations naming the same new item share no parent row to lock, and
-- `select ... for update` cannot serialize a row that does not exist yet. So the index is the
-- only thing that can decide the race: every writer inserts with
-- `on conflict do nothing returning id`, and an empty result means another writer won and the
-- existing row should be read. This is the same rule F-050's participant names already rely on.
CREATE UNIQUE INDEX "stand_items_one_per_location_name"
	ON "stand_items" ("sales_location_id", lower(btrim("display_name", E' \t\r\n')));--> statement-breakpoint

-- Backfill 1 of 2 — every existing standing claim becomes an item that is usually carried.
--
-- `distinct on` because the new key is narrower than the old primary key: `(location, 'Eggs')`
-- and `(location, 'eggs')` were two legal rows before and are one item now. The lowest
-- sort_order wins, so display order survives; the tie-break on `item` keeps the choice
-- deterministic rather than dependent on physical row order.
INSERT INTO "stand_items" ("sales_location_id", "display_name", "usually_carried", "sort_order")
SELECT DISTINCT ON ("sales_location_id", lower(btrim("item", E' \t\r\n')))
	"sales_location_id", "item", true, "sort_order"
FROM "sales_location_offerings"
ORDER BY "sales_location_id", lower(btrim("item", E' \t\r\n')), "sort_order", "item";--> statement-breakpoint

-- Backfill 2 of 2 — every item any published revision ever named exists too, WITHOUT the
-- standing state.
--
-- This is the half that would be missed by reading the offerings table alone, and missing it
-- would lose vocabulary: an item a farmer confirmed but never listed as usual would have no
-- record, and the readers would go back to case-folding two lists. `usually_carried` stays
-- false — a past confirmation is not a standing claim, which is the entire distinction this
-- feature preserves.
--
-- `on conflict do nothing` because the offerings backfill above may already have claimed the
-- name, and an item carrying BOTH states is the normal case, not a collision to resolve.
-- The stored name is trimmed on the way in: `inventory_entries` enforces only that its name is
-- not blank after a DEFAULT btrim, so " Eggs\t" is a legal entry name today. Inserting it here
-- verbatim would carry the padding into the item's display name and, for a tab/newline-only
-- name, violate this table's stricter not-blank CHECK and abort the whole migration. The
-- normalized key is unaffected either way — this only decides what the screen shows.
INSERT INTO "stand_items" ("sales_location_id", "display_name", "usually_carried", "sort_order")
SELECT DISTINCT ON ("sales_location_id", lower(btrim("item_name", E' \t\r\n')))
	"sales_location_id", btrim("item_name", E' \t\r\n'), false, 0
FROM "inventory_entries"
WHERE length(btrim("item_name", E' \t\r\n')) > 0
ORDER BY "sales_location_id", lower(btrim("item_name", E' \t\r\n')), "item_name"
ON CONFLICT DO NOTHING;
