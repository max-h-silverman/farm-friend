// Server-side role helper — used by EVERY route (Golden discipline: server-side role checks
// everywhere). Never trust a client-supplied role; look it up server-side and check it here.

export type Role = "admin" | "staff" | "farmer";

/** A resolved principal: who the caller is + the roles they actually hold (server-looked-up). */
export interface Principal {
  personId: string;
  tenantId: string;
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
 * every protected server route/action. Also enforces tenant match when a target tenant is given.
 */
export function requireRole(
  principal: Principal | null,
  required: Role,
  targetTenantId?: string,
): asserts principal is Principal {
  if (!principal) throw new AuthorizationError(required);
  if (targetTenantId !== undefined && principal.tenantId !== targetTenantId) {
    throw new AuthorizationError(required);
  }
  if (!hasRole(principal, required)) throw new AuthorizationError(required);
}
