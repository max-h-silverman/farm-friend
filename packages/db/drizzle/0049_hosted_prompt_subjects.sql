-- ===========================================================================================
-- F-114 Phase C.4 — THE DURABLE PROMPT SUBJECT FOLLOWS THE LISTING.
--
-- The last of the eight `*_location_own_seller_fk` keys that still asserts the one-seller-per-
-- stand model, and the third to be replaced (`0045` did `inventory_revisions`, `0048` did
-- `inventory_prompt_preferences`).
--
-- `scheduled_prompt_subjects_location_own_seller_fk` binds `(sales_location_id,
-- owner_seller_id)` to `sales_locations(id, own_seller_id)`: **the seller a scheduled prompt is
-- about must be the seller that owns the stand.** With the pass now reading the preference's own
-- seller, a hosted prompt writes Gracie's Greens beside Kelsey's stand, and this key refuses it —
-- at the database, after every application-level check has passed.
--
-- Like the other two it exists in `0042` and was **never carried into `schema.ts`**, so it is
-- invisible to a schema read and surfaces only on a hosted write.
--
-- ## Why the remaining two keys of the family STAY
--
-- `closure_revisions_location_own_seller_fk` and
-- `sales_location_participants_location_own_seller_fk` are correct and are deliberately left
-- alone. Both carry facts about the PLACE rather than about anyone's goods — a shutdown is not
-- any seller's stock, and the retired participant list is the stand's own record — so re-rooting
-- them onto a provider would make the record assert something false (max, 2026-08-15). That
-- decision is why this migration replaces exactly one key rather than sweeping the family.
--
-- ## What replaces it
--
-- `(provider_id, owner_seller_id)` -> `stand_providers(id, seller_id)`, the same substitution
-- `0045` and `0048` made: whose prompt this is is decided by the RELATIONSHIP. The subject
-- already carries `provider_id` and already keys `(provider_id, sales_location_id)` to
-- `stand_providers`, so the stand is still pinned; what changes is that the seller is pinned to
-- the LISTING'S seller instead of to the roof's.
-- ===========================================================================================

-- ---- 1. the relationship key arrives first --------------------------------------------------
-- Before the drop, so `owner_seller_id` is never unconstrained. Its composite target
-- `stand_providers(id, seller_id)` was created by `0044` and is declared in `schema.ts`.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'scheduled_prompt_subjects_provider_seller_fk'
  ) THEN
    ALTER TABLE "scheduled_inventory_prompt_subjects"
      ADD CONSTRAINT "scheduled_prompt_subjects_provider_seller_fk"
      FOREIGN KEY ("provider_id", "owner_seller_id")
      REFERENCES "public"."stand_providers"("id", "seller_id")
      ON DELETE restrict ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

-- ---- 2. the stand's own-seller key goes -----------------------------------------------------
ALTER TABLE "scheduled_inventory_prompt_subjects"
  DROP CONSTRAINT IF EXISTS "scheduled_prompt_subjects_location_own_seller_fk";
