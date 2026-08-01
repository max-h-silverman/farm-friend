/**
 * Vashon's one reviewed civil timezone.
 *
 * Closure dates are farmer-authored local calendar dates. A per-location timezone would
 * require an authority and backfill Farm Friend does not have; every launch location is on
 * Vashon, so one explicit constant is the honest fact.
 */
export const VASHON_TIME_ZONE = "America/Los_Angeles";

export type ClosureInstruction =
  | { result: "reopen" }
  | {
      result: "close";
      closureKind: "temporary" | "seasonal";
      startsOn: string;
      closedThrough?: string;
    };

export type ClosureProjection =
  | { state: "none" }
  | {
      state: "active" | "upcoming";
      closureKind: "temporary" | "seasonal";
      startsOn: string;
      closedThrough?: string;
    };

export type ClosureValidation =
  | { ok: true; value: ClosureInstruction }
  | { ok: false; reason: string };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLocalDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

/** Validate untrusted closure output before it can enter a proposal. */
export function validateClosureInstruction(candidate: unknown): ClosureValidation {
  if (typeof candidate !== "object" || candidate === null) {
    return { ok: false, reason: "closure must be an object" };
  }
  const record = candidate as Record<string, unknown>;

  if (record.result === "reopen") {
    if (!exactKeys(record, ["result"])) {
      return { ok: false, reason: "reopen carries no kind, dates, or note" };
    }
    return { ok: true, value: { result: "reopen" } };
  }

  if (record.result !== "close") {
    return { ok: false, reason: "closure result must be close or reopen" };
  }
  if (!exactKeys(record, ["result", "closureKind", "startsOn", "closedThrough"])) {
    return { ok: false, reason: "close carries only its kind and local dates" };
  }
  if (record.closureKind !== "temporary" && record.closureKind !== "seasonal") {
    return { ok: false, reason: "close requires a closure kind" };
  }
  if (!isLocalDate(record.startsOn)) {
    return { ok: false, reason: "close requires a valid local start date" };
  }

  if (record.closureKind === "seasonal") {
    if (record.closedThrough !== undefined) {
      return { ok: false, reason: "seasonal closure has no end date" };
    }
    return {
      ok: true,
      value: {
        result: "close",
        closureKind: "seasonal",
        startsOn: record.startsOn,
      },
    };
  }

  if (record.closedThrough !== undefined && !isLocalDate(record.closedThrough)) {
    return { ok: false, reason: "temporary closure end must be a valid local date" };
  }
  if (
    typeof record.closedThrough === "string" &&
    record.closedThrough < record.startsOn
  ) {
    return { ok: false, reason: "closure end cannot precede its start" };
  }
  return {
    ok: true,
    value: {
      result: "close",
      closureKind: "temporary",
      startsOn: record.startsOn,
      ...(typeof record.closedThrough === "string"
        ? { closedThrough: record.closedThrough }
        : {}),
    },
  };
}

/** Convert an instant to the code-owned local calendar date used for Vashon closures. */
export function vashonLocalDate(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: VASHON_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * The single read-time closure projection shared by public web, Open now, discovery, and SMS.
 * Bounded expiry is comparison only: no timer rewrites immutable history.
 */
export function projectClosure(
  instruction: ClosureInstruction | null | undefined,
  at: Date,
): ClosureProjection {
  if (!instruction || instruction.result === "reopen") return { state: "none" };

  const today = vashonLocalDate(at);
  if (instruction.closedThrough !== undefined && today > instruction.closedThrough) {
    return { state: "none" };
  }
  return {
    state: today < instruction.startsOn ? "upcoming" : "active",
    closureKind: instruction.closureKind,
    startsOn: instruction.startsOn,
    ...(instruction.closedThrough !== undefined
      ? { closedThrough: instruction.closedThrough }
      : {}),
  };
}

function displayDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(new Date(`${value}T00:00:00Z`));
}

/** Code-rendered public status; no farmer-authored closure note exists. */
export function renderClosureStatus(projection: ClosureProjection): string | null {
  if (projection.state === "none") return null;
  if (projection.state === "upcoming") {
    if (projection.closureKind === "seasonal") {
      return `Closing for the season ${displayDate(projection.startsOn)}.`;
    }
    return projection.closedThrough
      ? `Closing ${displayDate(projection.startsOn)} through ${displayDate(projection.closedThrough)}.`
      : `Temporarily closing ${displayDate(projection.startsOn)}.`;
  }
  if (projection.closureKind === "seasonal") return "Closed for the season.";
  return projection.closedThrough
    ? `Closed through ${displayDate(projection.closedThrough)}.`
    : "Temporarily closed.";
}
