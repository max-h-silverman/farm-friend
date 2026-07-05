import { z } from "zod";

// Shared API request/response types + Zod validators (web + mobile + core).
// This is the leaf package: no imports from other workspace packages.

/** Lifecycle status of an inventory snapshot — governs "is it shown on the map". */
export const inventoryStatusSchema = z.enum([
  "draft",
  "current",
  "superseded",
]);
export type InventoryStatus = z.infer<typeof inventoryStatusSchema>;

/** Provenance of inventory — governs "honesty about age". Migrated ≠ confirmed. */
export const provenanceSchema = z.enum(["migrated", "farmer_confirmed"]);
export type Provenance = z.infer<typeof provenanceSchema>;

/** Claim state at the stand grain (a migrated stand may have no snapshot to carry the label). */
export const claimStatusSchema = z.enum(["migrated", "claimed"]);
export type ClaimStatus = z.infer<typeof claimStatusSchema>;

/** Approximate stock labels, used when an exact quantity isn't known. */
export const approxLabelSchema = z.enum(["some", "limited", "a lot"]);
export type ApproxLabel = z.infer<typeof approxLabelSchema>;

/** A single inventory item as proposed by extraction / rendered to a customer. */
export const inventoryItemSchema = z.object({
  name: z.string().min(1),
  isStaple: z.boolean().default(false),
  quantity: z.number().nonnegative().optional(),
  unit: z.string().optional(),
  priceText: z.string().optional(),
  approxLabel: approxLabelSchema.optional(),
});
export type InventoryItem = z.infer<typeof inventoryItemSchema>;

/** Source channel of a stock-out report. */
export const reportSourceSchema = z.enum(["sms", "qr_web"]);
export type ReportSource = z.infer<typeof reportSourceSchema>;

/** A public map feed pin — the honest, recency-labeled shape the VIGA site embeds. */
export const feedPinSchema = z.object({
  standId: z.string(),
  standName: z.string(),
  lat: z.number(),
  lng: z.number(),
  items: z.array(inventoryItemSchema),
  /** Human-readable recency, e.g. "confirmed 2 days ago" or "via VIGA's map, updated 2026-06-01". */
  recencyLabel: z.string(),
  provenance: provenanceSchema,
  updatedAt: z.string(), // ISO
});
export type FeedPin = z.infer<typeof feedPinSchema>;

/** /api/health response. */
export const healthSchema = z.object({
  ok: z.literal(true),
  service: z.literal("farm-friend"),
});
export type Health = z.infer<typeof healthSchema>;
