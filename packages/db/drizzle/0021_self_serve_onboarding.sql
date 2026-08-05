-- F-067 — a farmer's own invitation redemption settles their onboarding request.
--
-- The invitation IS the authorization decision: a coordinator picks the farm and sends a
-- one-use link to a specific person. The queue click that used to follow re-approved a
-- decision already made, which is why the code it replaces could say "VIGA always approves".
-- Redeeming an agreed invitation now writes the `farmer_authorizations` row directly.
--
-- That breaks an assumption this CHECK encoded: that a settled request was settled by an
-- administrator. It now may also be settled by the farmer's own redemption, which records an
-- `authorization_id` and no administrator.
--
-- THE CONSTRAINT'S JOB IS UNCHANGED — a settled request must still say WHO settled it. Only
-- the set of acceptable answers widens, from "an administrator" to "an administrator, or the
-- authorization the redemption granted". A settlement naming neither stays refused, which is
-- what keeps this a widening rather than a hole.
--
-- Stated as a full disjunction over both shapes rather than by relaxing the administrator test
-- on its own: a CHECK *passes* on NULL, so dropping the NOT NULL requirement without naming
-- the replacement evidence would silently admit a settled row that records nothing at all.

ALTER TABLE "farmer_onboarding_requests"
	DROP CONSTRAINT "farmer_onboarding_requests_coherent_settlement";--> statement-breakpoint

ALTER TABLE "farmer_onboarding_requests"
	ADD CONSTRAINT "farmer_onboarding_requests_coherent_settlement"
	CHECK (
		(
			"farmer_onboarding_requests"."settled_at" IS NULL
			AND "farmer_onboarding_requests"."settled_by_administrator_id" IS NULL
			AND "farmer_onboarding_requests"."authorization_id" IS NULL
		)
		OR (
			"farmer_onboarding_requests"."settled_at" IS NOT NULL
			AND "farmer_onboarding_requests"."settled_by_administrator_id" IS NOT NULL
		)
		OR (
			"farmer_onboarding_requests"."settled_at" IS NOT NULL
			AND "farmer_onboarding_requests"."authorization_id" IS NOT NULL
		)
	);
