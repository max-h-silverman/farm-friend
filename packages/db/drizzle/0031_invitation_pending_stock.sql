-- F-090 — what is in the stand RIGHT NOW, stated during onboarding and held until `START`.
--
-- The onboarding form now asks two questions about items: the standing mix ("we usually sell
-- eggs") and today's confirmed stock ("eggs are on the table right now"). F-066 keeps those two
-- as different facts, and only the first had a farmer-facing writer — the second is a DATED
-- confirmation, and this is where the one stated at onboarding waits.
--
-- ## Why it waits
--
-- max's first instinct was to publish it at submit (2026-08-08). Shown that this puts a dated
-- public claim behind a phone nobody has proved yet, he chose to hold it instead.
--
-- The distinction is the whole reason this column exists. A listing is a standing description a
-- farmer may correct at leisure; a dated confirmation is Farm Friend telling the island "someone
-- who holds this farm's handset says this was true today". The invitation link proves VIGA sent
-- something to somebody. Only the inbound `START` proves who is holding the phone — and until
-- something proves that, there is nobody to attribute a dated claim to.
--
-- So the text sits here, invisible to every public reader, and `openFarmerOnboardingRequest`
-- publishes it in the SAME transaction that mints the authorization and the approval. An
-- invitation that is never redeemed leaves no public claim at all, which is exactly right: the
-- farmer never finished setting up.
--
-- ## Why the payload and not a second entries table
--
-- `inventory_entries` rows hang off a revision, and a revision cannot exist before the farm is
-- approved and the farmer authorized — both of which happen at redemption. Pre-creating any of
-- it would mean fabricating the keys `inventory_revisions_source_keys_coherent` exists to
-- demand honestly (F-063's reasoning, one table over).
--
-- ## `web` — a THIRD provenance, and why the existing two do not fit
--
-- A dated stock claim could previously come from two places, and the schema demanded the
-- evidence for each: `sms` names a proposal, an authorization, and a farm approval — the
-- handset chain, where the proposal carries the token the farmer texted back. `viga` names none
-- of them, because a spreadsheet has no handset.
--
-- Stock stated at onboarding is neither. The FARMER stated it, and their `START` proved they
-- hold the phone — so calling it `viga` would credit VIGA with a claim a farmer made. But there
-- was never a confirmation exchange: no prompt went out, no `YES` came back. Recording it as
-- `sms` would require `consumed_token = 'yes'` and a consumption event id naming an inbound
-- message the farmer never sent — inventing the exact evidence the constraint exists to demand.
--
-- So the honest answer is a third value with its own key rule (max's call, 2026-08-08):
--
--   'sms'  → proposal + authorization + approval   (texted in, confirmed by reply)
--   'web'  → authorization + approval, NO proposal (stated on the form, handset proved by START)
--   'viga' → none                                  (VIGA's records say so)
--
-- `web` is deliberately as strong as `sms` on the two keys that answer "who stands behind
-- this": a farmer who published it, and a farm VIGA approved. It differs only in lacking the
-- one thing that genuinely did not happen.

ALTER TABLE "farmer_invitations" ADD COLUMN "pending_stock" jsonb;--> statement-breakpoint

-- A held stock statement is a non-empty ARRAY of entries. NULL is "the farmer said nothing
-- about today", which is a real and common answer — the form does not require it.
--
-- Stated as a type-and-shape check rather than trusting the writer: this column is composed
-- into a publication that reaches the public map, and an empty array would publish a revision
-- claiming the stand was confirmed EMPTY when the farmer simply skipped the question. Those are
-- opposite facts. A CHECK passes on NULL, so unstated stays legal.
ALTER TABLE "farmer_invitations"
	ADD CONSTRAINT "farmer_invitations_pending_stock_shape"
	CHECK (
		"pending_stock" IS NULL
		OR (
			jsonb_typeof("pending_stock") = 'array'
			AND jsonb_array_length("pending_stock") > 0
		)
	);--> statement-breakpoint

-- Held stock is meaningless without a farm to publish it against and a phone to attribute it
-- to. The invitation paths that carry neither — a bare new-farm invitation — must never hold
-- one, or redemption would reach a payload it has nowhere to put.
--
-- `pending_phone_hash` is what an inbound START matches on; without it nothing would ever
-- publish this and it would sit forever as a claim that never lands.
ALTER TABLE "farmer_invitations"
	ADD CONSTRAINT "farmer_invitations_pending_stock_needs_target"
	CHECK (
		"pending_stock" IS NULL
		OR ("farm_id" IS NOT NULL AND "pending_phone_hash" IS NOT NULL)
	);--> statement-breakpoint

-- The third provenance, added by RECREATING the type rather than `ALTER TYPE … ADD VALUE`.
--
-- This is 0001's lesson and it is not optional: PostgreSQL cannot use a newly added enum value
-- in the transaction that added it, and the Drizzle migrator runs every pending migration
-- inside ONE transaction. `ADD VALUE` would apply cleanly and then fail the moment the new
-- CHECK below names 'web' — in the same run, on a fresh database.
--
-- The old constraint references the old type, so it is dropped first and reinstated below in
-- its three-way form.
ALTER TABLE "inventory_revisions"
	DROP CONSTRAINT "inventory_revisions_source_keys_coherent";--> statement-breakpoint

CREATE TYPE "public"."inventory_revision_source_next" AS ENUM('sms', 'web', 'viga');--> statement-breakpoint

ALTER TABLE "inventory_revisions"
	ALTER COLUMN "source" TYPE "public"."inventory_revision_source_next"
	USING "source"::text::"public"."inventory_revision_source_next";--> statement-breakpoint

DROP TYPE "public"."inventory_revision_source";--> statement-breakpoint

ALTER TYPE "public"."inventory_revision_source_next"
	RENAME TO "inventory_revision_source";--> statement-breakpoint

-- The key rule, restated to cover all three.
--
-- Still ONE constraint over all four columns rather than per-column rules, for the reason the
-- original states: a CHECK PASSES on NULL, so independent rules would silently admit the
-- half-populated row this exists to refuse.
ALTER TABLE "inventory_revisions"
	ADD CONSTRAINT "inventory_revisions_source_keys_coherent"
	CHECK (
		(
			"source" = 'sms'
			AND "proposal_id" IS NOT NULL
			AND "published_by_authorization_id" IS NOT NULL
			AND "farm_approval_id" IS NOT NULL
		)
		OR (
			-- Stated on the onboarding form, published when START proved the handset. As strong
			-- as 'sms' on who stands behind it; no proposal, because no confirmation exchange
			-- ever happened. `proposal_id` IS NULL is asserted, not merely unmentioned — an
			-- unstated column here would let a 'web' row carry a proposal it has no business
			-- naming.
			"source" = 'web'
			AND "proposal_id" IS NULL
			AND "published_by_authorization_id" IS NOT NULL
			AND "farm_approval_id" IS NOT NULL
		)
		OR (
			"source" = 'viga'
			AND "proposal_id" IS NULL
			AND "published_by_authorization_id" IS NULL
			AND "farm_approval_id" IS NULL
		)
	);
