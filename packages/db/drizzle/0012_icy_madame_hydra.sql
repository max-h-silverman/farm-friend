DO $$ BEGIN
 CREATE TYPE "public"."farmer_target_menu_purpose" AS ENUM('update', 'link', 'settings');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "farmer_target_contexts" (
	"sender_hash" text PRIMARY KEY NOT NULL,
	"selected_authorization_id" uuid,
	"selected_owner_farm_id" uuid,
	"selected_sales_location_id" uuid,
	"selected_at" timestamp with time zone,
	"menu_issued_at" timestamp with time zone,
	"menu_expires_at" timestamp with time zone,
	"menu_purpose" "farmer_target_menu_purpose",
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "farmer_target_menu_options" (
	"sender_hash" text NOT NULL,
	"option_number" integer NOT NULL,
	"authorization_id" uuid NOT NULL,
	"owner_farm_id" uuid NOT NULL,
	"sales_location_id" uuid NOT NULL,
	CONSTRAINT "farmer_target_menu_options_sender_hash_option_number_pk" PRIMARY KEY("sender_hash","option_number"),
	CONSTRAINT "farmer_target_menu_options_one_number_per_pair" UNIQUE("sender_hash","authorization_id","sales_location_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "farmer_target_contexts" ADD CONSTRAINT "farmer_target_contexts_sender_hash_contacts_phone_hash_fk" FOREIGN KEY ("sender_hash") REFERENCES "public"."contacts"("phone_hash") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "farmer_target_contexts" ADD CONSTRAINT "farmer_target_contexts_selected_authorization_owner_fk" FOREIGN KEY ("selected_authorization_id","selected_owner_farm_id") REFERENCES "public"."farmer_authorizations"("id","farm_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "farmer_target_contexts" ADD CONSTRAINT "farmer_target_contexts_selected_location_owner_fk" FOREIGN KEY ("selected_sales_location_id","selected_owner_farm_id") REFERENCES "public"."sales_locations"("id","owner_farm_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "farmer_target_menu_options" ADD CONSTRAINT "farmer_target_menu_options_context_fk" FOREIGN KEY ("sender_hash") REFERENCES "public"."farmer_target_contexts"("sender_hash") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "farmer_target_menu_options" ADD CONSTRAINT "farmer_target_menu_options_authorization_owner_fk" FOREIGN KEY ("authorization_id","owner_farm_id") REFERENCES "public"."farmer_authorizations"("id","farm_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "farmer_target_menu_options" ADD CONSTRAINT "farmer_target_menu_options_location_owner_fk" FOREIGN KEY ("sales_location_id","owner_farm_id") REFERENCES "public"."sales_locations"("id","owner_farm_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "farmer_target_contexts_selected_authorization" ON "farmer_target_contexts" USING btree ("selected_authorization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "farmer_target_contexts_selected_location" ON "farmer_target_contexts" USING btree ("selected_sales_location_id");--> statement-breakpoint

-- F-051: drizzle-kit 0.22.8 omits CHECK constraints from generated SQL. These are the
-- database's refusal of half-selected and half-live target contexts; every nullable case is
-- stated explicitly so SQL's CHECK-on-NULL rule cannot admit the shape being forbidden.
ALTER TABLE "farmer_target_contexts"
  ADD CONSTRAINT "farmer_target_contexts_selected_context_coherent"
  CHECK (
    (
      "selected_authorization_id" IS NULL
      AND "selected_owner_farm_id" IS NULL
      AND "selected_sales_location_id" IS NULL
      AND "selected_at" IS NULL
    )
    OR (
      "selected_authorization_id" IS NOT NULL
      AND "selected_owner_farm_id" IS NOT NULL
      AND "selected_sales_location_id" IS NOT NULL
      AND "selected_at" IS NOT NULL
    )
  );--> statement-breakpoint
ALTER TABLE "farmer_target_contexts"
  ADD CONSTRAINT "farmer_target_contexts_menu_context_coherent"
  CHECK (
    (
      "menu_issued_at" IS NULL
      AND "menu_expires_at" IS NULL
      AND "menu_purpose" IS NULL
    )
    OR (
      "menu_issued_at" IS NOT NULL
      AND "menu_expires_at" IS NOT NULL
      AND "menu_purpose" IS NOT NULL
      AND "menu_expires_at" > "menu_issued_at"
    )
  );--> statement-breakpoint
ALTER TABLE "farmer_target_menu_options"
  ADD CONSTRAINT "farmer_target_menu_options_positive_option"
  CHECK ("option_number" > 0);
