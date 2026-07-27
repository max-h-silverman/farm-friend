// Describing a database connection target without leaking its credentials (B-006).
//
// Lives in `src/` rather than beside the migrate script because it is the one piece of that script
// with a real invariant to test, and `scripts/` is deliberately outside the package's compiled
// surface (they are operator entry points run with `tsx`, never imported by the application).
//
// The invariant: an operator's real risk when migrating is pointing at the WRONG database, so the
// target must be named — but a Postgres connection string carries a password, and the moment it is
// most likely to be printed is also the moment someone is most likely to be recording their screen
// or pasting terminal output into a chat.

/**
 * Render a connection URL as `host:port/database`, omitting username and password.
 *
 * Throws if the input is not a valid URL, so a malformed `DATABASE_URL` fails before anything
 * connects rather than producing a confusing driver error.
 */
export function describeTarget(rawUrl: string): string {
  const url = new URL(rawUrl);
  const database = url.pathname.replace(/^\//, "") || "(default)";
  // `url.host` is host+port and excludes credentials by construction. Never `url.href`,
  // `url.password`, or the raw string.
  return `${url.host}/${database}`;
}
