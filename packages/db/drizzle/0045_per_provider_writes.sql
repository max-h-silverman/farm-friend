-- ===========================================================================================
-- F-114 Phase C.2 — RE-ROOTING A REVISION'S SELLER ONTO ITS PROVIDER.
--
-- Two constraint changes and no new column. This is the last place the one-seller-per-stand
-- assumption survived: `0042` gave `inventory_revisions` a key onto `(sales_locations.id,
-- own_seller_id)`, which reads plainly as **every revision's seller is the stand's own seller**.
-- That was true of 38 of 38 stands when it was written and it structurally forbids the thing
-- F-114 exists to build — Gracie's Greens publishing at Venison Valley's stand fails at the
-- database, not at a guard, with no writer able to reach around it.
--
-- ## What replaces it, which is strictly stronger
--
-- Dropping a key without replacing it would leave `seller_id` free to say anything at all, so the
-- fact it was reaching for is restated correctly rather than abandoned. Two keys now bind it:
--
--   * `inventory_revisions_location_provider_fk` on `(provider_id, sales_location_id)` — the
--     provider belongs to this stand. Present since Phase B, untouched here.
--   * `inventory_revisions_provider_seller_fk` on `(provider_id, seller_id)` — NEW. The seller is
--     the PROVIDER'S seller.
--
-- Together: a revision belongs to one real relationship, at one real stand, for the seller that
-- relationship names. The dropped key was a special case of exactly this, which happened to hold
-- while every stand had one seller. Whose goods these are is decided by the relationship, never
-- by who owns the roof.
--
-- ## The widening, named rather than buried
--
-- `inventory_revisions_authorization_farm_fk` bound `(published_by_authorization_id, seller_id)`:
-- the publisher's authorization must name the seller being published. Under the host stock right
-- (§the Venison Valley case) the publisher is the HOST and the goods are the guest's, so the key
-- refuses precisely the write the product permits — a baker who would rather her host mark the
-- last loaf gone than be texted about it.
--
-- It becomes a plain reference to the authorization. This IS a loosening: the database no longer
-- knows who may publish for whom. It cannot, because the answer is two live facts — the
-- relationship's `host_may_update_stock` opt-in and the authorization's revocation — and a static
-- composite key can see neither. `resolveProviderWriteAuthority` is the one place that answers it,
-- and `per-provider-publication.integration.test.ts` proves the refusal by effect, including the
-- negative: a host without the opt-in publishes nothing.
--
-- **`approval_farm_fk` is deliberately NOT widened.** VIGA's approval gates whether a seller may
-- be public at all; it is a fact about that seller and never about who typed the update. A host's
-- approval on a guest's goods stays refused.
--
-- ## Migration safety
--
-- No column is added, no data is rewritten, and nothing is backfilled — every existing row already
-- satisfies both new keys, because today's revisions all name the stand's own provider whose seller
-- IS the stand's own seller. The populated-schema test asserts that rather than assuming it: it
-- builds the preceding schema, populates it, applies this file, and requires the row count and
-- every seller/provider pair to be unchanged.
--
-- Every statement is guarded, and the suite applies each file TWICE requiring the second run to be
-- a no-op: `ADD CONSTRAINT` and `DROP CONSTRAINT` are not idempotent on their own.
-- ===========================================================================================

-- ---- 1. the seller is the provider's seller -------------------------------------------------
-- Added BEFORE the old key is dropped, so there is no window in which `seller_id` is unconstrained.
-- The order matters for the same reason `0042` replaced the one-current index in a single
-- migration: a gap between two guarantees is a gap in which unguarded rows can be written and
-- never detected afterwards.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_revisions_provider_seller_fk'
  ) THEN
    ALTER TABLE "inventory_revisions"
      ADD CONSTRAINT "inventory_revisions_provider_seller_fk"
      FOREIGN KEY ("provider_id", "seller_id")
      REFERENCES "public"."stand_providers"("id", "seller_id")
      ON DELETE restrict ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

-- ---- 2. the stand's own-seller key goes ------------------------------------------------------
-- The assumption itself. Nothing replaces it directly, because what it asserted is false under
-- hosting; what it was REACHING for is statement 1.
ALTER TABLE "inventory_revisions"
  DROP CONSTRAINT IF EXISTS "inventory_revisions_location_own_seller_fk";--> statement-breakpoint

-- ---- 3. the publisher's authorization need not name the goods' seller ------------------------
-- Replaced by a plain reference rather than dropped outright: a revision naming a publisher who is
-- not a real authorization would be an audit trail pointing at nothing, and that half of the key
-- was never the problem.
ALTER TABLE "inventory_revisions"
  DROP CONSTRAINT IF EXISTS "inventory_revisions_authorization_farm_fk";--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_revisions_authorization_fk'
  ) THEN
    ALTER TABLE "inventory_revisions"
      ADD CONSTRAINT "inventory_revisions_authorization_fk"
      FOREIGN KEY ("published_by_authorization_id")
      REFERENCES "public"."farmer_authorizations"("id")
      ON DELETE restrict ON UPDATE no action;
  END IF;
END $$;
