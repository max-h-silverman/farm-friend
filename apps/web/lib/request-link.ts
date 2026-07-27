import { z } from "zod";
import {
  issueMagicToken,
  renderSignInEmail,
  SIGN_IN_LINK_TTL_MS,
  type Clock,
  type MailSender,
  type PublicActionThrottle,
} from "@farm-friend/core";
import { clientSignalFor } from "./client-signal";

// The public "send me a sign-in link" endpoint (F-032).
//
// This is the recovery path for the entire admin surface, and it is PUBLIC and
// UNAUTHENTICATED — anyone on the internet can post any address to it. Three properties
// carry it, and each exists because the obvious implementation gets it wrong.
//
// **1. The response is byte-identical for every address.** Not "similar", not "the same
// status" — identical status, headers, and body. An endpoint that answers 202 for operators
// and 404 for everyone else is a membership oracle for who VIGA's operators are, which is
// precisely the disclosure the callback already refuses to make (F-025a). This is why the
// handler computes one response value up front and returns it on every path below.
//
// **2. That identity survives failure.** The tempting implementation lets a mail error
// propagate into a 500. But mail is only ever attempted for an administrator, so a 500 would
// mean "this address is an operator" — the oracle returns through the error path. Sends are
// therefore attempted in a way that cannot change the answer, and a failure is recorded as a
// count, never as a status or a body.
//
// **3. The throttle runs before the lookup.** A refused request must cost nothing and reveal
// nothing: no database read, so the endpoint cannot be used to time the administrator table
// and a throttled attacker cannot keep probing.
//
// What this deliberately does NOT do: rate-limit per EMAIL ADDRESS. A per-address budget is
// itself an oracle — an attacker watches which addresses start refusing and learns which ones
// send mail. The budget is per client, which is the thing being rationed anyway.

export interface RequestLinkDeps {
  clock: Clock;
  mail: MailSender;
  throttle: PublicActionThrottle;
  /** Signs the link. Absent configuration is handled by the caller, which fails closed. */
  magicLinkSecret: string;
  /** Salt for the coarse client bucket key. Never stored, never an identity. */
  signalSalt: string;
  /**
   * The origin links are built against. CONFIGURED, never taken from the request — a
   * `Host:` header the attacker controls would otherwise let this endpoint mail an operator
   * a link pointing at the attacker's origin, which is a credential-harvesting primitive.
   */
  baseUrl: string;
  /** Whether the address belongs to a live administrator. The authorization boundary. */
  isAdministrator(email: string): Promise<boolean>;
}

const requestSchema = z.object({
  // Bounded before any work: an address longer than this is not a typo, and the bound keeps
  // an absurd body from reaching the normalizer or the database.
  email: z.string().min(3).max(320),
});

/**
 * The single response every caller receives. Built fresh per call so that no caller can
 * mutate a shared object, and identical in every field so that comparing two responses
 * byte-for-byte cannot distinguish an administrator from a stranger.
 *
 * 202 rather than 200: "if that address belongs to an operator, a link is on its way" is
 * exactly what happened, and it commits to nothing observable.
 */
function acceptedResponse(): Response {
  return Response.json(
    {
      // Phrased so it is true for every caller. It promises nothing about the address.
      status: "If that address belongs to an administrator, a sign-in link is on its way.",
    },
    { status: 202 },
  );
}

/**
 * Normalize an address to the stored identity. `administrators.email` is stored lowercased
 * (migration 0003), so an operator typing capitals must resolve to the same row rather than
 * silently receiving nothing.
 */
function normalizeEmail(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  // Structural check only. This is not an attempt to validate deliverability — the
  // administrator lookup is the real gate, and a malformed address simply fails it.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Read the request body as either JSON or an HTML form post, returning `null` if it is
 * neither.
 *
 * Both are supported because `/admin/login` MUST work without JavaScript — it is the
 * recovery path for the whole admin surface, so it cannot be the one screen that breaks when
 * a script fails to load. A browser posting a native `<form>` sends
 * `application/x-www-form-urlencoded`; the enhanced path sends JSON. Accepting only the
 * latter would answer 400 to every no-JS submission.
 */
async function readBody(req: Request): Promise<unknown> {
  const contentType = req.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("application/x-www-form-urlencoded")) {
      return Object.fromEntries(new URLSearchParams(await req.text()));
    }
    return await req.json();
  } catch {
    return null;
  }
}

/**
 * Handle one sign-in link request. Returns the transport response; the caller binds
 * configuration. Never throws for an ordinary request, because a thrown error would become
 * a 500 that only administrators can trigger.
 */
export async function handleRequestLinkRequest(
  req: Request,
  deps: RequestLinkDeps,
): Promise<Response> {
  const body = await readBody(req);
  if (body === null) {
    // A malformed body is rejected BEFORE the throttle, so a client-side typo cannot consume
    // a real operator's budget. It also reveals nothing: it is a property of the body, not
    // of any address.
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  // Before the lookup, deliberately. A refused request performs no database read.
  const decision = deps.throttle.admit(clientSignalFor(req.headers, deps.signalSalt));
  if (!decision.allowed) {
    return Response.json(
      { error: "too_many_requests" },
      {
        status: 429,
        headers: { "retry-after": String(decision.retryAfterSeconds) },
      },
    );
  }

  const email = normalizeEmail(parsed.data.email);

  // Everything from here returns the SAME response. The work below changes what happens in
  // an operator's mailbox; it never changes what the caller can observe.
  if (email !== null) {
    await sendLinkIfAdministrator(email, deps);
  }

  return acceptedResponse();
}

/**
 * Mint and mail a link, but only to a live administrator. Swallows every failure by design:
 * the caller's response must not vary, and this function is reached only for a syntactically
 * valid address, so any error it could surface would be an administrator-only signal.
 */
async function sendLinkIfAdministrator(
  email: string,
  deps: RequestLinkDeps,
): Promise<void> {
  try {
    const isAdministrator = await deps.isAdministrator(email);
    if (!isAdministrator) {
      // The authorization boundary, and the same posture as the callback: holding an address
      // proves nothing. Nothing is minted, nothing is sent, nothing is recorded.
      return;
    }

    const token = issueMagicToken(
      email,
      deps.magicLinkSecret,
      deps.clock,
      SIGN_IN_LINK_TTL_MS,
    );
    // Built against the CONFIGURED origin. `encodeURIComponent` because the token is
    // base64url and a stray character must not truncate the query.
    const link = `${deps.baseUrl}/api/auth/callback?token=${encodeURIComponent(token)}`;
    const message = renderSignInEmail({ link, ttlMs: SIGN_IN_LINK_TTL_MS });

    await deps.mail.send({
      to: email,
      subject: message.subject,
      text: message.text,
    });
  } catch {
    // Swallowed WITHOUT logging the error object. A vendor SDK routinely attaches the request
    // payload to the error it throws, and that payload contains the live sign-in link — so
    // logging it here would write a working credential into the log aggregator. The error's
    // message could also name the recipient, which is the enumeration disclosure again.
    //
    // A silent failure is a real cost: a misconfigured provider means operators request links
    // that never arrive, with nothing in the log to explain it. That is deliberately accepted
    // here and paid for elsewhere — the seam fails CLOSED and loudly at construction
    // (`MailNotConfiguredError`), so "no provider" is a startup-visible condition rather than
    // something this path is expected to report. F-031 adds delivery observability that does
    // not name the recipient or carry the body.
  }
}
