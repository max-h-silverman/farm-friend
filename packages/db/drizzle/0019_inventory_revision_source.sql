-- F-063 — record VIGA-sourced inventory facts without fabricating an authorization.
--
-- Until now every `inventory_revisions` row asserted a specific authorized handset sent a
-- specific message: `proposal_id`, `published_by_authorization_id`, and `farm_approval_id`
-- were all NOT NULL. VIGA's own records — the launch import, the weekly stock form, a later
-- admin edit — have none of those. Fabricating them was rejected: it writes a false statement
-- about an identifiable person, and at inception it would make the ENTIRE founding corpus
-- permanently indistinguishable from farmer-authored data.
--
-- So provenance becomes explicit. `source` says who the fact came from, and a CHECK makes the
-- two shapes mutually exclusive at the database level:
--
--   'sms'  → all three keys REQUIRED   (what was previously convention is now enforced)
--   'viga' → all three NULL            (no handset, no message, no approval)
--
-- `farm_approval_id` joins the other two because approval is the ONBOARDING step: it happens
-- when a farmer joins, which is strictly after the launch import (F-064 runs before any farmer
-- onboards). At import time no farm in the corpus has an approval row to point at.
--
-- Backfill is 'sms' because every row that exists today arrived through the confirmation
-- transaction, which supplies all three keys. The column is then made NOT NULL, so no future
-- row can omit its provenance.

CREATE TYPE "inventory_revision_source" AS ENUM ('sms', 'viga');--> statement-breakpoint

-- Backfilled by DEFAULT, deliberately, and NOT by a follow-up UPDATE.
--
-- `inventory_revisions_guard_history` is a BEFORE UPDATE trigger that permits exactly one
-- update shape — superseding a current revision — and raises on everything else. A
-- `UPDATE ... SET source = 'sms'` therefore ABORTS on any table holding a current revision,
-- which is every real database including production. `ADD COLUMN ... DEFAULT` fills existing
-- rows as part of the DDL without firing row-level update triggers.
--
-- The default is then DROPPED: it exists only to carry the backfill. Leaving it would let a
-- future writer omit `source` and silently be recorded as a farmer's SMS confirmation, which
-- is precisely the false statement this whole feature exists to prevent.
ALTER TABLE "inventory_revisions"
	ADD COLUMN "source" "inventory_revision_source" NOT NULL DEFAULT 'sms';--> statement-breakpoint

ALTER TABLE "inventory_revisions"
	ALTER COLUMN "source" DROP DEFAULT;--> statement-breakpoint

ALTER TABLE "inventory_revisions"
	ALTER COLUMN "proposal_id" DROP NOT NULL;--> statement-breakpoint

ALTER TABLE "inventory_revisions"
	ALTER COLUMN "published_by_authorization_id" DROP NOT NULL;--> statement-breakpoint

ALTER TABLE "inventory_revisions"
	ALTER COLUMN "farm_approval_id" DROP NOT NULL;--> statement-breakpoint

-- The guarantee. Stated as a full biconditional over all three keys rather than as three
-- independent NULL tests: a CHECK *passes* on NULL, so a per-column rule would silently admit
-- exactly the half-populated rows this exists to refuse.
ALTER TABLE "inventory_revisions"
	ADD CONSTRAINT "inventory_revisions_source_keys_coherent"
	CHECK (
		(
			"inventory_revisions"."source" = 'sms'
			AND "inventory_revisions"."proposal_id" IS NOT NULL
			AND "inventory_revisions"."published_by_authorization_id" IS NOT NULL
			AND "inventory_revisions"."farm_approval_id" IS NOT NULL
		)
		OR (
			"inventory_revisions"."source" = 'viga'
			AND "inventory_revisions"."proposal_id" IS NULL
			AND "inventory_revisions"."published_by_authorization_id" IS NULL
			AND "inventory_revisions"."farm_approval_id" IS NULL
		)
	);
