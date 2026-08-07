import { headers } from "next/headers";
import Link from "next/link";
import {
  listAdministratorPhones,
  listFarmsForApproval,
  listFlagsForReview,
  listOpenFarmerOnboardingRequests,
  listStandsForAdministration,
  listStandDataFlags,
  listStockOutReports,
} from "@farm-friend/db";
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
import { TestFarms } from "./test-farms";

// The VIGA operator surface (F-025a): sign in, see every farm, approve or revoke.
//
// Server-rendered per request, and the authorization check happens HERE on the server — not
// in the browser component, which can only ever be a convenience. A caller without a live
// administrator session sees the signed-out page and no farm data, because the data is never
// fetched for them in the first place.
//
// The desk is an operator's starting point, not a metrics dashboard. It names only work that
// needs a VIGA decision, then leaves reference records one disclosure away.

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
      ? row.publishedAt === null ? "No availability update yet" : "Confirmed empty"
      : row.currentItems.map((item) => [item.itemName, item.quantity, item.unit, item.priceText].filter((part) => part !== null).join(" ")).join(", ");
    return {
      standId: row.standId,
      name: row.name,
      farmName: row.farmName,
      status: row.isPublic ? "Visible to customers" : "Not visible to customers",
      farmBucksStatus: row.farmBucksAccepted
        ? "accepts"
        : row.farmBucksEligible
          ? "does_not_accept"
          : "not_eligible",
      openState: OPEN_STATE_LABEL[openState],
      approved: row.approved,
      retired: row.retired,
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
  const [farms, stands, farmerRequests, flags, listingQuestions, stockReports, testPhones] = await Promise.all([
    listFarmsForApproval(db),
    listStandsForAdministration(db),
    listOpenFarmerOnboardingRequests(db),
    listFlagsForReview(db, { status: "open" }),
    listStandDataFlags(db, { status: "open" }),
    listStockOutReports(db, { status: "open" }),
    listAdministratorPhones(db),
  ]);
  const work = [
    // F-067 — approval is now the EXCEPTION, not the routine step. An invited farmer's farm is
    // approved by their own redemption, so anything landing here arrived by one of the two
    // paths that still need a person: an invitation naming no farm, or one whose agreement was
    // never ticked. (A bare uninvited SIGNUP was a third until F-080 removed the keyword.)
    { label: "Farm approvals", count: farms.filter((farm) => !farm.approved).length, href: "#farm-approvals", description: "Only farms that signed up without an invitation. Invited farmers are approved automatically." },
    { label: "Farmer access requests", count: farmerRequests.length, href: "/admin/farmers", description: "Give verified farm operators access to update their stands." },
    { label: "Customer reports", count: flags.length + listingQuestions.length, href: "/admin/flags", description: "Review customer FLAG messages and listing questions." },
    { label: "Stock reports", count: stockReports.length, href: "/admin/reports", description: "Review reports without changing a farmer’s listing." },
  ];
  const totalWork = work.reduce((total, item) => total + item.count, 0);

  return (
    <AdminShell currentPath="/admin">
      <section className="admin-work" aria-labelledby="needs-attention-heading">
        <h2 id="needs-attention-heading" className="admin-section-title">Needs attention</h2>
        {totalWork === 0 ? (
          <p className="admin-empty-state">Nothing needs a decision right now.</p>
        ) : (
          <ul className="admin-work-list">
            {work.filter((item) => item.count > 0).map((item) => (
              <li key={item.label}>
                <Link href={item.href}>
                  <span>
                    <strong>{item.label}</strong>
                    <span>{item.description}</span>
                  </span>
                  <span className="admin-count" aria-label={`${item.count} ${item.label.toLowerCase()}`}>{item.count}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section id="farm-approvals" className="admin-priority admin-priority--farm-approval" aria-labelledby="approve-farms-heading">
        <h2 id="approve-farms-heading" className="admin-section-title">Farm approvals</h2>
        {/*
          The old copy said approving "lets eligible stands appear to customers", which was never
          quite right and is now actively misleading: `listPublicStands` gates on `is_public`, not
          on approval, so a seeded stand is already visible. What approval actually gates is
          whether the FARMER may publish an update — `confirmProposal` and the scheduled prompts
          both re-read it.
        */}
        <p className="admin-note">
          Approving lets a farmer publish updates to their stand. It does not publish or edit a
          listing, and it is not what makes a stand visible on the map. Farmers who arrive by
          invitation are approved automatically, so only uninvited sign-ups appear here.
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

      <section className="admin-records" aria-labelledby="stand-records-heading">
        <details className="admin-secondary-disclosure">
          <summary id="stand-records-heading">Stand records ({stands.length})</summary>
          <p className="admin-note">Check what customers can currently see.</p>
          <StandList stands={asStandCards(stands)} />
        </details>
      </section>

      {/*
        F-074 — setup rather than pending work, so it sits with the reference records behind a
        disclosure rather than in "Needs attention". A test farm is not a decision waiting on
        anyone; it is a rehearsal VIGA set up on purpose.
      */}
      <section className="admin-records" aria-labelledby="test-farms-heading">
        <details className="admin-secondary-disclosure">
          <summary id="test-farms-heading">
            Test farms ({farms.filter((farm) => farm.isTestFarm).length})
          </summary>
          <TestFarms
            farms={farms.map((farm) => ({
              farmId: farm.farmId,
              name: farm.name,
              isTestFarm: farm.isTestFarm,
            }))}
            phones={testPhones.map((phone) => ({
              id: phone.id,
              lastFour: phone.lastFour,
            }))}
          />
        </details>
      </section>
    </AdminShell>
  );
}
