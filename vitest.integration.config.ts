import { defineConfig } from "vitest/config";

// Integration tests create an empty throwaway Postgres database, apply every
// committed migration, exercise the launch constraints, then drop that database.
// DATABASE_URL is required and its role must be allowed to create/drop databases.
export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.integration.test.ts",
      // The composition root in apps/web is where verified ingress, the database, and
      // the SMS adapter meet, so its integration tests live beside it.
      "apps/*/**/*.integration.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    environment: "node",
    testTimeout: 30_000,
  },
});
