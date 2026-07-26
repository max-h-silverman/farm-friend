// The provider privacy gate (docs/AI_ARCHITECTURE.md §"Provider privacy gate").
//
// A model-version swap under the SAME approved data-handling contract is a config change
// plus an eval run. Changing the provider, or changing its training, logging, retention, or
// stateful-storage behavior, must re-pass this gate. It fails CLOSED at startup: an
// unapproved or under-specified provider configuration is a configuration error, never a
// silent degradation to a provider that might train on or retain Farm Friend's data.
//
// This gate checks the DECLARED data-handling terms Farm Friend has approved for a provider.
// It is an operator-attested configuration check, not a network audit — Farm Friend cannot
// verify a vendor's internal practice from inside the process. What it buys is that the
// declaration is explicit, reviewed, and version-controlled rather than assumed.

/** The data-handling terms a provider must satisfy before it may be configured. */
export interface ProviderDataHandling {
  /** The provider contractually does not train on Farm Friend requests or responses. */
  trainsOnData: boolean;
  /** Calls are stateless: no provider-managed conversations, files, memory, or retrieval. */
  statefulStorage: boolean;
  /** Provider request/response logging is disabled where the provider supports doing so. */
  requestLoggingDisabled: boolean;
  /**
   * Maximum days of unavoidable provider-side retention. Must not exceed Farm Friend's
   * approved raw-context retention window.
   */
  retentionDays: number;
}

/** Farm Friend's approved maximum for unavoidable provider-side retention, in days. */
export const MAX_APPROVED_PROVIDER_RETENTION_DAYS = 30;

export class ProviderGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderGateError";
  }
}

export type ProviderGateResult =
  | { ok: true }
  | { ok: false; violations: string[] };

/** Evaluate a provider's declared data handling against the approved requirements. */
export function checkProviderDataHandling(
  declared: ProviderDataHandling,
): ProviderGateResult {
  const violations: string[] = [];

  if (declared.trainsOnData) {
    violations.push("provider trains on Farm Friend request/response data");
  }
  if (declared.statefulStorage) {
    violations.push(
      "provider retains conversations, files, memory, or retrieval state across calls",
    );
  }
  if (!declared.requestLoggingDisabled) {
    violations.push("provider request/response logging is not disabled");
  }
  if (!Number.isFinite(declared.retentionDays) || declared.retentionDays < 0) {
    violations.push("provider retention window is unspecified");
  } else if (declared.retentionDays > MAX_APPROVED_PROVIDER_RETENTION_DAYS) {
    violations.push(
      `provider retention of ${declared.retentionDays}d exceeds the approved ` +
        `maximum of ${MAX_APPROVED_PROVIDER_RETENTION_DAYS}d`,
    );
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

/**
 * Assert the gate at composition time. Throws before any model call is possible, so a
 * provider that cannot meet the requirements is never constructed.
 */
export function assertProviderApproved(
  providerName: string,
  declared: ProviderDataHandling,
): void {
  const result = checkProviderDataHandling(declared);
  if (!result.ok) {
    throw new ProviderGateError(
      `Provider "${providerName}" fails the privacy gate: ${result.violations.join("; ")}.`,
    );
  }
}
