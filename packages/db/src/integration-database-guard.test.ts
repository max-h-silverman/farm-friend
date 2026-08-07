import { describe, expect, it } from "vitest";
import { assertIntegrationDatabaseIsDisposable } from "./integration-database-guard";

describe("integration database guard", () => {
  const productionNeon =
    "postgresql://neondb_owner:secret@ep-wild-queen-a6452fpe.us-west-2.aws.neon.tech/neondb?sslmode=require";
  const localUrl = "postgres://max@localhost:5432/farm_friend_admin_local";

  it("refuses the production Neon host the repo's .env actually contains", () => {
    expect(() => assertIntegrationDatabaseIsDisposable(productionNeon, undefined)).toThrow(
      /Refusing to run integration tests against non-local database host/,
    );
  });

  it("names the offending host so the operator can tell which database was rejected", () => {
    expect(() => assertIntegrationDatabaseIsDisposable(productionNeon, undefined)).toThrow(
      /ep-wild-queen-a6452fpe\.us-west-2\.aws\.neon\.tech/,
    );
  });

  it("allows the local Postgres URL that test:integration:local loads", () => {
    expect(() => assertIntegrationDatabaseIsDisposable(localUrl, undefined)).not.toThrow();
  });

  it.each([
    "postgres://u@127.0.0.1:5432/db",
    "postgres://u@[::1]:5432/db",
    "postgres://u@host.docker.internal:5432/db",
    "postgres://u@db.localhost:5432/db",
  ])("allows local host %s", (url) => {
    expect(() => assertIntegrationDatabaseIsDisposable(url, undefined)).not.toThrow();
  });

  it("allows a remote host only with the explicit opt-in", () => {
    expect(() => assertIntegrationDatabaseIsDisposable(productionNeon, "1")).not.toThrow();
  });

  it("treats any opt-in value other than 1 as absent", () => {
    expect(() => assertIntegrationDatabaseIsDisposable(productionNeon, "true")).toThrow(
      /Refusing to run integration tests/,
    );
  });

  it("fails loudly on a missing DATABASE_URL rather than skipping", () => {
    expect(() => assertIntegrationDatabaseIsDisposable(undefined, undefined)).toThrow(
      /DATABASE_URL is required/,
    );
  });

  it("fails on a malformed DATABASE_URL rather than parsing a host of ''", () => {
    expect(() => assertIntegrationDatabaseIsDisposable("not-a-url", undefined)).toThrow(
      /not a valid connection URL/,
    );
  });
});
