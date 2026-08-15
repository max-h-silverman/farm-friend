-- ===========================================================================================
-- F-114 Phase C.1 (invitation) — BINDING AN INVITATION TO THE RELATIONSHIP IT ACCEPTS.
--
-- One nullable reference and the two constraints that make it unabusable. Nothing else: this is
-- the last record C.1's invitation flow needs, and per-provider publication, the seller list and
-- the item-first cards are the sub-phases that follow.
--
-- ## Why the hosting invitation IS the farmer invitation
--
-- §there is no second permission system already cut the "access grant" an earlier framing of C.1
-- was going to build: the permission that follows acceptance is an ORDINARY farmer authorization
-- for the seller who accepted. The same reasoning applies one level up.
--
-- `farmer_invitations` already names a seller, holds the handset a redemption must arrive from,
-- carries the SMS agreement, and — on a bare `START` — mints the authorization and the approval in
-- one transaction. That is invitation and acceptance, built, tested, and in production. A hosted
-- seller needs no second lifecycle beside it; what it needs is for that redemption to also say
-- WHICH pending relationship it accepts.
--
-- Hence one column. The alternative — a `hosting_invitations` table with its own token, its own
-- expiry, its own redemption path and its own consent story — would be a second mechanism doing
-- one mechanism's job, and every rule the first one enforces would have to be restated and kept
-- in step. The zen desk forbids exactly that.
--
-- ## The two rules this file adds, and what each refuses
--
-- **A provider-bound invitation must name its seller.** `seller_id` stays nullable because a plain
-- invitation may start onboarding a farm Farm Friend has never heard of. A HOSTING invitation
-- cannot: it is the acceptance of a specific seller's participation, and a row binding a provider
-- while naming no seller would redeem straight into `authorizeInvitedFarmerIn`'s "nothing to
-- authorize" branch — the invitation spent, the farmer consented, and the relationship still
-- pending with nothing saying why. Written as a one-directional implication ON PURPOSE: the
-- converse is legitimate and is what all 39 existing invitations look like.
--
-- **The invitation's seller is the provider's seller.** A composite foreign key, so "this
-- invitation accepts a relationship belonging to the seller it authorizes for" is a database
-- guarantee rather than a check some future caller might skip. Without it a typo could invite Zoe
-- to accept Gracie's Greens' participation while authorizing her for Venison Valley — the
-- fabricated authority §migration approach forbids, reached by accident instead of by inference.
-- Same shape as `stand_providers_id_location_unique`, which already does this for the stand.
--
-- **One live invitation per pending relationship.** Two unredeemed invitations for one provider row
-- would let two handsets each accept the same relationship; the second would find it already
-- `active` and have no honest answer. Partial on unredeemed so a lapsed invitation is reissuable,
-- which is the ordinary case — most invitations are never redeemed at all.
--
-- Every statement is guarded. The integration suite applies each file TWICE and requires the
-- second run to be a no-op; `ADD CONSTRAINT` and `CREATE INDEX` are not idempotent on their own.
-- ===========================================================================================

-- ---- 1. the composite key's target ----------------------------------------------------------
-- `stand_providers` already carries `(id, sales_location_id)` for exactly this purpose. The seller
-- pair is its sibling, and it is a plain UNIQUE rather than a unique index because a composite
-- foreign key can only reference a constraint.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stand_providers_id_seller_unique'
  ) THEN
    ALTER TABLE "stand_providers"
      ADD CONSTRAINT "stand_providers_id_seller_unique" UNIQUE ("id", "seller_id");
  END IF;
END $$;--> statement-breakpoint

-- ---- 2. the relationship an invitation accepts ----------------------------------------------
-- NULL on every existing row and on every ordinary invitation: this names a HOSTING invitation and
-- nothing else.
ALTER TABLE "farmer_invitations"
  ADD COLUMN IF NOT EXISTS "stand_provider_id" uuid;--> statement-breakpoint

-- `restrict`, matching `seller_id` beside it. An invitation is the record of an offer that was
-- made; a deleted provider row must not silently erase it. VIGA retires rather than deletes.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'farmer_invitations_provider_seller_fk'
  ) THEN
    ALTER TABLE "farmer_invitations"
      ADD CONSTRAINT "farmer_invitations_provider_seller_fk"
      FOREIGN KEY ("stand_provider_id", "seller_id")
      REFERENCES "stand_providers"("id", "seller_id") ON DELETE RESTRICT;
  END IF;
END $$;--> statement-breakpoint

-- ---- 3. a hosting invitation names its seller ------------------------------------------------
-- Deliberately NOT a biconditional. The usual reason for one is that a CHECK passes on NULL and
-- both directions are real failures; here only one is. `stand_provider_id is not null` implies
-- `seller_id is not null`, and the converse — a seller with no provider — is the shape every
-- invitation in production already has.
--
-- Added VALID (the default), so Postgres checks all 39 live rows as it runs. `NOT VALID` would
-- pass every insert test in the suite while live data violated it.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'farmer_invitations_hosting_names_seller'
  ) THEN
    ALTER TABLE "farmer_invitations"
      ADD CONSTRAINT "farmer_invitations_hosting_names_seller"
      CHECK ("stand_provider_id" IS NULL OR "seller_id" IS NOT NULL);
  END IF;
END $$;--> statement-breakpoint

-- ---- 4. one open invitation per pending relationship -----------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "farmer_invitations_one_open_per_provider"
  ON "farmer_invitations" ("stand_provider_id")
  WHERE "redeemed_at" IS NULL AND "stand_provider_id" IS NOT NULL;--> statement-breakpoint

-- ---- 5. who vouched, when it was not VIGA ----------------------------------------------------
-- §hosting and approval lifecycle: *VIGA approval is required before a seller appears publicly. A
-- VIGA invitation counts as approval. An already approved stand owner may vouch for a hosted
-- seller; the approval records that provenance, and VIGA may revoke the seller globally.*
--
-- `stand_providers` already carries the answer — `approval_source` and
-- `approved_by_authorization_id`. What it cannot carry is the answer BEFORE the seller accepts:
-- `stand_providers_hosting_lifecycle_coherent` refuses an approval on a `pending` row, and
-- rightly, because approving a relationship nobody has accepted would publish a seller who never
-- agreed to be there. So the vouch waits on the invitation and is applied at acceptance, in the
-- same transaction, exactly as `pending_stock` and `pending_prompt_cadence` already do for facts
-- that cannot legally exist until the authorization does.
--
-- NULL means VIGA issued it, and `created_by_administrator_id` is then the actor. That is the
-- SAME pair `farmer_invitations_self_issued_names_farm` already reasons about, and the CHECK below
-- keeps them from both being empty on a hosting invitation — a relationship approved by nobody
-- would go public with no one accountable for it, which is the fabricated authority §migration
-- approach forbids.
ALTER TABLE "farmer_invitations"
  ADD COLUMN IF NOT EXISTS "invited_by_authorization_id" uuid;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'farmer_invitations_vouching_authorization_fk'
  ) THEN
    ALTER TABLE "farmer_invitations"
      ADD CONSTRAINT "farmer_invitations_vouching_authorization_fk"
      FOREIGN KEY ("invited_by_authorization_id")
      REFERENCES "farmer_authorizations"("id") ON DELETE RESTRICT;
  END IF;
END $$;--> statement-breakpoint

-- A hosting invitation has EXACTLY ONE issuer, and a vouch belongs only to a hosting invitation.
--
-- A BICONDITIONAL here, unlike rule 3, because both directions are real failures:
--
--   - A hosting invitation with NEITHER issuer would accept into a provider row that can name no
--     approver, and `stand_providers_hosting_lifecycle_coherent` would refuse the activation —
--     the invitation spent and the farmer stuck, discovered only at redemption.
--   - A hosting invitation with BOTH would have two answers to "who approved this", and the
--     acceptance writer would have to pick one, which is the guess code must never make.
--   - A vouch on a NON-hosting invitation is an approval of no relationship at all.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'farmer_invitations_hosting_issuer'
  ) THEN
    ALTER TABLE "farmer_invitations"
      ADD CONSTRAINT "farmer_invitations_hosting_issuer"
      CHECK (
        CASE
          WHEN "stand_provider_id" IS NOT NULL
            THEN ("created_by_administrator_id" IS NULL)
              <> ("invited_by_authorization_id" IS NULL)
          ELSE "invited_by_authorization_id" IS NULL
        END
      );
  END IF;
END $$;
