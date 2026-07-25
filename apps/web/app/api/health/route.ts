import { z } from "zod";

export const dynamic = "force-dynamic";

const healthSchema = z.object({
  ok: z.literal(true),
  service: z.literal("farm-friend"),
});

export function GET(): Response {
  const body = healthSchema.parse({ ok: true, service: "farm-friend" });
  return Response.json(body);
}
