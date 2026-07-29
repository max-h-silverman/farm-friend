import { describe, expect, it } from "vitest";
import { AuthorizationError, hasRole, requireRole, type Principal, type Role } from "./roles";

// F-027: principals carry identity + roles only. There is no tenancy dimension — one VIGA
// operation, forever, by product decision. A guard that can only ever succeed is worse than no
// guard, so the tenant comparison was deleted rather than defaulted.
//
// GL-035: launch has ONE role, so the former `admin | staff | farmer` vocabulary and its
// "admin implies staff" table are gone — nothing produced or required either value. These
// tests hold the guard to the real contract: the held role passes, everything else is
// refused, and `requireRole` never disagrees with `hasRole`.

const ROLES: readonly Role[] = ["admin"];

const admin: Principal = { personId: "p1", roles: ["admin"] };
const roleless: Principal = { personId: "p2", roles: [] };

describe("server-side role checks", () => {
  it("grants the role a principal actually holds", () => {
    expect(hasRole(admin, "admin")).toBe(true);
  });

  it("refuses a principal holding no role at all", () => {
    for (const required of ROLES) {
      expect(hasRole(roleless, required), required).toBe(false);
      expect(() => requireRole(roleless, required)).toThrow(AuthorizationError);
    }
  });

  it("grants nothing beyond what is held", () => {
    // The anti-vacuity check. A `hasRole` that returned true unconditionally — or a role
    // vocabulary that quietly grew a second value nothing checks — fails here: the set of
    // roles an `admin` principal is granted must be exactly the set it holds.
    const granted = ROLES.filter((required) => hasRole(admin, required));
    expect(granted).toEqual(["admin"]);
    expect(ROLES).toEqual(["admin"]);
  });

  it("requireRole throws for a null principal", () => {
    expect(() => requireRole(null, "admin")).toThrow(AuthorizationError);
  });

  it("requireRole passes for a sufficient role", () => {
    expect(() => requireRole(admin, "admin")).not.toThrow();
  });

  it("requireRole agrees with hasRole on every principal/role pair", () => {
    // Ties the guard to the predicate in both directions: requireRole may not throw where
    // hasRole allows, and may not pass where hasRole refuses. A requireRole that stopped
    // consulting hasRole — or consulted it and ignored the answer — fails here.
    for (const principal of [admin, roleless]) {
      for (const required of ROLES) {
        const allowed = hasRole(principal, required);
        let threw = false;
        try {
          requireRole(principal, required);
        } catch (error) {
          threw = true;
          expect(error).toBeInstanceOf(AuthorizationError);
        }
        expect(threw, `${principal.personId} / ${required}`).toBe(!allowed);
      }
    }
  });

  it("names the required role in the error", () => {
    expect(() => requireRole(roleless, "admin")).toThrow(/admin/);
    expect(() => requireRole(null, "admin")).toThrow(/admin/);
  });

  it("takes the principal and the required role as separate arguments", () => {
    // A guard that read the required role off the principal could only ever succeed.
    expect(requireRole.length).toBe(2);
    expect(hasRole.length).toBe(2);
  });
});
