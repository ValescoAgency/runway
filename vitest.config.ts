import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // No coverage gate yet — VA-348 deliberately skips this so we can see
    // the baseline before deciding where to set thresholds.
  },
});
