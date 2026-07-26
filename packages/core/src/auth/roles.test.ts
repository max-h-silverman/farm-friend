import { describe, expect, it } from "vitest";
import { AuthorizationError, hasRole, requireRole, type Principal } from "./roles";

// F-027: principals carry identity + roles only. There is no tenancy dimension — one VIGA
// operation, forever, by product decision. A guard that can only ever succeed is worse than no
// guard, so the tenant comparison was deleted rather than defaulted.

const admin: Principal = { personId: "p1", roles: ["admin"] };
const staff: Principal = { personId: "p2", roles: ["staff"] };
const farmer: Principal = { personId: "p3", roles: ["farmer"] };
const roleless: Principal = { personId: "p4", roles: [] };
const farmerStaff: Principal = { personId: "p5", roles: ["farmer", "staff"] };

const ROLES = ["admin", "staff", "farmer"] as const;

describe("server-side role helper", () => {
  it("admin implies staff", () => {
    expect(hasRole(admin, "staff")).toBe(true);
    expect(hasRole(admin, "admin")).toBe(true);
  });

  it("staff does not imply admin", () => {
    expect(hasRole(staff, "admin")).toBe(false);
    expect(hasRole(staff, "staff")).toBe(true);
  });

  it("farmer is orthogonal to staff/admin", () => {
    expect(hasRole(farmer, "staff")).toBe(false);
    expect(hasRole(farmer, "admin")).toBe(false);
    expect(hasRole(farmer, "farmer")).toBe(true);
  });

  it("neither staff nor admin implies farmer", () => {
    // Orthogonality runs both ways: an operator role must not silently confer the ability to
    // act as a farm's owner. Only the farmer publishes a farm's state (Golden rule #1).
    expect(hasRole(staff, "farmer")).toBe(false);
    expect(hasRole(admin, "farmer")).toBe(false);
  });

  it("holds exactly the implied set for every role, and nothing more", () => {
    // The full implication matrix, stated positively AND negatively, so that widening
    // `IMPLIES` (or making `hasRole` return true unconditionally) fails here.
    const expected: Record<(typeof ROLES)[number], readonly string[]> = {
      admin: ["admin", "staff"],
      staff: ["staff"],
      farmer: ["farmer"],
    };

    for (const held of ROLES) {
      const principal: Principal = { personId: `p-${held}`, roles: [held] };
      const granted = ROLES.filter((required) => hasRole(principal, required));
      expect(granted, `roles granted by "${held}"`).toEqual(
        ROLES.filter((required) => expected[held].includes(required)),
      );
    }
  });

  it("grants nothing to a principal holding no roles", () => {
    // The realistic production shape today: resolvePrincipal returns an empty role list until
    // the DB-backed lookup lands (F-025). An authenticated caller must still be refused.
    for (const required of ROLES) {
      expect(hasRole(roleless, required), required).toBe(false);
      expect(() => requireRole(roleless, required)).toThrow(AuthorizationError);
    }
  });

  it("unions the implications of multiple held roles", () => {
    expect(hasRole(farmerStaff, "farmer")).toBe(true);
    expect(hasRole(farmerStaff, "staff")).toBe(true);
    expect(hasRole(farmerStaff, "admin")).toBe(false);
  });

  it("requireRole throws for a null principal", () => {
    expect(() => requireRole(null, "staff")).toThrow(AuthorizationError);
    expect(() => requireRole(null, "admin")).toThrow(AuthorizationError);
    expect(() => requireRole(null, "farmer")).toThrow(AuthorizationError);
  });

  it("requireRole refuses every insufficient role, at each boundary", () => {
    // Each pair is a distinct way the guard could be weakened: the orthogonal role reaching an
    // operator role, the operator role escalating to admin, and an operator role reaching the
    // farmer capability.
    const refused: ReadonlyArray<[Principal, (typeof ROLES)[number], string]> = [
      [farmer, "admin", "farmer must not escalate to admin"],
      [farmer, "staff", "farmer must not reach staff"],
      [staff, "admin", "staff must not escalate to admin"],
      [staff, "farmer", "staff must not act as a farmer"],
      [admin, "farmer", "admin must not act as a farmer"],
    ];

    for (const [principal, required, why] of refused) {
      expect(() => requireRole(principal, required), why).toThrow(AuthorizationError);
    }
  });

  it("requireRole passes for a sufficient role, directly or by implication", () => {
    expect(() => requireRole(admin, "admin")).not.toThrow();
    expect(() => requireRole(admin, "staff")).not.toThrow();
    expect(() => requireRole(staff, "staff")).not.toThrow();
    expect(() => requireRole(farmer, "farmer")).not.toThrow();
  });

  it("requireRole agrees with hasRole on every principal/role pair", () => {
    // Ties the guard to the predicate in both directions: requireRole may not throw where
    // hasRole allows, and may not pass where hasRole refuses. A requireRole that stopped
    // throwing — or started throwing always — breaks this regardless of the cases above.
    const principals = [admin, staff, farmer, roleless, farmerStaff];
    let threw = 0;
    let passed = 0;

    for (const principal of principals) {
      for (const required of ROLES) {
        const allowed = hasRole(principal, required);
        let didThrow = false;
        try {
          requireRole(principal, required);
        } catch (error) {
          didThrow = true;
          expect(error).toBeInstanceOf(AuthorizationError);
        }
        expect(didThrow, `${principal.personId} → ${required}`).toBe(!allowed);
        if (didThrow) threw++;
        else passed++;
      }
    }

    // Guard against a vacuous pass: the matrix must exercise both outcomes.
    expect(threw).toBeGreaterThan(0);
    expect(passed).toBeGreaterThan(0);
  });

  it("names the required role in the thrown error", () => {
    expect(() => requireRole(farmer, "admin")).toThrow(/admin/);
    expect(() => requireRole(null, "staff")).toThrow(/staff/);
  });

  it("takes no argument beyond the principal and the required role", () => {
    // The deleted tenant comparison arrived as a third parameter. Its absence is part of the
    // contract: a reintroduced optional scope argument would again be a check that cannot fail.
    expect(requireRole.length).toBe(2);
    expect(hasRole.length).toBe(2);
  });
});
