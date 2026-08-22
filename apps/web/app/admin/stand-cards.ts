import {
  openNow,
  projectClosure,
  type OpenState,
  type StandAvailabilityFacts,
} from "@farm-friend/core";
import type { listStandsForAdministration } from "@farm-friend/db";
import type { AdminStandCard } from "./stand-list";

// Turning a stand row into the card the operator surface renders.
//
// Extracted from the admin home page when stands moved inside farm cards: two surfaces now
// build the same card, and a second copy of this mapping would be a second place for the
// operator's vocabulary to drift.


const OPEN_STATE_LABEL: Record<OpenState, string> = {
  open: "Open now",
  farmer_closed: "Not open — closed by farmer",
  closed: "Not open",
  closed_today: "Not open today",
  out_of_season: "Not open — out of season",
  by_appointment: "By appointment",
  unknown: "Open status not stated",
};

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatMinutes(minutes: number | null): string | null {
  if (minutes === null) return null;
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(
    new Date(Date.UTC(2026, 0, 1, hour, minute)),
  );
}

function formatSeason(row: Awaited<ReturnType<typeof listStandsForAdministration>>[number]): string {
  if (row.seasonKind === null) return "Not stated";
  if (row.seasonKind === "year_round") return "Year-round";
  if (row.seasonKind === "named_season") return row.seasonNames?.join(", ") || "Not stated";
  const start = row.seasonStartMonth === null || row.seasonStartDay === null
    ? null
    : `${row.seasonStartMonth}/${row.seasonStartDay}`;
  const end = row.seasonEndMonth === null || row.seasonEndDay === null
    ? null
    : `${row.seasonEndMonth}/${row.seasonEndDay}`;
  return row.seasonKind === "open_ended" ? `From ${start ?? "not stated"}` : `${start ?? "Not stated"}–${end ?? "not stated"}`;
}

function formatHours(row: Awaited<ReturnType<typeof listStandsForAdministration>>[number]): string {
  switch (row.openHoursKind) {
    case "clock_range":
      return `${formatMinutes(row.openFromMinutes)}–${formatMinutes(row.openUntilMinutes)}`;
    case "until_dusk":
      return `${formatMinutes(row.openFromMinutes)} until dusk`;
    case "dawn_to_dusk":
      return "Dawn to dusk";
    case "daylight_hours":
      return "Daylight hours";
    case "all_day":
      return "All day";
    case "by_appointment":
      return "By appointment";
    default:
      return "Not stated";
  }
}

function vashonUtcOffset(at: Date): number {
  const zone = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    timeZoneName: "longOffset",
  }).formatToParts(at).find((part) => part.type === "timeZoneName")?.value;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(zone ?? "");
  if (match === null) throw new Error("Could not determine Vashon time zone offset");
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "+" ? minutes : -minutes;
}

function availabilityFor(
  row: Awaited<ReturnType<typeof listStandsForAdministration>>[number],
): StandAvailabilityFacts {
  const availability: StandAvailabilityFacts = {};
  switch (row.seasonKind) {
    case "year_round":
      availability.season = { kind: "year_round" };
      break;
    case "date_range":
      if (row.seasonStartMonth !== null && row.seasonStartDay !== null && row.seasonEndMonth !== null && row.seasonEndDay !== null) {
        availability.season = { kind: "date_range", startMonth: row.seasonStartMonth, startDay: row.seasonStartDay, endMonth: row.seasonEndMonth, endDay: row.seasonEndDay };
      }
      break;
    case "named_season":
      if (row.seasonNames !== null) availability.season = { kind: "named_season", names: row.seasonNames };
      break;
    case "open_ended":
      if (row.seasonStartMonth !== null && row.seasonStartDay !== null) {
        availability.season = { kind: "open_ended", startMonth: row.seasonStartMonth, startDay: row.seasonStartDay };
      }
      break;
  }
  switch (row.openHoursKind) {
    case "clock_range":
      if (row.openFromMinutes !== null && row.openUntilMinutes !== null) {
        availability.hours = { kind: "clock_range", fromMinutes: row.openFromMinutes, untilMinutes: row.openUntilMinutes };
      }
      break;
    case "until_dusk":
      if (row.openFromMinutes !== null) availability.hours = { kind: "until_dusk", fromMinutes: row.openFromMinutes };
      break;
    case "dawn_to_dusk":
    case "daylight_hours":
    case "all_day":
    case "by_appointment":
      availability.hours = { kind: row.openHoursKind };
      break;
  }
  if (row.openDays !== null) availability.days = row.openDays;
  return availability;
}

export function asStandCards(rows: Awaited<ReturnType<typeof listStandsForAdministration>>): AdminStandCard[] {
  const now = new Date();
  const offset = vashonUtcOffset(now);
  return rows.map((row) => {
    const availability = availabilityFor(row);
    const closure = row.closureResult === "close" && row.closureKind !== null && row.closureStartsOn !== null
      ? projectClosure({ result: "close", closureKind: row.closureKind, startsOn: row.closureStartsOn, ...(row.closureClosedThrough !== null ? { closedThrough: row.closureClosedThrough } : {}) }, now)
      : undefined;
    const openState = openNow({ availability, closure, at: now, utcOffsetMinutes: offset, ...(row.publicLatitude !== null ? { latitude: row.publicLatitude } : {}), ...(row.publicLongitude !== null ? { longitude: row.publicLongitude } : {}) }).state;
    const inventory = row.currentItems.length === 0
      ? row.publishedAt === null ? "No availability update yet" : "Confirmed empty"
      : row.currentItems.map((item) => [item.itemName, item.quantity, item.unit, item.priceText].filter((part) => part !== null).join(" ")).join(", ");
    return {
      standId: row.standId,
      name: row.name,
      farmName: row.farmName,
      status: row.isPublic ? "Visible to customers" : "Not visible to customers",
      // F-125 — two states. The seller either takes Farm Bucks or does not; the "not
      // reviewed" third state went with the eligibility grant.
      farmId: row.farmId,
      farmBucksStatus: row.farmBucksAccepted ? "accepts" : "does_not_accept",
      openState: OPEN_STATE_LABEL[openState],
      // The stand's own facts as VALUES, for the editor (F-101). `sections` below renders the
      // same facts as sentences for reading; a form cannot prefill from those.
      metadata: {
        name: row.name,
        publicAddress: row.publicAddress,
        addressPublic: row.addressPublic,
        latitude: row.publicLatitude,
        longitude: row.publicLongitude,
        hoursText: row.hoursText,
      },
      approved: row.approved,
      retired: row.retired,
      retiredWithFarm: row.retiredWithFarm,
      sections: [
        {
          title: "Availability",
          prominent: true,
          items: [
            ["Current items", inventory],
            ["Last confirmed", row.publishedAt?.toLocaleString() ?? "Never"],
            ["Current closure", closure?.state === "active" ? "Closed by farmer" : closure?.state === "upcoming" ? "Upcoming closure" : "None"],
            ["Usually sells", row.usualOfferings.join(", ") || "Not stated"],
          ],
        },
        {
          title: "Visit & listing",
          items: [
            // F-088 — the real address either way, marked when customers cannot see it. VIGA
            // answers "where is this farm?" from this screen, so hiding it here would break
            // support to protect a customer-facing preference this row is not shown to.
            ["Address", row.publicAddress === null ? "No public address" : row.addressPublic ? row.publicAddress : `${row.publicAddress} — hidden from customers`],
            ["Coordinates", row.publicLatitude === null || row.publicLongitude === null ? "Not applicable" : `${row.publicLatitude}, ${row.publicLongitude}`],
            ["Visit in person", row.visitability === "visitable" ? "Yes" : "No — contact the farm"],
            ["Type", row.kind === "farm_stand" ? "Farm stand" : "Farmers market"],
            ["What it offers", row.offeringType === "produce" ? "Farm goods" : row.offeringType === "services" ? "Services" : "Order ahead"],
          ],
        },
        {
          title: "Hours & season",
          items: [
            ["Farmer's note about hours", row.hoursText ?? "Not stated"],
            ["Season", formatSeason(row)],
            ["Hours", formatHours(row)],
            ["Open days", row.openDays?.map((day) => DAYS[day]).join(", ") ?? "Not stated"],
            ["How often restocked", row.stockingCadence?.replaceAll("_", " ") ?? "Not stated"],
            ["Restocking days", row.stockingDays?.map((day) => DAYS[day]).join(", ") ?? "Not stated"],
            ["Time zone", row.timezone],
          ],
        },
        {
          title: "Payment accepted",
          items: [
            ["Farm Bucks", row.farmBucksAccepted ? "Accepted" : "Not accepted"],
            ["Approved", row.approved ? row.approvedAt?.toLocaleDateString() ?? "Yes" : "Not yet"],
          ],
        },
      ],
    };
  });
}
