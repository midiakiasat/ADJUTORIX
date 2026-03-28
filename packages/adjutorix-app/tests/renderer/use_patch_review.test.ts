import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / RENDERER / use_patch_review.test.ts
 *
 * Canonical usePatchReview hook contract suite.
 *
 * Purpose:
 * - verify that usePatchReview preserves one authoritative renderer-side projection of patch-review truth
 * - verify that load/refresh flows are sequence-guarded so stale completions never overwrite newer review state
 * - verify that file, hunk, comment, verify-evidence, and apply-readiness updates remain deterministic
 * - verify that derived indexes, counts, and selected entities stay aligned to the canonical snapshot
 * - verify that empty, loading, refreshing, degraded, blocked, and error states remain explicit
 *
 * Test philosophy:
 * - no implementation snapshots
 * - assert hook contract, state transitions, race guarantees, and derived-data invariants directly
 * - prefer review lineage, selection coupling, and apply-gate consistency over shallow happy-path checks
 *
 * Notes:
 * - this suite assumes usePatchReview exports both a named and default hook from the renderer hooks tree
 * - if the production hook signature evolves, update fixture builders first
 */

import usePatchReview, {
  type PatchReviewComment,
  type PatchReviewEvent,
  type PatchReviewFile,
  type PatchReviewHealth,
  type PatchReviewHunk,
  type PatchReviewProvider,
  type PatchReviewSnapshot,
  type PatchVerifyEvidence,
} from "../../../src/hooks/usePatchReview";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function health(level: PatchReviewHealth["level"], reasons: string[] = []): PatchReviewHealth {
  return { level, reasons };
}

function hunk(partial: Partial<PatchReviewHunk> & Pick<PatchReviewHunk, "id" | "header">): PatchReviewHunk {
  return {
    oldRange: { startLine: 1, endLine: 1 },
    newRange: { startLine: 1, endLine: 1 },
    lines: [],
    addedLineCount: 0,
    deletedLineCount: 0,
    ...partial,
  } as PatchReviewHunk;
}

function comment(partial: Partial<PatchReviewComment> & Pick<PatchReviewComment, "id" | "body">): PatchReviewComment {
  return {
    author: "reviewer",
    createdAtMs: 1711000000000,
    status: "open",
    filePath: null,
    hunkId: null,
    ...partial,
  } as PatchReviewComment;
}

function file(partial: Partial<PatchReviewFile> & Pick<PatchReviewFile, "id" | "path" | "kind" | "status">): PatchReviewFile {
  return {
    oldPath: null,
    addedLineCount: 0,
    deletedLineCount: 0,
    hunks: [],
    comments: [],
    ...partial,
  } as PatchReviewFile;
}

function evidence(partial: Partial<PatchVerifyEvidence> & Pick<PatchVerifyEvidence, "verifyId" | "status" | "summary">): PatchVerifyEvidence {
  return {
    updatedAtMs: 1711000000000,
    ...partial,
  } as PatchVerifyEvidence;
}

function snapshot(overrides: Partial<PatchReviewSnapshot> = {}): PatchReviewSnapshot {
  const file1 = file({
    id: "file-1",
    path: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
    kind: "modify",
    status: "commented",
    addedLineCount: 24,
    deletedLineCount: 8,
    hunks: [
      hunk({ id: "hunk-1", header: "@@ -20,8 +20,15 @@", oldRange: { startLine: 20, endLine: 28 }, newRange: { startLine: 20, endLine: 35 }, addedLineCount: 7, deletedLineCount: 0 }),
      hunk({ id: "hunk-2", header: "@@ -80,6 +87,14 @@", oldRange: { startLine: 80, endLine: 86 }, newRange: { startLine: 87, endLine: 101 }, addedLineCount: 8, deletedLineCount: 0 }),
    ],
    comments: [
      comment({ id: "comment-1", body: "Status badge grouping needs clarification.", filePath: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx", hunkId: "hunk-1" }),
    ],
  });

  const file2 = file({
    id: "file-2",
    path: "/repo/adjutorix-app/src/renderer/components/ProviderStatus.tsx",
    kind: "modify",
    status: "accepted",
    addedLineCount: 6,
    deletedLineCount: 2,
    hunks: [
      hunk({ id: "hunk-3", header: "@@ -1,3 +1,7 @@", oldRange: { startLine: 1, endLine: 3 }, newRange: { startLine: 1, endLine: 7 }, addedLineCount: 4, deletedLineCount: 0 }),
    ],
    comments: [],
  });

  const file3 = file({
    id: "file-3",
    path: "/repo/adjutorix-app/src/renderer/components/DiagnosticsPanel.tsx",
    kind: "modify",
    status: "rejected",
    addedLineCount: 3,
    deletedLineCount: 5,
    hunks: [
      hunk({ id: "hunk-4", header: "@@ -55,9 +55,7 @@", oldRange: { startLine: 55, endLine: 64 }, newRange: { startLine: 55, endLine: 62 }, addedLineCount: 0, deletedLineCount: 2 }),
    ],
    comments: [
      comment({ id: "comment-2", body: "Severity grouping must stay aligned with diagnostic_parser output.", filePath: "/repo/adjutorix-app/src/renderer/components/DiagnosticsPanel.tsx", hunkId: "hunk-4" }),
    ],
  });

  return {
    patchId: "patch-42",
    title: "Refactor renderer shell composition",
    status: "in-review",
    selectedFileId: "file-1",
    selectedHunkId: "hunk-1",
    files: [file1, file2, file3],
    comments: [
      comment({ id: "comment-global-1", body: "Apply gate remains blocked until rejected files are resolved." }),
    ],
    verifyEvidence: [
      evidence({ verifyId: "verify-9", status: "passed", summary: "Renderer contract verify passed." }),
      evidence({ verifyId: "verify-10", status: "partial", summary: "Smoke suite pending due to rejected file state." }),
    ],
    applyReadiness: "blocked",
    health: health("healthy"),
    metadata: {
      provider: "patch-review-service",
    },
    ...overrides,
  } as PatchReviewSnapshot;
}

function makeProvider(overrides: Partial<PatchReviewProvider> = {}): PatchReviewProvider {
  return {
    loadPatchReview: vi.fn(async () => snapshot()),
    refreshPatchReview: vi.fn(async () => snapshot({ metadata: { refreshed: true } })),
    selectFile: vi.fn(async () => undefined),
    selectHunk: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => undefined),
    ...overrides,
  };
}

describe("usePatchReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hydrates from provider load into ready state with canonical snapshot and derived review indexes", async () => {
    const provider = makeProvider();
    const { result } = renderHook(() => usePatchReview({ provider, autoLoad: true }));

    expect(result.current.state).toBe("loading");
    expect(result.current.isBusy).toBe(true);

    await waitFor(() => expect(result.current.state).toBe("ready"));

    expect(provider.loadPatchReview).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot?.patchId).toBe("patch-42");
    expect(result.current.snapshot?.selectedFileId).toBe("file-1");
    expect(result.current.snapshot?.selectedHunkId).toBe("hunk-1");

    expect(result.current.derived.totalFiles).toBe(3);
    expect(result.current.derived.totalHunks).toBe(4);
    expect(result.current.derived.totalComments).toBe(3);
    expect(result.current.derived.acceptedFiles).toBe(1);
    expect(result.current.derived.rejectedFiles).toBe(1);
    expect(result.current.derived.commentedFiles).toBe(1);
    expect(result.current.derived.selectedFile?.path).toContain("AppShell.tsx");
    expect(result.current.derived.selectedHunk?.id).toBe("hunk-1");
    expect(result.current.derived.filesById.get("file-2")?.status).toBe("accepted");
    expect(result.current.derived.hunksById.get("hunk-4")?.header).toContain("@@ -55,9 +55,7 @@");
    expect(result.current.derived.commentsById.get("comment-global-1")?.body).toContain("Apply gate remains blocked");
    expect(result.current.derived.isApplyBlocked).toBe(true);
    expect(result.current.derived.isVerifyPassing).toBe(false);
  });

  it("stays idle without autoLoad and only transitions after explicit reload", async () => {
    const provider = makeProvider();
    const { result } = renderHook(() => usePatchReview({ provider, autoLoad: false }));

    expect(result.current.state).toBe("idle");
    expect(provider.loadPatchReview).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.reload();
    });

    expect(provider.loadPatchReview).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("ready");
  });

  it("uses refreshPatchReview during refresh and preserves ready semantics after completion", async () => {
    const provider = makeProvider();
    const { result } = renderHook(() => usePatchReview({ provider, autoLoad: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    await act(async () => {
      const promise = result.current.refresh();
      expect(result.current.state).toBe("refreshing");
      await promise;
    });

    expect(provider.refreshPatchReview).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("ready");
    expect(result.current.snapshot?.metadata).toEqual(expect.objectContaining({ refreshed: true }));
  });

  it("falls back to loadPatchReview on refresh when refreshPatchReview is unavailable", async () => {
    const provider = makeProvider({ refreshPatchReview: undefined });
    const { result } = renderHook(() => usePatchReview({ provider, autoLoad: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    await act(async () => {
      await result.current.refresh();
    });

    expect(provider.loadPatchReview).toHaveBeenCalledTimes(2);
  });

  it("guards against stale async load completion overwriting newer refresh results", async () => {
    const first = deferred<PatchReviewSnapshot>();
    const second = deferred<PatchReviewSnapshot>();

    const provider = makeProvider({
      loadPatchReview: vi.fn(() => first.promise),
      refreshPatchReview: vi.fn(() => second.promise),
    });

    const { result } = renderHook(() => usePatchReview({ provider, autoLoad: true }));

    await act(async () => {
      const refreshPromise = result.current.refresh();
      second.resolve(snapshot({ patchId: "patch-new", title: "newer review" }));
      await refreshPromise;
    });

    expect(result.current.snapshot?.patchId).toBe("patch-new");

    await act(async () => {
      first.resolve(snapshot({ patchId: "patch-stale", title: "stale review" }));
      await Promise.resolve();
    });

    expect(result.current.snapshot?.patchId).toBe("patch-new");
    expect(result.current.snapshot?.title).toBe("newer review");
  });

  it("exposes error state on failing load and preserves no snapshot truth", async () => {
    const provider = makeProvider({
      loadPatchReview: vi.fn(async () => {
        throw new Error("patch review load failed");
      }),
    });

    const { result } = renderHook(() => usePatchReview({ provider, autoLoad: true }));

    await waitFor(() => expect(result.current.state).toBe("error"));

    expect(result.current.error?.message).toBe("patch review load failed");
    expect(result.current.snapshot).toBeNull();
    expect(result.current.derived.totalFiles).toBe(0);
    expect(result.current.isReady).toBe(false);
  });

  it("selects file through provider and updates local selectedFileId and derived selectedFile immediately", async () => {
    const provider = makeProvider();
    const { result } = renderHook(() => usePatchReview({ provider, autoLoad: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    await act(async () => {
      await result.current.selectFile("file-2");
    });

    expect(provider.selectFile).toHaveBeenCalledWith("file-2");
    expect(result.current.snapshot?.selectedFileId).toBe("file-2");
    expect(result.current.derived.selectedFile?.path).toContain("ProviderStatus.tsx");

    expect(result.current.snapshot?.selectedHunkId).toBe("hunk-3");
    expect(result.current.derived.selectedHunk?.id).toBe("hunk-3");
  });

  it("selects hunk through provider and keeps selectedHunk aligned to the current file", async () => {
    const provider = makeProvider();
    const { result } = renderHook(() => usePatchReview({ provider, autoLoad: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    await act(async () => {
      await result.current.selectHunk("hunk-2");
    });

    expect(provider.selectHunk).toHaveBeenCalledWith("hunk-2");
    expect(result.current.snapshot?.selectedHunkId).toBe("hunk-2");
    expect(result.current.derived.selectedHunk?.header).toContain("@@ -80,6 +87,14 @@");
  });

  it("replaces snapshot explicitly through setSnapshot and rebuilds all derived indexes", () => {
    const provider = makeProvider();
    const { result } = renderHook(() => usePatchReview({ provider, autoLoad: false }));

    const next = snapshot({
      patchId: "patch-replaced",
      selectedFileId: "file-a",
      selectedHunkId: "hunk-a",
      files: [
        file({
          id: "file-a",
          path: "/repo/adjutorix-app/README.md",
          kind: "modify",
          status: "accepted",
          hunks: [hunk({ id: "hunk-a", header: "@@ -1,2 +1,2 @@" })],
          comments: [],
        }),
      ],
      comments: [],
      verifyEvidence: [evidence({ verifyId: "verify-a", status: "passed", summary: "all passed" })],
      applyReadiness: "ready",
    });

    act(() => {
      result.current.setSnapshot(next);
    });

    expect(result.current.snapshot?.patchId).toBe("patch-replaced");
    expect(result.current.derived.totalFiles).toBe(1);
    expect(result.current.derived.totalHunks).toBe(1);
    expect(result.current.derived.totalComments).toBe(0);
    expect(result.current.derived.selectedFile?.path).toContain("README.md");
    expect(result.current.derived.selectedHunk?.id).toBe("hunk-a");
    expect(result.current.derived.isApplyBlocked).toBe(false);
    expect(result.current.derived.isVerifyPassing).toBe(true);
  });

  it("subscribes to provider events and applies full snapshot replacement events canonically", async () => {
    let listener: ((event: PatchReviewEvent) => void) | null = null;
    const unsubscribe = vi.fn();
    const provider = makeProvider({
      subscribe: vi.fn((cb) => {
        listener = cb;
        return unsubscribe;
      }),
    });

    const { result, unmount } = renderHook(() => usePatchReview({ provider, autoLoad: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    act(() => {
      listener?.({
        type: "patch-review-snapshot",
        snapshot: snapshot({ patchId: "patch-event", title: "from-event" }),
      });
    });

    expect(result.current.snapshot?.patchId).toBe("patch-event");
    expect(result.current.snapshot?.title).toBe("from-event");

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("applies file upsert events and recomputes counts and file indexes", async () => {
    let listener: ((event: PatchReviewEvent) => void) | null = null;
    const provider = makeProvider({
      subscribe: vi.fn((cb) => {
        listener = cb;
        return () => undefined;
      }),
    });

    const { result } = renderHook(() => usePatchReview({ provider, autoLoad: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    act(() => {
      listener?.({
        type: "patch-review-file",
        file: file({
          id: "file-4",
          path: "/repo/adjutorix-app/src/renderer/components/ChatPanel.tsx",
          kind: "modify",
          status: "commented",
          hunks: [hunk({ id: "hunk-5", header: "@@ -1,1 +1,5 @@" })],
          comments: [],
        }),
      });
    });

    expect(result.current.derived.totalFiles).toBe(4);
    expect(result.current.derived.totalHunks).toBe(5);
    expect(result.current.derived.commentedFiles).toBe(2);
    expect(result.current.derived.filesById.get("file-4")?.path).toContain("ChatPanel.tsx");
  });

  it("applies comment upsert events and recomputes total comment count and comment indexes", async () => {
    let listener: ((event: PatchReviewEvent) => void) | null = null;
    const provider = makeProvider({
      subscribe: vi.fn((cb) => {
        listener = cb;
        return () => undefined;
      }),
    });

    const { result } = renderHook(() => usePatchReview({ provider, autoLoad: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    act(() => {
      listener?.({
        type: "patch-review-comment",
        comment: comment({
          id: "comment-3",
          body: "New review comment",
          filePath: "/repo/adjutorix-app/src/renderer/components/ProviderStatus.tsx",
          hunkId: "hunk-3",
        }),
      });
    });

    expect(result.current.derived.totalComments).toBe(4);
    expect(result.current.derived.commentsById.get("comment-3")?.body).toBe("New review comment");
  });

  it("applies verify evidence events and recomputes isVerifyPassing correctly", async () => {
    let listener: ((event: PatchReviewEvent) => void) | null = null;
    const provider = makeProvider({
      subscribe: vi.fn((cb) => {
        listener = cb;
        return () => undefined;
      }),
    });

    const { result } = renderHook(() => usePatchReview({ provider, autoLoad: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(result.current.derived.isVerifyPassing).toBe(false);

    act(() => {
      listener?.({
        type: "patch-review-verify-evidence",
        verifyEvidence: [evidence({ verifyId: "verify-pass", status: "passed", summary: "everything passed" })],
      });
    });

    expect(result.current.snapshot?.verifyEvidence).toHaveLength(1);
    expect(result.current.derived.isVerifyPassing).toBe(true);
  });

  it("applies apply readiness events and recomputes isApplyBlocked correctly", async () => {
    let listener: ((event: PatchReviewEvent) => void) | null = null;
    const provider = makeProvider({
      subscribe: vi.fn((cb) => {
        listener = cb;
        return () => undefined;
      }),
    });

    const { result } = renderHook(() => usePatchReview({ provider, autoLoad: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(result.current.derived.isApplyBlocked).toBe(true);

    act(() => {
      listener?.({
        type: "patch-review-apply-readiness",
        applyReadiness: "ready",
      });
    });

    expect(result.current.snapshot?.applyReadiness).toBe("ready");
    expect(result.current.derived.isApplyBlocked).toBe(false);
  });

  it("applies selection events and keeps selected file and hunk aligned", async () => {
    let listener: ((event: PatchReviewEvent) => void) | null = null;
    const provider = makeProvider({
      subscribe: vi.fn((cb) => {
        listener = cb;
        return () => undefined;
      }),
    });

    const { result } = renderHook(() => usePatchReview({ provider, autoLoad: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    act(() => {
      listener?.({
        type: "patch-review-selection",
        selectedFileId: "file-3",
        selectedHunkId: "hunk-4",
      });
    });

    expect(result.current.snapshot?.selectedFileId).toBe("file-3");
    expect(result.current.snapshot?.selectedHunkId).toBe("hunk-4");
    expect(result.current.derived.selectedFile?.path).toContain("DiagnosticsPanel.tsx");
    expect(result.current.derived.selectedHunk?.id).toBe("hunk-4");
  });

  it("applies health events and preserves degraded review posture explicitly", async () => {
    let listener: ((event: PatchReviewEvent) => void) | null = null;
    const provider = makeProvider({
      subscribe: vi.fn((cb) => {
        listener = cb;
        return () => undefined;
      }),
    });

    const { result } = renderHook(() => usePatchReview({ provider, autoLoad: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    act(() => {
      listener?.({
        type: "patch-review-health",
        health: health("degraded", ["verify evidence stale", "selection drift recovered"]),
      });
    });

    expect(result.current.snapshot?.health.level).toBe("degraded");
    expect(result.current.snapshot?.health.reasons).toEqual(["verify evidence stale", "selection drift recovered"]);
  });

  it("returns empty derived truth when snapshot is null", () => {
    const provider = makeProvider();
    const { result } = renderHook(() => usePatchReview({ provider, autoLoad: false }));

    expect(result.current.snapshot).toBeNull();
    expect(result.current.derived.totalFiles).toBe(0);
    expect(result.current.derived.totalHunks).toBe(0);
    expect(result.current.derived.totalComments).toBe(0);
    expect(result.current.derived.selectedFile).toBeNull();
    expect(result.current.derived.selectedHunk).toBeNull();
  });

  it("does not mutate state after unmount when async load resolves late", async () => {
    const gate = deferred<PatchReviewSnapshot>();
    const provider = makeProvider({ loadPatchReview: vi.fn(() => gate.promise) });

    const { unmount } = renderHook(() => usePatchReview({ provider, autoLoad: true }));
    unmount();

    await act(async () => {
      gate.resolve(snapshot({ patchId: "patch-late" }));
      await Promise.resolve();
    });

    expect(provider.loadPatchReview).toHaveBeenCalledTimes(1);
  });

  it("preserves provider-thrown selection failures instead of hiding them behind local mutation", async () => {
    const provider = makeProvider({
      selectFile: vi.fn(async () => {
        throw new Error("file selection denied");
      }),
    });

    const { result } = renderHook(() => usePatchReview({ provider, autoLoad: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    await expect(
      act(async () => {
        await result.current.selectFile("file-2");
      }),
    ).rejects.toThrow("file selection denied");

    expect(result.current.snapshot?.selectedFileId).toBe("file-1");
  });

  it("preserves provider-thrown hunk selection failures instead of silently rewriting selected hunk truth", async () => {
    const provider = makeProvider({
      selectHunk: vi.fn(async () => {
        throw new Error("hunk selection denied");
      }),
    });

    const { result } = renderHook(() => usePatchReview({ provider, autoLoad: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    await expect(
      act(async () => {
        await result.current.selectHunk("hunk-2");
      }),
    ).rejects.toThrow("hunk selection denied");

    expect(result.current.snapshot?.selectedHunkId).toBe("hunk-1");
  });

  it("tracks busy and ready flags consistently across load, refresh, and error phases", async () => {
    const gate = deferred<PatchReviewSnapshot>();
    const provider = makeProvider({ loadPatchReview: vi.fn(() => gate.promise) });

    const { result } = renderHook(() => usePatchReview({ provider, autoLoad: true }));

    expect(result.current.isBusy).toBe(true);
    expect(result.current.isReady).toBe(false);

    await act(async () => {
      gate.resolve(snapshot());
      await gate.promise;
    });

    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(result.current.isBusy).toBe(false);
    expect(result.current.isReady).toBe(true);
  });

  it("preserves empty-but-ready review truth for newly created empty patches", async () => {
    const provider = makeProvider({
      loadPatchReview: vi.fn(async () =>
        snapshot({
          patchId: "patch-empty",
          title: "empty review",
          files: [],
          comments: [],
          verifyEvidence: [],
          selectedFileId: null,
          selectedHunkId: null,
          applyReadiness: "unknown",
          status: "draft",
        }),
      ),
    });

    const { result } = renderHook(() => usePatchReview({ provider, autoLoad: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    expect(result.current.snapshot?.patchId).toBe("patch-empty");
    expect(result.current.derived.totalFiles).toBe(0);
    expect(result.current.derived.totalHunks).toBe(0);
    expect(result.current.derived.totalComments).toBe(0);
    expect(result.current.derived.selectedFile).toBeNull();
    expect(result.current.derived.isApplyBlocked).toBe(false);
  });
});
