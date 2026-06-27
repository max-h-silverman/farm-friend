import {
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const signupStatus = pgEnum("signup_status", [
  "confirmed",
  "dropped",
  "waitlisted",
]);

export const people = pgTable("people", {
  id: uuid("id").primaryKey().defaultRandom(),
  displayName: text("display_name"),
  phoneHash: text("phone_hash"),
  email: text("email"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const farmStands = pgTable("farm_stands", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  updateCadenceHours: integer("update_cadence_hours"),
});

export const inventorySnapshots = pgTable("inventory_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  farmStandId: uuid("farm_stand_id")
    .notNull()
    .references(() => farmStands.id),
  publishedAt: timestamp("published_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  expectedFreshUntil: timestamp("expected_fresh_until", { withTimezone: true }),
});

export const gleaningSignups = pgTable("gleaning_signups", {
  id: uuid("id").primaryKey().defaultRandom(),
  personId: uuid("person_id")
    .notNull()
    .references(() => people.id),
  status: signupStatus("status").notNull(),
  waitlistPosition: integer("waitlist_position"),
});
