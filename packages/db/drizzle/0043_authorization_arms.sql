-- ===========================================================================================
-- F-114 Phase C.1 (records) — THE TWO ARMS OF AN AUTHORIZATION, AND THE HOST STOCK RIGHT.
--
-- Two records C.1's behavior needs, and nothing else. Invitation, per-provider publication, the
-- seller list, and the item-first cards are the sub-phases that follow; each of them writes
-- against the shape this file settles.
--
-- ## An authorization names what it is for: a seller, or a stand
--
-- **There is no second permission system, and no "grant"** (§there is no second permission
-- system, decided by Max 2026-08-15). A phone authorized for a seller is the whole permission
-- mechanism and it already exists here. "Stand owner" is not a role — it is what being authorized
-- for the seller a stand points at already gets you, derived through the self-pointer at read
-- time and never stored.
--
-- The stand arm exists for exactly one case the seller arm cannot express: a stand with NO seller
-- of its own. Morgan Hill Community Stand is a venue with four nested sellers and none of its
-- own, so its hours, closure, description, and who sells there can be reached through no seller
-- authorization, because there is no seller to name.
--
-- Measured 2026-08-15: no phone has ever been authorized for Morgan Hill and its one inventory
-- revision has `source = 'viga'`. **That is a transitional state, not a permanent one** — VIGA is
-- mid-migration from the old system and Morgan Hill will have people managing it. An earlier
-- draft read it the other way and concluded no such role exists; designing around a
-- farmer-migration artifact is the mistake §customer behavior already warns against.
--
-- The split is already in the data. TWO tables carry stand-level facts written by an
-- authorization (`closure_revisions`, `sales_location_participants`) and SEVEN carry seller-level
-- ones. The seven keep their composite keys onto `(authorization, seller)` untouched, and a
-- stand-armed authorization has NULL there, so it cannot satisfy them — which is correct: a
-- person managing a venue is not thereby authorized for anyone's goods.
--
-- ## The host stock right belongs to the relationship, not to the stand or the role
--
-- **A stand-level authorization does not confer inventory rights over other sellers by default —
-- but the relationship may carry them, at the seller's option** (max, 2026-08-15).
--
-- Some hosted sellers want the host restocking on their behalf: a baker who drops off at dawn and
-- would rather the host mark the last loaf gone than be texted about it. Zoe at Venison Valley
-- specifically does not. Both are legitimate, so the `stand_providers` row that binds a seller to
-- a stand carries whether that seller's stock may be updated by the stand's own authorized
-- phones.
--
-- Two things it must not become:
--
--   - **Not a default.** An invitation that silently conferred stock rights would make acceptance
--     mean more than it says, which §hosting and approval lifecycle forbids. Hence `false`, both
--     as the column default and as the backfill for all 38 stands.
--   - **Not a general permission.** It covers current stock only. A host may never change a
--     hosted seller's identity, prices, payment, pause, or participation — those need separate
--     authorization for that seller, and §facts and authority is unchanged.
--
-- It is also distinct from the observation right §facts and authority already grants: marking an
-- item sold out is a physical observation of an empty cooler, available to a stand owner
-- regardless. What this optionally adds is the ability to STATE STOCK, which is a claim about
-- someone else's goods and therefore theirs to permit.
--
-- ## What this file deliberately does NOT do
--
-- `closure_revisions` stays seller-rooted. Its `owner_seller_id`, `owner_authorization_id`, and
-- `owner_approval_id` are all NOT NULL and route through the self-pointer, so a venue cannot
-- record a closure at all — a real gap, and one that needs the closure WRITER to grow a stand arm
-- rather than the column alone. That is owner-only stand closure, the next sub-phase's work, and
-- widening the column here without the writer would leave a nullable column no code can produce.
--
-- Every statement is guarded. The integration suite applies each file TWICE and requires the
-- second run to be a no-op; `ALTER TABLE … DROP NOT NULL` is idempotent on its own, but
-- `ADD CONSTRAINT` and `CREATE INDEX` are not.
-- ===========================================================================================

-- ---- 1. the stand arm ----------------------------------------------------------------------
-- Added NULLABLE, which is the whole point: it is one of two arms, and the arm not taken is NULL.
-- `restrict` rather than `cascade`, matching `seller_id` beside it — an authorization is a record
-- of who was permitted to act, and a deleted stand must not silently erase that history. VIGA
-- retires stands rather than deleting them (F-071), so this refuses only what should be refused.
ALTER TABLE "farmer_authorizations"
  ADD COLUMN IF NOT EXISTS "sales_location_id" uuid;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'farmer_authorizations_stand_fk'
  ) THEN
    ALTER TABLE "farmer_authorizations"
      ADD CONSTRAINT "farmer_authorizations_stand_fk"
      FOREIGN KEY ("sales_location_id") REFERENCES "sales_locations"("id") ON DELETE RESTRICT;
  END IF;
END $$;--> statement-breakpoint

-- `seller_id` becomes nullable so the stand arm can be taken. This cannot fail on any data, which
-- is exactly why the populated-schema test asserts every existing row still names its seller: a
-- migration that nulled one would be just as green as this one.
ALTER TABLE "farmer_authorizations"
  ALTER COLUMN "seller_id" DROP NOT NULL;--> statement-breakpoint

-- ---- 2. exactly one arm, always ------------------------------------------------------------
-- A BICONDITIONAL, not two independent NULL tests, for the reason the schema states everywhere:
-- **a CHECK PASSES on NULL.** "A seller is named" evaluates to NULL on the row that omits it and
-- NULL is not false, so the row is admitted. Both directions have to be refused:
--
--   - BOTH named — the row would satisfy composite keys on both sides at once, so a seller-level
--     fact could be filed by a stand-armed authorization, and "what is this for" would have two
--     answers.
--   - NEITHER named — an authorization for nothing. No reader would raise: each joins on a
--     subject, so the row simply never matches and the person cannot act with nothing saying why.
--
-- `(a is null) <> (b is null)` says exactly "one of them, never both, never neither".
--
-- Added VALID (the default), so Postgres checks all 14 live rows as it runs. `NOT VALID` would
-- pass every insert test in the suite while live data violated it — which is why the migration
-- test asks `pg_constraint.convalidated` directly rather than inferring it from an insert.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'farmer_authorizations_subject_arm'
  ) THEN
    ALTER TABLE "farmer_authorizations"
      ADD CONSTRAINT "farmer_authorizations_subject_arm"
      CHECK (("seller_id" IS NULL) <> ("sales_location_id" IS NULL));
  END IF;
END $$;--> statement-breakpoint

-- ---- 3. one live authorization per contact per stand ----------------------------------------
-- The stand arm needs its OWN uniqueness. `farmer_authorizations_one_active_contact_per_seller` is
-- keyed on `(seller_id, contact_id)`, and every stand-armed row has `seller_id` NULL — NULLs
-- never collide in a unique index, so without this a person could hold five live authorizations
-- for one venue and the revoke path would have to find them all.
--
-- Partial on `revoked_at is null`, matching its sibling exactly: a farmer removed and later
-- restored is an ordinary event, and an index that refused it would make revocation permanent.
CREATE UNIQUE INDEX IF NOT EXISTS "farmer_authorizations_one_active_contact_per_stand"
  ON "farmer_authorizations" ("sales_location_id", "contact_id")
  WHERE "revoked_at" IS NULL;--> statement-breakpoint

-- ---- 4. the host stock right ----------------------------------------------------------------
-- `false` as the column default AND as the backfill for every existing row. The default is the
-- product decision, not a convenience: an invitation must never silently confer more than it
-- says. For a stand's OWN seller the value is meaningless anyway — the host and the seller are
-- the same party — so `false` there asserts nothing false either.
--
-- NOT NULL because the column is two-state, not three. An `unknown` would force every stock
-- writer to decide what silence means, and the answer would be "no" at every one of them; a case
-- that can only be got wrong is better expressed once, here.
ALTER TABLE "stand_providers"
  ADD COLUMN IF NOT EXISTS "host_may_update_stock" boolean NOT NULL DEFAULT false;
