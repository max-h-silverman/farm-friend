ALTER TABLE "farmer_links" ADD COLUMN "owner_farm_id" uuid;--> statement-breakpoint
ALTER TABLE "farmer_links" ADD COLUMN "sales_location_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "farmer_links" ADD CONSTRAINT "farmer_links_targeted_authorization_owner_fk" FOREIGN KEY ("authorization_id","owner_farm_id") REFERENCES "public"."farmer_authorizations"("id","farm_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "farmer_links" ADD CONSTRAINT "farmer_links_target_coherent" CHECK (
  ("owner_farm_id" is null and "sales_location_id" is null)
  or ("owner_farm_id" is not null and "sales_location_id" is not null)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "farmer_links" ADD CONSTRAINT "farmer_links_targeted_location_owner_fk" FOREIGN KEY ("sales_location_id","owner_farm_id") REFERENCES "public"."sales_locations"("id","owner_farm_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
