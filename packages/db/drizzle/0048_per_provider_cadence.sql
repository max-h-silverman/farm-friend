-- ===========================================================================================
-- F-114 Phase C.4 — WHOSE REMINDER SCHEDULE THIS IS.
--
-- One constraint, and it is the same defect `0045` found on `inventory_revisions`, in the one
-- table `0045` had no reason to look at.
--
-- `inventory_prompt_preferences_location_own_seller_fk` binds `(sales_location_id,
-- owner_seller_id)` to `sales_locations(id, own_seller_id)`. In words: **this reminder's seller
-- must be the seller that owns the stand.** True of 38 of 38 stands when it was written, and
-- false of every hosting relationship C.1 and C.2 built. It forbids a hosted seller's cadence
-- AT THE DATABASE, where no writer can reach around it — and it forbids a venue's nested seller
-- outright, because `own_seller_id` is NULL at Morgan Hill and no row can match NULL.
--
-- §facts and authority: *reminder cadence is per provider, not per stand. A hosted seller
-- restocking weekly at a stand whose owner restocks daily needs its own cadence, and the
-- recipient differs by construction.* A key saying the schedule belongs to whoever owns the roof
-- contradicts that directly.
--
-- ## What replaces it, and why it is not a loosening
--
-- `(provider_id, owner_seller_id)` -> `stand_providers(id, seller_id)`: **whose reminder this is
-- is decided by the RELATIONSHIP**, exactly as `0045` decided whose goods a revision states. The
-- row still cannot name a seller who is not really the seller of the listing it schedules — it
-- simply no longer requires that seller to own the stand.
--
-- The two keys already in `schema.ts` carry the rest and are untouched:
--   * `inventory_prompt_preferences_location_provider_fk` — the listing is really at that stand.
--   * `inventory_prompt_preferences_authorization_owner_fk` — the recipient is really authorized
--     for that seller.
-- With the new key, the trio says: a real listing, at the stand it claims, whose seller is the
-- listing's seller, addressed to a phone authorized for that seller. Nothing is unconstrained.
--
-- ## Drift, found the way `0047`'s six were found
--
-- The dropped key exists in `0042` and **was never carried into `schema.ts`** — so it could not
-- be found by reading the schema, only by a populated-schema write that a hosted seller makes.
-- `0047` resolved six of these; this is the seventh, and it is in the table whose whole purpose
-- is the fact C.4 makes per-provider.
-- ===========================================================================================

-- ---- 1. the relationship key arrives first --------------------------------------------------
-- Added BEFORE the old one is dropped, so there is no window in which `owner_seller_id` is
-- unconstrained — the ordering `0045` established for the same reason.
--
-- Its composite target `stand_providers(id, seller_id)` already exists: `0044` created
-- `stand_providers_id_seller_unique` for the hosting invitation's key and `schema.ts` declares
-- it, so this migration depends on it rather than restating it.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'inventory_prompt_preferences_provider_seller_fk'
  ) THEN
    ALTER TABLE "inventory_prompt_preferences"
      ADD CONSTRAINT "inventory_prompt_preferences_provider_seller_fk"
      FOREIGN KEY ("provider_id", "owner_seller_id")
      REFERENCES "public"."stand_providers"("id", "seller_id")
      ON DELETE restrict ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

-- ---- 2. the stand's own-seller key goes -----------------------------------------------------
-- The assumption itself. Nothing replaces it directly: what it asserted is false under hosting,
-- and what it was reaching for — that a preference names a real seller at a real stand — is
-- statement 1 plus the location/provider key that was already there.
ALTER TABLE "inventory_prompt_preferences"
  DROP CONSTRAINT IF EXISTS "inventory_prompt_preferences_location_own_seller_fk";
