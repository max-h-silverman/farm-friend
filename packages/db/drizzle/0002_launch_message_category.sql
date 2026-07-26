-- F-016 forward migration: one launch operational SMS program.
--
-- The outbox previously carried TWO overlapping ways to say what a message was: a
-- free-text `message_kind` (unbounded, so the consent gate could not read it as a type)
-- and an `is_required` boolean. Neither could express the third case the launch consent
-- model actually needs — a direct reply that is permitted by the recipient's own inbound
-- message but is not carrier-required.
--
-- They are replaced by ONE bounded `message_category`. These are categories inside the
-- single registered program, deliberately NOT separate enrollments and NOT a program
-- discriminator; their consent meaning lives in packages/core/src/sms/consent.ts.
CREATE TYPE "public"."message_category" AS ENUM(
  'required_reply',
  'inquiry_reply',
  'inventory_prompt',
  'inventory_confirmation',
  'stock_out_alert'
);--> statement-breakpoint

ALTER TABLE "outbox_work"
  ADD COLUMN "message_category" "public"."message_category";--> statement-breakpoint

-- Greenfield build: existing rows are development/test data only, so the backfill maps
-- the old pair onto the new category conservatively rather than preserving provenance.
-- A required row becomes the carrier-required reply; everything else becomes a proactive
-- prompt, which is the STRICTER classification — it needs active consent to go out.
UPDATE "outbox_work"
  SET "message_category" = CASE
    WHEN "is_required" THEN 'required_reply'::"public"."message_category"
    WHEN "message_kind" = 'inventory_confirmation'
      THEN 'inventory_confirmation'::"public"."message_category"
    WHEN "message_kind" IN ('inventory_published', 'inventory_declined')
      THEN 'inquiry_reply'::"public"."message_category"
    ELSE 'inventory_prompt'::"public"."message_category"
  END;--> statement-breakpoint

ALTER TABLE "outbox_work"
  ALTER COLUMN "message_category" SET NOT NULL;--> statement-breakpoint

-- Delete on the way through: never leave two ways to say one thing.
ALTER TABLE "outbox_work" DROP COLUMN "message_kind";--> statement-breakpoint
ALTER TABLE "outbox_work" DROP COLUMN "is_required";
