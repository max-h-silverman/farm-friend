// Server-side role helper — used by EVERY protected route (never trust a client-supplied
// role; look it up server-side and check it here). `apps/web/lib/admin-guard.ts` is the one
// guard the admin API routes share, and the four admin pages call `hasRole` directly.
//
// GL-035: there is exactly ONE role. This used to declare `admin | staff | farmer` with an
// "admin implies staff" hierarchy, and nothing anywhere produced or required `staff` or
// `farmer` — `packages/db/src/admin.ts` returns the constant `["admin"]`, which is the whole
// role vocabulary in existence. Multi-level roles are an explicit launch non-goal, so the
// hierarchy was a speculative mechanism whose only exercise was its own unit test. Worse, an
// implication table that can never fire reads as protection while proving nothing, and
// invites a future change to treat the dimension as an existing property to preserve.
//
// Adding a second role later means adding the value and whatever check it genuinely needs —
// not restoring this table. Do not pre-create it.

/** The one role at launch. A single VIGA operation with one administrator level. */
export type Role = "admin";

/** A resolved principal: who the caller is + the roles they actually hold (server-looked-up). */
export interface Principal {
  personId: string;
  roles: Role[];
}

/** True iff the principal holds the required role. */
export function hasRole(principal: Principal, required: Role): boolean {
  return principal.roles.includes(required);
}

export class AuthorizationError extends Error {
  constructor(required: Role) {
    super(`Forbidden: requires role "${required}"`);
    this.name = "AuthorizationError";
  }
}

/**
 * Route guard: assert the principal holds `required`, throwing otherwise. Call at the top of
 * every protected server route/action.
 *
 * The authority check is the role check — there is no second scope dimension. Launch is a
 * single VIGA operation, so a scope comparison could only ever succeed, and a guard that
 * cannot fail reads as protection while proving nothing.
 */
export function requireRole(
  principal: Principal | null,
  required: Role,
): asserts principal is Principal {
  if (!principal) throw new AuthorizationError(required);
  if (!hasRole(principal, required)) throw new AuthorizationError(required);
}
