import { defineConfig } from "vitest/config";

// Unit tests: pure core logic + seam behavior. No DB/SMS/LLM I/O — providers and
// Clock are injected. Integration tests (Postgres) live in vitest.integration.config.ts.
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    exclude: ["**/*.integration.test.ts", "**/node_modules/**"],
    environment: "node",
  },
});
