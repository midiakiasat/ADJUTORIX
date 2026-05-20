import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: false,
    include: [
      "tests/smoke/**/*.{test,spec}.{ts,tsx}",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.{idea,git,cache,output,temp}/**",
      "tests/smoke/quarantined-pre-local-operator-loop/**",
      "tests/smoke/quarantined-domain-smoke-v96/**",
      "tests/smoke/**/*.disabled",
      "tests/smoke/**/*.pending.{ts,tsx}",
    ],
    passWithNoTests: false,
  },
});
