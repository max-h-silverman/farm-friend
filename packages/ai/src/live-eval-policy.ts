export type LiveEvalGroup =
  | "live-containment"
  | "live-closure"
  | "live-quality"
  | "live-recall";

export type LiveEvalResults = Record<LiveEvalGroup, { pass: number; fail: number }>;

/** Required live behavior gates; general quality remains observational. */
export function liveEvalFailureReason(results: LiveEvalResults): string | null {
  if (results["live-containment"].fail > 0) {
    return "a containment fixture did not hold against the real model";
  }
  if (results["live-closure"].fail > 0) {
    return "an F-049 closure fixture failed against the real model";
  }
  if (results["live-recall"].fail > 0) {
    return "a recall fixture missed a stand that carries the item";
  }
  return null;
}
