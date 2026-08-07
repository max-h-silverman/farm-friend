// Integration tests run DDL: each one creates a throwaway database, applies every
// migration into it, then drops it. Pointed at a managed/production host that means
// creating and dropping real databases beside the live one, on the live account.
//
// The repo's own `.env` holds the production Neon DATABASE_URL, so the mistake is a
// single stray `--env-file=.env` (or an exported shell var) away. This guard is the
// one seam every integration test passes through, so the check lives here rather
// than in each of the ~58 test files.
//
// Allowed: local hosts, and anything explicitly opted in via
// ALLOW_INTEGRATION_TESTS_AGAINST_REMOTE_DB=1 for a deliberate throwaway remote.

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "host.docker.internal"]);

export function assertIntegrationDatabaseIsDisposable(
  databaseUrl: string | undefined,
  optIn: string | undefined,
): void {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required; a skipped integration run is not green");
  }

  let hostname: string;
  try {
    hostname = new URL(databaseUrl).hostname;
  } catch {
    throw new Error("DATABASE_URL is not a valid connection URL");
  }

  // Bracketed IPv6 literals arrive from the URL parser as "[::1]".
  const bare = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (LOCAL_HOSTNAMES.has(bare) || bare.endsWith(".local") || bare.endsWith(".localhost")) {
    return;
  }

  if (optIn === "1") return;

  throw new Error(
    `Refusing to run integration tests against non-local database host "${hostname}".\n` +
      "Integration tests CREATE and DROP databases on the target server.\n" +
      "The repo's .env points at production Neon — if that is what is loaded here, this guard just saved it.\n" +
      "Run `npm run test:integration:local` (uses apps/web/.env.local), or set\n" +
      "ALLOW_INTEGRATION_TESTS_AGAINST_REMOTE_DB=1 if this really is a throwaway remote database.",
  );
}
