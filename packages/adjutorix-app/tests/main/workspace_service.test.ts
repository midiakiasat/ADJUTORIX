import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / MAIN / workspace_service.test.ts
 *
 * Canonical workspace-service contract suite.
 *
 * Purpose:
 * - verify that the main-process workspace service preserves one authoritative workspace state model
 *   across open, refresh, selection, expansion, watcher updates, and subscription fanout
 * - verify that root-path constraints, hidden/ignored classification, deterministic entry ordering,
 *   snapshot replacement, and event sequencing remain coherent under partial and degraded state
 * - verify that stale refreshes, malformed watcher events, and out-of-root mutations fail safely
 *   instead of drifting renderer truth away from service truth
 *
 * Test philosophy:
 * - no snapshots
 * - assert service semantics, state transitions, event fanout, and race boundaries directly
 * - prefer limiting cases and failure modes over happy-path only coverage
 *
 * Notes:
 * - this suite assumes src/main/services/workspace_service exports the functions and types referenced below
 * - if the production module exports differ slightly, update the adapters first rather than weakening intent
 */

import {
  createWorkspaceService,
  type WorkspaceServiceEnvironment,
  type WorkspaceSnapshot,
  type WorkspaceEntry,
  type WorkspaceEvent,
} from "../../../src/main/services/workspace_service";

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
      entry({ path: "/repo/adjutorix-app", name: "adjutorix-app", kind: "directory", childCount: 4 }),
      entry({ path: "/repo/adjutorix-app/src", name: "src", kind: "directory", parentPath: "/repo/adjutorix-app", childCount: 1 }),
      entry({ path: "/repo/adjutorix-app/src/renderer", name: "renderer", kind: "directory", parentPath: "/repo/adjutorix-app/src", childCount: 2 }),
      entry({ path: "/repo/adjutorix-app/src/renderer/App.tsx", name: "App.tsx", kind: "file", parentPath: "/repo/adjutorix-app/src/renderer" }),
      entry({ path: "/repo/adjutorix-app/src/renderer/components", name: "components", kind: "directory", parentPath: "/repo/adjutorix-app/src/renderer", childCount: 1 }),
      entry({ path: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx", name: "AppShell.tsx", kind: "file", parentPath: "/repo/adjutorix-app/src/renderer/components" }),
      entry({ path: "/repo/adjutorix-app/.env.local", name: ".env.local", kind: "file", parentPath: "/repo/adjutorix-app", hidden: true }),
      entry({ path: "/repo/adjutorix-app/node_modules", name: "node_modules", kind: "directory", parentPath: "/repo/adjutorix-app", ignored: true, childCount: 1000 }),
    ],
    expandedPaths: ["/repo/adjutorix-app", "/repo/adjutorix-app/src", "/repo/adjutorix-app/src/renderer"],
    openedPaths: ["/repo/adjutorix-app/src/renderer/App.tsx"],
    recentPaths: ["/repo/adjutorix-app/src/renderer/App.tsx"],
    selectedPath: "/repo/adjutorix-app/src/renderer/App.tsx",
    diagnostics: {
      total: 2,
      fatalCount: 0,
      errorCount: 1,
      warningCount: 1,
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
      watchedPaths: 42,
      eventLagMs: 8,
    },
    metadata: {
      provider: "filesystem",
    },
    ...overrides,
  } as WorkspaceSnapshot;
}

function env(overrides: Partial<WorkspaceServiceEnvironment> = {}): WorkspaceServiceEnvironment {
  const fsSnapshot = snapshot();
  return {
    provider: {
      loadWorkspaceSnapshot: vi.fn(async (_workspaceId: string) => fsSnapshot),
      refreshWorkspaceSnapshot: vi.fn(async (_workspaceId: string) => ({ ...fsSnapshot, metadata: { refreshed: true } })),
      watchWorkspace: vi.fn((_workspaceId: string, _rootPath: string, listener: (event: WorkspaceEvent) => void) => {
        return () => undefined;
      }),
    },
    clock: {
      now: vi.fn(() => 1711000009999),
    },
    idGenerator: {
      nextWorkspaceId: vi.fn(() => "ws-1"),
    },
    ...overrides,
  } as WorkspaceServiceEnvironment;
}

describe("main/services/workspace_service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads a workspace snapshot into canonical service state with deterministic identity", async () => {
    const environment = env();
    const service = createWorkspaceService(environment);

    const result = await service.loadWorkspace("ws-1");

    expect(environment.provider.loadWorkspaceSnapshot).toHaveBeenCalledWith("ws-1");
    expect(result.workspaceId).toBe("ws-1");
    expect(result.rootPath).toBe("/repo/adjutorix-app");
    expect(service.getWorkspace("ws-1")?.selectedPath).toBe("/repo/adjutorix-app/src/renderer/App.tsx");
  });

  it("refreshes a workspace snapshot and preserves canonical workspace identity", async () => {
    const environment = env();
    const service = createWorkspaceService(environment);

    await service.loadWorkspace("ws-1");
    const refreshed = await service.refreshWorkspace("ws-1");

    expect(environment.provider.refreshWorkspaceSnapshot).toHaveBeenCalledWith("ws-1");
    expect(refreshed.workspaceId).toBe("ws-1");
    expect(refreshed.metadata).toEqual(expect.objectContaining({ refreshed: true }));
  });

  it("falls back to load when refresh provider path is unavailable", async () => {
    const environment = env({
      provider: {
        ...env().provider,
        refreshWorkspaceSnapshot: undefined,
      },
    });
    const service = createWorkspaceService(environment);

    await service.loadWorkspace("ws-1");
    const refreshed = await service.refreshWorkspace("ws-1");

    expect(environment.provider.loadWorkspaceSnapshot).toHaveBeenCalledTimes(2);
    expect(refreshed.workspaceId).toBe("ws-1");
  });

  it("sets selectedPath explicitly and preserves canonical opened/recent path projections", async () => {
    const service = createWorkspaceService(env());
    await service.loadWorkspace("ws-1");

    await service.selectPath("ws-1", "/repo/adjutorix-app/src/renderer/components/AppShell.tsx");

    const state = service.getWorkspace("ws-1")!;
    expect(state.selectedPath).toBe("/repo/adjutorix-app/src/renderer/components/AppShell.tsx");
    expect(state.openedPaths).toContain("/repo/adjutorix-app/src/renderer/components/AppShell.tsx");
    expect(state.recentPaths[0]).toBe("/repo/adjutorix-app/src/renderer/components/AppShell.tsx");
  });

  it("rejects selection outside the workspace root instead of mutating canonical state", async () => {
    const service = createWorkspaceService(env());
    await service.loadWorkspace("ws-1");

    await expect(service.selectPath("ws-1", "/etc/passwd")).rejects.toThrow();
    expect(service.getWorkspace("ws-1")?.selectedPath).toBe("/repo/adjutorix-app/src/renderer/App.tsx");
  });

  it("sets expanded paths explicitly and preserves exact caller order/contents after validation", async () => {
    const service = createWorkspaceService(env());
    await service.loadWorkspace("ws-1");

    const expanded = ["/repo/adjutorix-app", "/repo/adjutorix-app/src", "/repo/adjutorix-app/src/renderer/components"];
    await service.setExpandedPaths("ws-1", expanded);

    expect(service.getWorkspace("ws-1")?.expandedPaths).toEqual(expanded);
  });

  it("rejects expanded paths outside the workspace root instead of widening tree authority", async () => {
    const service = createWorkspaceService(env());
    await service.loadWorkspace("ws-1");

    await expect(
      service.setExpandedPaths("ws-1", ["/repo/adjutorix-app", "/etc"]),
    ).rejects.toThrow();

    expect(service.getWorkspace("ws-1")?.expandedPaths).toEqual([
      "/repo/adjutorix-app",
      "/repo/adjutorix-app/src",
      "/repo/adjutorix-app/src/renderer",
    ]);
  });

  it("preserves deterministic entry ordering after load so derived renderers cannot drift by iteration order", async () => {
    const unordered = snapshot({
      entries: [
        entry({ path: "/repo/adjutorix-app/src/renderer/App.tsx", name: "App.tsx", kind: "file", parentPath: "/repo/adjutorix-app/src/renderer" }),
        entry({ path: "/repo/adjutorix-app", name: "adjutorix-app", kind: "directory", childCount: 2 }),
        entry({ path: "/repo/adjutorix-app/src", name: "src", kind: "directory", parentPath: "/repo/adjutorix-app", childCount: 1 }),
        entry({ path: "/repo/adjutorix-app/src/renderer", name: "renderer", kind: "directory", parentPath: "/repo/adjutorix-app/src", childCount: 1 }),
      ],
    });
    const service = createWorkspaceService(
      env({
        provider: {
          ...env().provider,
          loadWorkspaceSnapshot: vi.fn(async () => unordered),
        },
      }),
    );

    const loaded = await service.loadWorkspace("ws-1");
    expect(loaded.entries.map((e) => e.path)).toEqual([
      "/repo/adjutorix-app",
      "/repo/adjutorix-app/src",
      "/repo/adjutorix-app/src/renderer",
      "/repo/adjutorix-app/src/renderer/App.tsx",
    ]);
  });

  it("preserves hidden and ignored entry classification without collapsing them into ordinary files", async () => {
    const service = createWorkspaceService(env());
    const loaded = await service.loadWorkspace("ws-1");

    expect(loaded.entries.find((e) => e.path.endsWith(".env.local"))?.hidden).toBe(true);
    expect(loaded.entries.find((e) => e.path.endsWith("node_modules"))?.ignored).toBe(true);
  });

  it("subscribes listeners and fans out snapshot replacement events deterministically", async () => {
    const service = createWorkspaceService(env());
    const listener = vi.fn();
    service.subscribe("ws-1", listener);

    await service.loadWorkspace("ws-1");

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: "workspace-snapshot", snapshot: expect.objectContaining({ workspaceId: "ws-1" }) }),
    );
  });

  it("fans out selection and expanded-path events after explicit state changes", async () => {
    const service = createWorkspaceService(env());
    const listener = vi.fn();
    service.subscribe("ws-1", listener);
    await service.loadWorkspace("ws-1");
    listener.mockClear();

    await service.selectPath("ws-1", "/repo/adjutorix-app/src/renderer/components/AppShell.tsx");
    await service.setExpandedPaths("ws-1", ["/repo/adjutorix-app", "/repo/adjutorix-app/src/renderer/components"]);

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: "workspace-selection", selectedPath: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx" }),
    );
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: "workspace-expanded-paths", expandedPaths: ["/repo/adjutorix-app", "/repo/adjutorix-app/src/renderer/components"] }),
    );
  });

  it("applies watcher entry-upsert events and keeps canonical workspace state updated", async () => {
    let watcherListener: ((event: WorkspaceEvent) => void) | null = null;
    const service = createWorkspaceService(
      env({
        provider: {
          ...env().provider,
          watchWorkspace: vi.fn((_workspaceId, _rootPath, listener) => {
            watcherListener = listener;
            return () => undefined;
          }),
        },
      }),
    );

    await service.loadWorkspace("ws-1");

    watcherListener?.({
      type: "workspace-entry",
      entry: entry({
        path: "/repo/adjutorix-app/src/renderer/components/ChatPanel.tsx",
        name: "ChatPanel.tsx",
        kind: "file",
        parentPath: "/repo/adjutorix-app/src/renderer/components",
      }),
    });

    expect(service.getWorkspace("ws-1")?.entries.some((e) => e.path.endsWith("ChatPanel.tsx"))).toBe(true);
  });

  it("applies watcher health events and preserves degraded workspace posture explicitly", async () => {
    let watcherListener: ((event: WorkspaceEvent) => void) | null = null;
    const service = createWorkspaceService(
      env({
        provider: {
          ...env().provider,
          watchWorkspace: vi.fn((_workspaceId, _rootPath, listener) => {
            watcherListener = listener;
            return () => undefined;
          }),
        },
      }),
    );

    await service.loadWorkspace("ws-1");
    watcherListener?.({
      type: "workspace-health",
      health: { level: "degraded", reasons: ["watch lag rising"] },
    });

    expect(service.getWorkspace("ws-1")?.health.level).toBe("degraded");
    expect(service.getWorkspace("ws-1")?.health.reasons).toEqual(["watch lag rising"]);
  });

  it("ignores malformed watcher events instead of corrupting service state", async () => {
    let watcherListener: ((event: WorkspaceEvent) => void) | null = null;
    const service = createWorkspaceService(
      env({
        provider: {
          ...env().provider,
          watchWorkspace: vi.fn((_workspaceId, _rootPath, listener) => {
            watcherListener = listener;
            return () => undefined;
          }),
        },
      }),
    );

    await service.loadWorkspace("ws-1");
    const before = service.getWorkspace("ws-1")!;

    watcherListener?.({ type: "workspace-selection", selectedPath: null } as unknown as WorkspaceEvent);

    expect(service.getWorkspace("ws-1")).toEqual(before);
  });

  it("guards against stale refresh completion overwriting newer refresh state", async () => {
    let resolveA!: (value: WorkspaceSnapshot) => void;
    let resolveB!: (value: WorkspaceSnapshot) => void;
    const refreshA = new Promise<WorkspaceSnapshot>((r) => {
      resolveA = r;
    });
    const refreshB = new Promise<WorkspaceSnapshot>((r) => {
      resolveB = r;
    });

    const refreshWorkspaceSnapshot = vi
      .fn()
      .mockImplementationOnce(async () => refreshA)
      .mockImplementationOnce(async () => refreshB);

    const service = createWorkspaceService(
      env({
        provider: {
          ...env().provider,
          refreshWorkspaceSnapshot,
        },
      }),
    );

    await service.loadWorkspace("ws-1");

    const first = service.refreshWorkspace("ws-1");
    const second = service.refreshWorkspace("ws-1");

    resolveB(snapshot({ metadata: { refreshed: "newer" } }));
    await second;

    resolveA(snapshot({ metadata: { refreshed: "stale" } }));
    await first;

    expect(service.getWorkspace("ws-1")?.metadata).toEqual({ refreshed: "newer" });
  });

  it("throws for unknown workspace ids instead of inventing implicit state", async () => {
    const service = createWorkspaceService(env());

    await expect(service.refreshWorkspace("missing")).rejects.toThrow();
    await expect(service.selectPath("missing", "/repo/adjutorix-app/src/renderer/App.tsx")).rejects.toThrow();
    await expect(service.setExpandedPaths("missing", ["/repo/adjutorix-app"])).rejects.toThrow();
  });

  it("returns null for missing workspace lookups instead of stale ghost state", () => {
    const service = createWorkspaceService(env());
    expect(service.getWorkspace("missing")).toBeNull();
  });

  it("supports unsubscribe so later events no longer reach that listener", async () => {
    const service = createWorkspaceService(env());
    const listener = vi.fn();
    const unsubscribe = service.subscribe("ws-1", listener);

    await service.loadWorkspace("ws-1");
    unsubscribe();
    listener.mockClear();

    await service.selectPath("ws-1", "/repo/adjutorix-app/src/renderer/components/AppShell.tsx");

    expect(listener).not.toHaveBeenCalled();
  });

  it("disposes watcher subscriptions on service dispose so later provider events cannot leak in", async () => {
    const stopWatching = vi.fn();
    let watcherListener: ((event: WorkspaceEvent) => void) | null = null;

    const service = createWorkspaceService(
      env({
        provider: {
          ...env().provider,
          watchWorkspace: vi.fn((_workspaceId, _rootPath, listener) => {
            watcherListener = listener;
            return stopWatching;
          }),
        },
      }),
    );

    await service.loadWorkspace("ws-1");
    service.dispose();

    expect(stopWatching).toHaveBeenCalledTimes(1);

    watcherListener?.({
      type: "workspace-health",
      health: { level: "degraded", reasons: ["should not land after dispose"] },
    });

    expect(service.getWorkspace("ws-1")?.health.level).toBe("healthy");
  });

  it("preserves empty-but-ready workspace truth for newly attached empty roots", async () => {
    const empty = snapshot({
      workspaceId: "ws-empty",
      rootPath: "/repo/empty",
      name: "empty",
      entries: [entry({ path: "/repo/empty", name: "empty", kind: "directory", childCount: 0 })],
      expandedPaths: ["/repo/empty"],
      openedPaths: [],
      recentPaths: [],
      selectedPath: null,
      diagnostics: {
        total: 0,
        fatalCount: 0,
        errorCount: 0,
        warningCount: 0,
        infoCount: 0,
      },
      watcherStatus: {
        state: "inactive",
        watchedPaths: 0,
        eventLagMs: 0,
      },
      indexStatus: {
        state: "idle",
        progressPct: 0,
        issueCount: 0,
      },
    });

    const service = createWorkspaceService(
      env({
        idGenerator: { nextWorkspaceId: vi.fn(() => "ws-empty") },
        provider: {
          ...env().provider,
          loadWorkspaceSnapshot: vi.fn(async () => empty),
        },
      }),
    );

    const loaded = await service.loadWorkspace("ws-empty");
    expect(loaded.workspaceId).toBe("ws-empty");
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.selectedPath).toBeNull();
  });

  it("returns deterministic identical snapshots for identical provider state", async () => {
    const service = createWorkspaceService(env());

    const a = await service.loadWorkspace("ws-1");
    const b = await service.refreshWorkspace("ws-1");

    expect(a.workspaceId).toBe(b.workspaceId);
    expect(a.rootPath).toBe(b.rootPath);
    expect(a.entries.map((e) => e.path)).toEqual(b.entries.map((e) => e.path));
  });
});
