"use client";

import { useState } from "react";
import { ActionMenu, type ActionMenuItem } from "./action-menu";
import { ClockIcon, PeopleIcon } from "./icons";
import { useSellerControls } from "./seller-controls";
import { StandDetails, type AdminStandCard } from "./stand-list";
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

/**
 * What this stand or seller needs from an operator right now, or null when it needs nothing.
 * Shown on the collapsed summary so a long list can be scanned without opening every card —
 * "which of these needs me?" is the question an operator arrives with.
 */
function standAttention(stand: StandCard): string | null {
  if (stand.retired) return null;
  if (!stand.approved) return "Waiting for approval";
  if (stand.providers.length === 0) return "Nobody sells here";
  if (stand.providers.every((row) => row.lifecycleState === "paused")) return "Nothing on sale";
  return null;
}

function sellerAttention(seller: SellerCard): string | null {
  if (seller.retired) return null;
  if (!seller.approved) return "Waiting for approval";
  if (seller.providers.length === 0) return "Sells nowhere";
  return null;
}

/**
 * What is TRUE of this stand right now, as chips.
 *
 * **Read from the stand's own card, never re-derived here.** `openState` is `stand-cards.ts`'s
 * projection of closure — code owns that answer (Golden Rule #3), and a second reading of the
 * hours in the browser would be a second answer for the map and the console to disagree about.
 * So the chip either shows the sentence that projection produced, or shows nothing.
 *
 * A retired stand's visibility and open state describe a listing nobody is being shown, so
 * "Off the map" replaces them rather than joining them.
 */
function standStates(stand: StandCard): CardState[] {
  if (stand.retired) return [{ key: "retired", label: "Off the map" }];

  const openState = stand.details?.openState;
  return [
    {
      key: "visible",
      label: stand.approved ? "Visible to customers" : "Not yet on the map",
      tone: stand.approved ? "ok" : "neutral",
      icon: <PeopleIcon />,
    },
    ...(openState === undefined
      ? []
      : [
          {
            key: "open",
            label: openState,
            // Green for open, plain for every other honest answer — "Not open today" and
            // "Open status not stated" are facts, not faults, so neither turns amber.
            tone: openState === "Open now" ? ("ok" as const) : ("neutral" as const),
            icon: <ClockIcon />,
          },
        ]),
  ];
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
 * A chip: one neutral fact about a record, in a tone that names its kind.
 *
 * One mechanism with tones rather than a family of near-duplicates, and **every tone keeps its
 * text** — an operator never has to have learned that green means visible. The icon is
 * decorative for the same reason.
 */
function Chip({
  tone = "neutral",
  icon,
  children,
}: {
  tone?: "neutral" | "ok" | "attention";
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span className={`admin-chip admin-chip--${tone}`}>
      {icon !== undefined && (
        <span className="admin-chip-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span>{children}</span>
    </span>
  );
}

export interface CardState {
  key: string;
  label: string;
  tone?: "neutral" | "ok" | "attention";
  icon?: React.ReactNode;
}

/**
 * The card: a header bar you can read at a glance, and a body you open to work in.
 *
 * **The header is identity, state, and one way in** (max, 2026-08-17). Name and subtitle on
 * the left, chips for what is true of the record, and a single Actions menu on the right.
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
  attention,
  states,
  actions,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  subtitle: string;
  attention: string | null;
  /** Neutral facts about the record. Never work waiting — that is `attention`. */
  states: CardState[];
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
          <span className="admin-row-states">
            {states.map((state) => (
              <Chip key={state.key} tone={state.tone} icon={state.icon}>
                {state.label}
              </Chip>
            ))}
            {attention !== null && <Chip tone="attention">{attention}</Chip>}
          </span>
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

  /*
    What is TRUE of this seller, in the order it matters: whether customers can see her at all,
    then whether anyone can publish for her. A retired farm's other states describe a listing
    nobody is being shown, so "Off the map" replaces them rather than joining them.
  */
  const states: CardState[] = row.retired
    ? [{ key: "retired", label: "Off the map" }]
    : [
        ...(row.isTestFarm ? [{ key: "test", label: "Test farm" }] : []),
        ...(canUpdate
          ? []
          : [{ key: "unclaimed", label: "Unclaimed" }]),
      ];

  return (
    <Card
      id={seller.farmId}
      title={row.name}
      subtitle={
        seller.providers.length === 1
          ? (seller.providers[0] as ParticipationRow).standName
          : `${seller.providers.length} stands`
      }
      attention={sellerAttention({ ...seller, approved: row.approved, retired: row.retired })}
      states={states}
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

export function StandsAndSellers({
  stands,
  sellers,
  fetcher = fetch,
}: {
  stands: StandCard[];
  sellers: SellerCard[];
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

  // What is waiting, counted from the same rows the operator is looking at. Each phrase is the
  // plural of one card's own attention line, so the summary and the card never disagree.
  const waitingApproval =
    view === "stands"
      ? visibleStands.filter((stand) => !stand.approved && !stand.retired).length
      : visibleSellers.filter((seller) => !seller.approved && !seller.retired).length;
  const attention = [
    waitingApproval > 0 ? `${waitingApproval} waiting for approval` : null,
  ].filter((part): part is string => part !== null);

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

      {/*
        What is WAITING, above the rows it describes (max, 2026-08-10), and only when there is
        some. A standing "0 waiting" is chrome an operator learns to skip, which is exactly how
        the real number stops being noticed — so an empty attention line renders nothing at all.
      */}
      {attention.length > 0 && (
        <p className="admin-attention-summary" role="status">
          {attention.join(" · ")}
        </p>
      )}

      {view === "stands" ? (
        <ul className="admin-farms">
          {visibleStands.map((stand) => (
            <Card
              key={stand.standId}
              id={stand.standId}
              title={stand.name}
              subtitle={stand.farmName}
              attention={standAttention(stand)}
              states={standStates(stand)}
              open={open === stand.standId}
              onToggle={() => setOpen(open === stand.standId ? null : stand.standId)}
            >
              <Group title="Also selling here">
                <SellerParticipation view="stand" rows={stand.providers} fetcher={fetcher} />
              </Group>
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
    </div>
  );
}
