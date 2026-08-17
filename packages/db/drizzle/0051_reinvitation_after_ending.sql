-- ===========================================================================================
-- F-115 Tranche D — A SELLER WHO ENDED MAY BE INVITED BACK.
--
-- §hosting and approval lifecycle: *"Either side may end it."* Ending closes one arrangement.
-- It was never meant to close the door, and max confirmed that reading (2026-08-17) when the
-- schema was measured rather than assumed.
--
-- ## What was wrong
--
-- `stand_providers_one_per_seller_per_location` was a FULL unique index on
-- `(sales_location_id, seller_id)` — deliberately non-partial since C.0, when the native-brand
-- slot was removed and the old `seller_id is not null` predicate stopped excluding anything.
--
-- An ended row therefore went on occupying the slot forever. `inviteSellerToStand`'s
-- `on conflict do nothing returning` found the ended row, returned nothing, and answered
-- `already_selling_here` — to a seller who is demonstrably NOT selling here. Kelsey and Zoe
-- part ways in April and Kelsey cannot invite her back in June, with a refusal that says the
-- opposite of the truth. Measured, not inferred:
-- `hosting.integration.test.ts` §MEASURES what re-inviting a seller whose relationship ENDED.
--
-- ## The rule now
--
-- **At most one LIVE relationship per (stand, seller); any number of ended ones.**
--
-- That is what the index was always for. Two live rows for one seller at one stand would be two
-- listings under one name, which is the ambiguity C.0's comment describes; two ENDED rows are
-- two episodes of a history, which is what `ended_at` exists to record.
--
-- **It stays the first-insert ARBITER.** `select … for update` cannot serialize a row that does
-- not exist yet, so `inviteSellerToStand` still relies on this index to decide which of two
-- racing writers wins — `on conflict do nothing returning`, with an empty result meaning "someone
-- else already did this". A partial index still arbitrates, because the row both racers try to
-- insert has `ended_at is null` and therefore falls inside the predicate.
--
-- ## What is deliberately NOT changed
--
-- No composite foreign key moves. `farmer_links`, `inventory_revisions`,
-- `scheduled_inventory_prompt_subjects` and the rest are rooted on `stand_providers.id`, which
-- is per-EPISODE — so a seller's history at a stand stays attached to the arrangement it was
-- published under, and a new arrangement starts with none of it. That is the correct reading:
-- goods confirmed under an arrangement that ended are not goods confirmed under the new one.
-- ===========================================================================================

DROP INDEX IF EXISTS "stand_providers_one_per_seller_per_location";--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "stand_providers_one_per_seller_per_location"
  ON "stand_providers" ("sales_location_id", "seller_id")
  WHERE "ended_at" is null;
