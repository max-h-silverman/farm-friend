import {
  projectClosure,
  renderClosureStatus,
  type ClosureInstruction,
  type ClosureProjection,
} from "@farm-friend/core";

/** The public shape every web/SMS reader consumes after one canonical read-time decision. */
export type PublicClosure = Exclude<ClosureProjection, { state: "none" }> & {
  label: string;
};

/**
 * Turn the current durable row selected by a reader into the one canonical projection.
 * Queries alias their columns to these names; no surface computes expiry or status itself.
 */
export function readPublicClosure(
  row: Record<string, unknown>,
  at: Date,
): PublicClosure | undefined {
  const result = row.closure_result as "close" | "reopen" | null | undefined;
  if (!result) return undefined;
  const instruction: ClosureInstruction =
    result === "reopen"
      ? { result: "reopen" }
      : {
          result: "close",
          closureKind: row.closure_kind as "temporary" | "seasonal",
          startsOn: row.closure_starts_on as string,
          ...(row.closure_closed_through !== null &&
          row.closure_closed_through !== undefined
            ? { closedThrough: row.closure_closed_through as string }
            : {}),
        };
  const projection = projectClosure(instruction, at);
  if (projection.state === "none") return undefined;
  const label = renderClosureStatus(projection);
  if (label === null) return undefined;
  return { ...projection, label };
}
