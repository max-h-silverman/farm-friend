-- The phone an invited farmer states on the onboarding form, so a bare `START` from it completes
-- their setup (max 2026-08-07).
--
-- ## What this replaces, and why
--
-- Onboarding was completed by texting `JOIN <64-hex-token>`: the token in the message body was
-- what tied the handset to the farm. max removed that route — a farmer hand-copying a 64-character
-- token from a web page into a text message is a transcription error waiting to happen, and every
-- error lands as a silent miss (the token simply does not match, and nothing says why).
--
-- What replaces it moves the farm identity OUT of the message body and into a value the farmer
-- states on a form they are already filling in. The message becomes the one word the carrier
-- itself defines: `START`.
--
-- ## Why `START` and not a word of our own
--
-- **The carrier owns its own opt-out list and only `START` clears it** (B-011, verified live
-- 2026-07-27). While a number sits on that list every send is refused 409 regardless of what our
-- own records say. `JOIN` is ours and means nothing to Telnyx's compliance layer, so a farmer
-- whose phone had ever texted `STOP` would be recorded as consenting while every message to them
-- was silently dropped. `START` is the only word that both enrolls and unblocks, which makes it
-- the only honest instruction to print for a farmer whose history we cannot see.
--
-- ## Privacy: Golden Rule #5, unchanged by this
--
-- The same two-column shape as `contacts` and `farm_emails`, for the same reason:
--
--   * `pending_phone_e164` is the raw number in EXACTLY ONE column, read only by the send path.
--   * `pending_phone_hash` is the ONLY lookup key. An inbound `START` is matched by hash — the
--     raw column is never read to answer "whose invitation is this?", never logged, and never
--     enters model context.
--
-- Both are nullable: an invitation minted before the farmer reaches the form has neither, and an
-- administrator may still mint one for a farmer who never fills it in.
--
-- ## What keeps a wrong number from claiming a farm
--
-- The invitation TOKEN is still the credential — it arrives only in the link VIGA sent, and only
-- an unredeemed, unexpired invitation can be matched at all. The phone says which handset to
-- expect, never who may be set up. A mistyped number therefore matches nothing and grants
-- nothing; it leaves the invitation unredeemed and retryable, which is the failure direction to
-- want.
--
-- ## This file is HAND-WRITTEN
--
-- Same reason as 0024: `drizzle-kit generate` silently drops CHECK constraints, so its output
-- would create columns enforcing none of the rules `schema.ts` appears to declare. The
-- constraints below are proven to REFUSE in `invitation-pending-phone-migration.integration.test.ts`
-- rather than trusted from either file.
--
-- Additive and nullable, so an image built before this migration keeps serving correctly in the
-- window between applying it and deploying the code that reads it.

ALTER TABLE "farmer_invitations"
	ADD COLUMN IF NOT EXISTS "pending_phone_e164" text;--> statement-breakpoint

ALTER TABLE "farmer_invitations"
	ADD COLUMN IF NOT EXISTS "pending_phone_hash" text;--> statement-breakpoint

-- E.164 as `normalizePhone` produces it: `+1` and exactly ten digits. Enforced rather than
-- trusted because this column feeds the outbound send path, and a malformed number there is a
-- message that cannot be delivered with nothing reporting why.
--
-- Passes on NULL DELIBERATELY — an invitation with no stated phone is the normal starting state.
ALTER TABLE "farmer_invitations"
	ADD CONSTRAINT "farmer_invitations_pending_phone_e164_shape"
	CHECK ("pending_phone_e164" IS NULL OR "pending_phone_e164" ~ '^\+1[0-9]{10}$');--> statement-breakpoint

-- The 64-character LOWERCASE hex digest every hash column in this schema uses. A malformed hash
-- is a row that can never be matched, so the farmer's `START` would miss and nothing would report
-- an error. Lowercase is enforced rather than folded so a digest has exactly one spelling.
ALTER TABLE "farmer_invitations"
	ADD CONSTRAINT "farmer_invitations_pending_phone_hash_is_digest"
	CHECK ("pending_phone_hash" IS NULL OR "pending_phone_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint

-- A COHERENCE PAIR in both directions, not the one-directional form.
--
-- `(a IS NULL) = (b IS NULL)` rather than `a IS NULL OR b IS NOT NULL`: the one-directional
-- version passes whenever the left side is NULL and enforces nothing in that case — 0023's
-- lesson, and 0025's. A raw number with no hash can never be matched; a hash with no raw number
-- matches an invitation we then cannot text.
ALTER TABLE "farmer_invitations"
	ADD CONSTRAINT "farmer_invitations_pending_phone_coherent"
	CHECK (("pending_phone_e164" IS NULL) = ("pending_phone_hash" IS NULL));--> statement-breakpoint

-- The match path: given an inbound sender's hash, which unredeemed invitation expects it.
--
-- PARTIAL on `redeemed_at IS NULL`, which is the set actually queried — a redeemed invitation is
-- history and must never be matched again. Deliberately NOT unique: two farmers sharing a
-- household phone may each hold an invitation, and a unique index would refuse the second. Which
-- one a `START` completes is decided by the query's ordering, not by refusing to store the row.
CREATE INDEX IF NOT EXISTS "farmer_invitations_pending_phone_hash_idx"
	ON "farmer_invitations" ("pending_phone_hash")
	WHERE "redeemed_at" IS NULL;
