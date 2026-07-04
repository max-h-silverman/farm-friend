import { defineConfig } from "vitest/config";

// Integration tests: data-layer invariants against Postgres (tenant scoping, the
// stock-out-report-never-mutates-inventory rule, importer idempotency, VIGA seed).
// Requires DATABASE_URL; skips its body when unset (see the suite guards).
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.integration.test.ts"],
    exclude: ["**/node_modules/**"],
    environment: "node",
    testTimeout: 30_000,
  },
});
