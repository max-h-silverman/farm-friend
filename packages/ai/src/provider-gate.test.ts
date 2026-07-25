import { describe, expect, it } from "vitest";
import {
  assertProviderApproved,
  checkProviderDataHandling,
  MAX_APPROVED_PROVIDER_RETENTION_DAYS,
  ProviderGateError,
  type ProviderDataHandling,
} from "./index";

const approved: ProviderDataHandling = {
  trainsOnData: false,
  statefulStorage: false,
  requestLoggingDisabled: true,
  retentionDays: 0,
};

describe("provider privacy gate", () => {
  it("accepts a provider meeting every approved term", () => {
    expect(checkProviderDataHandling(approved).ok).toBe(true);
    expect(() => assertProviderApproved("stub", approved)).not.toThrow();
  });

  it("refuses a provider that trains on Farm Friend data", () => {
    const result = checkProviderDataHandling({ ...approved, trainsOnData: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]).toContain("trains on");
  });

  it("refuses provider-managed conversations, files, memory, or retrieval state", () => {
    const result = checkProviderDataHandling({ ...approved, statefulStorage: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]).toContain("retains conversations");
  });

  it("refuses a provider whose request/response logging is not disabled", () => {
    const result = checkProviderDataHandling({ ...approved, requestLoggingDisabled: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]).toContain("logging is not disabled");
  });

  it("refuses retention beyond the approved maximum, and permits it at the boundary", () => {
    const over = checkProviderDataHandling({
      ...approved,
      retentionDays: MAX_APPROVED_PROVIDER_RETENTION_DAYS + 1,
    });
    expect(over.ok).toBe(false);

    const at = checkProviderDataHandling({
      ...approved,
      retentionDays: MAX_APPROVED_PROVIDER_RETENTION_DAYS,
    });
    expect(at.ok).toBe(true);
  });

  it("refuses an unspecified retention window rather than assuming zero", () => {
    expect(checkProviderDataHandling({ ...approved, retentionDays: NaN }).ok).toBe(false);
    expect(checkProviderDataHandling({ ...approved, retentionDays: -1 }).ok).toBe(false);
  });

  it("reports every violation at once and fails closed by throwing", () => {
    const result = checkProviderDataHandling({
      trainsOnData: true,
      statefulStorage: true,
      requestLoggingDisabled: false,
      retentionDays: 400,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations).toHaveLength(4);

    expect(() =>
      assertProviderApproved("hostile-vendor", { ...approved, trainsOnData: true }),
    ).toThrow(ProviderGateError);
  });
});
