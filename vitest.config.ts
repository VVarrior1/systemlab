import { defineConfig } from "vitest/config";

// The curriculum, remix and engine suites simulate every lesson on several seeds; a single test can
// legitimately take tens of seconds on a loaded machine, so the default 5 s budget produces phantom failures.
export default defineConfig({
  test: {
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
