-- F-088 — every farm may be PLACED, including one with no stand to visit.
--
-- F-038 bundled two rules into one constraint: a location is complete or absent, AND a
-- contact-only farm carries nothing at all. max reopened the second half (2026-08-07).
--
-- ## Why the original rule existed, and why it no longer has to
--
-- The legacy map export carried real coordinates for Open Gate Lamb, a farm that delivers and
-- has no stand. Seeding those would have put a pin on the map that sent someone driving to a
-- place with nothing to buy — so the database refused the coordinate outright rather than
-- trusting every future loader and admin screen to remember.
--
-- That was the right call while a pin was an unqualified invitation. It no longer is:
--
--   * `mapMarkerKind` returns its own `contact-only` marker, and the map key names it
--     "Farm, no stand". Both were built long ago and have been UNREACHABLE the whole time,
--     precisely because this constraint forbade the coordinate that would render them.
--   * The card states "No farm stand to visit" from the same `visitability` value.
--   * The directions link is suppressed for a contact-only farm, in `buildMapView`, with a
--     test that fails if it comes back.
--
-- The defect was never the coordinate — it was the UNLABELLED coordinate. The label is now
-- code with tests behind it, so the storage rule can stop standing in for it. Being findable
-- is what a farm wants; being drivable-to is what it may decline.
--
-- ## What did NOT relax
--
-- Half a location is still refused in every direction. Latitude without longitude puts a pin in
-- the ocean; a point with no address cannot be checked by anyone. Neither has anything to do
-- with whether there is a stand — which is why the rule is now stated ONCE over the shape of a
-- location rather than twice over the two visitability values.
--
-- A `visitable` stand still cannot exist unplaced: that is the second branch, and it is the
-- only place `visitability` is still named.
--
-- ## Migration safety
--
-- Strictly WIDENING: every row that satisfied the old constraint satisfies the new one. No row
-- is rewritten and no existing farm changes what it shows. Verified against the local corpus
-- before writing: 47 visitable rows fully placed, 1 contact-only row carrying nothing — the
-- first group matches branch one, the second matches branch two.

ALTER TABLE "sales_locations"
	DROP CONSTRAINT IF EXISTS "sales_locations_coherent_visitability";--> statement-breakpoint

ALTER TABLE "sales_locations"
	ADD CONSTRAINT "sales_locations_coherent_visitability"
	CHECK (
		(
			-- Fully placed: an address AND both coordinates. Any farm may be.
			"sales_locations"."public_address" IS NOT NULL
			AND "sales_locations"."public_latitude" IS NOT NULL
			AND "sales_locations"."public_longitude" IS NOT NULL
		)
		OR (
			-- Not placed at all — and then it cannot claim to be visitable.
			"sales_locations"."visitability" = 'contact_only'
			AND "sales_locations"."public_address" IS NULL
			AND "sales_locations"."public_latitude" IS NULL
			AND "sales_locations"."public_longitude" IS NULL
		)
	);
