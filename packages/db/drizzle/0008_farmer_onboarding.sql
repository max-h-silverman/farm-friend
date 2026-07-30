-- F-040 — farmer onboarding: the missing link between "a farmer texts us" and "that farmer
-- can publish".
--
-- `farmer_authorizations` has existed since the clean launch and has had NO WRITER outside
-- test fixtures. Publishing demands one (`inventory_revisions.published_by_authorization_id`),
-- so a real farmer who texted an update fell through to the CUSTOMER branch and nothing
-- anywhere reported why. This migration adds the two records that close the chain. The
-- authorization table itself is unchanged — it already required a verified phone and was
-- already revocable, which is exactly what the settled design needs.
--
-- TWO tables, and the split is the load-bearing part:
--
--   `farmer_onboarding_requests`  what a farmer ASKED for. Grants nothing.
--   `farmer_links`                a standing key to ONE existing authorization.
--
-- Neither is an authorization, and neither can become one. VIGA always approves, so a
-- farmer's request must be inert by construction rather than by a rule someone remembers:
-- the request table has no `authorized_at`, no grant column, and nothing reads it as
-- authority. The only writer of `farmer_authorizations` is an administrator-gated one.

-- ---------------------------------------------------------------------------------------
-- The request queue.
-- ---------------------------------------------------------------------------------------
--
-- A farmer texts asking to be set up; this is where that ask waits for VIGA. It is written
-- from an UNAUTHENTICATED inbound SMS, so everything about it is shaped to make that safe:
-- it carries no free text (nothing an inbound message controls is stored), it names no farm
-- (the farmer does not get to choose which farm they are claiming — VIGA decides that when
-- they act), and its only content is "this phone asked, at this time".
--
-- Deliberately NOT a `stand_data_flags`-style table with a source text column. The reason
-- `stand_data_flags` carries `source_text` is that a SEEDER wrote it from VIGA's own export.
-- Here the writer is the public internet, and a stored body would be untrusted text sitting
-- in an operator's queue for no benefit — the flag rail (FLAG) already owns "a human should
-- read this message", and the thread viewer already exists for it.
CREATE TABLE "farmer_onboarding_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- The hash, never a raw number (Golden Rule #5). The operator surface masks from the
  -- contact row at query time, exactly as the flag queue does.
  "contact_hash" text NOT NULL,
  "requested_at" timestamp with time zone NOT NULL,
  -- How the request left the queue. An acted-on request is CLOSED, never deleted, because
  -- "did anyone deal with this farmer" is a question the queue has to be able to answer.
  "settled_at" timestamp with time zone,
  "settled_by_administrator_id" uuid,
  -- The authorization this request produced, when it produced one. NULL for a request that
  -- was declined, or that is still open. This is a REFERENCE to authority, never a source
  -- of it: the authorization exists first and this column points at it.
  "authorization_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "farmer_onboarding_requests"
  ADD CONSTRAINT "farmer_onboarding_requests_contact_fk"
  FOREIGN KEY ("contact_hash") REFERENCES "contacts"("phone_hash") ON DELETE restrict;--> statement-breakpoint

ALTER TABLE "farmer_onboarding_requests"
  ADD CONSTRAINT "farmer_onboarding_requests_administrator_fk"
  FOREIGN KEY ("settled_by_administrator_id") REFERENCES "administrators"("id")
  ON DELETE restrict;--> statement-breakpoint

ALTER TABLE "farmer_onboarding_requests"
  ADD CONSTRAINT "farmer_onboarding_requests_authorization_fk"
  FOREIGN KEY ("authorization_id") REFERENCES "farmer_authorizations"("id")
  ON DELETE restrict;--> statement-breakpoint

-- One OPEN request per phone. A farmer who texts the keyword five times because nothing
-- visibly happened must not produce five queue entries for one operator to work through.
-- Settled requests stay as history, so the same farmer can ask again later.
CREATE UNIQUE INDEX "farmer_onboarding_requests_one_open_per_contact"
  ON "farmer_onboarding_requests" ("contact_hash") WHERE "settled_at" IS NULL;--> statement-breakpoint

-- A settled request records WHO settled it, in the same row, always. The pair is the audit
-- answer; either half alone is a record that cannot say who acted.
ALTER TABLE "farmer_onboarding_requests"
  ADD CONSTRAINT "farmer_onboarding_requests_coherent_settlement"
  CHECK (
    ("settled_at" IS NULL AND "settled_by_administrator_id" IS NULL
      AND "authorization_id" IS NULL)
    OR ("settled_at" IS NOT NULL AND "settled_by_administrator_id" IS NOT NULL)
  );--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- The standing link.
-- ---------------------------------------------------------------------------------------
--
-- max chose a link that NEVER EXPIRES until revoked, so the farmer can bookmark it once and
-- return without texting. That decision moves the entire safety burden onto revocation, and
-- this table is shaped so revocation cannot be forgotten or cached around.
--
-- **The link is not a credential this table can vouch for on its own.** It is a POINTER to
-- an authorization, and the authorization is what carries authority. Resolution therefore
-- reads both rows and re-checks `farmer_authorizations.revoked_at` on EVERY request. There
-- is deliberately no denormalized farm id, no cached "is active" flag, and no signed claim
-- in the link itself — nothing that could still say "valid" after the authorization behind
-- it was withdrawn. Revoking the authorization kills every link to it, with no second thing
-- to remember.
--
-- Contrast with the admin magic link, which is single-use and 15 minutes: that one is an
-- authentication event, and its consume record IS the session. This one is a durable
-- capability with no session at all, which is why it is a table and not a token.
CREATE TABLE "farmer_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- SHA-256 of 32 random bytes, hex. Only the hash is stored — the same discipline as
  -- `admin_sessions.token_hash` and the phone hash: a database read cannot recover a live
  -- credential, so a leaked backup is not a leaked set of working links.
  "token_hash" text NOT NULL,
  "authorization_id" uuid NOT NULL,
  "issued_at" timestamp with time zone NOT NULL,
  -- A link may also be revoked INDIVIDUALLY, without withdrawing the farmer's authority —
  -- the "I lost my phone, send me a new link" case. Withdrawing the authorization kills
  -- every link regardless; this is the narrower act, not a second mechanism for the same one.
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "farmer_links"
  ADD CONSTRAINT "farmer_links_authorization_fk"
  FOREIGN KEY ("authorization_id") REFERENCES "farmer_authorizations"("id")
  ON DELETE restrict;--> statement-breakpoint

ALTER TABLE "farmer_links"
  ADD CONSTRAINT "farmer_links_token_hash_unique" UNIQUE ("token_hash");--> statement-breakpoint

-- 32 random bytes hex-encoded. A short or non-hex value would mean the raw token was stored,
-- or truncated to something enumerable.
ALTER TABLE "farmer_links"
  ADD CONSTRAINT "farmer_links_token_hash_shape"
  CHECK ("token_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint

ALTER TABLE "farmer_links"
  ADD CONSTRAINT "farmer_links_valid_revocation"
  CHECK ("revoked_at" IS NULL OR "revoked_at" >= "issued_at");--> statement-breakpoint

-- One LIVE link per authorization. Re-issuing replaces rather than accumulates: a farmer who
-- asks for a new link because the old one was on a lost phone must not leave the old one
-- working. Revoked rows stay for the audit trail and are excluded here.
CREATE UNIQUE INDEX "farmer_links_one_live_per_authorization"
  ON "farmer_links" ("authorization_id") WHERE "revoked_at" IS NULL;
