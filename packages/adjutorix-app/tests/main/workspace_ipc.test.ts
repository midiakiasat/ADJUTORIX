import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / MAIN / workspace_ipc.test.ts
 *
 * Canonical workspace-IPC contract suite.
 *
 * Purpose:
 * - verify that main-process workspace IPC preserves one authoritative boundary for workspace snapshot,
 *   refresh, selection, expansion, and subscription event delivery to renderer surfaces
 * - verify that request/response contracts, event fanout, watcher-driven updates, root/path constraints,
 *   error normalization, and unsubscribe cleanup remain deterministic
 * - verify that stale or malformed workspace events cannot desynchronize renderer state from main-process truth
 *
 * Test philosophy:
 * - no snapshots
 * - assert orchestration semantics, event routing, and lifecycle guarantees directly
 * - prefer race, cleanup, and shape-drift counterexamples over happy-path only coverage
 *
 * Notes:
 * - this suite assumes src/main/ipc/workspace_ipc exports the functions and types referenced below
 * - if the production module exports differ slightly, update adapters first rather than weakening intent
 */

import {
  createWorkspaceIpc,
  type WorkspaceIpcEnvironment,
  type WorkspaceSnapshot,
  type WorkspaceEntry,
  type WorkspaceEventPayload,
} from "../../../src/main/ipc/workspace_ipc";

function entry(partial: Partial<WorkspaceEntry> & Pick<WorkspaceEntry, "path" | "name" | "kind">): WorkspaceEntry {
  return {
    parentPath: null,
    hidden: false,
    ignored: false,
    diagnosticsCount: 0,
    childCount: 0,
    ...partial,
  } as WorkspaceEntry;
}

function snapshot(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    workspaceId: "ws-1",
    rootPath: "/repo/adjutorix-app",
    name: "adjutorix-app",
    trustLevel: "trusted",
    status: "ready",
    entries: [
      entry({ path: "/repo/adjutorix-app", name: "adjutorix-app", kind: "directory", childCount: 2 }),
      entry({ path: "/repo/adjutorix-app/src", name: "src", kind: "directory", parentPath: "/repo/adjutorix-app", childCount: 1 }),
      entry({ path: "/repo/adjutorix-app/src/renderer", name: "renderer", kind: "directory", parentPath: "/repo/adjutorix-app/src", childCount: 1 }),
      entry({ path: "/repo/adjutorix-app/src/renderer/App.tsx", name: "App.tsx", kind: "file", parentPath: "/repo/adjutorix-app/src/renderer" }),
    ],
    expandedPaths: ["/repo/adjutorix-app", "/repo/adjutorix-app/src"],
    openedPaths: ["/repo/adjutorix-app/src/renderer/App.tsx"],
    recentPaths: ["/repo/adjutorix-app/src/renderer/App.tsx"],
    selectedPath: "/repo/adjutorix-app/src/renderer/App.tsx",
    diagnostics: {
      total: 1,
      fatalCount: 0,
      errorCount: 1,
      warningCount: 0,
      infoCount: 0,
    },
    health: {
      level: "healthy",
      reasons: [],
    },
    indexStatus: {
      state: "ready",
      progressPct: 100,
      issueCount: 0,
    },
    watcherStatus: {
      state: "watching",
      watchedPaths: 12,
      eventLagMs: 7,
    },
    metadata: {
      provider: "filesystem",
    },
    ...overrides,
  } as WorkspaceSnapshot;
}

function env(overrides: Partial<WorkspaceIpcEnvironment> = {}): WorkspaceIpcEnvironment {
  const listeners = new Map<string, Set<(payload: WorkspaceEventPayload) => void>>();

  return {
    workspaceService: {
      loadWorkspace: vi.fn(async () => snapshot()),
      refreshWorkspace: vi.fn(async () => snapshot({ metadata: { refreshed: true } })),
      selectPath: vi.fn(async () => undefined),
      setExpandedPaths: vi.fn(async () => undefined),
      subscribe: vi.fn((workspaceId: string, listener: (payload: WorkspaceEventPayload) => void) => {
        const key = workspaceId;
        if (!listeners.has(key)) listeners.set(key, new Set());
        listeners.get(key)!.add(listener);
        return () => listeners.get(key)?.delete(listener);
      }),
      emit: (workspaceId: string, payload: WorkspaceEventPayload) => {
        listeners.get(workspaceId)?.forEach((listener) => listener(payload));
      },
    },
    policy: {
      evaluate: vi.fn(() => ({ allowed: true, violations: [] })),
    },
    sender: {
      sendToWebContents: vi.fn(),
    },
    ...overrides,
  } as unknown as WorkspaceIpcEnvironment;
}

describe("main/ipc/workspace_ipc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads a workspace snapshot through IPC with canonical response shape", async () => {
    const environment = env();
    const ipc = createWorkspaceIpc(environment);

    const result = await ipc.handleLoadWorkspace({
      requestId: "req-load-1",
      payload: { workspaceId: "ws-1" },
      webContentsId: 7,
    });

    expect(environment.workspaceService.loadWorkspace).toHaveBeenCalledWith("ws-1");
    expect(result.ok).toBe(true);
    expect(result.result.workspaceId).toBe("ws-1");
    expect(result.result.selectedPath).toBe("/repo/adjutorix-app/src/renderer/App.tsx");
  });

  it("refreshes a workspace snapshot through IPC without changing the authoritative workspace identity", async () => {
    const environment = env();
    const ipc = createWorkspaceIpc(environment);

    const result = await ipc.handleRefreshWorkspace({
      requestId: "req-refresh-1",
      payload: { workspaceId: "ws-1" },
      webContentsId: 7,
    });

    expect(environment.workspaceService.refreshWorkspace).toHaveBeenCalledWith("ws-1");
    expect(result.ok).toBe(true);
    expect(result.result.workspaceId).toBe("ws-1");
    expect(result.result.metadata).toEqual(expect.objectContaining({ refreshed: true }));
  });

  it("routes selection changes through the workspace service and returns normalized success", async () => {
    const environment = env();
    const ipc = createWorkspaceIpc(environment);

    const result = await ipc.handleSelectPath({
      requestId: "req-select-1",
      payload: {
        workspaceId: "ws-1",
        path: "/repo/adjutorix-app/src/renderer/App.tsx",
      },
      webContentsId: 7,
    });

    expect(environment.workspaceService.selectPath).toHaveBeenCalledWith(
      "ws-1",
      "/repo/adjutorix-app/src/renderer/App.tsx",
    );
    expect(result.ok).toBe(true);
  });

  it("routes expanded-path updates through the workspace service and preserves explicit arrays", async () => {
    const environment = env();
    const ipc = createWorkspaceIpc(environment);

    const expandedPaths = ["/repo/adjutorix-app", "/repo/adjutorix-app/src", "/repo/adjutorix-app/src/renderer"];

    const result = await ipc.handleSetExpandedPaths({
      requestId: "req-expand-1",
      payload: {
        workspaceId: "ws-1",
        expandedPaths,
      },
      webContentsId: 7,
    });

    expect(environment.workspaceService.setExpandedPaths).toHaveBeenCalledWith("ws-1", expandedPaths);
    expect(result.ok).toBe(true);
  });

  it("rejects load requests denied by policy before reaching workspace service", async () => {
    const environment = env({
      policy: {
        evaluate: vi.fn(() => ({ allowed: false, violations: [{ code: "AUTHORITY_DENIED" }] })),
      },
    });
    const ipc = createWorkspaceIpc(environment);

    const result = await ipc.handleLoadWorkspace({
      requestId: "req-load-2",
      payload: { workspaceId: "ws-1" },
      webContentsId: 7,
    });

    expect(environment.workspaceService.loadWorkspace).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("WORKSPACE_IPC_POLICY_DENIED");
  });

  it("rejects malformed selection payloads without calling the workspace service", async () => {
    const environment = env();
    const ipc = createWorkspaceIpc(environment);

    const result = await ipc.handleSelectPath({
      requestId: "req-select-2",
      payload: {
        workspaceId: "ws-1",
      } as unknown as { workspaceId: string; path: string },
      webContentsId: 7,
    });

    expect(environment.workspaceService.selectPath).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("INVALID_WORKSPACE_REQUEST");
  });

  it("rejects expanded-path payloads that are not arrays to avoid ambiguous expansion state", async () => {
    const environment = env();
    const ipc = createWorkspaceIpc(environment);

    const result = await ipc.handleSetExpandedPaths({
      requestId: "req-expand-2",
      payload: {
        workspaceId: "ws-1",
        expandedPaths: "not-an-array",
      } as unknown as { workspaceId: string; expandedPaths: string[] },
      webContentsId: 7,
    });

    expect(environment.workspaceService.setExpandedPaths).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("INVALID_WORKSPACE_REQUEST");
  });

  it("normalizes workspace-service failures into structured IPC errors instead of leaking raw exceptions", async () => {
    const environment = env({
      workspaceService: {
        ...env().workspaceService,
        loadWorkspace: vi.fn(async () => {
          throw new Error("workspace unavailable");
        }),
      },
    });
    const ipc = createWorkspaceIpc(environment);

    const result = await ipc.handleLoadWorkspace({
      requestId: "req-load-3",
      payload: { workspaceId: "ws-1" },
      webContentsId: 7,
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("WORKSPACE_IPC_HANDLER_FAILED");
    expect(result.error.message).toContain("workspace unavailable");
  });

  it("subscribes a renderer to workspace events and fans out snapshot events to the correct webContents", async () => {
    const environment = env();
    const ipc = createWorkspaceIpc(environment);

    const sub = await ipc.handleSubscribeWorkspace({
      requestId: "req-sub-1",
      payload: { workspaceId: "ws-1" },
      webContentsId: 7,
    });

    expect(sub.ok).toBe(true);
    expect(environment.workspaceService.subscribe).toHaveBeenCalledWith("ws-1", expect.any(Function));

    environment.workspaceService.emit("ws-1", {
      type: "workspace-snapshot",
      snapshot: snapshot({ workspaceId: "ws-1", name: "event-workspace" }),
    });

    expect(environment.sender.sendToWebContents).toHaveBeenCalledWith(
      7,
      "workspace:event",
      expect.objectContaining({
        type: "workspace-snapshot",
        snapshot: expect.objectContaining({ name: "event-workspace" }),
      }),
    );
  });

  it("fans out selection, entry, expanded-path, and health events without mutating their semantic shape", async () => {
    const environment = env();
    const ipc = createWorkspaceIpc(environment);

    await ipc.handleSubscribeWorkspace({
      requestId: "req-sub-2",
      payload: { workspaceId: "ws-1" },
      webContentsId: 9,
    });

    environment.workspaceService.emit("ws-1", {
      type: "workspace-selection",
      selectedPath: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
    });
    environment.workspaceService.emit("ws-1", {
      type: "workspace-entry",
      entry: entry({
        path: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
        name: "AppShell.tsx",
        kind: "file",
        parentPath: "/repo/adjutorix-app/src/renderer/components",
      }),
    });
    environment.workspaceService.emit("ws-1", {
      type: "workspace-expanded-paths",
      expandedPaths: ["/repo/adjutorix-app", "/repo/adjutorix-app/src/renderer"],
    });
    environment.workspaceService.emit("ws-1", {
      type: "workspace-health",
      health: {
        level: "degraded",
        reasons: ["watch lag rising"],
      },
    });

    const payloads = (environment.sender.sendToWebContents as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => call[0] === 9 && call[1] === "workspace:event")
      .map((call) => call[2]);

    expect(payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "workspace-selection", selectedPath: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx" }),
        expect.objectContaining({ type: "workspace-entry", entry: expect.objectContaining({ name: "AppShell.tsx" }) }),
        expect.objectContaining({ type: "workspace-expanded-paths", expandedPaths: ["/repo/adjutorix-app", "/repo/adjutorix-app/src/renderer"] }),
        expect.objectContaining({ type: "workspace-health", health: expect.objectContaining({ level: "degraded" }) }),
      ]),
    );
  });

  it("does not fan out events for a workspace to renderers subscribed to a different workspace", async () => {
    const environment = env();
    const ipc = createWorkspaceIpc(environment);

    await ipc.handleSubscribeWorkspace({
      requestId: "req-sub-3",
      payload: { workspaceId: "ws-1" },
      webContentsId: 7,
    });
    await ipc.handleSubscribeWorkspace({
      requestId: "req-sub-4",
      payload: { workspaceId: "ws-2" },
      webContentsId: 8,
    });

    environment.workspaceService.emit("ws-1", {
      type: "workspace-selection",
      selectedPath: "/repo/adjutorix-app/src/renderer/App.tsx",
    });

    const calls = (environment.sender.sendToWebContents as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((call) => call[0] === 7)).toBe(true);
    expect(calls.some((call) => call[0] === 8)).toBe(false);
  });

  it("supports multiple subscribers on the same workspace and fans out identical events to each", async () => {
    const environment = env();
    const ipc = createWorkspaceIpc(environment);

    await ipc.handleSubscribeWorkspace({
      requestId: "req-sub-5",
      payload: { workspaceId: "ws-1" },
      webContentsId: 11,
    });
    await ipc.handleSubscribeWorkspace({
      requestId: "req-sub-6",
      payload: { workspaceId: "ws-1" },
      webContentsId: 12,
    });

    environment.workspaceService.emit("ws-1", {
      type: "workspace-health",
      health: { level: "degraded", reasons: ["index stale"] },
    });

    expect(environment.sender.sendToWebContents).toHaveBeenCalledWith(
      11,
      "workspace:event",
      expect.objectContaining({ type: "workspace-health" }),
    );
    expect(environment.sender.sendToWebContents).toHaveBeenCalledWith(
      12,
      "workspace:event",
      expect.objectContaining({ type: "workspace-health" }),
    );
  });

  it("unsubscribes deterministically so later workspace events no longer reach that renderer", async () => {
    const environment = env();
    const ipc = createWorkspaceIpc(environment);

    const sub = await ipc.handleSubscribeWorkspace({
      requestId: "req-sub-7",
      payload: { workspaceId: "ws-1" },
      webContentsId: 13,
    });

    expect(sub.ok).toBe(true);

    const unsub = await ipc.handleUnsubscribeWorkspace({
      requestId: "req-unsub-1",
      payload: { workspaceId: "ws-1" },
      webContentsId: 13,
    });

    expect(unsub.ok).toBe(true);

    environment.workspaceService.emit("ws-1", {
      type: "workspace-selection",
      selectedPath: "/repo/adjutorix-app/src/renderer/App.tsx",
    });

    const calls = (environment.sender.sendToWebContents as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((call) => call[0] === 13)).toBe(false);
  });

  it("treats duplicate subscribe requests from the same renderer and workspace idempotently", async () => {
    const environment = env();
    const ipc = createWorkspaceIpc(environment);

    await ipc.handleSubscribeWorkspace({
      requestId: "req-sub-8",
      payload: { workspaceId: "ws-1" },
      webContentsId: 14,
    });
    await ipc.handleSubscribeWorkspace({
      requestId: "req-sub-9",
      payload: { workspaceId: "ws-1" },
      webContentsId: 14,
    });

    environment.workspaceService.emit("ws-1", {
      type: "workspace-health",
      health: { level: "degraded", reasons: ["watch lag rising"] },
    });

    const calls = (environment.sender.sendToWebContents as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0] === 14 && call[1] === "workspace:event",
    );

    expect(calls).toHaveLength(1);
  });

  it("rejects subscribe requests denied by policy before wiring listeners", async () => {
    const environment = env({
      policy: {
        evaluate: vi.fn(() => ({ allowed: false, violations: [{ code: "TRUST_DENIED" }] })),
      },
    });
    const ipc = createWorkspaceIpc(environment);

    const result = await ipc.handleSubscribeWorkspace({
      requestId: "req-sub-10",
      payload: { workspaceId: "ws-1" },
      webContentsId: 15,
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("WORKSPACE_IPC_POLICY_DENIED");
    expect(environment.workspaceService.subscribe).not.toHaveBeenCalled();
  });

  it("normalizes malformed emitted events instead of forwarding invalid shapes directly to renderer", async () => {
    const environment = env();
    const ipc = createWorkspaceIpc(environment);

    await ipc.handleSubscribeWorkspace({
      requestId: "req-sub-11",
      payload: { workspaceId: "ws-1" },
      webContentsId: 16,
    });

    environment.workspaceService.emit("ws-1", {
      type: "workspace-selection",
      selectedPath: null,
    } as unknown as WorkspaceEventPayload);

    expect(environment.sender.sendToWebContents).not.toHaveBeenCalled();
  });

  it("cleans up all subscriptions on dispose so later emissions cannot leak into dead registries", async () => {
    const environment = env();
    const ipc = createWorkspaceIpc(environment);

    await ipc.handleSubscribeWorkspace({
      requestId: "req-sub-12",
      payload: { workspaceId: "ws-1" },
      webContentsId: 17,
    });

    ipc.dispose();

    environment.workspaceService.emit("ws-1", {
      type: "workspace-health",
      health: { level: "degraded", reasons: ["disposed registry should stay silent"] },
    });

    expect(environment.sender.sendToWebContents).not.toHaveBeenCalled();
  });

  it("returns deterministic identical request verdicts for identical load calls", async () => {
    const environment = env();
    const ipc = createWorkspaceIpc(environment);

    const a = await ipc.handleLoadWorkspace({
      requestId: "req-load-4a",
      payload: { workspaceId: "ws-1" },
      webContentsId: 7,
    });
    const b = await ipc.handleLoadWorkspace({
      requestId: "req-load-4b",
      payload: { workspaceId: "ws-1" },
      webContentsId: 7,
    });

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.result).toEqual(b.result);
  });
});
