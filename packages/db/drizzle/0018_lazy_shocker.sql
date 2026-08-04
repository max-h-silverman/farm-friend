ALTER TABLE "farmer_invitations"
	ADD COLUMN "agreed_to_sms_at" timestamp with time zone;--> statement-breakpoint

ALTER TABLE "farmer_invitations"
	ADD CONSTRAINT "farmer_invitations_valid_agreement"
	CHECK ("farmer_invitations"."agreed_to_sms_at" IS NULL OR "farmer_invitations"."agreed_to_sms_at" >= "farmer_invitations"."created_at");
