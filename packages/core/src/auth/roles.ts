// Server-side role helper — used by EVERY route (Golden discipline: server-side role checks
// everywhere). Never trust a client-supplied role; look it up server-side and check it here.

export type Role = "admin" | "staff" | "farmer";

/** A resolved principal: who the caller is + the roles they actually hold (server-looked-up). */
export interface Principal {
  personId: string;
  roles: Role[];
}

// admin implies staff (admins can do anything staff can). farmer is orthogonal.
const IMPLIES: Record<Role, Role[]> = {
  admin: ["admin", "staff"],
  staff: ["staff"],
  farmer: ["farmer"],
};

/** True iff the principal holds (directly or by implication) the required role. */
export function hasRole(principal: Principal, required: Role): boolean {
  return principal.roles.some((held) => IMPLIES[held].includes(required));
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
 * The authority check is the role check — there is no second scope dimension. Launch is a single
 * VIGA operation, so a scope comparison could only ever succeed, and a guard that cannot fail
 * reads as protection while proving nothing.
 */
export function requireRole(
  principal: Principal | null,
  required: Role,
): asserts principal is Principal {
  if (!principal) throw new AuthorizationError(required);
  if (!hasRole(principal, required)) throw new AuthorizationError(required);
}
