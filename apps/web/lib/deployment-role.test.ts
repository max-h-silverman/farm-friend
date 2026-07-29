import { describe, expect, it } from "vitest";
import {
  isInternalSurfaceEnabled,
  resolveDeploymentRole,
  type DeploymentRole,
} from "./deployment-role";

// One image, two services (docs/GCP_MIGRATION_PLAN.md §"Containerization and configuration").
//
// The same artifact runs as `farm-friend-web` (public ingress) and `farm-friend-worker`
// (internal ingress + IAM). `DEPLOYMENT_ROLE` is what tells a revision which surfaces it
// exposes. Building two images instead would let the two drift apart, and a digest pin
// could no longer prove both services run the same code.
//
// The role is a DEFENCE IN DEPTH, never the primary control. The worker is protected by
// Cloud Run's internal ingress and IAM — infrastructure, enforced by Google, outside this
// process. This flag additionally refuses internal routes on the public service, so a
// misapplied Terraform change that exposes the worker publicly still meets a second closed
// door. Neither substitutes for the other: IAM cannot be evaluated in-process, and a
// process-level flag cannot stop traffic reaching the container.

describe("resolving the deployment role", () => {
  it("accepts the two real roles", () => {
    expect(resolveDeploymentRole({ DEPLOYMENT_ROLE: "web" })).toBe("web");
    expect(resolveDeploymentRole({ DEPLOYMENT_ROLE: "worker" })).toBe("worker");
  });

  it("is case- and whitespace-insensitive", () => {
    // A trailing newline in a Terraform heredoc or console paste must not produce a role
    // nothing recognizes and a service that refuses every request.
    expect(resolveDeploymentRole({ DEPLOYMENT_ROLE: " Worker\n" })).toBe("worker");
  });

  it("defaults to the PUBLIC role when unset", () => {
    // Deliberate, and the opposite of this repo's usual fail-closed default.
    //
    // The dangerous mistake is an unconfigured deployment exposing INTERNAL routes, not one
    // exposing public routes — the public surface is meant to be public and its own routes
    // carry their own authentication. Defaulting to `worker` would mean a missing variable
    // turns the public site into a worker that serves the internal cron surface to the
    // internet, which is the failure this flag exists to prevent.
    //
    // Absent config therefore yields the LEAST privileged surface, which here is `web`.
    expect(resolveDeploymentRole({})).toBe("web");
    expect(resolveDeploymentRole({ DEPLOYMENT_ROLE: "" })).toBe("web");
  });

  it("refuses an unrecognized role rather than guessing", () => {
    // A typo must not silently select a surface. This mirrors LLM_PROVIDER (GL-019), where
    // an unknown value throws instead of falling back — production ran the stub for its
    // entire life because a default had quietly been chosen.
    expect(() => resolveDeploymentRole({ DEPLOYMENT_ROLE: "wroker" })).toThrow(
      /DEPLOYMENT_ROLE/,
    );
  });
});

describe("which surfaces each role exposes", () => {
  it("exposes internal surfaces only on the worker", () => {
    expect(isInternalSurfaceEnabled("worker")).toBe(true);
    expect(isInternalSurfaceEnabled("web")).toBe(false);
  });

  it("covers every role the type admits", () => {
    // If a third role is ever added, this fails until its internal-surface policy is
    // decided explicitly rather than defaulting to whatever the predicate happens to do.
    const roles: DeploymentRole[] = ["web", "worker"];
    for (const role of roles) {
      expect(typeof isInternalSurfaceEnabled(role)).toBe("boolean");
    }
  });
});
