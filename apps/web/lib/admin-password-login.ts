import { z } from "zod";
import {
  ADMIN_SESSION_TTL_MS,
  hashSessionToken,
  type Clock,
} from "@farm-friend/core";
import type {
  AdminLoginReservation,
  CreateAdminSessionInput,
  CreateAdminSessionResult,
} from "@farm-friend/db";
import { serializeSessionCookie } from "./admin-auth";
import { adminLoginBucketsFor } from "./admin-login-signal";
import {
  ADMIN_PASSWORD_MAX_LENGTH,
  FIXED_ADMIN_EMAIL,
} from "./admin-password";

export { FIXED_ADMIN_EMAIL } from "./admin-password";

const requestSchema = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(ADMIN_PASSWORD_MAX_LENGTH),
}).strict();

export interface AdminPasswordLoginDeps {
  clock: Clock;
  signalSalt: string;
  passwordHash: string;
  verifyPassword(passwordHash: string, password: string): Promise<boolean>;
  reserveAttempt(input: {
    accountBucketHash: string;
    clientBucketHash: string;
    now: Date;
  }): Promise<AdminLoginReservation>;
  clearFailures(input: {
    accountBucketHash: string;
    clientBucketHash: string;
  }): Promise<unknown>;
  findAdministrator(): Promise<{ administratorId: string } | null>;
  createSession(input: CreateAdminSessionInput): Promise<CreateAdminSessionResult>;
  issueSessionToken(): string;
}

function isNativeForm(req: Request): boolean {
  return (req.headers.get("content-type") ?? "").includes(
    "application/x-www-form-urlencoded",
  );
}

export function adminLoginRefusalResponse(req: Request): Response {
  const nativeForm = isNativeForm(req);
  if (nativeForm) {
    return new Response(null, {
      status: 303,
      headers: { location: "/admin/login?failed=1" },
    });
  }
  return Response.json({ authenticated: false }, { status: 401 });
}

async function readBody(req: Request): Promise<unknown> {
  try {
    if (isNativeForm(req)) {
      return Object.fromEntries(new URLSearchParams(await req.text()));
    }
    if (!(req.headers.get("content-type") ?? "").includes("application/json")) return null;
    return await req.json();
  } catch {
    return null;
  }
}

function normalizedEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Public fixed-account login. Every failed condition collapses to one response; neither the
 * password verifier nor the durable authority lookup can become a membership oracle.
 */
export async function handleAdminPasswordLogin(
  req: Request,
  deps: AdminPasswordLoginDeps,
): Promise<Response> {
  const nativeForm = isNativeForm(req);
  const now = deps.clock.now();
  const buckets = adminLoginBucketsFor(req.headers, deps.signalSalt);

  try {
    const reservation = await deps.reserveAttempt({ ...buckets, now });
    if (!reservation.allowed) return adminLoginRefusalResponse(req);

    const parsed = requestSchema.safeParse(await readBody(req));
    const candidatePassword = parsed.success ? parsed.data.password : "invalid-request";

    // A syntactically valid wrong email performs the same expensive verifier and fixed-row
    // lookup as the real email. Email is checked only after both, so timing cannot reveal it.
    const passwordMatches = await deps.verifyPassword(
      deps.passwordHash,
      candidatePassword,
    );
    const administrator = await deps.findAdministrator();
    const emailMatches =
      parsed.success && normalizedEmail(parsed.data.email) === FIXED_ADMIN_EMAIL;
    if (!parsed.success || !emailMatches || !passwordMatches || administrator === null) {
      return adminLoginRefusalResponse(req);
    }

    const sessionToken = deps.issueSessionToken();
    const created = await deps.createSession({
      tokenHash: hashSessionToken(sessionToken),
      administratorId: administrator.administratorId,
      issuedAt: now,
    });
    if (created.status !== "created") return adminLoginRefusalResponse(req);

    await deps.clearFailures(buckets);
    const cookie = serializeSessionCookie(sessionToken, ADMIN_SESSION_TTL_MS);
    if (nativeForm) {
      return new Response(null, {
        status: 303,
        headers: { location: "/admin", "set-cookie": cookie },
      });
    }
    return Response.json(
      { authenticated: true },
      { status: 200, headers: { "set-cookie": cookie } },
    );
  } catch {
    // Never log the error: an Argon/provider error can attach verifier or request material.
    return adminLoginRefusalResponse(req);
  }
}
