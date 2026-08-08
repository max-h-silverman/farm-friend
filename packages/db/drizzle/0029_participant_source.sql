-- F-064 — record VIGA-sourced participant names without fabricating an authorization.
--
-- The map export states host farms as prose — "Hosting: Kareli Farm" — for 7 stands, and the
-- weekly form asks the question as its own column. The public card already renders an "Also
-- selling here" section and the admin table an "Other sellers here" row, so the reader has
-- existed all along; only the writer was missing, and `sales_location_participants` seeded
-- empty at launch.
--
-- It could not be written, because every row asserted a specific authorized handset confirmed
-- the list: `confirmed_by_authorization_id` was NOT NULL with a foreign key to the owning
-- farm's authorization. A spreadsheet has no handset behind it.
--
-- This is the SAME problem F-063 settled for `inventory_revisions`, so it takes the same shape
-- rather than a second bespoke one. Fabricating an authorization is rejected for the same
-- reason it was there: it writes a false statement about an identifiable person, and at
-- inception it would make the founding corpus indistinguishable from farmer-confirmed data at
-- exactly the moment farmers are asked to trust the system.
--
--   'sms'  → confirmed_by_authorization_id REQUIRED   (the farmer confirmed this list)
--   'viga' → confirmed_by_authorization_id NULL       (VIGA's records say so)
--
-- Retirement keeps its own separate rule and is deliberately NOT folded in: a row may be
-- retired by an authorization regardless of how it was confirmed, which is exactly the
-- migration path — a farmer takes ownership of a VIGA-seeded list by editing it. The existing
-- `retired_at`/`retired_by_authorization_id` pairing is untouched.

CREATE TYPE "participant_source" AS ENUM ('sms', 'viga');--> statement-breakpoint

-- Backfilled by DEFAULT rather than a follow-up UPDATE, matching 0019: filling existing rows as
-- part of the DDL avoids firing row-level triggers. The default is then dropped, so no future
-- writer can omit its provenance and be silently recorded as a farmer's own confirmation —
-- precisely the false statement this exists to prevent.
ALTER TABLE "sales_location_participants"
	ADD COLUMN "source" "participant_source" NOT NULL DEFAULT 'sms';--> statement-breakpoint

ALTER TABLE "sales_location_participants"
	ALTER COLUMN "source" DROP DEFAULT;--> statement-breakpoint

ALTER TABLE "sales_location_participants"
	ALTER COLUMN "confirmed_by_authorization_id" DROP NOT NULL;--> statement-breakpoint

-- Stated as a biconditional over the key rather than as an independent NULL test, because a
-- CHECK *passes* on NULL: `source = 'sms'` with a null key would otherwise be admitted.
ALTER TABLE "sales_location_participants"
	ADD CONSTRAINT "sales_location_participants_source_keys_coherent"
	CHECK (
		(
			"sales_location_participants"."source" = 'sms'
			AND "sales_location_participants"."confirmed_by_authorization_id" IS NOT NULL
		)
		OR (
			"sales_location_participants"."source" = 'viga'
			AND "sales_location_participants"."confirmed_by_authorization_id" IS NULL
		)
	);
