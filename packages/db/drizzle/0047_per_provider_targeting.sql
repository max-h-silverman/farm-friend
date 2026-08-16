-- ===========================================================================================
-- F-114 Phase C.3 — THE LAST PLACE THE ONE-SELLER-PER-STAND ASSUMPTION LIVES.
--
-- SMS targeting is the gate: `lockLiveTargets` decided what a farmer's phone could reach by
-- joining `sales_locations.own_seller_id = auth.seller_id`, so a hosted seller was untargetable
-- outright — Zoe could publish from the web (C.2) and nothing could prompt her. Making the
-- targeting query provider-shaped is a code change; making the RECORDS able to hold the answer
-- is this migration, and SIX composite keys refuse it at the database where no writer can reach
-- around them: two on each of the three records in the chain. The pair on `farmer_links` was
-- found only when a populated-schema probe was refused by a constraint nobody had re-read.
--
-- This is the same discovery `0045` made about `inventory_revisions`, in the same shape: a key
-- that was true of 38 of 38 stands when it was written, and that states the assumption C.0
-- removed. `0042` re-rooted these tables onto `(provider, location)` and left the older
-- `(location, own_seller)` and `(authorization, seller)` keys standing beside the new ones. Four
-- of the six were never carried into `schema.ts` at all — they exist only in `0042` — so the
-- drift is resolved here rather than left for the next generated migration to discover.
--
-- ## What each key said, and why it is wrong now
--
-- **`*_location_own_seller_fk` (contexts, menu options)** — `(sales_location_id,
-- owner_seller_id)` into `sales_locations(id, own_seller_id)`. It says *the seller this target
-- names is the seller the stand points at as itself*. For a hosted target that is false by
-- construction: Gracie's Greens is not Venison Valley.
--
-- It is REPLACED by `(provider_id, owner_seller_id)` into `stand_providers(id, seller_id)`,
-- which is the true version of what it was reaching for and is exactly the substitution `0045`
-- made on `inventory_revisions`: whose goods a target names is decided by the RELATIONSHIP, not
-- by who owns the roof. Dropping it outright was the first draft and was wrong — nothing would
-- then tie `owner_seller_id` to the provider beside it, so a menu row could name one seller's
-- listing under another seller's name and no constraint anywhere would see it.
-- `*_location_provider_fk`, added by `0042`, keeps the other half (the provider belongs to the
-- stand); the two together say the whole thing.
--
-- **`*_authorization_owner_fk` (contexts, menu options)** — `(authorization_id,
-- owner_seller_id)` into `farmer_authorizations(id, seller_id)`. It says *the phone acting is
-- authorized for the seller whose goods are being targeted*. That is one of the three ways to
-- say yes and not the only one: a host targeting a hosted listing under
-- `stand_providers.host_may_update_stock` acts under the HOST'S authorization on the SELLER'S
-- goods, and a venue's manager holds a stand-armed authorization naming no seller at all — a
-- row this key cannot even represent, because `seller_id` is NULL on that arm and NULL never
-- matches.
--
-- These become plain single-column references. **That is a real loosening, named rather than
-- buried**, and it is the same one `0045` made to `authorization_farm_fk` for the same reason:
-- *who may target whom* is two LIVE facts — the relationship's opt-in and the authorization's
-- revocation — and a static key sees neither. `resolveProviderWriteAuthority` and
-- `lockLiveTargets` enforce it from one shared set of arms, and the targeting suite asserts the
-- refusals by effect rather than trusting the key to make them.
--
-- The `on delete cascade` behavior is preserved exactly: a revoked authorization's rows still
-- disappear with it, which is what keeps a stale menu from outliving the authority behind it.
--
-- **`farmer_links_targeted_authorization_owner_fk` and
-- `farmer_links_targeted_location_own_seller_fk`** — BOTH shapes on the third record in this
-- chain, and they matter for the same reasons: `LINK` and `SETTINGS` text the farmer a standing
-- link to the listing they were targeting. Phase B already gave `farmer_links` its
-- `provider_id` and its `(provider, location)` key, foreseeing this; what it left behind are the
-- `(authorization, seller)` pair, which refuses a link a host holds to a hosted seller's
-- listing, and the `(location, own_seller)` pair, which refuses a hosted seller's own link
-- outright. Without these the SMS door opens for Zoe and then hands her a page that refuses her.
-- Neither was ever carried into `schema.ts`, the same drift as the two targeting tables.
--
-- ## No data changes
--
-- Constraint-only, like `0045` and `0046`. No column is added, no row is written, and every
-- existing target row satisfies the replacements — but `ADD CONSTRAINT ... FOREIGN KEY`
-- validates against every existing row on a populated table, so that claim is reasoning until
-- `per-provider-targeting-migration.integration.test.ts` proves it against real preceding rows.
-- ===========================================================================================

ALTER TABLE "farmer_target_contexts"
  DROP CONSTRAINT IF EXISTS "farmer_target_contexts_selected_location_own_seller_fk";
--> statement-breakpoint
ALTER TABLE "farmer_target_menu_options"
  DROP CONSTRAINT IF EXISTS "farmer_target_menu_options_location_own_seller_fk";
--> statement-breakpoint

ALTER TABLE "farmer_target_contexts"
  DROP CONSTRAINT IF EXISTS "farmer_target_contexts_selected_authorization_owner_fk";
--> statement-breakpoint
ALTER TABLE "farmer_target_menu_options"
  DROP CONSTRAINT IF EXISTS "farmer_target_menu_options_authorization_owner_fk";
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "farmer_target_contexts"
    ADD CONSTRAINT "farmer_target_contexts_selected_authorization_fk"
    FOREIGN KEY ("selected_authorization_id")
    REFERENCES "public"."farmer_authorizations"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "farmer_target_menu_options"
    ADD CONSTRAINT "farmer_target_menu_options_authorization_fk"
    FOREIGN KEY ("authorization_id")
    REFERENCES "public"."farmer_authorizations"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- The seller a target names is the PROVIDER'S seller. `0045`'s substitution, on the two
-- targeting tables: the relationship decides whose goods these are, not the self-pointer.
DO $$ BEGIN
  ALTER TABLE "farmer_target_contexts"
    ADD CONSTRAINT "farmer_target_contexts_selected_provider_seller_fk"
    FOREIGN KEY ("selected_provider_id", "selected_owner_seller_id")
    REFERENCES "public"."stand_providers"("id", "seller_id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "farmer_target_menu_options"
    ADD CONSTRAINT "farmer_target_menu_options_provider_seller_fk"
    FOREIGN KEY ("provider_id", "owner_seller_id")
    REFERENCES "public"."stand_providers"("id", "seller_id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- The standing link, third in the chain — and it carries BOTH shapes, like the two targeting
-- tables. `restrict` throughout, matching what each replaces: a link is a live credential, so
-- the authorization behind it is not deleted out from under it.
ALTER TABLE "farmer_links"
  DROP CONSTRAINT IF EXISTS "farmer_links_targeted_authorization_owner_fk";
--> statement-breakpoint
ALTER TABLE "farmer_links"
  DROP CONSTRAINT IF EXISTS "farmer_links_targeted_location_own_seller_fk";
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "farmer_links"
    ADD CONSTRAINT "farmer_links_targeted_authorization_fk"
    FOREIGN KEY ("authorization_id")
    REFERENCES "public"."farmer_authorizations"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "farmer_links"
    ADD CONSTRAINT "farmer_links_targeted_provider_seller_fk"
    FOREIGN KEY ("provider_id", "owner_seller_id")
    REFERENCES "public"."stand_providers"("id", "seller_id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
