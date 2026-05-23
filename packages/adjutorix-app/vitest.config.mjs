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
      "tests/renderer/diagnostics_panel.test.tsx",
      "tests/renderer/diff_viewer_pane.test.tsx",
      "tests/renderer/editor_buffers.test.ts",
      "tests/renderer/editor_tabs.test.tsx",
      "tests/renderer/file_tree_pane.test.tsx",
      "tests/renderer/index_health_panel.test.tsx",
      "tests/renderer/interaction_contract.test.tsx",
      "tests/renderer/job_panel.test.tsx",
      "tests/renderer/keyboard.test.ts",
      "tests/renderer/large_file_guard.test.ts",
      "tests/renderer/ledger_panel.test.tsx",
      "tests/renderer/monaco_editor_pane.test.tsx",
      "tests/renderer/monaco_models.test.ts",
      "tests/renderer/outline_panel.test.tsx",
      "tests/renderer/patch_review_panel.test.tsx",
      "tests/renderer/path_labels.test.ts",
      "tests/renderer/provider_status.test.tsx",
      "tests/renderer/operator_kernel_ipc_contract.test.ts",
      "tests/renderer/release_surface_guard.test.ts",
      "tests/renderer/search_panel.test.tsx",
      "tests/renderer/settings_panel.test.tsx",
      "tests/renderer/split_layout.test.tsx",
      "tests/renderer/terminal_panel.test.tsx",
      "tests/renderer/transaction_graph_panel.test.tsx",
      "tests/renderer/use_agent.test.ts",
      "tests/renderer/use_keyboard_shortcuts.test.ts",
      "tests/renderer/use_ledger.test.ts",
      "tests/renderer/use_patch_review.test.ts",
      "tests/renderer/use_workspace.test.ts",
      "tests/renderer/verify_panel.test.tsx",
      "tests/renderer/welcome_screen.test.tsx"
    ],
    coverage: {
      enabled: false
    }
  }
});
