import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    restoreMocks: true,
    clearMocks: true,
    include: [
      "tests/renderer/file_tree_pane.test.tsx",
      "tests/renderer/diagnostic_parser.test.ts",
      "tests/renderer/about_panel.test.tsx"
    ],
    coverage: {
      enabled: false
    }
  }
});
