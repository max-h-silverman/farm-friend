/**
 * The console's marks.
 *
 * Inline SVG rather than a font or a package: there are nine of them, they inherit `currentColor`
 * so a chip's tone paints its own icon, and nothing has to load before a row is legible.
 *
 * **Every one is decorative.** `aria-hidden` throughout, because each sits beside a label that
 * already carries the meaning — a chip whose state depended on the picture would fail the rule
 * that no state is communicated by colour or glyph alone.
 */

function Icon({ children, size = 16 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function PencilIcon() {
  return (
    <Icon>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </Icon>
  );
}

export function CheckIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </Icon>
  );
}

export function LinkIcon() {
  return (
    <Icon>
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </Icon>
  );
}

export function FlaskIcon() {
  return (
    <Icon>
      <path d="M9 3h6" />
      <path d="M10 3v6L5 18a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-9V3" />
      <path d="M7.5 14h9" />
    </Icon>
  );
}

/** Taking something off the map: a pin, struck through. */
export function UnpinIcon() {
  return (
    <Icon>
      <path d="M12 21s-6-5.7-6-10a6 6 0 0 1 8.5-5.4" />
      <path d="M18 8.5A6.6 6.6 0 0 1 18 11" />
      <circle cx="12" cy="11" r="2.2" />
      <path d="M4 3.5 20 20" />
    </Icon>
  );
}

export function TrashIcon() {
  return (
    <Icon>
      <path d="M4 7h16" />
      <path d="M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7" />
      <path d="M6.5 7 7.4 19a2 2 0 0 0 2 1.9h5.2a2 2 0 0 0 2-1.9L17.5 7" />
      <path d="M10.5 11v6M13.5 11v6" />
    </Icon>
  );
}

/** Visible to customers — people, not an eye: the fact is who sees it. */
export function PeopleIcon() {
  return (
    <Icon>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.3a3.2 3.2 0 0 1 0 5.6" />
      <path d="M17.5 14.6A5.5 5.5 0 0 1 20.5 20" />
    </Icon>
  );
}

export function ClockIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5.2l3.2 2" />
    </Icon>
  );
}

export function InfoIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 7.8h.01" />
    </Icon>
  );
}

/** A stand: the awning over a counter. The one glyph that names a place rather than an action. */
export function StandIcon() {
  return (
    <Icon size={20}>
      <path d="M4 10v9h16v-9" />
      <path d="M3 10 5 5h14l2 5a2.6 2.6 0 0 1-4.5 1.6A2.6 2.6 0 0 1 12 11.6a2.6 2.6 0 0 1-4.5 0A2.6 2.6 0 0 1 3 10Z" />
      <path d="M9.5 19v-4.5h5V19" />
    </Icon>
  );
}
