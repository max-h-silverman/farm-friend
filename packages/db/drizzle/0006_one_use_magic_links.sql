-- GL-004 — make an admin magic link genuinely one-use.
--
-- The defect: the link was a stateless signed claim (email + issued/expires). A signature
-- can say "authentic" any number of times, so EVERY callback inside the 15-minute window
-- minted a fresh session. A link forwarded, scanned by a mail gateway, sitting in a shared
-- inbox, or recovered from a browser history was a working credential for the whole window.
-- The sign-in email had been promising "can be used once" since F-032.
--
-- **Why a column on `admin_sessions` and not a new table.** A link being spent and a session
-- existing are the SAME event: the session row IS the record that the link was used. Storing
-- that fact anywhere else would create a second thing to keep in step with the first, and a
-- window between them in which a link could be consumed without a session or a session
-- created without consuming a link. Here the consume and the session are one INSERT, so
-- there is nothing between them to interleave and no reconciliation to get wrong.
--
-- It also keeps the unauthenticated `/api/auth/request-link` endpoint writing NOTHING.
-- A separate credential table would have to be populated when a link is MINTED — that is,
-- from the internet, by anyone who can guess an operator's address — which is both a way to
-- grow Farm Friend's tables from outside and a per-address write whose presence or absence
-- is exactly the membership oracle that route exists to deny. The row appears only when a
-- link is OPENED, by someone who already holds a validly signed one.
--
-- **The arbiter is the unique index, not a check-then-write.** Two callbacks racing on one
-- link would both read "unused" and both insert; a `select … for update` cannot help, since
-- it locks rows that EXIST and the first use of a link has no row to lock (the B-011 lesson).
-- The insert is therefore `on conflict (magic_nonce_hash) do nothing returning id`, where
-- the EMPTY result is the signal that someone else won.
--
-- NULLABLE, because sessions that came from no link at all are legitimate — the bootstrap
-- path and every test that mints a session directly. Postgres treats NULLs as distinct in a
-- unique index, so any number of them coexist. That is why the index is a plain UNIQUE
-- rather than a partial one: the semantics are already what is wanted.

ALTER TABLE "admin_sessions" ADD COLUMN "magic_nonce_hash" text;--> statement-breakpoint

-- SHA-256 of the link's nonce, hex — never the nonce itself. Same discipline as
-- `token_hash` and the phone hash (Golden Rule #5): what is stored is a lookup key, and a
-- database read cannot recover a live credential. A short or non-hex value would mean the
-- raw nonce was stored, or truncated to something enumerable.
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_magic_nonce_hash_shape"
  CHECK ("magic_nonce_hash" IS NULL OR "magic_nonce_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint

-- The single-use guarantee itself. Everything above this line is bookkeeping; this is the
-- line that makes a second use impossible rather than merely unlikely.
CREATE UNIQUE INDEX "admin_sessions_one_per_magic_nonce"
  ON "admin_sessions" ("magic_nonce_hash");
