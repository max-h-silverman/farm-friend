import { renderProposedSnapshot, type SnapshotEntry } from "./proposal";

export type PromptCadence =
  | "every_2_days"
  | "weekly"
  | "every_2_weeks"
  | "paused";

const CADENCE_DAYS: Readonly<Record<Exclude<PromptCadence, "paused">, number>> = {
  every_2_days: 2,
  weekly: 7,
  every_2_weeks: 14,
};

interface LocalDate {
  year: number;
  month: number;
  day: number;
}

function localDate(at: Date, timeZone: string): LocalDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((candidate) => candidate.type === type)?.value;
    if (value === undefined) throw new RangeError(`missing ${type} for ${timeZone}`);
    return Number(value);
  };
  return { year: part("year"), month: part("month"), day: part("day") };
}

function addCalendarDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** Convert an unambiguous daytime local wall-clock value to its UTC instant. */
function localTenAmToInstant(date: LocalDate, timeZone: string): Date {
  const desired = Date.UTC(date.year, date.month - 1, date.day, 10);
  let candidate = desired;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rendered = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(candidate));
    const part = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(rendered.find((value) => value.type === type)?.value);
    const observedAsUtc = Date.UTC(
      part("year"),
      part("month") - 1,
      part("day"),
      part("hour"),
      part("minute"),
      part("second"),
    );
    const corrected = candidate + (desired - observedAsUtc);
    if (corrected === candidate) return new Date(candidate);
    candidate = corrected;
  }

  return new Date(candidate);
}

/** The next cadence slot after the later durable activity, always at 10:00 location-local time. */
export function nextPromptDueSlot(input: {
  cadence: PromptCadence;
  timeZone: string;
  laterOf: Date;
}): Date | null {
  if (input.cadence === "paused") return null;
  const dueDate = addCalendarDays(localDate(input.laterOf, input.timeZone), CADENCE_DAYS[input.cadence]);
  return localTenAmToInstant(dueDate, input.timeZone);
}

/** Code-render the exact visible snapshot; SAME is absent unless the caller proved it fits. */
export function renderScheduledInventoryPrompt(input: {
  locationName: string;
  entries: SnapshotEntry[];
}): string {
  return [
    `For ${input.locationName}:`,
    renderProposedSnapshot({
      entries: input.entries,
      baseRevisionId: null,
      isFirstPublication: false,
    }),
    "Reply SAME if this complete listing is still right, or text what changed.",
  ].join("\n\n");
}

/** Code-rendered fallback when no published base exists or the full prompt exceeds its ceiling. */
export function renderScheduledInventoryUpdateRequest(input: {
  locationName: string;
}): string {
  return `${input.locationName}: no complete current listing can be shown here. Please text what is available now.`;
}
