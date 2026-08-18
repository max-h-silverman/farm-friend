"use client";

import { useState } from "react";
import { copyText } from "../../lib/copy-text";
import { ActionMenu } from "./action-menu";
import { CheckIcon, ClockIcon, LinkIcon, PencilIcon, PeopleIcon, StandIcon, UnpinIcon } from "./icons";

/** Which of a stand's three surfaces is open, or none. One at a time, by construction. */
type StandPanel = "details" | "farm-bucks" | "invite" | "retire" | null;

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
  farmBucksStatus: "accepts" | "does_not_accept" | "not_eligible";
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
}

export interface AdminStandDetailSection {
  title: string;
  prominent?: boolean;
  items: Array<readonly [label: string, value: string, emphasis?: "primary"]>;
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
 * **Narrower than the farmer's form on purpose.** `/stand/[token]/listing` lets the stand's
 * owner edit her whole listing — payment methods, what she usually sells, her own description,
 * her items. None of that is here: those are the farmer's published words, and Golden Rule #1
 * keeps VIGA's hand off them. The fields are exactly `saveStandMetadata`'s columns.
 *
 * **Prefilled, and that is load-bearing.** The writer sets every column it names, so a blank
 * form would clear an address when an operator only came to fix a spelling.
 */
function StandMetadataEditor({
  standId,
  standName,
  metadata,
  onSaved,
}: {
  standId: string;
  standName: string;
  metadata: AdminStandMetadata;
  onSaved: (metadata: AdminStandMetadata) => void;
}) {
  const [draft, setDraft] = useState(metadata);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);

  function field<K extends keyof AdminStandMetadata>(key: K, value: AdminStandMetadata[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
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

  const id = (suffix: string): string => `stand-${standId}-${suffix}`;

  return (
    <section
      className="admin-stand-editor"
      role="group"
      aria-label={`Stand details for ${standName}`}
    >
      <h4>Stand details</h4>
      <p className="admin-note">
        What customers see on the map. The farmer edits these too, from her own link.
      </p>

      {note !== null && (
        <p
          className={note.kind === "ok" ? "admin-success" : "admin-error"}
          role={note.kind === "ok" ? "status" : "alert"}
        >
          {note.text}
        </p>
      )}

      <label htmlFor={id("name")}>Stand name</label>
      <input
        id={id("name")}
        type="text"
        value={draft.name}
        disabled={busy}
        onChange={(event) => field("name", event.target.value)}
      />

      <label htmlFor={id("address")}>Address</label>
      <input
        id={id("address")}
        type="text"
        value={draft.publicAddress ?? ""}
        disabled={busy}
        onChange={(event) => field("publicAddress", event.target.value)}
      />

      {/* The address is always STORED; this decides only whether customers see it. Some stands
          sit at the farmer's home — findable, without printing the street address. */}
      <label className="admin-stand-editor-check">
        <input
          type="checkbox"
          checked={draft.addressPublic}
          disabled={busy}
          onChange={(event) => field("addressPublic", event.target.checked)}
        />
        <span>Show the address to customers</span>
      </label>

      <label htmlFor={id("latitude")}>Map pin latitude</label>
      <input
        id={id("latitude")}
        type="text"
        inputMode="decimal"
        value={draft.latitude ?? ""}
        disabled={busy}
        onChange={(event) => field("latitude", coordinate(event.target.value))}
      />

      <label htmlFor={id("longitude")}>Map pin longitude</label>
      <input
        id={id("longitude")}
        type="text"
        inputMode="decimal"
        value={draft.longitude ?? ""}
        disabled={busy}
        onChange={(event) => field("longitude", coordinate(event.target.value))}
      />

      <label htmlFor={id("hours")}>Hours, in the farmer&apos;s own words</label>
      <input
        id={id("hours")}
        type="text"
        value={draft.hoursText ?? ""}
        disabled={busy}
        onChange={(event) => field("hoursText", event.target.value)}
      />

      <button type="button" disabled={busy} onClick={() => void save()}>
        {busy ? "Saving…" : "Save stand details"}
      </button>
    </section>
  );
}

function farmBucksDetail(status: AdminStandCard["farmBucksStatus"]): string {
  switch (status) {
    case "accepts":
      return "Accepted";
    case "does_not_accept":
      return "Does not accept";
    default:
      return "Not reviewed";
  }
}

/**
 * One stand's facts, and the verbs that change them.
 *
 * **The facts are always on screen; the verbs are behind one menu** (max, 2026-08-17). An
 * operator arrives to read something — is this on the map, when is it open, does it take Farm
 * Bucks — and the card answers that first. The three surfaces that change a stand (the details
 * editor, the Farm Bucks decision, an invitation) each open on request, one at a time, so a
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
   * A select that writes on change has no natural "committed" moment, so it says so itself.
   * Without this the control showed the value the operator had just picked whether or not the
   * write landed — indistinguishable from having done nothing.
   */
  async function saveFarmBucks(standId: string, status: AdminStandCard["farmBucksStatus"]) {
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
        body: JSON.stringify({ standId, farmBucksStatus: status }),
      });
      if (!response.ok) throw new Error("save failed");
      setRows((current) => current.map((row) => row.standId === standId ? { ...row, farmBucksStatus: status } : row));
      say(standId, "ok", "Farm Bucks saved.");
    } catch {
      say(standId, "bad", "That did not save. Try again.");
    } finally {
      setSaving(null);
    }
  }

  /**
   * Take a stand off the map, or put it back (F-071).
   *
   * The local row is updated from the answer the SERVER gave, never optimistically: an
   * operator who believes a stand is off the map while it is still being served is worse off
   * than one who sees an error.
   */
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
                  {
                    key: "farm-bucks",
                    label: "Farm Bucks decision",
                    icon: <CheckIcon />,
                    onSelect: () => showPanel(stand.standId, "farm-bucks"),
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

              {/* WHAT IS TRUE. Always on screen, whatever verb is open above it. */}
              {stand.sections.map((section, index) => {
                const headingId = `stand-${stand.standId}-section-${index}`;
                const items = section.items.map((item) =>
                  item[0] === "Farm Bucks"
                    ? [item[0], farmBucksDetail(stand.farmBucksStatus), item[2]] as AdminStandDetailSection["items"][number]
                    : item,
                );
                return (
                  <section
                    key={section.title}
                    className={section.prominent ? "admin-stand-detail-section admin-stand-detail-section--prominent" : "admin-stand-detail-section"}
                    aria-labelledby={headingId}
                  >
                    <h3 id={headingId}>{section.title}</h3>
                    <dl>
                      {items.map(([label, value, emphasis]) => (
                        <div key={label} className={emphasis === "primary" ? "admin-stand-detail-item--primary" : undefined}>
                          <dt>{label}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                );
              })}

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

              {/* THE STAND'S OWN FACTS (F-101), opened on request from the menu. */}
              {panel === "details" && (
                <StandMetadataEditor
                  standId={stand.standId}
                  standName={stand.name}
                  metadata={stand.metadata}
                  onSaved={(metadata) =>
                    setRows((current) =>
                      current.map((row) =>
                        row.standId === stand.standId
                          ? { ...row, metadata, name: metadata.name }
                          : row,
                      ),
                    )
                  }
                />
              )}

              {panel === "farm-bucks" && (
                <section
                  className="admin-stand-editor"
                  role="group"
                  aria-label={`Farm Bucks for ${stand.name}`}
                >
                  <h4>Farm Bucks</h4>
                  <p className="admin-note">Record this only after VIGA confirms the stand’s Farm Bucks policy.</p>
                  <label className="admin-field">
                    <select
                      aria-label="Farm Bucks decision"
                      disabled={busy}
                      value={stand.farmBucksStatus}
                      onChange={(event) => void saveFarmBucks(
                        stand.standId,
                        event.target.value as AdminStandCard["farmBucksStatus"],
                      )}
                    >
                      <option value="not_eligible">Not reviewed</option>
                      <option value="accepts">Accepts Farm Bucks</option>
                      <option value="does_not_accept">Does not accept Farm Bucks</option>
                    </select>
                  </label>
                </section>
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
                  <button
                    className="admin-action-secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => void invite(stand.standId, stand.name)}
                  >
                    {busy ? "Inviting…" : "Invite and copy link"}
                  </button>
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
