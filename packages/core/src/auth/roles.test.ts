import { describe, expect, it } from "vitest";
import { AuthorizationError, hasRole, requireRole, type Principal } from "./roles";

const admin: Principal = { personId: "p1", tenantId: "t1", roles: ["admin"] };
const staff: Principal = { personId: "p2", tenantId: "t1", roles: ["staff"] };
const farmer: Principal = { personId: "p3", tenantId: "t1", roles: ["farmer"] };

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
    expect(hasRole(farmer, "farmer")).toBe(true);
  });

  it("requireRole throws for a null principal or insufficient role", () => {
    expect(() => requireRole(null, "staff")).toThrow(AuthorizationError);
    expect(() => requireRole(farmer, "admin")).toThrow(AuthorizationError);
  });

  it("requireRole enforces tenant match (no cross-tenant access)", () => {
    expect(() => requireRole(admin, "admin", "t2")).toThrow(AuthorizationError);
    expect(() => requireRole(admin, "admin", "t1")).not.toThrow();
  });

  it("requireRole passes for a sufficient role", () => {
    expect(() => requireRole(admin, "staff")).not.toThrow();
    expect(() => requireRole(staff, "staff")).not.toThrow();
  });
});
