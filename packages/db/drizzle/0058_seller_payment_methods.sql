-- F-125 — payment moves from the STAND to the SELLER, with a stand-level override that narrows.
--
-- Hand-edited after generation. `drizzle-kit` emitted the create/drop pair with NO backfill
-- between them, which would have destroyed all 86 production payment rows and every Farm Bucks
-- answer. It also omits CHECK constraints entirely (this repo hand-appends them; see RUNBOOK
-- §Migrations). The order below is create → COPY → drop, so the data is already carried before
-- anything is dropped.
--
-- Measured against production before writing (43 sellers / 39 stands / 86 payment rows):
--   * every stand has an `own_seller_id` — there is no unowned row to strand;
--   * all four shared stands carry only the HOST's payment statement, so no two sellers
--     disagree and no row has to be chosen between;
--   * only two sellers sell at more than one stand, and neither had a statement of her own —
--     both stands' rows were their respective hosts'.
-- The copy is therefore a lift, not a decision.

CREATE TABLE IF NOT EXISTS "seller_payment_methods" (
	"seller_id" uuid NOT NULL,
	"method" text NOT NULL,
	CONSTRAINT "seller_payment_methods_pk" PRIMARY KEY("seller_id","method")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales_location_payment_method_exclusions" (
	"sales_location_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"method" text NOT NULL,
	CONSTRAINT "sales_location_payment_method_exclusions_pk" PRIMARY KEY("sales_location_id","seller_id","method")
);
--> statement-breakpoint
ALTER TABLE "seller_payment_methods" ADD CONSTRAINT "seller_payment_methods_method_not_blank" CHECK (length(trim("method")) > 0);--> statement-breakpoint
ALTER TABLE "sales_location_payment_method_exclusions" ADD CONSTRAINT "sales_location_payment_method_exclusions_method_not_blank" CHECK (length(trim("method")) > 0);--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "seller_payment_methods" ADD CONSTRAINT "seller_payment_methods_seller_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_location_payment_method_exclusions" ADD CONSTRAINT "sales_location_payment_exclusions_location_fk" FOREIGN KEY ("sales_location_id") REFERENCES "public"."sales_locations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_location_payment_method_exclusions" ADD CONSTRAINT "sales_location_payment_exclusions_seller_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- The Farm Bucks column lands with DEFAULT true, which is also the answer for every row that
-- never carried one (max, 2026-08-20: Farm Bucks is near-universal, so silence is nobody
-- ticking a box rather than a refusal).
ALTER TABLE "sellers" ADD COLUMN "farm_bucks_accepted" boolean DEFAULT true NOT NULL;--> statement-breakpoint

-- Carry each stand's stated methods up to the seller who owns that stand.
--
-- `on conflict do nothing` is the union: a seller owning two stands that state overlapping
-- methods keeps one row per method, and the PK is what makes that deterministic rather than
-- dependent on which stand sorted first. A seller ends up with the union of what her own stands
-- stated — never an intersection, which would silently drop a method she really takes.
INSERT INTO "seller_payment_methods" ("seller_id", "method")
SELECT l."own_seller_id", m."method"
FROM "sales_location_payment_methods" m
JOIN "sales_locations" l ON l."id" = m."sales_location_id"
WHERE l."own_seller_id" IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Carry Farm Bucks acceptance up to the owning seller.
--
-- **A refusal is copied only where one was actually REVIEWED**, which is why this reads both
-- old columns rather than `farm_bucks_accepted` alone. The dropped `farm_bucks_eligible` made
-- the old model three-state, and `accepted = false` meant two different things:
--
--   * `eligible = true,  accepted = false` — VIGA asked, the farm said no. A real refusal.
--   * `eligible = false, accepted = false` — nobody ever asked. Silence.
--
-- Reading `accepted = false` alone would turn silence into a public refusal for eleven farms.
-- Max settled the direction on 2026-08-20: Farm Bucks is near-universal among VIGA farms, so
-- silence is nobody ticking a box and those eleven land on the accepted default. Measured
-- against production at write time: 20 reviewed-accepts, 3 reviewed-refusals, 11 silent, and
-- 5 claiming acceptance with no grant (kept as acceptance — the farmer's own claim is the half
-- that survives, since the grant it lacked is the concept this migration deletes).
--
-- A seller owning two stands that disagree keeps the REFUSAL: the conservative direction for a
-- claim about money. No production seller is in that position today, so this decides nothing
-- now — it is here so a future row cannot be resolved by whichever stand sorted first.
UPDATE "sellers" s
SET "farm_bucks_accepted" = false
WHERE EXISTS (
  SELECT 1 FROM "sales_locations" l
  WHERE l."own_seller_id" = s."id"
    AND l."farm_bucks_eligible" = true
    AND l."farm_bucks_accepted" = false
);
--> statement-breakpoint

DROP TABLE "sales_location_payment_methods";--> statement-breakpoint
ALTER TABLE "sales_locations" DROP COLUMN IF EXISTS "farm_bucks_accepted";--> statement-breakpoint
ALTER TABLE "sales_locations" DROP COLUMN IF EXISTS "farm_bucks_eligible";
