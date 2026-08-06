import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Unmount anything a jsdom test rendered, between tests.
//
// Testing Library registers this itself ONLY when `globals: true` exposes a global
// `afterEach` — this project runs without globals, so nothing was tearing renders down and
// every mounted component stayed in the document for the rest of the file. Assertions kept
// passing anyway because `getByText` finds the FIRST match, so a leaked render from an
// earlier test satisfied a later one: a test could pass while the behavior it named was
// broken, and only a duplicate-match error ever exposed it.
//
// Harmless in the node-environment suites, which never mount anything.
afterEach(() => {
  cleanup();
});
