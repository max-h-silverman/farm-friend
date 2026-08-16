-- ===========================================================================================
-- F-114 Phase C.2 / B-077 — THE CLOSURE WRITER'S STAND ARM.
--
-- `closure_revisions` had `owner_seller_id`, `owner_authorization_id` and `owner_approval_id`
-- all NOT NULL and all routed through the stand's self-pointer. Morgan Hill Community Stand has
-- no seller of its own, so it could hold none of them: **a venue could not record a closure at
-- all** — and "the stand is shut" is the one fact a venue's manager most needs to state.
--
-- §there is no second permission system already says the two tables carrying stand-level facts
-- pair against the authorization's STAND arm. `sales_location_participants` is retired
-- display-only history and needs nothing. This is the other one.
--
-- ## Two arms, mirroring the authorization's own — not a nullable column
--
-- C.1 filed this rather than half-building it, because widening a column without the writer
-- leaves a nullable column no code can produce and no constraint can characterize. The arms are:
--
--   * **The seller arm** — a stand with a seller of its own. `owner_seller_id` names it and
--     `owner_approval_id` names VIGA's approval OF that seller. Every closure in production.
--   * **The stand arm** — a venue. BOTH are NULL. There is no seller to name, and therefore no
--     seller-approval either: VIGA's approval gates whether a SELLER may be public, and a venue
--     sells nothing. Requiring one would re-invent exactly the fabricated seller C.0 removed.
--
-- `owner_authorization_id` stays NOT NULL in both arms. A closure always has a person behind it;
-- which arm they hold does not change that. The stand arm drops the SELLER, never the person.
--
-- ## The two rules that keep the arms honest
--
-- **`closure_revisions_owner_arm`** — seller and approval are named together or not at all,
-- written as a BICONDITIONAL because a CHECK PASSES on NULL. Both directions are real failures:
-- a seller without its approval publishes a closure VIGA never approved that seller for, and an
-- approval without its seller files one under nobody named on the row.
--
-- **`closure_revisions_arm_matches_stand`** — the arm is determined by the STAND, never chosen.
-- Without this, a stand that has a seller of its own could file a stand-armed closure and skip
-- the approval gate entirely: the venue's arm would become an escape hatch for all 38 stands.
-- The rule is `(owner_seller_id is null) = (the stand's own_seller_id is null)`, and it cannot be
-- a CHECK because it reads another table — so it is a trigger, which is also how
-- `sales_locations_create_own_seller_provider` states a cross-table invariant on this schema.
--
-- The existing composite key `closure_revisions_location_own_seller_fk` still does the rest: when
-- a seller IS named it must be the stand's own. A NULL never matches a composite foreign key, so
-- the stand arm passes it without weakening it for the seller arm.
--
-- ## Migration safety
--
-- Dropping NOT NULL cannot fail on data and rewrites nothing: every existing row names all three
-- columns and stays valid under both new rules. That is the claim the populated-schema test
-- proves rather than assumes — a CHECK added to a populated table VALIDATES against every row,
-- so a rule written the wrong way round fails in production having passed on every empty
-- database in the repo.
--
-- Every statement is guarded; the suite applies each file TWICE and requires a no-op.
-- ===========================================================================================

-- ---- 0. a venue's closure-only proposal names no provider -------------------------------------
-- `inventory_publication_proposals.provider_id` is what binds a confirmation token to the listing
-- the farmer was shown (Phase B item 6). A venue's closure has no listing: Morgan Hill has no
-- provider of its own, and naming one of its hosted sellers' would bind the token to goods the
-- closure is not about — and would let that seller's YES publish the venue's shutter.
--
-- So the token binds to the STAND in that one case, which is the same two-arm shape the closure
-- row itself takes. `inventory_proposals_provider_arm` keeps it to exactly that case: the column
-- may be NULL only for a closure-only proposal, and `has_inventory` already tells us which.
--
-- The composite key beside it is unaffected — a NULL never matches a composite foreign key, so
-- the arm passes it without weakening it for every other proposal.
ALTER TABLE "inventory_publication_proposals"
  ALTER COLUMN "provider_id" DROP NOT NULL;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_proposals_provider_arm'
  ) THEN
    ALTER TABLE "inventory_publication_proposals"
      ADD CONSTRAINT "inventory_proposals_provider_arm"
      CHECK ("provider_id" IS NOT NULL OR "has_inventory" = false);
  END IF;
END $$;--> statement-breakpoint

-- ---- 1. the seller and its approval become optional ------------------------------------------
-- Optional, never free: statement 2 requires them together and statement 3 decides which arm the
-- row must take. Neither column is nullable in the sense of "may be absent for any reason".
ALTER TABLE "closure_revisions"
  ALTER COLUMN "owner_seller_id" DROP NOT NULL;--> statement-breakpoint

ALTER TABLE "closure_revisions"
  ALTER COLUMN "owner_approval_id" DROP NOT NULL;--> statement-breakpoint

-- ---- 2. the two travel together ---------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'closure_revisions_owner_arm'
  ) THEN
    ALTER TABLE "closure_revisions"
      ADD CONSTRAINT "closure_revisions_owner_arm"
      CHECK (("owner_seller_id" IS NULL) = ("owner_approval_id" IS NULL));
  END IF;
END $$;--> statement-breakpoint

-- ---- 3. the stand decides which arm ------------------------------------------------------------
-- A trigger rather than a CHECK, because the rule reads `sales_locations.own_seller_id`. Stated
-- once here so no writer has to remember it, which is the same reasoning that made the own-seller
-- provider a trigger in `0042`: the number of writers that must get this right is zero.
CREATE OR REPLACE FUNCTION guard_closure_revision_arm() RETURNS trigger AS $$
DECLARE
  stand_own_seller uuid;
BEGIN
  SELECT own_seller_id INTO stand_own_seller
  FROM sales_locations WHERE id = NEW.sales_location_id;

  IF (NEW.owner_seller_id IS NULL) <> (stand_own_seller IS NULL) THEN
    RAISE EXCEPTION
      'closure_revisions_arm_matches_stand: a closure names the stand''s own seller when it has one, and neither seller nor approval when it does not'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS closure_revisions_guard_arm ON "closure_revisions";--> statement-breakpoint

CREATE TRIGGER closure_revisions_guard_arm
  BEFORE INSERT OR UPDATE ON "closure_revisions"
  FOR EACH ROW EXECUTE FUNCTION guard_closure_revision_arm();
