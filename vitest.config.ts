import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.{js,ts}"],
    globals: true,
    setupFiles: ["__tests__/setup.ts"],
    // All suites share one database.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
