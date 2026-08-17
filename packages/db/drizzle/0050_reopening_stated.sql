-- ===========================================================================================
-- F-114 Phase C.4 — RECORDING THAT THE RE-OPENING CONSEQUENCE WAS STATED.
--
-- §facts and authority: a paused provider's update *triggers a new confirmation stating the
-- consequence — "Publishing this update will re-open your listing. Reply YES to confirm, NO to
-- cancel." The seller decides what they meant; code never infers it.*
--
-- The farmer answers that with an ordinary `YES` (max, 2026-08-16) — no new SMS keyword, because
-- `YES` and `NO` are the two words a farmer already knows and a third would be one more thing to
-- teach for a case that arises rarely.
--
-- That makes the `YES` ambiguous on its own: it is consent to re-opening only if the message it
-- answers actually SAID so. Inferring it from "the listing is paused and a YES arrived" is
-- exactly the guessing the rule forbids — a farmer whose prompt predates the pause would have
-- her listing re-opened by a YES that answered a different sentence.
--
-- So the fact is stored, on the row the token is already bound to. One column, one fact: **the
-- re-opening sentence was sent for this proposal at this version.**
--
-- ## Why the VERSION and not a boolean
--
-- A revision bumps `proposal_version` and clears the activation, so the farmer must be shown a
-- fresh prompt before any token commits. A bare boolean would survive that: the farmer sees the
-- consequence, revises her update instead of confirming, gets an ordinary prompt with no
-- re-opening sentence in it, and her `YES` would still count as consent to re-open.
--
-- Storing the version makes the consent as context-bound as the token itself — it counts only
-- while the version it was stated for is the one being confirmed.
-- ===========================================================================================

ALTER TABLE "inventory_publication_proposals"
  ADD COLUMN IF NOT EXISTS "reopening_stated_version" integer;--> statement-breakpoint

-- A version is a version. `proposal_version` carries the same rule
-- (`inventory_proposals_positive_version`), and without this a `0` or a negative value would
-- compare equal to nothing and silently disable the consent forever.
DO $$ BEGIN
  ALTER TABLE "inventory_publication_proposals"
    ADD CONSTRAINT "inventory_proposals_reopening_stated_version_positive" CHECK (
      "reopening_stated_version" is null or "reopening_stated_version" > 0
    );
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN null;
END $$;
