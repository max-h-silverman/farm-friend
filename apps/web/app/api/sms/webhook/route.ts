import { parseCommand } from "@farm-friend/core";

// Telnyx inbound webhook stub. Inbound SMS enters the DETERMINISTIC routing
// (parseCommand) before any model call — see docs/ARCHITECTURE.md §routing.
// Full routing + persistence lands with the launch-set features; this proves the
// webhook accepts a simulated payload and runs the deterministic parse.

export const dynamic = "force-dynamic";

interface TelnyxInbound {
  data?: { payload?: { text?: string; from?: { phone_number?: string } } };
}

export async function POST(req: Request): Promise<Response> {
  let payload: TelnyxInbound;
  try {
    payload = (await req.json()) as TelnyxInbound;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const text = payload.data?.payload?.text ?? "";
  const command = parseCommand(text);

  // Phase 0: acknowledge + echo the deterministic classification. No model call, no send.
  return Response.json({ received: true, command });
}
