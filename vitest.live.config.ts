import { defineConfig } from "vitest/config";

// The full gate's tests (tests-folder conventions): they need the built app,
// so `npm test` leaves them out and `npm run test:full` runs them, one file at
// a time, with no runner timeouts.
export default defineConfig({
  test: {
    include: ["tests/live/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 0,
    hookTimeout: 0,
  },
});
