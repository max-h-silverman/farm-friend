// One image, two services (docs/GCP_MIGRATION_PLAN.md §"Containerization and configuration").
//
// The same artifact is deployed as `farm-friend-web` (public ingress) and
// `farm-friend-worker` (internal ingress + IAM), pinned to the same digest so a deploy can
// never put two different builds in front of one database. `DEPLOYMENT_ROLE` tells a
// revision which surfaces it exposes.
//
// This is DEFENCE IN DEPTH and never the primary control. The worker is protected by Cloud
// Run's internal-only ingress and by IAM — enforced by Google, outside this process, and
// unreachable from application code. The role flag adds a second closed door so that a
// misapplied Terraform change exposing the worker publicly, or a routing mistake that sends
// external traffic to it, still meets a refusal. Neither layer substitutes for the other:
// IAM cannot be evaluated in-process, and an in-process flag cannot stop traffic arriving.

export type DeploymentRole = "web" | "worker";

const ROLES: readonly DeploymentRole[] = ["web", "worker"];

/**
 * Resolve the role from the environment.
 *
 * ## Why absent means `web`, when this repo usually fails closed
 *
 * The dangerous misconfiguration is a deployment that exposes INTERNAL routes unintentionally,
 * not one that exposes public routes. Defaulting to `worker` would mean a missing variable
 * turns the public website into a worker serving `/api/internal/*` to the open internet.
 * Defaulting to `web` means a missing variable produces a service that refuses internal
 * routes — the safe direction. "Fail closed" here means "close the internal surface", and
 * that is what this default does.
 *
 * An UNRECOGNIZED value still throws. A typo must never silently select a surface: GL-019 is
 * the cautionary case, where `LLM_PROVIDER` defaulting to `stub` meant production ran the
 * deterministic test double against real traffic for its entire life while every check stayed
 * green. Absent is a decision; misspelled is a mistake, and the two get different answers.
 */
export function resolveDeploymentRole(
  env: Record<string, string | undefined> = process.env,
): DeploymentRole {
  const raw = env.DEPLOYMENT_ROLE;
  if (raw === undefined || raw.trim() === "") return "web";

  const normalized = raw.trim().toLowerCase();
  const role = ROLES.find((candidate) => candidate === normalized);
  if (role === undefined) {
    throw new Error(
      `DEPLOYMENT_ROLE="${raw}" is not a known role (expected "web" or "worker")`,
    );
  }
  return role;
}

/**
 * Whether this role serves the internal surfaces — the scheduled cron pass and the Cloud
 * Tasks kick handler.
 *
 * Both drive consent transitions and outbound SMS, so an internal route reachable from the
 * public service would be a remote way to drive real messaging at a real person.
 */
export function isInternalSurfaceEnabled(role: DeploymentRole): boolean {
  return role === "worker";
}
