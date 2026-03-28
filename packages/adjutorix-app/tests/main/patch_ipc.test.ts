import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / MAIN / patch_ipc.test.ts
 *
 * Canonical patch-IPC contract suite.
 *
 * Purpose:
 * - verify that main-process patch IPC preserves one authoritative boundary for patch-review snapshot,
 *   refresh, file selection, hunk selection, comment creation, verify-evidence updates,
 *   and apply-readiness event delivery to renderer surfaces
 * - verify that request/response contracts, event fanout, policy gating, shape validation,
 *   optimistic review actions, and unsubscribe cleanup remain deterministic
 * - verify that stale or malformed patch events cannot desynchronize renderer review state
 *   from main-process patch truth
 *
 * Test philosophy:
 * - no snapshots
 * - assert orchestration semantics, event routing, lifecycle guarantees, and limiting cases directly
 * - prefer selection drift, cleanup, and shape-drift counterexamples over happy-path only coverage
 *
 * Notes:
 * - this suite assumes src/main/ipc/patch_ipc exports the functions and types referenced below
 * - if the production module exports differ slightly, update adapters first rather than weakening intent
 */

import {
  createPatchIpc,
  type PatchIpcEnvironment,
  type PatchReviewSnapshot,
  type PatchReviewFile,
  type PatchReviewHunk,
  type PatchReviewComment,
  type PatchVerifyEvidence,
  type PatchEventPayload,
} from "../../../src/main/ipc/patch_ipc";

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
  return {
    patchId: "patch-42",
    title: "Refactor renderer shell composition",
    status: "in-review",
    selectedFileId: "file-1",
    selectedHunkId: "hunk-1",
    files: [
      file({
        id: "file-1",
        path: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
        kind: "modify",
        status: "commented",
        addedLineCount: 24,
        deletedLineCount: 8,
        hunks: [
          hunk({ id: "hunk-1", header: "@@ -20,8 +20,15 @@", oldRange: { startLine: 20, endLine: 28 }, newRange: { startLine: 20, endLine: 35 }, addedLineCount: 7 }),
          hunk({ id: "hunk-2", header: "@@ -80,6 +87,14 @@", oldRange: { startLine: 80, endLine: 86 }, newRange: { startLine: 87, endLine: 101 }, addedLineCount: 8 }),
        ],
        comments: [
          comment({ id: "comment-1", body: "Status badge grouping needs clarification.", filePath: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx", hunkId: "hunk-1" }),
        ],
      }),
      file({
        id: "file-2",
        path: "/repo/adjutorix-app/src/renderer/components/ProviderStatus.tsx",
        kind: "modify",
        status: "accepted",
        addedLineCount: 6,
        deletedLineCount: 2,
        hunks: [
          hunk({ id: "hunk-3", header: "@@ -1,3 +1,7 @@", oldRange: { startLine: 1, endLine: 3 }, newRange: { startLine: 1, endLine: 7 }, addedLineCount: 4 }),
        ],
        comments: [],
      }),
    ],
    comments: [
      comment({ id: "comment-global-1", body: "Apply gate remains blocked until rejected files are resolved." }),
    ],
    verifyEvidence: [
      evidence({ verifyId: "verify-9", status: "passed", summary: "Renderer contract verify passed." }),
      evidence({ verifyId: "verify-10", status: "partial", summary: "Smoke suite pending due to rejected file state." }),
    ],
    applyReadiness: "blocked",
    health: {
      level: "healthy",
      reasons: [],
    },
    metadata: {
      provider: "patch-review-service",
    },
    ...overrides,
  } as PatchReviewSnapshot;
}

function env(overrides: Partial<PatchIpcEnvironment> = {}): PatchIpcEnvironment {
  const listeners = new Map<string, Set<(payload: PatchEventPayload) => void>>();

  return {
    patchService: {
      loadPatchReview: vi.fn(async () => snapshot()),
      refreshPatchReview: vi.fn(async () => snapshot({ metadata: { refreshed: true } })),
      selectFile: vi.fn(async () => undefined),
      selectHunk: vi.fn(async () => undefined),
      createComment: vi.fn(async (patchId: string, payload: { body: string; fileId?: string | null; hunkId?: string | null }) =>
        comment({
          id: "comment-new-1",
          body: payload.body,
          filePath: payload.fileId ? "/repo/adjutorix-app/src/renderer/components/AppShell.tsx" : null,
          hunkId: payload.hunkId ?? null,
        }),
      ),
      subscribe: vi.fn((patchId: string, listener: (payload: PatchEventPayload) => void) => {
        if (!listeners.has(patchId)) listeners.set(patchId, new Set());
        listeners.get(patchId)!.add(listener);
        return () => listeners.get(patchId)?.delete(listener);
      }),
      emit: (patchId: string, payload: PatchEventPayload) => {
        listeners.get(patchId)?.forEach((listener) => listener(payload));
      },
    },
    policy: {
      evaluate: vi.fn(() => ({ allowed: true, violations: [] })),
    },
    sender: {
      sendToWebContents: vi.fn(),
    },
    ...overrides,
  } as unknown as PatchIpcEnvironment;
}

describe("main/ipc/patch_ipc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads a patch-review snapshot through IPC with canonical response shape", async () => {
    const environment = env();
    const ipc = createPatchIpc(environment);

    const result = await ipc.handleLoadPatchReview({
      requestId: "req-load-1",
      payload: { patchId: "patch-42" },
      webContentsId: 7,
    });

    expect(environment.patchService.loadPatchReview).toHaveBeenCalledWith("patch-42");
    expect(result.ok).toBe(true);
    expect(result.result.patchId).toBe("patch-42");
    expect(result.result.selectedFileId).toBe("file-1");
    expect(result.result.selectedHunkId).toBe("hunk-1");
  });

  it("refreshes a patch-review snapshot through IPC without changing canonical patch identity", async () => {
    const environment = env();
    const ipc = createPatchIpc(environment);

    const result = await ipc.handleRefreshPatchReview({
      requestId: "req-refresh-1",
      payload: { patchId: "patch-42" },
      webContentsId: 7,
    });

    expect(environment.patchService.refreshPatchReview).toHaveBeenCalledWith("patch-42");
    expect(result.ok).toBe(true);
    expect(result.result.patchId).toBe("patch-42");
    expect(result.result.metadata).toEqual(expect.objectContaining({ refreshed: true }));
  });

  it("routes file selection through the patch service and returns normalized success", async () => {
    const environment = env();
    const ipc = createPatchIpc(environment);

    const result = await ipc.handleSelectFile({
      requestId: "req-select-file-1",
      payload: {
        patchId: "patch-42",
        fileId: "file-2",
      },
      webContentsId: 7,
    });

    expect(environment.patchService.selectFile).toHaveBeenCalledWith("patch-42", "file-2");
    expect(result.ok).toBe(true);
  });

  it("routes hunk selection through the patch service and returns normalized success", async () => {
    const environment = env();
    const ipc = createPatchIpc(environment);

    const result = await ipc.handleSelectHunk({
      requestId: "req-select-hunk-1",
      payload: {
        patchId: "patch-42",
        hunkId: "hunk-2",
      },
      webContentsId: 7,
    });

    expect(environment.patchService.selectHunk).toHaveBeenCalledWith("patch-42", "hunk-2");
    expect(result.ok).toBe(true);
  });

  it("creates a comment through IPC and returns the normalized created comment payload", async () => {
    const environment = env();
    const ipc = createPatchIpc(environment);

    const result = await ipc.handleCreateComment({
      requestId: "req-comment-1",
      payload: {
        patchId: "patch-42",
        body: "Need explicit provider status trust semantics.",
        fileId: "file-1",
        hunkId: "hunk-1",
      },
      webContentsId: 7,
    });

    expect(environment.patchService.createComment).toHaveBeenCalledWith(
      "patch-42",
      expect.objectContaining({
        body: "Need explicit provider status trust semantics.",
        fileId: "file-1",
        hunkId: "hunk-1",
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.result).toEqual(
      expect.objectContaining({
        id: "comment-new-1",
        body: "Need explicit provider status trust semantics.",
      }),
    );
  });

  it("rejects policy-denied patch-review loads before reaching the patch service", async () => {
    const environment = env({
      policy: {
        evaluate: vi.fn(() => ({ allowed: false, violations: [{ code: "AUTHORITY_DENIED" }] })),
      },
    });
    const ipc = createPatchIpc(environment);

    const result = await ipc.handleLoadPatchReview({
      requestId: "req-load-2",
      payload: { patchId: "patch-42" },
      webContentsId: 7,
    });

    expect(environment.patchService.loadPatchReview).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("PATCH_IPC_POLICY_DENIED");
  });

  it("rejects malformed file-selection payloads without calling the patch service", async () => {
    const environment = env();
    const ipc = createPatchIpc(environment);

    const result = await ipc.handleSelectFile({
      requestId: "req-select-file-2",
      payload: {
        patchId: "patch-42",
      } as unknown as { patchId: string; fileId: string },
      webContentsId: 7,
    });

    expect(environment.patchService.selectFile).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("INVALID_PATCH_REQUEST");
  });

  it("rejects malformed comment payloads without required body content", async () => {
    const environment = env();
    const ipc = createPatchIpc(environment);

    const result = await ipc.handleCreateComment({
      requestId: "req-comment-2",
      payload: {
        patchId: "patch-42",
        body: "",
      },
      webContentsId: 7,
    });

    expect(environment.patchService.createComment).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("INVALID_PATCH_REQUEST");
  });

  it("normalizes patch-service failures into structured IPC errors instead of leaking raw exceptions", async () => {
    const environment = env({
      patchService: {
        ...env().patchService,
        loadPatchReview: vi.fn(async () => {
          throw new Error("patch service unavailable");
        }),
      },
    });
    const ipc = createPatchIpc(environment);

    const result = await ipc.handleLoadPatchReview({
      requestId: "req-load-3",
      payload: { patchId: "patch-42" },
      webContentsId: 7,
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("PATCH_IPC_HANDLER_FAILED");
    expect(result.error.message).toContain("patch service unavailable");
  });

  it("subscribes a renderer to patch events and fans out snapshot events to the correct webContents", async () => {
    const environment = env();
    const ipc = createPatchIpc(environment);

    const sub = await ipc.handleSubscribePatch({
      requestId: "req-sub-1",
      payload: { patchId: "patch-42" },
      webContentsId: 7,
    });

    expect(sub.ok).toBe(true);
    expect(environment.patchService.subscribe).toHaveBeenCalledWith("patch-42", expect.any(Function));

    environment.patchService.emit("patch-42", {
      type: "patch-review-snapshot",
      snapshot: snapshot({ patchId: "patch-42", title: "event review" }),
    });

    expect(environment.sender.sendToWebContents).toHaveBeenCalledWith(
      7,
      "patch:event",
      expect.objectContaining({
        type: "patch-review-snapshot",
        snapshot: expect.objectContaining({ title: "event review" }),
      }),
    );
  });

  it("fans out file, comment, verify-evidence, apply-readiness, selection, and health events without mutating shape", async () => {
    const environment = env();
    const ipc = createPatchIpc(environment);

    await ipc.handleSubscribePatch({
      requestId: "req-sub-2",
      payload: { patchId: "patch-42" },
      webContentsId: 9,
    });

    environment.patchService.emit("patch-42", {
      type: "patch-review-file",
      file: file({
        id: "file-3",
        path: "/repo/adjutorix-app/src/renderer/components/DiagnosticsPanel.tsx",
        kind: "modify",
        status: "rejected",
        hunks: [hunk({ id: "hunk-4", header: "@@ -55,9 +55,7 @@" })],
        comments: [],
      }),
    });
    environment.patchService.emit("patch-42", {
      type: "patch-review-comment",
      comment: comment({
        id: "comment-3",
        body: "Severity grouping must align with diagnostic_parser output.",
        filePath: "/repo/adjutorix-app/src/renderer/components/DiagnosticsPanel.tsx",
        hunkId: "hunk-4",
      }),
    });
    environment.patchService.emit("patch-42", {
      type: "patch-review-verify-evidence",
      verifyEvidence: [
        evidence({ verifyId: "verify-11", status: "failed", summary: "Replay mismatch blocks apply." }),
      ],
    });
    environment.patchService.emit("patch-42", {
      type: "patch-review-apply-readiness",
      applyReadiness: "blocked",
    });
    environment.patchService.emit("patch-42", {
      type: "patch-review-selection",
      selectedFileId: "file-3",
      selectedHunkId: "hunk-4",
    });
    environment.patchService.emit("patch-42", {
      type: "patch-review-health",
      health: {
        level: "degraded",
        reasons: ["verify evidence stale"],
      },
    });

    const payloads = (environment.sender.sendToWebContents as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => call[0] === 9 && call[1] === "patch:event")
      .map((call) => call[2]);

    expect(payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "patch-review-file", file: expect.objectContaining({ id: "file-3", status: "rejected" }) }),
        expect.objectContaining({ type: "patch-review-comment", comment: expect.objectContaining({ id: "comment-3" }) }),
        expect.objectContaining({ type: "patch-review-verify-evidence", verifyEvidence: [expect.objectContaining({ verifyId: "verify-11", status: "failed" })] }),
        expect.objectContaining({ type: "patch-review-apply-readiness", applyReadiness: "blocked" }),
        expect.objectContaining({ type: "patch-review-selection", selectedFileId: "file-3", selectedHunkId: "hunk-4" }),
        expect.objectContaining({ type: "patch-review-health", health: expect.objectContaining({ level: "degraded" }) }),
      ]),
    );
  });

  it("does not fan out events for one patch to renderers subscribed to a different patch", async () => {
    const environment = env();
    const ipc = createPatchIpc(environment);

    await ipc.handleSubscribePatch({
      requestId: "req-sub-3",
      payload: { patchId: "patch-42" },
      webContentsId: 7,
    });
    await ipc.handleSubscribePatch({
      requestId: "req-sub-4",
      payload: { patchId: "patch-99" },
      webContentsId: 8,
    });

    environment.patchService.emit("patch-42", {
      type: "patch-review-selection",
      selectedFileId: "file-1",
      selectedHunkId: "hunk-1",
    });

    const calls = (environment.sender.sendToWebContents as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((call) => call[0] === 7)).toBe(true);
    expect(calls.some((call) => call[0] === 8)).toBe(false);
  });

  it("supports multiple subscribers on the same patch and fans out identical events to each", async () => {
    const environment = env();
    const ipc = createPatchIpc(environment);

    await ipc.handleSubscribePatch({
      requestId: "req-sub-5",
      payload: { patchId: "patch-42" },
      webContentsId: 11,
    });
    await ipc.handleSubscribePatch({
      requestId: "req-sub-6",
      payload: { patchId: "patch-42" },
      webContentsId: 12,
    });

    environment.patchService.emit("patch-42", {
      type: "patch-review-health",
      health: { level: "degraded", reasons: ["selection drift recovered"] },
    });

    expect(environment.sender.sendToWebContents).toHaveBeenCalledWith(
      11,
      "patch:event",
      expect.objectContaining({ type: "patch-review-health" }),
    );
    expect(environment.sender.sendToWebContents).toHaveBeenCalledWith(
      12,
      "patch:event",
      expect.objectContaining({ type: "patch-review-health" }),
    );
  });

  it("unsubscribes deterministically so later patch events no longer reach that renderer", async () => {
    const environment = env();
    const ipc = createPatchIpc(environment);

    const sub = await ipc.handleSubscribePatch({
      requestId: "req-sub-7",
      payload: { patchId: "patch-42" },
      webContentsId: 13,
    });

    expect(sub.ok).toBe(true);

    const unsub = await ipc.handleUnsubscribePatch({
      requestId: "req-unsub-1",
      payload: { patchId: "patch-42" },
      webContentsId: 13,
    });

    expect(unsub.ok).toBe(true);

    environment.patchService.emit("patch-42", {
      type: "patch-review-comment",
      comment: comment({ id: "comment-after-unsub", body: "should not arrive" }),
    });

    const calls = (environment.sender.sendToWebContents as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((call) => call[0] === 13)).toBe(false);
  });

  it("treats duplicate subscribe requests from the same renderer and patch idempotently", async () => {
    const environment = env();
    const ipc = createPatchIpc(environment);

    await ipc.handleSubscribePatch({
      requestId: "req-sub-8",
      payload: { patchId: "patch-42" },
      webContentsId: 14,
    });
    await ipc.handleSubscribePatch({
      requestId: "req-sub-9",
      payload: { patchId: "patch-42" },
      webContentsId: 14,
    });

    environment.patchService.emit("patch-42", {
      type: "patch-review-apply-readiness",
      applyReadiness: "ready",
    });

    const calls = (environment.sender.sendToWebContents as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0] === 14 && call[1] === "patch:event",
    );

    expect(calls).toHaveLength(1);
  });

  it("rejects subscribe requests denied by policy before wiring listeners", async () => {
    const environment = env({
      policy: {
        evaluate: vi.fn(() => ({ allowed: false, violations: [{ code: "TRUST_DENIED" }] })),
      },
    });
    const ipc = createPatchIpc(environment);

    const result = await ipc.handleSubscribePatch({
      requestId: "req-sub-10",
      payload: { patchId: "patch-42" },
      webContentsId: 15,
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("PATCH_IPC_POLICY_DENIED");
    expect(environment.patchService.subscribe).not.toHaveBeenCalled();
  });

  it("normalizes malformed emitted patch events instead of forwarding invalid shapes directly to renderer", async () => {
    const environment = env();
    const ipc = createPatchIpc(environment);

    await ipc.handleSubscribePatch({
      requestId: "req-sub-11",
      payload: { patchId: "patch-42" },
      webContentsId: 16,
    });

    environment.patchService.emit("patch-42", {
      type: "patch-review-selection",
      selectedFileId: null,
      selectedHunkId: null,
    } as unknown as PatchEventPayload);

    expect(environment.sender.sendToWebContents).not.toHaveBeenCalled();
  });

  it("cleans up all subscriptions on dispose so later emissions cannot leak into dead registries", async () => {
    const environment = env();
    const ipc = createPatchIpc(environment);

    await ipc.handleSubscribePatch({
      requestId: "req-sub-12",
      payload: { patchId: "patch-42" },
      webContentsId: 17,
    });

    ipc.dispose();

    environment.patchService.emit("patch-42", {
      type: "patch-review-health",
      health: { level: "degraded", reasons: ["disposed registry should stay silent"] },
    });

    expect(environment.sender.sendToWebContents).not.toHaveBeenCalled();
  });

  it("returns deterministic identical request verdicts for identical patch-review loads", async () => {
    const environment = env();
    const ipc = createPatchIpc(environment);

    const a = await ipc.handleLoadPatchReview({
      requestId: "req-load-4a",
      payload: { patchId: "patch-42" },
      webContentsId: 7,
    });
    const b = await ipc.handleLoadPatchReview({
      requestId: "req-load-4b",
      payload: { patchId: "patch-42" },
      webContentsId: 7,
    });

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.result).toEqual(b.result);
  });
});
