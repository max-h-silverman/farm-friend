-- F-046 — the pending result list that `MORE` pages through.
--
-- F-045 made SMS answers correct; F-046 makes them readable. A question about leafy greens
-- returned 9 stands in one message (488 characters, FOUR billed segments). Answers are now
-- paged three at a time, and `MORE` asks for the next three — which means the answer has to
-- outlive the message that produced it.
--
-- ONE ROW PER SENDER, replaced on each new question (max, 2026-07-31: replay the original
-- list rather than re-running retrieval). Paging is therefore consistent — no stand appears
-- twice or gets skipped as ordering shifts — and `MORE` costs no model call. The tradeoff,
-- accepted: stock confirmed after the question was asked does not appear until the customer
-- asks again. `expires_at` bounds how stale a replayed list can be.
--
-- WHAT THIS TABLE DELIBERATELY DOES NOT STORE
--
-- No message body, and no rendered reply text. The customer's question is untrusted inbound
-- text with a short retention life of its own (`outbox_work.body_expires_at`, the retention
-- pass); copying it here would quietly create a second, longer-lived home for it and defeat
-- that. What is stored is what code needs to render page 2: WHICH facts, and HOW FAR through
-- them the sender has read.
--
-- `items_requested` is the exception, and it is a narrow one: it is the product words the
-- interpretation seam extracted ("leafy greens"), not the sender's sentence, and page 2 has
-- to name the subject to read as an answer at all. It is bounded, non-identifying, and
-- already the least sensitive thing in the pipeline.
CREATE TABLE "pending_result_lists" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,

  -- The hash, never a raw number (Golden Rule #5). UNIQUE: one pending list per sender, so a
  -- new question REPLACES the old one rather than accumulating. A sender cannot have two
  -- lists in flight, so `MORE` is never ambiguous about which list it means.
  "sender_hash" text NOT NULL UNIQUE,

  -- The ordered fact identifiers the answer selected, as the renderer will replay them.
  -- Opaque strings owned by the inquiry path; this table never interprets them.
  "fact_ids" text[] NOT NULL,

  -- The product words the answer was about, for page 2's heading. Not the sender's message.
  "items_requested" text[] NOT NULL,

  -- How many of `fact_ids` the sender has already been shown. Page 1 leaves this at 3.
  "offset" integer NOT NULL DEFAULT 0,

  "created_at" timestamptz NOT NULL DEFAULT now(),

  -- Bounds staleness. A replayed list an hour old is a reasonable answer; a day-old one is
  -- not, and the honest response is to ask what they are looking for.
  "expires_at" timestamptz NOT NULL,

  -- A list must contain something to be worth storing, and the offset must stay inside it.
  -- Both are CHECKs rather than conventions because a zero-length list would render an empty
  -- page and an out-of-range offset would render nothing at all — each looking like "no
  -- results" to a customer.
  --
  -- `coalesce` is required: `array_length` of an empty array returns NULL, not 0, and a CHECK
  -- constraint PASSES on NULL. Without it this constraint would admit exactly the empty array
  -- it exists to forbid.
  CONSTRAINT "pending_result_lists_not_empty"
    CHECK (coalesce(array_length("fact_ids", 1), 0) > 0),
  CONSTRAINT "pending_result_lists_offset_in_range"
    CHECK ("offset" >= 0 AND "offset" <= coalesce(array_length("fact_ids", 1), 0)),
  CONSTRAINT "pending_result_lists_expires_after_creation"
    CHECK ("expires_at" > "created_at")
);

-- The only read path: resolve a sender's live list. Partial on expiry would need `now()`,
-- which is not immutable, so expiry is filtered at query time against this index.
CREATE INDEX "pending_result_lists_sender_idx"
  ON "pending_result_lists" ("sender_hash", "expires_at");
