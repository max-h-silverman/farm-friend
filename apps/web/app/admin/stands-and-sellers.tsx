"use client";

import { useState } from "react";
import { ActionMenu, type ActionMenuItem } from "./action-menu";
import { PeopleIcon } from "./icons";
import { useSellerControls } from "./seller-controls";
import { StandDetails, type AdminStandCard } from "./stand-list";
import { FarmerQueue, type FarmOption, type PendingRequestRow } from "./farmers/farmer-queue";
import { SellerParticipation, type ParticipationRow } from "./seller-participation";

/**
 * Stands & Sellers — one destination, two views of the same arrangements.
 *
 * **The lists are entities, not states** (max, 2026-08-17). One row per stand, one row per
 * seller; a participation is a detail inside a row and never a row of its own. A seller at
 * three stands is one row here, not three — the count on the screen is farms and stands,
 * which is what a volunteer means when they ask how many there are.
 *
 * **Two views rather than two tabs in the nav**, because they are two ways of looking at one
 * thing: a stand lists who sells there, a seller lists where she sells. Asking the volunteer
 * to choose a destination before looking would ask them which side of a relationship they
 * wanted, which is the data model leaking into the navigation.
 *
 * The controls come from `SellerParticipation`, one component shared by both views, so the
 * three transitions and their copy have one home. This file owns only the structure.
 */

export interface StandCard {
  standId: string;
  name: string;
  farmName: string;
  approved: boolean;
  retired: boolean;
  providers: ParticipationRow[];
  /**
   * The stand's own details and controls, in the shape `StandDetails` already renders.
   *
   * Reused rather than rebuilt: that component owns retire/restore, the Farm Bucks decision and
   * the F-114 invite button, each with its own copy and its own tests. Rewriting them here
   * would be a second way to do one thing, and the two would drift.
   */
  details?: AdminStandCard;
}

/**
 * One handset that may publish for this seller. Masked at the query boundary — no phone
 * number and no hash ever reaches the browser (Golden Rule #5).
 */
export interface SellerAccessRow {
  authorizationId: string;
  senderMask: string;
  authorizedAt: string;
  revokedAt: string | null;
}

export interface SellerCard {
  farmId: string;
  name: string;
  description?: string | null;
  approved: boolean;
  retired: boolean;
  isTestFarm: boolean;
  providers: ParticipationRow[];
  /** Who can update this seller's listing. Part of viewing the seller, not a screen of its own. */
  access: SellerAccessRow[];
}

type View = "stands" | "sellers";

/*
  ONE summary per card, carrying two facts (max, 2026-08-19): the record's live state, then how
  many are on the other side of its relationship — `Open now · 2 sellers` on a stand,
  `Live · 2 stands` on a seller.

  This replaced a row of neutral chips PLUS a separate amber "attention" chip: two parallel
  mechanisms describing one record, which had to be kept from contradicting each other. A stand
  nobody sells at now reads `0 sellers` — the problem states itself, so no second label competes
  for the same space.

  **A retired record's state is the whole answer.** How many sell there describes a listing
  nobody is being shown, so `Off the map` replaces the count rather than joining it.
*/

/** `1 seller` / `2 sellers`, without a pluralization mechanism nothing else needs. */
function countOf(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * A stand's live state. Read from the stand's own card, NEVER re-derived here: `openState` is
 * `stand-cards.ts`'s projection of closure, code owns that answer (Golden Rule #3), and a
 * second reading of the hours in the browser would be a second answer for the map and the
 * console to disagree about.
 */
function standSummary(stand: StandCard): string {
  if (stand.retired) return "Off the map";
  const state = stand.details?.openState ?? "Live";
  return `${state} · ${countOf(stand.providers.length, "seller")}`;
}

/**
 * A seller's live state, then how many stands she sells at.
 *
 * **`Unclaimed` replaces `Live`, never joins it.** A farm nobody can publish for is not live in
 * any useful sense — the listing is there and frozen — and it is a STATE of the record rather
 * than work waiting (max, 2026-08-17): most farms start this way, so alerting on it would make
 * the alert permanent furniture and teach the operator to skip the row.
 */
function sellerSummary(seller: {
  retired: boolean;
  canUpdate: boolean;
  providers: ParticipationRow[];
}): string {
  if (seller.retired) return "Off the map";
  const state = seller.canUpdate ? "Live" : "Unclaimed";
  return `${state} · ${countOf(seller.providers.length, "stand")}`;
}

/**
 * Who can update this seller's listing, and VIGA's control to take that away.
 *
 * It lives inside the seller card because who may publish for a farm is part of *viewing that
 * farm* (max, 2026-08-17) — VIGA's job is view and edit sellers, so this is not a destination
 * of its own. It is also the only reader of `listFarmerAuthorizations` and the only caller of
 * `/api/admin/farmers`: without it here, both are dead surface.
 *
 * The mask is what the server sent. No phone number and no hash exists on this side to leak.
 */
function AccessRoster({
  seller,
  fetcher,
}: {
  seller: SellerCard;
  fetcher: typeof fetch;
}) {
  const [rows, setRows] = useState(seller.access);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const live = rows.filter((row) => row.revokedAt === null);

  async function revoke(row: SellerAccessRow) {
    setBusy(row.authorizationId);
    setNote(null);
    try {
      const response = await fetcher("/api/admin/farmers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ authorizationId: row.authorizationId, action: "revoke" }),
      });
      if (!response.ok) {
        setNote("That did not save. Try again.");
        return;
      }
      setRows((current) =>
        current.map((entry) =>
          entry.authorizationId === row.authorizationId
            ? { ...entry, revokedAt: new Date().toISOString() }
            : entry,
        ),
      );
    } catch {
      setNote("That did not save. Try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="admin-access-roster">
      {live.length === 0 ? (
        <p className="admin-empty">
          <span className="admin-empty-icon" aria-hidden="true">
            <PeopleIcon />
          </span>
          <span>Unclaimed — no handset can publish for this farm yet.</span>
        </p>
      ) : (
        live.map((row) => (
          <p key={row.authorizationId} className="admin-access-row">
            <span className="admin-access-mask">
              <span className="admin-access-icon" aria-hidden="true">
                <PeopleIcon />
              </span>
              <span>{row.senderMask}</span>
            </span>
            <button
              type="button"
              className="admin-action-danger"
              aria-label={`Revoke ${row.senderMask}`}
              disabled={busy === row.authorizationId}
              onClick={() => void revoke(row)}
            >
              Revoke
            </button>
          </p>
        ))
      )}
      {note !== null && (
        <p className="admin-error" role="alert">
          {note}
        </p>
      )}
    </div>
  );
}

/**
 * The card: a header bar you can read at a glance, and a body you open to work in.
 *
 * **The header is identity, state, and one way in** (max, 2026-08-17). Name and subtitle on
 * the left, ONE summary of what is true of the record, and a single Actions menu on the right.
 * Everything an operator can *do* about the record hangs off that menu, which is what replaced
 * the wrapping row of five to seven buttons the open card used to carry — where "Approve" and
 * "Take off the map" competed for attention with the farm's own name.
 *
 * The header is tinted and the body is the card face, so an open card reads as one object with
 * a titled lid rather than as two stacked panels.
 */
function Card({
  id,
  title,
  subtitle,
  summary,
  actions,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  subtitle: string;
  /** The one line describing this record's current state. See `standSummary`. */
  summary: string;
  /** Everything an operator can do about this record. Omitted entirely when there is nothing. */
  actions?: Array<ActionMenuItem | null>;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    /*
      The GROUP is the whole card, header included (max, 2026-08-17). The header carries the
      states and the one way in, so a card whose group began at the body would name a region
      that excludes half of what the card is — and a screen reader moving by region would land
      past the Actions menu it was looking for.
    */
    <li className="admin-farm-card">
      {/* `role` on the <li> itself would cost it its `listitem` role, and the list is what
          says "one row per entity". The group is a wrapper inside it instead. */}
      <details open={open} role="group" aria-label={title}>
        <summary
          className="admin-row"
          onClick={(event) => {
            event.preventDefault();
            onToggle();
          }}
        >
          <span className="admin-row-caret-box" aria-hidden="true">
            <span className="admin-row-caret" />
          </span>
          <span className="admin-row-identity">
            <strong>{title}</strong>
            <span className="admin-row-sub">{subtitle}</span>
          </span>
          <span className="admin-row-summary">{summary}</span>
          {actions !== undefined && open && (
            /*
              Only on an OPEN card (max, 2026-08-17). A closed row is a thing to read — a name,
              a subtitle, its states — and a menu on each of thirty of them put a control beside
              every name that could not act on anything the operator was looking at. Opening the
              card is how an operator says "this one", so the verbs arrive with the body.

              Still inside the summary, so the one way in sits with the identity it belongs to,
              and the press is stopped here: without that, opening the menu would also toggle
              the card and collapse the body the operator is about to act on.
            */
            <span
              className="admin-row-actions"
              onClick={(event) => event.stopPropagation()}
            >
              <ActionMenu label="Actions" items={actions} />
            </span>
          )}
        </summary>
        {open && (
          <div className="admin-entity-detail" id={`entity-${id}`}>
            {children}
          </div>
        )}
      </details>
    </li>
  );
}

/** A titled group inside an open card. Space and a heading group it; a box holds its rows. */
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="admin-group" role="group" aria-label={title}>
      <h3 className="admin-group-title">{title}</h3>
      <div className="admin-group-body">{children}</div>
    </section>
  );
}

/**
 * One seller card, header menu and all.
 *
 * Its own component because `useSellerControls` is a hook and cannot be called inside the
 * list's `map`. That hook owns the seller's verbs AND everything they open — the editor, the
 * confirmation, the minted link, the outcome note — so the card hands the verbs to its header
 * and renders the rest above the groups they act on.
 */
function SellerEntityCard({
  seller,
  open,
  onToggle,
  fetcher,
}: {
  seller: SellerCard;
  open: boolean;
  onToggle: () => void;
  fetcher: typeof fetch;
}) {
  const canUpdate = seller.access.some((entry) => entry.revokedAt === null);
  const { row, menuItems, panel } = useSellerControls({ seller, canUpdate, fetcher });

  return (
    <Card
      id={seller.farmId}
      title={row.name}
      subtitle={
        seller.providers.length === 1
          ? (seller.providers[0] as ParticipationRow).standName
          : `${seller.providers.length} stands`
      }
      summary={sellerSummary({ retired: row.retired, canUpdate, providers: seller.providers })}
      actions={menuItems}
      open={open}
      onToggle={onToggle}
    >
      {panel}
      <Group title="Stands">
        <SellerParticipation view="seller" rows={seller.providers} fetcher={fetcher} />
      </Group>
      <Group title="Who can update">
        <AccessRoster seller={seller} fetcher={fetcher} />
      </Group>
    </Card>
  );
}

/**
 * Inviting a farmer, and the invitations already out (max, 2026-08-19).
 *
 * **On this screen because both are about a stand or seller joining the roster** — the subject
 * this destination owns. SMS Users is about handsets that have texted us, which is a different
 * subject that happened to be where the invite form was first built.
 *
 * Optional: a caller that carries no invites renders no section rather than an empty one.
 */
export interface InvitesPanel {
  requests: PendingRequestRow[];
  sellers: FarmOption[];
}

/**
 * What is in the trash, and the one control that takes it back out (F-124).
 *
 * **Trash and off-the-map are two decisions, not two names for one.** Off the map is the
 * everyday reversible hide: the record is still VIGA's, still in the roster, just not shown to
 * customers. Trash means "this should not be in my list at all", so a trashed record leaves the
 * roster entirely and is reachable only here. The two partition the records between them.
 *
 * **Nothing here destroys anything.** Every revision, report and authorization survives a
 * trashing untouched, which is exactly what lets a restore put back the record rather than an
 * approximation of it. "Empty the trash" is deliberately not built: a permanent delete has to
 * answer a large `on delete restrict` closure, and that is its own piece of work.
 */
export interface TrashPanel {
  stands: StandCard[];
  sellers: SellerCard[];
}

/** One row in the trash: what it was, and one press to put it back. */
interface TrashRow {
  key: string;
  name: string;
  subtitle: string;
  url: string;
  body: Record<string, string>;
}

function TrashSection({ trash, fetcher }: { trash: TrashPanel; fetcher: typeof fetch }) {
  // Restored rows leave the list without a reload: the operator just acted on this row, and
  // making them refresh to see it worked is how a screen teaches people not to trust it.
  const [restored, setRestored] = useState<string[]>([]);
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);

  const rows: TrashRow[] = [
    ...trash.stands.map((stand) => ({
      key: `stand:${stand.standId}`,
      name: stand.name,
      subtitle: stand.farmName,
      url: "/api/admin/stands",
      body: { standId: stand.standId, action: "restore_from_trash" },
    })),
    ...trash.sellers.map((seller) => ({
      key: `seller:${seller.farmId}`,
      name: seller.name,
      subtitle: "Seller",
      url: "/api/admin/sellers",
      body: { farmId: seller.farmId, action: "restore_from_trash" },
    })),
  ];

  const remaining = rows.filter((row) => !restored.includes(row.key));

  // An empty trash renders NOTHING, the same way no invites render no invites section: a
  // standing empty section is chrome an operator learns to skip.
  if (rows.length === 0) return null;

  async function restore(row: TrashRow) {
    setNote(null);
    let response: Response;
    try {
      response = await fetcher(row.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(row.body),
      });
    } catch {
      setNote({ kind: "bad", text: "That change did not go through. Try again." });
      return;
    }
    if (!response.ok) {
      // The row STAYS. A disappeared row would tell the operator the restore worked.
      setNote({ kind: "bad", text: "That change did not go through. Try again." });
      return;
    }
    setRestored((current) => [...current, row.key]);
    setNote({ kind: "ok", text: `${row.name} is back in your list.` });
  }

  return (
    <details className="admin-trash-section" role="group" aria-label="Trash">
      <summary className="admin-invites-summary">
        <span className="admin-row-caret-box" aria-hidden="true">
          <span className="admin-row-caret" />
        </span>
        <span className="admin-invites-title">Trash</span>
        <span className="admin-count">{remaining.length}</span>
      </summary>
      <div className="admin-invites-body">
        <p className="admin-trash-note">
          Nothing here is deleted. Every listing, update and report is still there, and putting
          one back restores exactly what was trashed.
        </p>
        {note !== null && (
          <p
            className={note.kind === "ok" ? "admin-note admin-note--ok" : "admin-note admin-note--bad"}
            role="status"
          >
            {note.text}
          </p>
        )}
        {remaining.length === 0 ? (
          <p className="admin-trash-note">The trash is empty.</p>
        ) : (
          <ul className="admin-trash-rows">
            {remaining.map((row) => (
              <li key={row.key} className="admin-trash-row">
                <span className="admin-row-identity">
                  <strong>{row.name}</strong>
                  <span className="admin-row-sub">{row.subtitle}</span>
                </span>
                {/*
                  One press, no confirmation: restoring puts something BACK, and its mistake is
                  undone by the same control (the rule un-retiring already follows). The name is
                  in the label so thirty rows do not offer thirty identical buttons.
                */}
                <button
                  type="button"
                  className="admin-secondary-button"
                  onClick={() => void restore(row)}
                >
                  Put back {row.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

export function StandsAndSellers({
  stands,
  sellers,
  invites,
  trash,
  fetcher = fetch,
}: {
  stands: StandCard[];
  sellers: SellerCard[];
  invites?: InvitesPanel;
  /** Absent renders no Trash section at all, the same way absent invites render none. */
  trash?: TrashPanel;
  fetcher?: typeof fetch;
}) {
  const [view, setView] = useState<View>("stands");
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const needle = filter.trim().toLowerCase();
  const visibleStands = stands.filter(
    (stand) =>
      needle === "" ||
      stand.name.toLowerCase().includes(needle) ||
      // A volunteer looking for a stand often knows only who sells there.
      stand.providers.some((row) => row.sellerName.toLowerCase().includes(needle)),
  );
  const visibleSellers = sellers.filter(
    (seller) =>
      needle === "" ||
      seller.name.toLowerCase().includes(needle) ||
      seller.providers.some((row) => row.standName.toLowerCase().includes(needle)),
  );

  const count = view === "stands" ? visibleStands.length : visibleSellers.length;

  function tab(target: View, label: string) {
    return (
      <button
        type="button"
        role="tab"
        aria-selected={view === target}
        className="admin-view-tab"
        onClick={() => {
          setView(target);
          // The open card belongs to the view it was opened in; carrying an id across would
          // open an unrelated entity that happened to share it.
          setOpen(null);
        }}
      >
        {label}
      </button>
    );
  }

  return (
    <div className="admin-stands-and-sellers">
      {/*
        INVITES, above the roster and shut by default (max, 2026-08-19).

        The roster is what an operator comes here for; an invite is occasional. A section that
        opened by default would push the list they came to read below the fold on every visit —
        so it announces itself with a heading and a count, and costs one press when wanted.

        A `<details>` for the same reason the entity cards use one: the browser owns the
        disclosure, so there is no open-state to hold here and nothing to get out of step.
      */}
      {invites !== undefined && (
        <details className="admin-invites-section" role="group" aria-label="Invites">
          <summary className="admin-invites-summary">
            <span className="admin-row-caret-box" aria-hidden="true">
              <span className="admin-row-caret" />
            </span>
            <span className="admin-invites-title">Invites</span>
            {invites.requests.length > 0 && (
              <span className="admin-count">{invites.requests.length}</span>
            )}
          </summary>
          <div className="admin-invites-body">
            <FarmerQueue requests={invites.requests} sellers={invites.sellers} />
          </div>
        </details>
      )}

      {/*
        The count sits BESIDE the switch as plain text (max, 2026-08-17). How many rows there
        are is a label for the list, not news — announcing it as a live status made a standing
        fact behave like an alert, which is the same wear the unclaimed flag was causing.
      */}
      <div className="admin-view-switch">
        <div className="admin-view-tabs" role="tablist" aria-label="Stands or sellers">
          {tab("stands", "Stands")}
          {tab("sellers", "Sellers")}
        </div>
        <span className="admin-view-count" data-testid="entity-count">
          {count}{" "}
          {view === "stands"
            ? count === 1
              ? "stand"
              : "stands"
            : count === 1
              ? "seller"
              : "sellers"}
        </span>
      </div>

      <input
        type="search"
        className="admin-filter"
        aria-label={view === "stands" ? "Filter stands" : "Filter sellers"}
        placeholder={view === "stands" ? "Find a stand" : "Find a seller"}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />

      {view === "stands" ? (
        <ul className="admin-farms">
          {visibleStands.map((stand) => (
            <Card
              key={stand.standId}
              id={stand.standId}
              title={stand.name}
              subtitle={stand.farmName}
              summary={standSummary(stand)}
              open={open === stand.standId}
              onToggle={() => setOpen(open === stand.standId ? null : stand.standId)}
            >
              {!(stand.providers.length === 1 && stand.providers[0]?.nativeSeller === true) && (
                <Group title="Also selling here">
                  <SellerParticipation view="stand" rows={stand.providers} fetcher={fetcher} />
                </Group>
              )}
              {/* The card head already named this stand, so the block does not name it again. */}
              {stand.details !== undefined && (
                <StandDetails stands={[stand.details]} headed={false} />
              )}
            </Card>
          ))}
        </ul>
      ) : (
        <ul className="admin-farms">
          {visibleSellers.map((seller) => (
            <SellerEntityCard
              key={seller.farmId}
              seller={seller}
              open={open === seller.farmId}
              onToggle={() => setOpen(open === seller.farmId ? null : seller.farmId)}
              fetcher={fetcher}
            />
          ))}
        </ul>
      )}

      {/*
        THE TRASH, below the roster and shut by default (max, 2026-08-19).

        Invites sits above the roster because an invite starts something; the trash sits below
        because it is where an operator goes to undo something. Both are occasional, so both
        announce themselves with a heading and a count and cost one press when wanted.
      */}
      {trash !== undefined && <TrashSection trash={trash} fetcher={fetcher} />}
    </div>
  );
}
