import { headers } from "next/headers";
import { listFarmsForApproval, listStandsForAdministration } from "@farm-friend/db";
import {
  openNow,
  projectClosure,
  type OpenState,
  type StandAvailabilityFacts,
} from "@farm-friend/core";
import { resolveAdministrator } from "../../lib/auth";
import { publicReadContext } from "../../lib/public-context";
import { ApprovalQueue } from "./approval-queue";
import { AdminShell, SignedOutAdmin } from "./admin-shell";
import { StandList, type AdminStandCard } from "./stand-list";

// The VIGA operator surface (F-025a): sign in, see every farm, approve or revoke.
//
// Server-rendered per request, and the authorization check happens HERE on the server — not
// in the browser component, which can only ever be a convenience. A caller without a live
// administrator session sees the signed-out page and no farm data, because the data is never
// fetched for them in the first place.
//
// Deliberately not a general admin console. Three screens, each one decision: may this farm
// publish (here), what happened with this flag (/admin/flags), did anyone look at this report
// (/admin/reports).

export const dynamic = "force-dynamic";

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

function asStandCards(rows: Awaited<ReturnType<typeof listStandsForAdministration>>): AdminStandCard[] {
  const now = new Date();
  const offset = vashonUtcOffset(now);
  return rows.map((row) => {
    const availability = availabilityFor(row);
    const closure = row.closureResult === "close" && row.closureKind !== null && row.closureStartsOn !== null
      ? projectClosure({ result: "close", closureKind: row.closureKind, startsOn: row.closureStartsOn, ...(row.closureClosedThrough !== null ? { closedThrough: row.closureClosedThrough } : {}) }, now)
      : undefined;
    const openState = openNow({ availability, closure, at: now, utcOffsetMinutes: offset, ...(row.publicLatitude !== null ? { latitude: row.publicLatitude } : {}), ...(row.publicLongitude !== null ? { longitude: row.publicLongitude } : {}) }).state;
    const inventory = row.currentItems.length === 0
      ? row.publishedAt === null ? "No farmer confirmation yet" : "Confirmed empty"
      : row.currentItems.map((item) => [item.itemName, item.quantity, item.unit, item.priceText].filter((part) => part !== null).join(" ")).join(", ");
    return {
      standId: row.standId,
      name: row.name,
      farmName: row.farmName,
      status: row.isPublic ? "Shown on map" : "Hidden from map",
      openState: OPEN_STATE_LABEL[openState],
      approved: row.approved,
      sections: [
        {
          title: "Availability",
          prominent: true,
          items: [
            ["Current items", inventory, "primary"],
            ["Last confirmed", row.publishedAt?.toLocaleString() ?? "Never"],
            ["Current closure", closure?.state === "active" ? "Closed by farmer" : closure?.state === "upcoming" ? "Upcoming closure" : "None"],
            ["Usually sells", row.usualOfferings.join(", ") || "Not stated"],
          ],
        },
        {
          title: "Visit & listing",
          items: [
            ["Address", row.publicAddress ?? "No public address"],
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
          ],
        },
        {
          title: "Other details",
          items: [
            ["Other sellers here", row.participantNames.join(", ") || "None"],
            ["Farm Bucks", row.farmBucksAccepted ? "Accepted" : row.farmBucksEligible ? "Eligible, not accepted" : "Not eligible"],
            ["Time zone", row.timezone],
          ],
        },
      ],
    };
  });
}

export default async function AdminPage() {
  // Next's server components do not hand a Request to a page, so the incoming cookie header
  // is rebuilt into one for the same `resolveAdministrator` every API route uses. One code path
  // resolves administrator identity, not two that could drift apart.
  const cookie = headers().get("cookie") ?? "";
  const administrator = await resolveAdministrator(
    new Request("https://farm-friend.internal/admin", {
      headers: cookie === "" ? {} : { cookie },
    }),
  );

  if (administrator === null) {
    return <SignedOutAdmin />;
  }

  const { db } = publicReadContext();
  const [farms, stands] = await Promise.all([listFarmsForApproval(db), listStandsForAdministration(db)]);

  return (
    <AdminShell currentPath="/admin">
      <section className="admin-priority admin-priority--farm-approval" aria-labelledby="approve-farms-heading">
        <h2 id="approve-farms-heading" className="admin-section-title">Approve farms</h2>
        <p className="admin-note">
          Approve a farm when it&apos;s ready to join Farm Friend.
        </p>
        <ApprovalQueue
          farms={farms.map((farm) => ({
            farmId: farm.farmId,
            name: farm.name,
            approved: farm.approved,
            approvedAt: farm.approvedAt?.toISOString() ?? null,
            approvedByEmail: farm.approvedByEmail,
          }))}
        />
      </section>

      <section aria-labelledby="all-stands-heading">
        <h2 id="all-stands-heading" className="admin-section-title">All stands</h2>
        <p className="admin-note">
          A quick view of what people see. Open any stand for the full listing. “Open status not
          stated” simply means we do not have enough hours to tell.
        </p>
        <StandList stands={asStandCards(stands)} />
      </section>
    </AdminShell>
  );
}
