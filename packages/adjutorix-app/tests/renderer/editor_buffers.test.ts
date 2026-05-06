import { describe, expect, it } from "vitest";

import {
  applyEditorBuffersActions,
  createInitialEditorBuffersState,
  editorBuffersReducer,
  validateEditorBuffersState,
  type EditorBuffersAction,
} from "../../src/renderer/state/editor_buffers";

function openFile(path: string, atMs: number, content = ""): EditorBuffersAction[] {
  return [
    {
      type: "BUFFER_OPEN_REQUESTED",
      payload: { path, atMs, readOnly: true },
    },
    {
      type: "BUFFER_OPEN_SUCCEEDED",
      payload: { path, content, atMs: atMs + 1, readOnly: true },
    },
  ];
}

describe("editor_buffers", () => {
  it("preserves operator open order instead of alphabetizing tabs", () => {
    const state = applyEditorBuffersActions(createInitialEditorBuffersState(), [
      ...openFile("/repo/zeta.ts", 1, "z"),
      ...openFile("/repo/alpha.ts", 3, "a"),
    ]);

    expect(state.tabOrder).toEqual(["/repo/zeta.ts", "/repo/alpha.ts"]);
    expect(state.activePath).toBe("/repo/alpha.ts");
    validateEditorBuffersState(state);
  });

  it("deduplicates explicit tab reorders while preserving the requested order", () => {
    const opened = applyEditorBuffersActions(createInitialEditorBuffersState(), [
      ...openFile("/repo/alpha.ts", 1, "a"),
      ...openFile("/repo/beta.ts", 3, "b"),
      ...openFile("/repo/gamma.ts", 5, "g"),
    ]);

    const reordered = editorBuffersReducer(opened, {
      type: "BUFFER_REORDERED",
      tabOrder: ["/repo/gamma.ts", "/repo/alpha.ts", "/repo/gamma.ts"],
    });

    expect(reordered.tabOrder).toEqual(["/repo/gamma.ts", "/repo/alpha.ts", "/repo/beta.ts"]);
    validateEditorBuffersState(reordered);
  });

  it("promotes the leftmost remaining operator tab when the active buffer closes", () => {
    const opened = applyEditorBuffersActions(createInitialEditorBuffersState(), [
      ...openFile("/repo/zeta.ts", 1, "z"),
      ...openFile("/repo/alpha.ts", 3, "a"),
      ...openFile("/repo/beta.ts", 5, "b"),
    ]);

    const closed = editorBuffersReducer(opened, {
      type: "BUFFER_CLOSED",
      path: "/repo/beta.ts",
      atMs: 7,
    });

    expect(closed.tabOrder).toEqual(["/repo/zeta.ts", "/repo/alpha.ts"]);
    expect(closed.activePath).toBe("/repo/zeta.ts");
    validateEditorBuffersState(closed);
  });
});
