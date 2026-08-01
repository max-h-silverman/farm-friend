import { isLocalDate } from "../public/closure";

export type ClosureTimingEvidence =
  | { kind: "none" }
  | { kind: "reopen" }
  | {
      kind: "close";
      closureKind: "temporary" | "seasonal";
      startsOn: string;
      closedThrough?: string;
    };

export type ClosureTimingPreflight =
  | { kind: "proceed"; evidence: ClosureTimingEvidence }
  | { kind: "clarification"; question: string };

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const MONTH_PATTERN = Object.keys(MONTHS).join("|");
const MONTH_RANGE_RE = new RegExp(
  `\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:\\s*(?:-|–|—|through|thru|to)\\s*(?:(${MONTH_PATTERN})\\s+)?(\\d{1,2}))?(?:,?\\s+(\\d{4}))?\\b`,
  "gi",
);
const CLOSE_RE = /\bclos(?:e|ed|ing)\b/i;
const REOPEN_RE = /\breopen(?:ed|ing)?\b|\bopen again\b/i;
const VAGUE_RE = /\b(?:for a while|for awhile|for some time|for a bit|temporarily)\b/i;
const STAND_OPEN_RE =
  /\b(?:the\s+|our\s+)?(?:farm\s+)?(?:stand|farmstand|farm|location|shop|store)\s+(?:is|will be|stays?|remains?)\s+open\b/i;
const SUBJECT_CLOSED_RE =
  /\b(?:the|our)\s+([a-z][a-z -]{0,40}?)\s+(?:is|will be|stays?|remains?)\s+closed\b/i;
const WHOLE_LOCATION_RE = /\b(?:stand|farmstand|farm|location|shop|store)\b/i;

function dateString(year: number, month: number, day: number): string | null {
  const value = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isLocalDate(value) ? value : null;
}

function addDays(localDate: string, days: number): string {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function thisWeekend(localDate: string): ClosureTimingEvidence {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const daysUntilSaturday = weekday === 0 ? -1 : (6 - weekday + 7) % 7;
  const startsOn = addDays(localDate, daysUntilSaturday);
  return {
    kind: "close",
    closureKind: "temporary",
    startsOn,
    closedThrough: addDays(startsOn, 1),
  };
}

function explicitWindows(taskText: string, currentLocalDate: string): ClosureTimingEvidence[] {
  const currentYear = Number(currentLocalDate.slice(0, 4));
  const windows: ClosureTimingEvidence[] = [];
  for (const match of taskText.matchAll(MONTH_RANGE_RE)) {
    const startMonth = MONTHS[match[1]!.toLowerCase()];
    const startDay = Number(match[2]);
    const endMonth = match[3]
      ? MONTHS[match[3].toLowerCase()]
      : startMonth;
    const endDay = match[4] ? Number(match[4]) : undefined;
    const startYear = match[5] ? Number(match[5]) : currentYear;
    const endYear =
      endMonth !== undefined && startMonth !== undefined && endMonth < startMonth
        ? startYear + 1
        : startYear;
    if (startMonth === undefined || endMonth === undefined) continue;
    const startsOn = dateString(startYear, startMonth, startDay);
    const closedThrough =
      endDay === undefined ? undefined : dateString(endYear, endMonth, endDay);
    if (startsOn === null || (endDay !== undefined && closedThrough === null)) continue;
    windows.push({
      kind: "close",
      closureKind: "temporary",
      startsOn,
      ...(closedThrough !== undefined && closedThrough !== null ? { closedThrough } : {}),
    });
  }
  return windows;
}

/**
 * Resolve closure timing code can understand before a model call. Unsupported or ambiguous
 * timing asks the farmer instead of making the model invent calendar facts.
 */
export function preflightClosureTiming(
  taskText: string,
  currentLocalDate: string,
): ClosureTimingPreflight {
  if (!isLocalDate(currentLocalDate)) {
    return { kind: "clarification", question: "What dates should I use for the closure?" };
  }
  const closes = CLOSE_RE.test(taskText);
  const reopens = REOPEN_RE.test(taskText);
  if (!closes) {
    return {
      kind: "proceed",
      evidence: reopens ? { kind: "reopen" } : { kind: "none" },
    };
  }

  if (reopens || STAND_OPEN_RE.test(taskText)) {
    return {
      kind: "clarification",
      question: "Is the whole stand open or closed?",
    };
  }
  const subject = SUBJECT_CLOSED_RE.exec(taskText)?.[1];
  if (subject !== undefined && !WHOLE_LOCATION_RE.test(subject)) {
    return {
      kind: "clarification",
      question: "Is the whole stand closed, or only part of it?",
    };
  }
  if (VAGUE_RE.test(taskText)) {
    return {
      kind: "clarification",
      question: "What exact dates should I use for the closure?",
    };
  }

  const windows = explicitWindows(taskText, currentLocalDate);
  if (
    windows.some(
      (window) =>
        window.kind === "close" &&
        window.closedThrough !== undefined &&
        window.closedThrough < window.startsOn,
    )
  ) {
    return {
      kind: "clarification",
      question: "The closure end is before its start. What dates should I use?",
    };
  }
  const relativeWeekends = [...taskText.matchAll(/\bthis\s+weekend\b/gi)].map(() =>
    thisWeekend(currentLocalDate),
  );
  const allWindows = [...windows, ...relativeWeekends];
  if (allWindows.length > 1 || /\band\s+again\b/i.test(taskText)) {
    return {
      kind: "clarification",
      question: "I can confirm one closure at a time. Which date range should I use?",
    };
  }
  if (allWindows.length === 1) {
    return { kind: "proceed", evidence: allWindows[0]! };
  }
  if (/\b(?:for|through)\s+(?:the\s+)?season\b/i.test(taskText)) {
    return {
      kind: "proceed",
      evidence: {
        kind: "close",
        closureKind: "seasonal",
        startsOn: currentLocalDate,
      },
    };
  }
  if (
    /\buntil\s+further\s+notice\b/i.test(taskText) ||
    /^\s*(?:we(?:'re| are)\s+)?closed[.!]?\s*$/i.test(taskText) ||
    (subject !== undefined && WHOLE_LOCATION_RE.test(subject))
  ) {
    return {
      kind: "proceed",
      evidence: {
        kind: "close",
        closureKind: "temporary",
        startsOn: currentLocalDate,
      },
    };
  }
  return {
    kind: "clarification",
    question: "What exact dates should I use for the closure?",
  };
}

export function closureMatchesTiming(
  closure: import("../public/closure").ClosureInstruction | undefined,
  evidence: ClosureTimingEvidence,
): boolean {
  if (evidence.kind === "none") return closure === undefined;
  if (evidence.kind === "reopen") return closure?.result === "reopen";
  if (!closure || closure.result !== "close") return false;
  return (
    closure.closureKind === evidence.closureKind &&
    closure.startsOn === evidence.startsOn &&
    closure.closedThrough === evidence.closedThrough
  );
}
