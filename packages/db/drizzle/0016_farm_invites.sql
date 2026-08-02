CREATE TYPE "public"."farmer_invite_channel" AS ENUM('sms', 'email');--> statement-breakpoint

CREATE TABLE "farmer_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"farm_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"channel" "farmer_invite_channel" NOT NULL,
	"created_by_administrator_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone,
	CONSTRAINT "farmer_invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "farmer_invitations_token_hash_shape" CHECK ("farmer_invitations"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "farmer_invitations_expiry_after_creation" CHECK ("farmer_invitations"."expires_at" > "farmer_invitations"."created_at"),
	CONSTRAINT "farmer_invitations_valid_redemption" CHECK ("farmer_invitations"."redeemed_at" IS NULL OR "farmer_invitations"."redeemed_at" >= "farmer_invitations"."created_at")
);--> statement-breakpoint

ALTER TABLE "farmer_onboarding_requests"
	ADD COLUMN "invitation_id" uuid;--> statement-breakpoint

ALTER TABLE "farmer_invitations"
	ADD CONSTRAINT "farmer_invitations_farm_fk"
	FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "farmer_invitations"
	ADD CONSTRAINT "farmer_invitations_administrator_fk"
	FOREIGN KEY ("created_by_administrator_id") REFERENCES "public"."administrators"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "farmer_onboarding_requests"
	ADD CONSTRAINT "farmer_onboarding_requests_invitation_fk"
	FOREIGN KEY ("invitation_id") REFERENCES "public"."farmer_invitations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "farmer_onboarding_requests_one_per_invitation"
	ON "farmer_onboarding_requests" ("invitation_id")
	WHERE "invitation_id" IS NOT NULL;
