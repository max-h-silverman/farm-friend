import { assertIntegrationDatabaseIsDisposable } from "./packages/db/src/integration-database-guard";

// Runs once per integration test file, before any of it. Throwing here fails the file
// outright, so no `create database` reaches a host that should never see one.
assertIntegrationDatabaseIsDisposable(
  process.env.DATABASE_URL,
  process.env.ALLOW_INTEGRATION_TESTS_AGAINST_REMOTE_DB,
);
