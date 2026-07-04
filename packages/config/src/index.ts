import { z } from "zod";

// Env parsing/validation. Leaf package: no workspace imports. Parsing is explicit
// and total — a missing required var fails loudly rather than defaulting silently.

export const llmProviderSchema = z.enum(["stub", "openweight"]);
export const smsProviderSchema = z.enum(["simulator", "telnyx"]);
export const mapProviderSchema = z.enum(["stub", "live"]);

export const envSchema = z.object({
  DATABASE_URL: z.string().optional(),
  LLM_PROVIDER: llmProviderSchema.default("stub"),
  LLM_MODEL: z.string().optional(),
  SMS_PROVIDER: smsProviderSchema.default("simulator"),
  TELNYX_API_KEY: z.string().optional(),
  TELNYX_MESSAGING_PROFILE_ID: z.string().optional(),
  TELNYX_FROM_NUMBER: z.string().optional(),
  MAP_PROVIDER: mapProviderSchema.default("stub"),
  PHONE_HASH_SALT: z.string().default("dev-only-change-me"),
  MAGIC_LINK_SECRET: z.string().default("dev-only-change-me"),
});

export type Env = z.infer<typeof envSchema>;

/** Parse process.env (or a provided record) into a validated Env. */
export function loadEnv(source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Env {
  return envSchema.parse(source);
}
