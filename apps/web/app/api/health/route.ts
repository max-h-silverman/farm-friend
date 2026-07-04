import type { Health } from "@farm-friend/contracts";

export const dynamic = "force-dynamic";

export function GET(): Response {
  const body: Health = { ok: true, service: "farm-friend" };
  return Response.json(body);
}
