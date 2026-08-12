import { renderShortElapsed } from "../inquiry/answer";
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

/**
 * The opt-out reminder, carried by the scheduled prompt and nothing else (F-096).
 *
 * **This is the one place a periodic footer is genuinely earned.** No rule requires opt-out
 * language on every message — the obligations are the opt-in confirmation, the HELP response,
 * and that STOP always works, none of which depend on advertising it here. What makes this
 * different is that it is the only stream where Farm Friend speaks FIRST, on a cadence, for as
 * long as the farmer stays enrolled. A farmer months into that must have seen the exit recently.
 *
 * Every reply-shaped message lost its footer in the same change: those answer something the
 * farmer sent seconds earlier, where the boilerplate is noise on their own errand.
 *
 * **Deliberately NOT every-Nth-send.** That needs durable state tracking when each recipient
 * last saw it, and max chose the simple version first (2026-08-08) — revisit only if farmers
 * report the prompts read as boilerplate.
 *
 * **It costs one item of snapshot capacity, measured not assumed**: against F-046's live-corpus
 * range of 22-57 characters per entry, a prompt fits 7/4/3 items inside
 * `MAX_SCHEDULED_PROMPT_SEGMENTS` with this footer and 8/4/3 without. Past that ceiling
 * `scheduledPromptFitsSms` withdraws the `SAME` offer and the farmer gets the fallback, so the
 * cost of this line is that a stand one item over now retypes instead of replying with one word.
 * Typical stands sit under it, which is why it is acceptable rather than free.
 */
const SCHEDULED_PROMPT_OPT_OUT = "Reply STOP to opt out.";

/**
 * The prompt's own heading, which deliberately does NOT reuse the proposal renderer's.
 *
 * "Your stand will show:" is confirmation copy — it describes something about to publish, and
 * the farmer is reading it to approve a change. Nothing publishes here: this is the listing
 * that is ALREADY live, shown so the farmer can correct it. A future tense on a record of the
 * present is the same class of error as B-063, where a present-tense label sat next to a
 * fortnight-old timestamp on a customer's handset.
 *
 * **"Items listed", not "In stock" (max, 2026-08-12).** The heading states what our record
 * holds, never what the stand currently has — the farmer is the authority on the second, and
 * asking them is the entire point of the message. The recency stamp then says how old the
 * record is, using the same `renderShortElapsed` arithmetic as the SMS answer path, so one
 * listing cannot read as a week old over SMS and a fortnight old on the web.
 *
 * It costs against `MAX_SCHEDULED_PROMPT_SEGMENTS`, measured not assumed: at the 22/40/57
 * characters-per-entry F-046 found in the live corpus, a prompt fits 7/4/3 items with this
 * heading. Past that ceiling `scheduledPromptFitsSms` withdraws the `SAME` offer.
 */
function scheduledPromptHeading(
  locationName: string,
  publishedAt: Date | null,
  now: Date,
): string {
  return publishedAt === null
    ? `Items listed for ${locationName}:`
    : `Items listed for ${locationName} (updated ${renderShortElapsed(publishedAt, now)}):`;
}

/** Code-render the exact visible snapshot; SAME is absent unless the caller proved it fits. */
export function renderScheduledInventoryPrompt(input: {
  locationName: string;
  entries: SnapshotEntry[];
  /** When the shown revision published. Null renders no recency claim rather than a false one. */
  publishedAt: Date | null;
  now: Date;
}): string {
  return [
    scheduledPromptHeading(input.locationName, input.publishedAt, input.now),
    renderScheduledSnapshotItems(input.entries),
    "Reply SAME to confirm, or let us know what changed.",
    SCHEDULED_PROMPT_OPT_OUT,
  ].join("\n\n");
}

/** The item lines alone: this prompt has its own heading, and nothing here is being removed. */
function renderScheduledSnapshotItems(entries: SnapshotEntry[]): string {
  const rendered = renderProposedSnapshot({
    entries,
    baseRevisionId: null,
    isFirstPublication: false,
    // This prompt shows what is ALREADY published, not a proposed change — nothing is
    // being taken off, so there is no loss to name.
    removedItemNames: [],
  });
  const [, ...lines] = rendered.split("\n");
  // An empty snapshot renders one sentence and no items; it has no heading line to drop.
  return entries.length === 0 ? rendered : lines.join("\n");
}

/**
 * Code-rendered fallback when no published base exists or the full prompt exceeds its ceiling.
 *
 * **This is the one place the reminder stream names `LINK` (max, 2026-08-12).** The farmer is
 * being asked to retype a listing they cannot see, which is exactly when the web editor is
 * worth the characters — and this message has room the SAME prompt does not, having no snapshot
 * to fit. In the prompt itself the same line costs an item of snapshot capacity to repeat a
 * keyword onboarding already taught, and pushes the largest stands into this very fallback.
 */
export function renderScheduledInventoryUpdateRequest(input: {
  locationName: string;
}): string {
  return [
    `${input.locationName}: no complete current listing can be shown here. ` +
      `Please text what is available now.`,
    "You can also text LINK to update on the web.",
    SCHEDULED_PROMPT_OPT_OUT,
  ].join("\n\n");
}
