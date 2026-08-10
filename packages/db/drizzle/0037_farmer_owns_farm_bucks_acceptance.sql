-- VIGA Bucks acceptance becomes the farmer's own fact (max, 2026-08-10).
--
-- Acceptance was gated on an eligibility flag VIGA sets per stand, so the onboarding form's
-- toggle only rendered for a farm VIGA had already marked. A farmer onboarding a NEW farm —
-- which is every farmer the form exists for — could never state it, because eligibility is
-- recorded on a stand row that does not exist yet.
--
-- Max's call: every farmer states acceptance directly, and it publishes. That makes acceptance
-- what Golden Rule #1 already says published state is — the farmer's own claim about their own
-- stand — rather than a fact VIGA must grant first.
--
-- So the CHECK goes. It is the authority behind the rule, and leaving it while removing the
-- code guard would turn a farmer's tick into an opaque constraint violation at save time.
--
-- `farm_bucks_eligible` is DELIBERATELY KEPT. It still records VIGA's own decision, which is a
-- different fact from the farmer's acceptance and is read by the admin surfaces; dropping it
-- would discard 23 rows of real VIGA data to no purpose. What changes is only that it no
-- longer constrains what the farmer may say.
ALTER TABLE "sales_locations"
	DROP CONSTRAINT IF EXISTS "sales_locations_farm_bucks_acceptance_requires_eligibility";
