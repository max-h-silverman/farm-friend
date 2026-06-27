import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().optional(),
  SMS_PROVIDER: z.enum(["simulator", "telnyx"]).default("simulator"),
  LLM_PROVIDER: z.enum(["stub"]).default("stub"),
  PHONE_HASH_SALT: z.string().optional(),
});

export type FarmFriendConfig = z.infer<typeof envSchema>;

export function readConfig(
  env: Record<string, string | undefined> = process.env,
): FarmFriendConfig {
  return envSchema.parse(env);
}
