import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    restoreMocks: true,
    clearMocks: true,
    include: [
      "tests/renderer/about_panel.test.tsx",
      "tests/renderer/active_buffer_diff_review.test.ts",
      "tests/renderer/app_shell.composition_contract.test.tsx",
      "tests/renderer/app_shell_overlay_layers.regression.test.tsx",
      "tests/renderer/chat_panel.test.tsx",
      "tests/renderer/command_palette.test.tsx",
      "tests/renderer/diagnostic_parser.test.ts",
      "tests/renderer/editor_buffers.test.ts",
      "tests/renderer/editor_tabs.test.tsx",
      "tests/renderer/file_tree_pane.test.tsx",
      "tests/renderer/index_health_panel.test.tsx",
      "tests/renderer/interaction_contract.test.tsx",
      "tests/renderer/outline_panel.test.tsx",
      "tests/renderer/release_surface_guard.test.ts"
    ],
    coverage: {
      enabled: false
    }
  }
});
