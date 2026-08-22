"use client";

import { useState } from "react";
import {
  FARMER_SELECTABLE_PAYMENT_METHODS,
  type ListingAvailability,
  type StandingItem,
} from "@farm-friend/db";
import { copyText } from "../../lib/copy-text";
import { ActionMenu } from "./action-menu";
import { ClockIcon, LinkIcon, PencilIcon, PeopleIcon, StandIcon, TrashIcon, UnpinIcon } from "./icons";

/** Which of a stand's three surfaces is open, or none. One at a time, by construction. */
type StandPanel = "details" | "invite" | "retire" | "trash" | null;

export interface AdminStandCard {
  standId: string;
  name: string;
  farmName: string;
  status: string;
  openState: string;
  approved: boolean;
  /** F-071 — this stand is off the map, by its own retirement or its farm's. */
  retired: boolean;
  /** Off the map only because its FARM is down. The control that reverses it is the farm's. */
  retiredWithFarm: boolean;
  farmId: string;
  farmBucksStatus: "accepts" | "does_not_accept";
  /**
   * The stand's own facts, as VALUES rather than as the display strings in `sections` (F-101).
   *
   * `sections` renders "No public address" and "hidden from customers" — sentences for reading,
   * which a form cannot prefill from without parsing its own labels back. The editor writes
   * these columns, so it reads them.
   */
  metadata: AdminStandMetadata;
  sections: AdminStandDetailSection[];
}

export interface AdminStandMetadata {
  name: string;
  publicAddress: string | null;
  addressPublic: boolean;
  latitude: number | null;
  longitude: number | null;
  hoursText: string | null;
  visitability?: "visitable" | "contact_only";
  offeringType?: "produce" | "services" | "by_order";
  pricesPublic?: boolean;
  availability?: ListingAvailability;
  paymentMethods?: string[];
  farmBucksAccepted?: boolean;
  items?: StandingItem[];
  description?: string | null;
}

type EditableStandMetadata = AdminStandMetadata & Required<Pick<AdminStandMetadata,
  "visitability" | "offeringType" | "pricesPublic" | "availability" |
  "paymentMethods" | "farmBucksAccepted" | "items" | "description"
>>;

export interface AdminStandDetailSection {
  title: string;
  /** This section carries the facts that LEAD the card. See `LEAD_LABELS`. */
  prominent?: boolean;
  items: Array<readonly [label: string, value: string]>;
}

/**
 * What to tell an operator whose invitation was refused (F-114 Phase C.1).
 *
 * Each named refusal has a different next move, so each gets its own sentence. Anything else
 * says only that nothing happened — inventing a reason for a status this screen does not know
 * would be worse than admitting it, because the operator would act on the invented one.
 *
 * `unsafe_public_text` prefers the SERVER's rendered message: that copy is code-owned and shared
 * with the farmer's own door, and restating it here is how the two come to disagree.
 */
function invitationRefusal(
  payload: Record<string, unknown>,
  sellerName: string,
  standName: string,
): string {
  if (typeof payload.message === "string") return payload.message;
  switch (payload.status) {
    case "already_selling_here":
      return `${sellerName} already sells at ${standName}, or has an invitation waiting. Nobody was invited again.`;
    case "invalid_seller":
      return "That name cannot be used. Nobody was invited.";
    case "unknown_stand":
      return "That stand is no longer here. Nobody was invited.";
    case "not_authorized":
    case "not_an_administrator":
      return "Your sign-in is no longer valid. Nobody was invited — sign in again.";
    default:
      return "That did not go through. Nobody was invited — try again.";
  }
}

/**
 * What to tell an operator whose stand edit was refused (F-101).
 *
 * Each named refusal has its own next move; anything else says only that nothing happened,
 * which is the honest answer when this screen does not know why.
 */
function metadataRefusal(payload: Record<string, unknown>): string {
  switch (payload.status) {
    case "incomplete_location":
      return "A stand people can visit needs an address and a map pin. Nothing was saved.";
    case "invalid_name":
      return "A stand needs a name. Nothing was saved.";
    case "incoherent_availability":
      return "Complete the season, hours, and restocking details. Nothing was saved.";
    case "off_island":
      return "That map pin is outside Vashon-Maury Island. Nothing was saved.";
    case "unknown_stand":
      return "That stand is no longer here. Nothing was saved.";
    case "not_an_administrator":
      return "Your sign-in is no longer valid. Nothing was saved — sign in again.";
    default:
      return "That did not save. Nothing was changed — try again.";
  }
}

/**
 * VIGA corrects one stand's own facts (F-101, max 2026-08-17).
 *
 * This is the onboarding listing in admin form: every onboarding answer is prefilled and
 * writable, while dated inventory and closures remain outside this mode.
 *
 * **Prefilled, and that is load-bearing.** The writer sets every column it names, so a blank
 * form would clear an address when an operator only came to fix a spelling.
 */
function StandMetadataEditor({
  standId,
  standName,
  metadata,
  sections,
  farmBucks,
  onSaved,
  onClose,
}: {
  standId: string;
  standName: string;
  metadata: AdminStandMetadata;
  sections: AdminStandDetailSection[];
  farmBucks: string;
  onSaved: (metadata: AdminStandMetadata) => void;
  /** Leave the editor without writing. The draft goes with it. */
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<EditableStandMetadata>({
    ...metadata,
    visitability: metadata.visitability ?? "visitable",
    offeringType: metadata.offeringType ?? "produce",
    pricesPublic: metadata.pricesPublic ?? false,
    availability: metadata.availability ?? {
      seasonKind: null, seasonStartMonth: null, seasonStartDay: null,
      seasonEndMonth: null, seasonEndDay: null, seasonNames: null,
      openHoursKind: null, openFromMinutes: null, openUntilMinutes: null,
      openDays: null, stockingCadence: null, stockingDays: null,
    },
    paymentMethods: metadata.paymentMethods ?? [],
    farmBucksAccepted: metadata.farmBucksAccepted ?? false,
    items: metadata.items ?? [],
    description: metadata.description ?? null,
  });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);

  function field<K extends keyof AdminStandMetadata>(key: K, value: AdminStandMetadata[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setNote(null);
  }

  function availability<K extends keyof ListingAvailability>(
    key: K,
    value: ListingAvailability[K],
  ) {
    setDraft((current) => ({
      ...current,
      availability: { ...current.availability, [key]: value },
    }));
    setNote(null);
  }

  function item(index: number, value: StandingItem) {
    setDraft((current) => ({
      ...current,
      items: current.items.map((existing, at) => at === index ? value : existing),
    }));
    setNote(null);
  }

  /** A typed coordinate, or null. A half-typed "47." is not a number and is not a pin. */
  function coordinate(value: string): number | null {
    if (value.trim() === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  async function save(): Promise<void> {
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch("/api/admin/stands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          standId,
          action: "save_metadata",
          name: draft.name,
          publicAddress: draft.publicAddress,
          addressPublic: draft.addressPublic,
          latitude: draft.latitude,
          longitude: draft.longitude,
          hoursText: draft.hoursText,
          visitability: draft.visitability,
          offeringType: draft.offeringType,
          pricesPublic: draft.pricesPublic,
          availability: draft.availability,
          paymentMethods: draft.paymentMethods,
          farmBucksAccepted: draft.farmBucksAccepted,
          items: draft.items,
          description: draft.description,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        // The typed values are KEPT — an operator correcting one field must not retype the form.
        setNote({ kind: "bad", text: metadataRefusal(payload) });
        return;
      }
      onSaved(draft);
      setNote({ kind: "ok", text: "Stand details saved." });
    } catch {
      setNote({ kind: "bad", text: "That did not save. Nothing was changed — try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <StandFacts
      standId={standId}
      sections={sections}
      farmBucks={farmBucks}
      editor={{
        standName,
        draft,
        busy,
        note,
        field,
        availability,
        item,
        coordinate,
        save,
        close: onClose,
      }}
    />
  );
}

/**
 * The two facts that lead a stand's profile, by label.
 *
 * **Named here rather than flagged in the data** (max, 2026-08-17). The card's shape is a
 * presentation decision and belongs to the surface that presents it; `stand-cards.ts` states
 * the facts and stays out of the layout. It also keeps ONE way to say "this leads" — the old
 * `emphasis: "primary"` marker said the same thing a second time, from the other end.
 */
const LEAD_LABELS = ["Current items", "Last confirmed"] as const;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function clockValue(minutes: number | null): string {
  if (minutes === null) return "";
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function clockMinutes(value: string): number | null {
  const [hours, minutes] = value.split(":").map(Number);
  return Number.isInteger(hours) && Number.isInteger(minutes) ? hours! * 60 + minutes! : null;
}

/**
 * One stand's read-only facts, as a PROFILE rather than a table (max, 2026-08-17).
 *
 * An operator opens a stand to learn two things — what is on the shelf, and how long ago
 * anyone said so. Those lead, in their own block, in type you can read at a glance. Everything
 * else is reference: true, occasionally needed, and never the reason the card was opened. It
 * sits in the same titled boxes the rest of the card already uses, two across where there is
 * room, so four short groups stop reading as one eighteen-row column.
 *
 * The recency line is load-bearing, not decoration. Nearly every stand is unattended and its
 * stock is variable, so the honest claim is always "this is what she said, and this is when" —
 * the card must never present an old inventory as a current one.
 */
function StandFacts({
  standId,
  sections,
  farmBucks,
  editor,
}: {
  standId: string;
  sections: AdminStandDetailSection[];
  /** The live Farm Bucks decision. */
  farmBucks: string;
  editor?: {
    standName: string;
    draft: EditableStandMetadata;
    busy: boolean;
    note: { kind: "ok" | "bad"; text: string } | null;
    field: <K extends keyof AdminStandMetadata>(key: K, value: AdminStandMetadata[K]) => void;
    availability: <K extends keyof ListingAvailability>(key: K, value: ListingAvailability[K]) => void;
    item: (index: number, value: StandingItem) => void;
    coordinate: (value: string) => number | null;
    save: () => Promise<void>;
    close: () => void;
  };
}) {
  const lead = new Map<string, string>();
  for (const section of sections) {
    if (section.prominent !== true) continue;
    for (const [label, value] of section.items) {
      if ((LEAD_LABELS as readonly string[]).includes(label)) lead.set(label, value);
    }
  }
  const items = lead.get("Current items");
  const confirmed = lead.get("Last confirmed");

  const displayedSections = [...sections];
  if (editor !== undefined && !displayedSections.some(({ title }) => title === "Availability")) {
    displayedSections.push({ title: "Availability", items: [] });
  }
  if (editor !== undefined && !displayedSections.some(({ title }) => title === "Visit & listing")) {
    displayedSections.push({ title: "Visit & listing", items: [] });
  }
  if (editor !== undefined && !displayedSections.some(({ title }) => title === "Hours & season")) {
    displayedSections.push({ title: "Hours & season", items: [] });
  }
  if (editor !== undefined && !displayedSections.some(({ title }) => title === "Payment accepted")) {
    displayedSections.push({ title: "Payment accepted", items: [] });
  }
  if (editor !== undefined) displayedSections.push({ title: "Additional information", items: [] });
  const id = (suffix: string): string => `stand-${standId}-${suffix}`;

  return (
    <div
      className={`admin-stand-facts${editor === undefined ? "" : " admin-stand-facts--editing"}`}
      role={editor === undefined ? undefined : "group"}
      aria-label={editor === undefined ? undefined : `Stand details for ${editor.standName}`}
    >
      {items !== undefined && (
        <div className="admin-stand-lead" role="group" aria-label="What is on the shelf">
          <p className="admin-stand-lead-items">{items}</p>
          {confirmed !== undefined && (
            /*
              "Confirmed" rather than "updated": the farmer said so at that moment and nobody
              has checked since. Never printed as a bare timestamp — a date with no verb reads
              as a guarantee of the present, which is exactly what an honor-system stand
              cannot give.
            */
            <p className="admin-stand-lead-when">
              {confirmed === "Never"
                ? "Never confirmed"
                : `Confirmed ${confirmed}`}
            </p>
          )}
        </div>
      )}

      <div className="admin-stand-groups">
        {displayedSections.map((section, index) => {
          // The lead's facts are stated ONCE. A section whose items the lead consumed has
          // nothing left to say, so it does not print a heading over an empty box.
          const rows = section.items
            .filter(([label]) => !(section.prominent === true && lead.has(label)))
            .map(([label, value]) =>
              label === "Farm Bucks" ? ([label, farmBucks] as const) : ([label, value] as const),
            );
          const hasInlineEditor = editor !== undefined &&
            ["Availability", "Visit & listing", "Hours & season", "Payment accepted", "Additional information"].includes(section.title);
          if (rows.length === 0 && !hasInlineEditor) return null;

          const headingId = `stand-${standId}-section-${index}`;
          return (
            <section
              key={section.title}
              className="admin-stand-group"
              role="group"
              aria-label={section.title}
            >
              <h3 className="admin-stand-group-title" id={headingId}>
                {section.title}
              </h3>
              <dl className="admin-stand-group-body">
                {editor !== undefined && section.title === "Visit & listing" && (
                  <>
                    <div className="admin-stand-edit-row">
                      <dt>
                        <label htmlFor={id("name")}>Stand name</label>
                      </dt>
                      <dd>
                        <input
                          id={id("name")}
                          type="text"
                          value={editor.draft.name}
                          disabled={editor.busy}
                          onChange={(event) => editor.field("name", event.target.value)}
                        />
                      </dd>
                    </div>
                    <div className="admin-stand-edit-row">
                      <dt>
                        <label htmlFor={id("address")}>Address</label>
                      </dt>
                      <dd>
                        <input
                          id={id("address")}
                          type="text"
                          value={editor.draft.publicAddress ?? ""}
                          disabled={editor.busy}
                          onChange={(event) => editor.field("publicAddress", event.target.value)}
                        />
                        <label className="admin-stand-editor-check">
                          <input
                            type="checkbox"
                            checked={editor.draft.addressPublic}
                            disabled={editor.busy}
                            onChange={(event) =>
                              editor.field("addressPublic", event.target.checked)
                            }
                          />
                          <span>Show the address to customers</span>
                        </label>
                      </dd>
                    </div>
                    <div className="admin-stand-edit-row">
                      <dt>Coordinates</dt>
                      <dd className="admin-stand-coordinate-fields">
                        <label htmlFor={id("latitude")}>Map pin latitude</label>
                        <input
                          id={id("latitude")}
                          type="text"
                          inputMode="decimal"
                          value={editor.draft.latitude ?? ""}
                          disabled={editor.busy}
                          onChange={(event) =>
                            editor.field("latitude", editor.coordinate(event.target.value))
                          }
                        />
                        <label htmlFor={id("longitude")}>Map pin longitude</label>
                        <input
                          id={id("longitude")}
                          type="text"
                          inputMode="decimal"
                          value={editor.draft.longitude ?? ""}
                          disabled={editor.busy}
                          onChange={(event) =>
                            editor.field("longitude", editor.coordinate(event.target.value))
                          }
                        />
                      </dd>
                    </div>
                    <div className="admin-stand-edit-row">
                      <dt><label htmlFor={id("visitability")}>Can customers visit in person?</label></dt>
                      <dd>
                        <select id={id("visitability")} value={editor.draft.visitability} disabled={editor.busy} onChange={(event) => editor.field("visitability", event.target.value as AdminStandMetadata["visitability"])}>
                          <option value="visitable">Yes — customers can visit</option>
                          <option value="contact_only">No — contact the farm</option>
                        </select>
                      </dd>
                    </div>
                    <div className="admin-stand-edit-row">
                      <dt><label htmlFor={id("offering")}>What does this listing offer?</label></dt>
                      <dd>
                        <select id={id("offering")} value={editor.draft.offeringType} disabled={editor.busy} onChange={(event) => editor.field("offeringType", event.target.value as AdminStandMetadata["offeringType"])}>
                          <option value="produce">Farm goods</option>
                          <option value="services">Services</option>
                          <option value="by_order">Order ahead</option>
                        </select>
                      </dd>
                    </div>
                    <div className="admin-stand-edit-row">
                      <dt>Prices</dt>
                      <dd><label className="admin-stand-editor-check"><input type="checkbox" checked={editor.draft.pricesPublic} disabled={editor.busy} onChange={(event) => editor.field("pricesPublic", event.target.checked)} /><span>Show prices to customers</span></label></dd>
                    </div>
                  </>
                )}
                {editor !== undefined && section.title === "Hours & season" && (
                  <>
                  <div className="admin-stand-edit-row">
                    <dt><label htmlFor={id("season")}>When is your stand open in the year?</label></dt>
                    <dd><select id={id("season")} value={editor.draft.availability.seasonKind ?? ""} disabled={editor.busy} onChange={(event) => editor.field("availability", { ...editor.draft.availability, seasonKind: (event.target.value || null) as ListingAvailability["seasonKind"], seasonStartMonth: null, seasonStartDay: null, seasonEndMonth: null, seasonEndDay: null, seasonNames: null })}>
                      <option value="">Rather not say</option><option value="year_round">All year</option><option value="date_range">Between two dates</option><option value="open_ended">From a date onward</option><option value="named_season">Named seasons</option>
                    </select></dd>
                  </div>
                  {(editor.draft.availability.seasonKind === "date_range" || editor.draft.availability.seasonKind === "open_ended") && <div className="admin-stand-edit-row"><dt>Opens</dt><dd className="admin-stand-paired-fields"><label>Month<input type="number" min="1" max="12" value={editor.draft.availability.seasonStartMonth ?? ""} onChange={(event) => editor.availability("seasonStartMonth", event.target.value === "" ? null : Number(event.target.value))} /></label><label>Day<input type="number" min="1" max="31" value={editor.draft.availability.seasonStartDay ?? ""} onChange={(event) => editor.availability("seasonStartDay", event.target.value === "" ? null : Number(event.target.value))} /></label></dd></div>}
                  {editor.draft.availability.seasonKind === "date_range" && <div className="admin-stand-edit-row"><dt>Closes</dt><dd className="admin-stand-paired-fields"><label>Month<input type="number" min="1" max="12" value={editor.draft.availability.seasonEndMonth ?? ""} onChange={(event) => editor.availability("seasonEndMonth", event.target.value === "" ? null : Number(event.target.value))} /></label><label>Day<input type="number" min="1" max="31" value={editor.draft.availability.seasonEndDay ?? ""} onChange={(event) => editor.availability("seasonEndDay", event.target.value === "" ? null : Number(event.target.value))} /></label></dd></div>}
                  {editor.draft.availability.seasonKind === "named_season" && <div className="admin-stand-edit-row"><dt><label htmlFor={id("season-names")}>Which seasons?</label></dt><dd><input id={id("season-names")} type="text" value={editor.draft.availability.seasonNames?.join(", ") ?? ""} onChange={(event) => editor.availability("seasonNames", event.target.value.split(",").map((item) => item.trim()).filter(Boolean))} /></dd></div>}
                  <div className="admin-stand-edit-row">
                    <dt><label htmlFor={id("hours-kind")}>When are you usually open?</label></dt>
                    <dd><select id={id("hours-kind")} value={editor.draft.availability.openHoursKind ?? ""} disabled={editor.busy} onChange={(event) => editor.field("availability", { ...editor.draft.availability, openHoursKind: (event.target.value || null) as ListingAvailability["openHoursKind"], openFromMinutes: null, openUntilMinutes: null })}>
                      <option value="">Rather not say</option><option value="dawn_to_dusk">Dawn to dusk</option><option value="all_day">All day</option><option value="clock_range">Set hours</option><option value="until_dusk">Set time until dusk</option><option value="by_appointment">By appointment</option>
                    </select></dd>
                  </div>
                  {(editor.draft.availability.openHoursKind === "clock_range" || editor.draft.availability.openHoursKind === "until_dusk") && <div className="admin-stand-edit-row"><dt>Clock hours</dt><dd><label>Opens at<input type="time" value={clockValue(editor.draft.availability.openFromMinutes)} onChange={(event) => editor.availability("openFromMinutes", clockMinutes(event.target.value))} /></label>{editor.draft.availability.openHoursKind === "clock_range" && <label>Closes at<input type="time" value={clockValue(editor.draft.availability.openUntilMinutes)} onChange={(event) => editor.availability("openUntilMinutes", clockMinutes(event.target.value))} /></label>}</dd></div>}
                  <div className="admin-stand-edit-row"><dt>Open days</dt><dd className="admin-stand-day-fields">{WEEKDAYS.map((day, value) => <label key={day}><input type="checkbox" checked={editor.draft.availability.openDays?.includes(value) ?? false} onChange={() => { const days = editor.draft.availability.openDays ?? []; const next = days.includes(value) ? days.filter((item) => item !== value) : [...days, value].sort(); editor.availability("openDays", next.length === 0 ? null : next); }} />{day}</label>)}</dd></div>
                  <div className="admin-stand-edit-row"><dt><label htmlFor={id("stocking")}>How often do you restock?</label></dt><dd><select id={id("stocking")} value={editor.draft.availability.stockingCadence ?? ""} onChange={(event) => editor.field("availability", { ...editor.draft.availability, stockingCadence: (event.target.value || null) as ListingAvailability["stockingCadence"], stockingDays: null })}><option value="">Rather not say</option><option value="daily">Daily</option><option value="specific_days">Specific days</option><option value="variable">Varies</option><option value="as_needed">As needed</option><option value="intermittent">Intermittently</option></select></dd></div>
                  {editor.draft.availability.stockingCadence === "specific_days" && <div className="admin-stand-edit-row"><dt>Restocking days</dt><dd className="admin-stand-day-fields">{WEEKDAYS.map((day, value) => <label key={day}><input type="checkbox" checked={editor.draft.availability.stockingDays?.includes(value) ?? false} onChange={() => { const days = editor.draft.availability.stockingDays ?? []; const next = days.includes(value) ? days.filter((item) => item !== value) : [...days, value].sort(); editor.availability("stockingDays", next.length === 0 ? null : next); }} />{day}</label>)}</dd></div>}
                  <div className="admin-stand-edit-row">
                    <dt>
                      <label htmlFor={id("hours")}>Anything else about your hours?</label>
                    </dt>
                    <dd>
                      <input
                        id={id("hours")}
                        type="text"
                        value={editor.draft.hoursText ?? ""}
                        disabled={editor.busy}
                        onChange={(event) => editor.field("hoursText", event.target.value)}
                      />
                    </dd>
                  </div>
                  </>
                )}
                {editor !== undefined && section.title === "Availability" && <div className="admin-stand-edit-row"><dt>Usually sells</dt><dd className="admin-stand-item-fields">{editor.draft.items.map((listingItem, index) => <div key={index}><label>Usually sells item {index + 1}<input type="text" value={listingItem.name} onChange={(event) => editor.item(index, { ...listingItem, name: event.target.value })} /></label>{editor.draft.pricesPublic && <div className="admin-stand-price-fields"><label>Price<input type="number" min="0" step="0.01" value={listingItem.price?.amount ?? ""} onChange={(event) => editor.item(index, { ...listingItem, price: event.target.value === "" ? null : { amount: event.target.value, quantity: listingItem.price?.quantity ?? "1", unit: listingItem.price?.unit ?? "item", basis: listingItem.price?.basis ?? "per" } })} /></label><label>For<input type="number" min="0.01" step="0.01" value={listingItem.price?.quantity ?? "1"} onChange={(event) => editor.item(index, { ...listingItem, price: { amount: listingItem.price?.amount ?? "0", quantity: event.target.value, unit: listingItem.price?.unit ?? "item", basis: listingItem.price?.basis ?? "per" } })} /></label><label>Unit<input type="text" value={listingItem.price?.unit ?? ""} onChange={(event) => editor.item(index, { ...listingItem, price: { amount: listingItem.price?.amount ?? "0", quantity: listingItem.price?.quantity ?? "1", unit: event.target.value || null, basis: listingItem.price?.basis ?? "per" } })} /></label><label>Basis<select value={listingItem.price?.basis ?? "per"} onChange={(event) => editor.item(index, { ...listingItem, price: { amount: listingItem.price?.amount ?? "0", quantity: listingItem.price?.quantity ?? "1", unit: listingItem.price?.unit ?? "item", basis: event.target.value as "per" | "for" } })}><option value="per">per</option><option value="for">for</option></select></label></div>}<button type="button" className="admin-action-secondary" onClick={() => editor.field("items", editor.draft.items.filter((_, at) => at !== index))}>Remove</button></div>)}<button type="button" className="admin-action-secondary" onClick={() => editor.field("items", [...editor.draft.items, { name: "", price: null }])}>Add item</button></dd></div>}
                {editor !== undefined && section.title === "Payment accepted" && <><div className="admin-stand-edit-row"><dt>Payment methods</dt><dd className="admin-stand-payment-fields">{FARMER_SELECTABLE_PAYMENT_METHODS.map((method) => <label key={method}><input type="checkbox" checked={editor.draft.paymentMethods.includes(method)} onChange={() => editor.field("paymentMethods", editor.draft.paymentMethods.includes(method) ? editor.draft.paymentMethods.filter((item) => item !== method) : [...editor.draft.paymentMethods, method])} />{method}</label>)}<label>Other payment methods<input type="text" value={editor.draft.paymentMethods.filter((method) => !FARMER_SELECTABLE_PAYMENT_METHODS.includes(method)).join(", ")} onChange={(event) => editor.field("paymentMethods", [...editor.draft.paymentMethods.filter((method) => FARMER_SELECTABLE_PAYMENT_METHODS.includes(method)), ...event.target.value.split(",").map((method) => method.trim()).filter(Boolean)])} /></label></dd></div><div className="admin-stand-edit-row"><dt>Farm Bucks</dt><dd><label className="admin-stand-editor-check"><input aria-label="Farm Bucks" type="checkbox" checked={editor.draft.farmBucksAccepted} onChange={(event) => editor.field("farmBucksAccepted", event.target.checked)} /><span>Accepted</span></label></dd></div></>}
                {editor !== undefined && section.title === "Additional information" && <div className="admin-stand-edit-row"><dt><label htmlFor={id("description")}>Additional information</label></dt><dd><textarea id={id("description")} value={editor.draft.description ?? ""} onChange={(event) => editor.field("description", event.target.value)} /></dd></div>}
                {rows.map(([label, value]) => {
                  const replacedByEditor = editor !== undefined &&
                    ((section.title === "Visit & listing" &&
                      (label === "Address" || label === "Coordinates")) ||
                      (section.title === "Hours & season" &&
                        ["Farmer's note about hours", "Season", "Hours", "Open days", "How often restocked", "Restocking days"].includes(label)) ||
                      (section.title === "Visit & listing" && ["Visit in person", "What it offers"].includes(label)) ||
                      (section.title === "Availability" && label === "Usually sells") ||
                      (section.title === "Payment accepted" && label === "Farm Bucks"));
                  return replacedByEditor ? null : (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  );
                })}
              </dl>
            </section>
          );
        })}
      </div>
      {editor !== undefined && (
        <div className="admin-stand-edit-actions">
          {editor.note !== null && (
            <p
              className={editor.note.kind === "ok" ? "admin-success" : "admin-error"}
              role={editor.note.kind === "ok" ? "status" : "alert"}
            >
              {editor.note.text}
            </p>
          )}
          <div className="admin-confirm-actions">
            <button
              className="admin-action-primary"
              type="button"
              disabled={editor.busy}
              onClick={() => void editor.save()}
            >
              {editor.busy ? "Saving…" : "Save stand details"}
            </button>
            <button
              className="admin-action-secondary"
              type="button"
              disabled={editor.busy}
              onClick={editor.close}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function farmBucksDetail(status: AdminStandCard["farmBucksStatus"]): string {
  // F-125 — two states. There is no "not reviewed": a farm either takes Farm Bucks or does not.
  return status === "accepts" ? "Accepted" : "Does not accept";
}

/**
 * One stand's facts, and the verbs that change them.
 *
 * **The facts are always on screen; the verbs are behind one menu** (max, 2026-08-17). An
 * operator arrives to read something — is this on the map, when is it open, does it take Farm
 * Bucks — and the card answers that first. The three surfaces that change a stand (the details
 * editor and invitation) each open on request, one at a time, so a
 * card at rest is never a page of form.
 *
 * The second disclosure is gone with it: the card in Stands & Sellers already answered "which
 * stand", so opening the same stand again inside it was chrome the operator had to click past.
 */
export function StandDetails({
  stands,
  headed = true,
}: {
  stands: AdminStandCard[];
  /**
   * Whether this block writes the stand's own identity line.
   *
   * **False when the enclosing card already named the stand** — on the Stands view the card
   * head IS the stand, so a second head restated its name and its chips and left two controls
   * on one card carrying the identical accessible name. The verbs stay: they are the stand's,
   * and the card's own Actions menu holds the *seller's*.
   */
  headed?: boolean;
}) {
  const [rows, setRows] = useState(stands);
  const [saving, setSaving] = useState<string | null>(null);
  /**
   * Keyed by stand and rendered on the stand it belongs to. A single banner above the list
   * reported the thirtieth stand's outcome above the first stand's card.
   */
  const [note, setNote] = useState<Record<string, { kind: "ok" | "bad"; text: string }>>({});
  /**
   * Which surface one stand has open, if any. **One at a time**, so choosing a verb replaces
   * the last one rather than stacking beneath it — the state that made this card unreadable.
   */
  const [openPanel, setOpenPanel] = useState<Record<string, StandPanel>>({});
  /** The seller name being typed, per stand. Cleared once its invitation is minted. */
  const [sellerName, setSellerName] = useState<Record<string, string>>({});
  /**
   * The invitation link just minted, per stand. Held in state rather than only copied: the
   * token is shown ONCE and a clipboard write can fail silently, so an operator who leaves this
   * screen without the link has to reissue.
   */
  const [freshLink, setFreshLink] = useState<Record<string, string>>({});

  function panelOf(standId: string): StandPanel {
    return openPanel[standId] ?? null;
  }

  function showPanel(standId: string, panel: StandPanel) {
    setOpenPanel((current) => ({ ...current, [standId]: panel }));
  }

  function say(standId: string, kind: "ok" | "bad", text: string) {
    setNote((current) => ({ ...current, [standId]: { kind, text } }));
  }

  /**
   * Take a stand off the map, or put it back (F-071).
   *
   * The local row is updated from the answer the SERVER gave, never optimistically: an
   * operator who believes a stand is off the map while it is still being served is worse off
   * than one who sees an error.
   */
  /**
   * Move a stand to the trash: out of VIGA's list entirely, restorable from the Trash section
   * (F-124).
   *
   * The row is updated from the SERVER's answer for the same reason `setRetired` is, and it
   * stays on screen carrying the note rather than removing itself — the list is the server's,
   * and a card that vanished on its own would make a refused trash look like a successful one.
   */
  async function moveToTrash(standId: string, standName: string) {
    setSaving(standId);
    setNote((current) => {
      const next = { ...current };
      delete next[standId];
      return next;
    });
    try {
      const response = await fetch("/api/admin/stands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ standId, action: "trash" }),
      });
      if (!response.ok) throw new Error("save failed");
      setRows((current) =>
        current.map((row) => (row.standId === standId ? { ...row, retired: true } : row)),
      );
      say(
        standId,
        "ok",
        `${standName} is in the trash. Reload to update the list, or put it back from Trash.`,
      );
    } catch {
      say(standId, "bad", "That stand was not moved to the trash. Try again.");
    } finally {
      showPanel(standId, null);
      setSaving(null);
    }
  }

  async function setRetired(standId: string, retired: boolean) {
    setSaving(standId);
    setNote((current) => {
      const next = { ...current };
      delete next[standId];
      return next;
    });
    try {
      const response = await fetch("/api/admin/stands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ standId, action: retired ? "retire" : "restore" }),
      });
      if (!response.ok) throw new Error("save failed");
      setRows((current) =>
        current.map((row) => (row.standId === standId ? { ...row, retired } : row)),
      );
      say(
        standId,
        "ok",
        retired
          ? "Off the map. Customers no longer see this stand. Everything it published is kept."
          : "Back on the map. Customers can see this stand again.",
      );
    } catch {
      say(
        standId,
        "bad",
        retired
          ? "That stand was not taken off the map. Try again."
          : "That stand was not put back on the map. Try again.",
      );
    } finally {
      // Closed whichever way it went. On failure the row is unchanged and the plain menu item
      // is back, so a retry is a deliberate act rather than a second click on a stuck dialog.
      showPanel(standId, null);
      setSaving(null);
    }
  }

  /*
    F-114 Phase C.1 — VIGA invites a seller to sell at this stand.

    The endpoint has been live since the invitation merged and had no button, which made VIGA's
    only door an authenticated request typed by hand. The control lives on the STAND rather than
    on the enclosing farm card because a hosting relationship binds a seller to one stand, and a
    farm with two stands would otherwise present one control that had to ask which.

    **Farm Friend texts the invited seller nothing** (max, 2026-08-15). No consent row exists for
    a number nobody gave us, so an outbound send would be suppressed anyway — the coordinator
    forwards the link by hand, which is why the link is shown rather than merely acted on.
  */
  async function invite(standId: string, standName: string) {
    const name = (sellerName[standId] ?? "").trim();
    // Refused here as well as by the writer, and NOT as a duplicate rule: this one stops a press
    // that could only ever fail, so the operator is not told about a request they did not mean
    // to make. The writer still refuses a blank name, which is the guarantee.
    if (name === "") return;
    setSaving(standId);
    setNote((current) => {
      const next = { ...current };
      delete next[standId];
      return next;
    });
    try {
      const response = await fetch("/api/admin/stands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ standId, action: "invite_seller", newSellerName: name }),
      });
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok || typeof payload.link !== "string") {
        // Named refusals get their own sentence, because each one has a different next move.
        // Everything else says only that nothing happened, which is the honest answer.
        say(standId, "bad", invitationRefusal(payload, name, standName));
        return;
      }
      const link = payload.link;
      setFreshLink((current) => ({ ...current, [standId]: link }));
      setSellerName((current) => ({ ...current, [standId]: "" }));
      if (await copyText(link)) {
        say(
          standId,
          "ok",
          `Invitation link for ${name} copied. Send it to them — we only show it once.`,
        );
        return;
      }
      say(
        standId,
        "bad",
        "Link created, but copying failed. Copy it from the box below before you leave.",
      );
    } catch {
      say(standId, "bad", "That did not go through. Nobody was invited — try again.");
    } finally {
      setSaving(null);
    }
  }

  if (rows.length === 0) return <p className="admin-note">No stands yet.</p>;

  return (
    <div className="admin-stands">
      {rows.map((stand) => {
        const panel = panelOf(stand.standId);
        const busy = saving === stand.standId;
        return (
          <div key={stand.standId} className="admin-stand">
            {/*
              THE STAND'S HEAD: who it is, what is true of it, and one way in. The glyph is the
              one place in the console an icon names a THING rather than an action, which is
              what lets a stand row inside a seller's card be recognised at a glance.
            */}
            <div className={headed ? "admin-stand-head" : "admin-stand-head admin-stand-head--bare"}>
              {headed && (
                <>
              <span className="admin-stand-glyph" aria-hidden="true">
                <StandIcon />
              </span>
              <span className="admin-stand-identity">
                <strong>{stand.name}</strong>
                <span className="admin-stand-states">
                  {/*
                    A retired stand's `status` and `openState` describe a listing nobody is
                    being shown, so leading with them would be misleading. "Off the map"
                    replaces them rather than joining them.

                    A stand that is down only because its FARM is down says so, because the
                    operator's next move differs: this stand has no retirement of its own to
                    undo, and the control that brings it back is on the farm.
                  */}
                  {stand.retiredWithFarm ? (
                    <span className="admin-chip admin-chip--neutral">
                      <span>Off the map with the farm</span>
                    </span>
                  ) : stand.retired ? (
                    <span className="admin-chip admin-chip--neutral">
                      <span>Off the map</span>
                    </span>
                  ) : (
                    <>
                      <span className="admin-chip admin-chip--ok">
                        <span className="admin-chip-icon" aria-hidden="true">
                          <PeopleIcon />
                        </span>
                        <span>{stand.status}</span>
                      </span>
                      <span
                        className={
                          stand.openState === "Open now"
                            ? "admin-chip admin-chip--ok"
                            : "admin-chip admin-chip--neutral"
                        }
                      >
                        <span className="admin-chip-icon" aria-hidden="true">
                          <ClockIcon />
                        </span>
                        <span>{stand.openState}</span>
                      </span>
                    </>
                  )}
                </span>
              </span>
                </>
              )}

              <ActionMenu
                compact
                label={`More for ${stand.name}`}
                disabled={busy}
                items={[
                  {
                    key: "edit",
                    label: "Edit details",
                    icon: <PencilIcon />,
                    onSelect: () => showPanel(stand.standId, "details"),
                  },
                  /*
                    ABSENT for a stand that is off the map, rather than disabled: a seller
                    invited to a stand no customer can see would onboard into nothing, and
                    there is no state here to reverse — the operator's move is to put the
                    stand back first.
                  */
                  stand.retired || stand.retiredWithFarm
                    ? null
                    : {
                        key: "invite",
                        label: "Invite a seller",
                        icon: <LinkIcon />,
                        onSelect: () => showPanel(stand.standId, "invite"),
                      },
                  /*
                    No entry at all for a stand held down by its farm. "Put back on the map"
                    would post a restore for a stand that was never retired, the server would
                    answer `not_retired`, and the stand would stay exactly where it is.
                  */
                  stand.retiredWithFarm
                    ? null
                    : stand.retired
                      ? {
                          key: "restore",
                          label: "Put back on the map",
                          icon: <UnpinIcon />,
                          onSelect: () => void setRetired(stand.standId, false),
                        }
                      : {
                          // Asks before acting. Retirement is reversible, but it removes a farm
                          // from the island's only guide, so a misplaced click must not be enough.
                          key: "retire",
                          label: "Take off the map",
                          icon: <UnpinIcon />,
                          danger: true,
                          onSelect: () => showPanel(stand.standId, "retire"),
                        },
                  /*
                    LAST, after the map controls: trash takes the stand out of VIGA's list
                    altogether, where "off the map" only stops customers seeing it. Offered
                    whatever the stand's map state, because a stand VIGA has already taken
                    down is exactly the one they are most likely to want out of the list.
                  */
                  {
                    key: "trash",
                    label: "Move to trash",
                    icon: <TrashIcon />,
                    danger: true,
                    onSelect: () => showPanel(stand.standId, "trash"),
                  },
                ]}
              />
            </div>

            <div className="admin-stand-body">
              {note[stand.standId] !== undefined && (
                <p
                  className={note[stand.standId]?.kind === "ok" ? "admin-success" : "admin-error"}
                  role={note[stand.standId]?.kind === "ok" ? "status" : "alert"}
                >
                  {note[stand.standId]?.text}
                </p>
              )}

              {/* Edit details changes these facts in place; every other verb leaves them as a profile. */}
              {panel === "details" ? (
                <StandMetadataEditor
                  standId={stand.standId}
                  standName={stand.name}
                  metadata={stand.metadata}
                  sections={stand.sections}
                  farmBucks={farmBucksDetail(stand.farmBucksStatus)}
                  onSaved={(metadata) =>
                    setRows((current) =>
                      current.map((row) =>
                        row.standId === stand.standId
                          ? { ...row, metadata, name: metadata.name, farmBucksStatus: metadata.farmBucksAccepted ? "accepts" : "does_not_accept" }
                          : row.farmId === stand.farmId
                            ? { ...row, farmBucksStatus: metadata.farmBucksAccepted ? "accepts" : "does_not_accept", metadata: { ...row.metadata, paymentMethods: metadata.paymentMethods, farmBucksAccepted: metadata.farmBucksAccepted, description: metadata.description } }
                            : row,
                      ),
                    )
                  }
                  onClose={() => showPanel(stand.standId, null)}
                />
              ) : (
                <StandFacts
                  standId={stand.standId}
                  sections={stand.sections}
                  farmBucks={farmBucksDetail(stand.farmBucksStatus)}
                />
              )}

              {panel === "trash" && (
                <div
                  className="admin-confirm"
                  role="group"
                  aria-label={`Move ${stand.name} to trash`}
                >
                  {/* Says what happens AND that it is reversible — see the seller card's own
                      trash confirmation for why the second half is not optional. */}
                  <p>
                    {stand.name} leaves your list and customers stop seeing it. Nothing is
                    deleted — every listing, update and report is kept, and you can put it back
                    from Trash.
                  </p>
                  <div className="admin-confirm-actions">
                    <button
                      className="admin-action-danger"
                      type="button"
                      disabled={busy}
                      onClick={() => void moveToTrash(stand.standId, stand.name)}
                    >
                      {busy ? "Saving…" : "Move to trash"}
                    </button>
                    <button
                      className="admin-action-secondary"
                      type="button"
                      disabled={busy}
                      onClick={() => showPanel(stand.standId, null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {panel === "retire" && (
                <div
                  className="admin-confirm"
                  role="group"
                  aria-label={`Take ${stand.name} off the map`}
                >
                  <p>Take {stand.name} off the map? Customers will stop seeing it. Nothing it already published is deleted, and you can put it back.</p>
                  <div className="admin-confirm-actions">
                    <button
                      className="admin-action-danger"
                      type="button"
                      disabled={busy}
                      onClick={() => void setRetired(stand.standId, true)}
                    >
                      {busy ? "Saving…" : "Yes, take it off the map"}
                    </button>
                    <button
                      className="admin-action-secondary"
                      type="button"
                      disabled={busy}
                      onClick={() => showPanel(stand.standId, null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {panel === "invite" && (
                <section
                  className="admin-stand-editor"
                  role="group"
                  aria-label={`Invite a seller to ${stand.name}`}
                >
                  <h4>Invite a seller</h4>
                  <p className="admin-note" id={`stand-${stand.standId}-invite-help`}>
                    Someone whose own goods sell at {stand.name}, with their own inventory and
                    their own phone. We give you a link to send them — Farm Friend never texts
                    them first. Nobody is listed until they finish setting up.
                  </p>
                  <label className="admin-field">
                    <span>Seller&apos;s name</span>
                    <input
                      type="text"
                      aria-describedby={`stand-${stand.standId}-invite-help`}
                      value={sellerName[stand.standId] ?? ""}
                      disabled={busy}
                      onChange={(event) =>
                        setSellerName((current) => ({
                          ...current,
                          [stand.standId]: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <div className="admin-confirm-actions">
                    <button
                      className="admin-action-primary"
                      type="button"
                      disabled={busy}
                      onClick={() => void invite(stand.standId, stand.name)}
                    >
                      {busy ? "Inviting…" : "Invite and copy link"}
                    </button>
                    <button
                      className="admin-action-secondary"
                      type="button"
                      disabled={busy}
                      onClick={() => showPanel(stand.standId, null)}
                    >
                      Cancel
                    </button>
                  </div>
                  {/*
                    Shown because the token exists exactly once. A clipboard write can fail with
                    nothing to show for it, and an operator who leaves without the link has to
                    reissue — which invalidates nothing but wastes the farmer's next step.
                  */}
                  {freshLink[stand.standId] !== undefined && (
                    <div
                      className="admin-link-reveal"
                      role="group"
                      aria-label={`Invitation link for ${stand.name}`}
                    >
                      <p className="admin-note">
                        <strong>Copy this now — we only show it once.</strong> Send it to the
                        seller. It lets them set up their listing and expires in 7 days.
                      </p>
                      <input
                        aria-label="Invitation link"
                        readOnly
                        value={freshLink[stand.standId]}
                      />
                    </div>
                  )}
                </section>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
