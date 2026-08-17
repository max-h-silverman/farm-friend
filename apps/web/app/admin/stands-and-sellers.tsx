"use client";

import { useState } from "react";
import { SellerControls } from "./seller-controls";
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
 * Nobody can publish for this farm yet (max, 2026-08-17).
 *
 * A STATE of the record, deliberately not an alert. Most farms begin life this way — VIGA
 * enters them from the map long before a farmer takes one over — so flagging it made the
 * attention line permanent furniture, and an operator who learns to skip that line skips the
 * real alert sitting next to it.
 *
 * It still shows, as a neutral chip, because "has this one been claimed?" is a question the
 * operator genuinely asks. What changed is that it no longer shouts.
 */
function unclaimed(seller: SellerCard): boolean {
  return !seller.retired && seller.access.every((row) => row.revokedAt !== null);
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
    <section className="admin-access-roster">
      <h4>Who can update this listing</h4>
      {live.length === 0 ? (
        <p className="admin-note">Unclaimed — no handset can publish for this farm yet.</p>
      ) : (
        live.map((row) => (
          <p key={row.authorizationId} className="admin-access-row">
            <span>{row.senderMask}</span>
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
    </section>
  );
}

function Card({
  id,
  title,
  subtitle,
  attention,
  states,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  subtitle: string;
  attention: string | null;
  /** Neutral facts about the record. Never work waiting — that is `attention`. */
  states: string[];
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <li className="admin-farm-card">
      <details open={open}>
        {/*
          The farm directory's own scan row, minus its glyph (max, 2026-08-17): caret,
          identity, meta, states. Reused rather than restyled — a second row vocabulary would
          mean two visual languages for one console, and the fixed leading columns are what
          keep every name on the same x down a long list.
        */}
        <summary
          className="admin-row"
          onClick={(event) => {
            event.preventDefault();
            onToggle();
          }}
        >
          <span className="admin-row-caret" aria-hidden="true" />
          <span className="admin-row-identity">
            <strong>{title}</strong>
            <span className="admin-row-sub">{subtitle}</span>
          </span>
          <span className="admin-row-meta" />
          <span className="admin-row-states">
            {states.map((state) => (
              <span key={state} className="admin-pill">
                {state}
              </span>
            ))}
            {attention !== null && (
              <span className="admin-pill admin-pill--attention">{attention}</span>
            )}
          </span>
        </summary>
        {open && (
          <div className="admin-entity-detail" id={`entity-${id}`} role="group" aria-label={title}>
            {children}
          </div>
        )}
      </details>
    </li>
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
              states={[]}
              open={open === stand.standId}
              onToggle={() => setOpen(open === stand.standId ? null : stand.standId)}
            >
              {stand.details !== undefined && <StandDetails stands={[stand.details]} />}
              <SellerParticipation view="stand" rows={stand.providers} fetcher={fetcher} />
            </Card>
          ))}
        </ul>
      ) : (
        <ul className="admin-farms">
          {visibleSellers.map((seller) => (
            <Card
              key={seller.farmId}
              id={seller.farmId}
              title={seller.name}
              subtitle={
                seller.providers.length === 1
                  ? (seller.providers[0] as ParticipationRow).standName
                  : `${seller.providers.length} stands`
              }
              attention={sellerAttention(seller)}
              states={unclaimed(seller) ? ["Unclaimed"] : []}
              open={open === seller.farmId}
              onToggle={() => setOpen(open === seller.farmId ? null : seller.farmId)}
            >
              <SellerControls
                seller={seller}
                canUpdate={seller.access.some((row) => row.revokedAt === null)}
                fetcher={fetcher}
              />
              <SellerParticipation view="seller" rows={seller.providers} fetcher={fetcher} />
              <AccessRoster seller={seller} fetcher={fetcher} />
            </Card>
          ))}
        </ul>
      )}
    </div>
  );
}
