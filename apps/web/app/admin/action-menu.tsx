"use client";

import { useEffect, useId, useRef, useState } from "react";

/**
 * The console's one menu.
 *
 * A card's **Actions** button and a row's **kebab** are the same mechanism at two sizes, so
 * they are one component with a `compact` flag rather than two that drift apart. Everything a
 * VIGA volunteer can do *about* a record hangs off it, which is what lets a card at rest show
 * an identity and its states instead of a wrapping row of five buttons — the operator reads
 * the list first, and acts second.
 *
 * **It only opens things.** Nothing here writes: every item hands control back to the card,
 * which keeps its own confirmation for anything destructive. A menu that committed on the item
 * press would put a real removal one misclick away, and `danger` is styling, never authority.
 *
 * **A `null` item is absent, not disabled.** An action a record cannot take is a question the
 * operator should never be asked — the existing controls already work this way (no setup link
 * for a claimed farm), and the menu keeps that rule rather than greying rows out.
 */

export interface ActionMenuItem {
  key: string;
  label: string;
  /** A small leading mark. Decorative — the label always carries the meaning. */
  icon?: React.ReactNode;
  /** Renders in red under a divider. Presentation only; the card still confirms. */
  danger?: boolean;
  onSelect: () => void;
}

export function ActionMenu({
  label,
  items,
  compact = false,
  disabled = false,
}: {
  /** The trigger's accessible name. On a compact trigger it is the ONLY name it has. */
  label: string;
  /** `null` entries are omitted, so a caller can express "not offered here" inline. */
  items: Array<ActionMenuItem | null>;
  compact?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const offered = items.filter((item): item is ActionMenuItem => item !== null);

  /*
    Escape and an outside press both close WITHOUT running anything. Bound only while open, so
    a page of thirty cards holds no listeners for the twenty-nine that are shut.

    `pointerdown` rather than `click`: a press that begins outside has already dismissed the
    menu by the time the click lands, so an item cannot be selected by a press that started
    somewhere else.
  */
  useEffect(() => {
    if (!open) return;

    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    }
    function onPointerDown(event: PointerEvent) {
      const node = event.target;
      if (node instanceof Node && wrapper.current?.contains(node) === true) return;
      setOpen(false);
    }

    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  if (offered.length === 0) return null;

  return (
    <div className="admin-menu" ref={wrapper}>
      <button
        ref={trigger}
        type="button"
        className={compact ? "admin-menu-trigger admin-menu-trigger--compact" : "admin-menu-trigger"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={compact ? label : undefined}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        {compact ? (
          <KebabGlyph />
        ) : (
          <>
            <span>{label}</span>
            <CaretGlyph />
          </>
        )}
      </button>

      {open && (
        <div className="admin-menu-list" id={menuId} role="menu" aria-label={label}>
          {offered.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className={item.danger ? "admin-menu-item admin-menu-item--danger" : "admin-menu-item"}
              onClick={() => {
                // Closed BEFORE the action runs, so the card's own answer — a note, a
                // confirmation, a revealed link — is never covered by the menu that asked for it.
                setOpen(false);
                item.onSelect();
              }}
            >
              <span className="admin-menu-item-icon" aria-hidden="true">
                {item.icon}
              </span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CaretGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M4 6.5 8 10.5 12 6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function KebabGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="3.2" r="1.35" fill="currentColor" />
      <circle cx="8" cy="8" r="1.35" fill="currentColor" />
      <circle cx="8" cy="12.8" r="1.35" fill="currentColor" />
    </svg>
  );
}
