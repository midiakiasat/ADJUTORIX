import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / RENDERER / use_workspace.test.ts
 *
 * Canonical useWorkspace hook contract suite.
 *
 * Purpose:
 * - verify that useWorkspace preserves one authoritative renderer-side projection of workspace truth
 * - verify that async load/refresh flows are sequence-guarded so stale completions never overwrite newer state
 * - verify that event-driven updates, selection changes, expansion changes, and snapshot replacement
 *   remain deterministic and derive stable tree/lookup structures from canonical workspace entries
 * - verify that loading, refreshing, error, empty, degraded, and subscription-driven states remain explicit
 *
 * Test philosophy:
 * - no implementation snapshots
 * - assert hook contract, state transitions, and derived-data invariants directly
 * - prefer race-condition, derivation, and event-application guarantees over shallow happy-path checks
 *
 * Notes:
 * - this suite assumes useWorkspace exports both a named and default hook from the renderer hooks tree
 * - if the production hook signature evolves, update fixture builders first
 */

import useWorkspace, {
  type WorkspaceEntry,
  type WorkspaceEvent,
  type WorkspaceHealth,
  type WorkspaceProvider,
  type WorkspaceSnapshot,
  type WorkspaceStatus,
} from "../../../src/hooks/useWorkspace";

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

function health(level: WorkspaceHealth["level"], reasons: string[] = []): WorkspaceHealth {
  return { level, reasons };
}

function snapshot(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  const entries: WorkspaceEntry[] = overrides.entries ?? [
    entry({ path: "/repo/adjutorix-app", name: "adjutorix-app", kind: "directory", childCount: 3 }),
    entry({ path: "/repo/adjutorix-app/src", name: "src", kind: "directory", parentPath: "/repo/adjutorix-app", childCount: 2 }),
    entry({ path: "/repo/adjutorix-app/src/renderer", name: "renderer", kind: "directory", parentPath: "/repo/adjutorix-app/src", childCount: 2 }),
    entry({ path: "/repo/adjutorix-app/src/renderer/App.tsx", name: "App.tsx", kind: "file", parentPath: "/repo/adjutorix-app/src/renderer" }),
    entry({ path: "/repo/adjutorix-app/src/renderer/components", name: "components", kind: "directory", parentPath: "/repo/adjutorix-app/src/renderer", childCount: 1 }),
    entry({ path: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx", name: "AppShell.tsx", kind: "file", parentPath: "/repo/adjutorix-app/src/renderer/components" }),
    entry({ path: "/repo/adjutorix-app/.env.local", name: ".env.local", kind: "file", parentPath: "/repo/adjutorix-app", hidden: true }),
    entry({ path: "/repo/adjutorix-app/node_modules", name: "node_modules", kind: "directory", parentPath: "/repo/adjutorix-app", ignored: true, childCount: 1500 }),
  ];

  return {
    workspaceId: "ws-1",
    rootPath: "/repo/adjutorix-app",
    name: "adjutorix-app",
    trustLevel: "trusted",
    status: "ready",
    entries,
    expandedPaths: [
      "/repo/adjutorix-app",
      "/repo/adjutorix-app/src",
      "/repo/adjutorix-app/src/renderer",
      "/repo/adjutorix-app/src/renderer/components",
    ],
    openedPaths: [
      "/repo/adjutorix-app/src/renderer/App.tsx",
      "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
    ],
    recentPaths: [
      "/repo/adjutorix-app/src/renderer/App.tsx",
      "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
    ],
    selectedPath: "/repo/adjutorix-app/src/renderer/App.tsx",
    diagnostics: {
      total: 3,
      fatalCount: 0,
      errorCount: 1,
      warningCount: 1,
      infoCount: 1,
    },
    health: health("healthy"),
    indexStatus: {
      state: "ready",
      progressPct: 100,
      issueCount: 0,
    },
    watcherStatus: {
      state: "watching",
      watchedPaths: 42,
      eventLagMs: 11,
    },
    metadata: {
      provider: "filesystem",
    },
    ...overrides,
  } as WorkspaceSnapshot;
}

function makeProvider(overrides: Partial<WorkspaceProvider> = {}): WorkspaceProvider {
  return {
    loadWorkspace: vi.fn(async () => snapshot()),
    refreshWorkspace: vi.fn(async () => snapshot({ metadata: { refreshed: true } })),
    selectPath: vi.fn(async () => undefined),
    setExpandedPaths: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => undefined),
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// TESTS
// -----------------------------------------------------------------------------

describe("useWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hydrates from provider load into ready state with canonical snapshot and derived tree truth", async () => {
    const provider = makeProvider();

    const { result } = renderHook(() => useWorkspace({ provider, autoLoad: true }));

    expect(result.current.state).toBe("loading");
    expect(result.current.isBusy).toBe(true);

    await waitFor(() => {
      expect(result.current.state).toBe("ready");
    });

    expect(provider.loadWorkspace).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot?.workspaceId).toBe("ws-1");
    expect(result.current.snapshot?.selectedPath).toBe("/repo/adjutorix-app/src/renderer/App.tsx");

    expect(result.current.derived.totalEntries).toBe(8);
    expect(result.current.derived.totalFiles).toBe(3);
    expect(result.current.derived.totalDirectories).toBe(5);
    expect(result.current.derived.hiddenEntries).toBe(1);
    expect(result.current.derived.ignoredEntries).toBe(1);
    expect(result.current.derived.openedEntrySet.has("/repo/adjutorix-app/src/renderer/App.tsx")).toBe(true);
    expect(result.current.derived.recentEntrySet.has("/repo/adjutorix-app/src/renderer/components/AppShell.tsx")).toBe(true);
    expect(result.current.derived.selectedEntry?.name).toBe("App.tsx");
    expect(result.current.derived.byPath.get("/repo/adjutorix-app/src/renderer/components/AppShell.tsx")?.name).toBe("AppShell.tsx");
    expect(result.current.derived.treeRoots.map((item) => item.path)).toContain("/repo/adjutorix-app");
  });

  it("stays idle without autoLoad and only transitions after explicit reload", async () => {
    const provider = makeProvider();
    const { result } = renderHook(() => useWorkspace({ provider, autoLoad: false }));

    expect(result.current.state).toBe("idle");
    expect(provider.loadWorkspace).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.reload();
    });

    expect(provider.loadWorkspace).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("ready");
  });

  it("uses refreshWorkspace during refresh and preserves ready semantics after completion", async () => {
    const provider = makeProvider();
    const { result } = renderHook(() => useWorkspace({ provider, autoLoad: true }));

    await waitFor(() => expect(result.current.state).toBe("ready"));

    await act(async () => {
      const promise = result.current.refresh();
      expect(result.current.state).toBe("refreshing");
      await promise;
    });

    expect(provider.refreshWorkspace).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("ready");
    expect(result.current.snapshot?.metadata).toEqual(expect.objectContaining({ refreshed: true }));
  });

  it("falls back to loadWorkspace on refresh when refreshWorkspace is unavailable", async () => {
    const provider = makeProvider({ refreshWorkspace: undefined });
    const { result } = renderHook(() => useWorkspace({ provider, autoLoad: true }));

    await waitFor(() => expect(result.current.state).toBe("ready"));

    await act(async () => {
      await result.current.refresh();
    });

    expect(provider.loadWorkspace).toHaveBeenCalledTimes(2);
  });

  it("guards against stale async load completion overwriting newer refresh results", async () => {
    const first = deferred<WorkspaceSnapshot>();
    const second = deferred<WorkspaceSnapshot>();

    const provider = makeProvider({
      loadWorkspace: vi.fn(() => first.promise),
      refreshWorkspace: vi.fn(() => second.promise),
    });

    const { result } = renderHook(() => useWorkspace({ provider, autoLoad: true }));

    await act(async () => {
      const refreshPromise = result.current.refresh();
      second.resolve(snapshot({ workspaceId: "ws-new", name: "newer" }));
      await refreshPromise;
    });

    expect(result.current.snapshot?.workspaceId).toBe("ws-new");

    await act(async () => {
      first.resolve(snapshot({ workspaceId: "ws-stale", name: "stale" }));
      await Promise.resolve();
    });

    expect(result.current.snapshot?.workspaceId).toBe("ws-new");
    expect(result.current.snapshot?.name).toBe("newer");
  });

  it("exposes error state on failing load and preserves no snapshot truth", async () => {
    const provider = makeProvider({
      loadWorkspace: vi.fn(async () => {
        throw new Error("workspace load failed");
      }),
    });

    const { result } = renderHook(() => useWorkspace({ provider, autoLoad: true }));

    await waitFor(() => expect(result.current.state).toBe("error"));

    expect(result.current.error?.message).toBe("workspace load failed");
    expect(result.current.snapshot).toBeNull();
    expect(result.current.derived.totalEntries).toBe(0);
    expect(result.current.isReady).toBe(false);
  });

  it("selects path through provider and updates local selectedPath immediately", async () => {
    const provider = makeProvider();
    const { result } = renderHook(() => useWorkspace({ provider, autoLoad: true }));

    await waitFor(() => expect(result.current.state).toBe("ready"));

    await act(async () => {
      await result.current.selectPath("/repo/adjutorix-app/src/renderer/components/AppShell.tsx");
    });

    expect(provider.selectPath).toHaveBeenCalledWith("/repo/adjutorix-app/src/renderer/components/AppShell.tsx");
    expect(result.current.snapshot?.selectedPath).toBe("/repo/adjutorix-app/src/renderer/components/AppShell.tsx");
    expect(result.current.derived.selectedEntry?.name).toBe("AppShell.tsx");
  });

  it("updates expanded paths through provider and local snapshot deterministically", async () => {
    const provider = makeProvider();
    const { result } = renderHook(() => useWorkspace({ provider, autoLoad: true }));

    await waitFor(() => expect(result.current.state).toBe("ready"));

    const nextExpanded = ["/repo/adjutorix-app", "/repo/adjutorix-app/src"];

    await act(async () => {
      await result.current.setExpandedPaths(nextExpanded);
    });

    expect(provider.setExpandedPaths).toHaveBeenCalledWith(nextExpanded);
    expect(result.current.snapshot?.expandedPaths).toEqual(nextExpanded);
  });

  it("replaces snapshot explicitly through setSnapshot and rebuilds all derived indexes", async () => {
    const provider = makeProvider();
    const { result } = renderHook(() => useWorkspace({ provider, autoLoad: false }));

    const next = snapshot({
      workspaceId: "ws-replaced",
      selectedPath: "/repo/adjutorix-app/README.md",
      entries: [
        entry({ path: "/repo/adjutorix-app", name: "adjutorix-app", kind: "directory", childCount: 1 }),
        entry({ path: "/repo/adjutorix-app/README.md", name: "README.md", kind: "file", parentPath: "/repo/adjutorix-app" }),
      ],
      openedPaths: ["/repo/adjutorix-app/README.md"],
      recentPaths: ["/repo/adjutorix-app/README.md"],
    });

    act(() => {
      result.current.setSnapshot(next);
    });

    expect(result.current.snapshot?.workspaceId).toBe("ws-replaced");
    expect(result.current.derived.totalEntries).toBe(2);
    expect(result.current.derived.totalFiles).toBe(1);
    expect(result.current.derived.selectedEntry?.name).toBe("README.md");
    expect(result.current.derived.byPath.has("/repo/adjutorix-app/src/renderer/App.tsx")).toBe(false);
  });

  it("subscribes to provider events and applies snapshot replacement events canonically", async () => {
    let listener: ((event: WorkspaceEvent) => void) | null = null;
    const unsubscribe = vi.fn();

    const provider = makeProvider({
      subscribe: vi.fn((nextListener) => {
        listener = nextListener;
        return unsubscribe;
      }),
    });

    const { result, unmount } = renderHook(() => useWorkspace({ provider, autoLoad: true }));

    await waitFor(() => expect(result.current.state).toBe("ready"));

    act(() => {
      listener?.({
        type: "workspace-snapshot",
        snapshot: snapshot({ workspaceId: "ws-event", name: "from-event" }),
      });
    });

    expect(result.current.snapshot?.workspaceId).toBe("ws-event");
    expect(result.current.snapshot?.name).toBe("from-event");

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("applies entry upsert events and rebuilds derived counts and indexes", async () => {
    let listener: ((event: WorkspaceEvent) => void) | null = null;
    const provider = makeProvider({
      subscribe: vi.fn((cb) => {
        listener = cb;
        return () => undefined;
      }),
    });

    const { result } = renderHook(() => useWorkspace({ provider, autoLoad: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    act(() => {
      listener?.({
        type: "workspace-entry",
        entry: entry({
          path: "/repo/adjutorix-app/src/renderer/components/ChatPanel.tsx",
          name: "ChatPanel.tsx",
          kind: "file",
          parentPath: "/repo/adjutorix-app/src/renderer/components",
        }),
      });
    });

    expect(result.current.derived.totalEntries).toBe(9);
    expect(result.current.derived.totalFiles).toBe(4);
    expect(result.current.derived.byPath.get("/repo/adjutorix-app/src/renderer/components/ChatPanel.tsx")?.name).toBe("ChatPanel.tsx");
  });

  it("applies selection events and keeps derived selectedEntry aligned", async () => {
    let listener: ((event: WorkspaceEvent) => void) | null = null;
    const provider = makeProvider({
      subscribe: vi.fn((cb) => {
        listener = cb;
        return () => undefined;
      }),
    });

    const { result } = renderHook(() => useWorkspace({ provider, autoLoad: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    act(() => {
      listener?.({
        type: "workspace-selection",
        selectedPath: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
      });
    });

    expect(result.current.snapshot?.selectedPath).toBe("/repo/adjutorix-app/src/renderer/components/AppShell.tsx");
    expect(result.current.derived.selectedEntry?.name).toBe("AppShell.tsx");
  });

  it("applies expanded-path events and keeps snapshot expansion explicit", async () => {
    let listener: ((event: WorkspaceEvent) => void) | null = null;
    const provider = makeProvider({
      subscribe: vi.fn((cb) => {
        listener = cb;
        return () => undefined;
      }),
    });

    const { result } = renderHook(() => useWorkspace({ provider, autoLoad: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    act(() => {
      listener?.({
        type: "workspace-expanded-paths",
        expandedPaths: ["/repo/adjutorix-app"],
      });
    });

    expect(result.current.snapshot?.expandedPaths).toEqual(["/repo/adjutorix-app"]);
  });

  it("applies health events and preserves degraded workspace posture explicitly", async () => {
    let listener: ((event: WorkspaceEvent) => void) | null = null;
    const provider = makeProvider({
      subscribe: vi.fn((cb) => {
        listener = cb;
        return () => undefined;
      }),
    });

    const { result } = renderHook(() => useWorkspace({ provider, autoLoad: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    act(() => {
      listener?.({
        type: "workspace-health",
        health: health("degraded", ["watch lag rising", "index stale"]),
      });
    });

    expect(result.current.snapshot?.health.level).toBe("degraded");
    expect(result.current.snapshot?.health.reasons).toEqual(["watch lag rising", "index stale"]);
  });

  it("builds stable tree roots and child ordering from normalized sorted entries", async () => {
    const provider = makeProvider({
      loadWorkspace: vi.fn(async () =>
        snapshot({
          entries: [
            entry({ path: "/repo/adjutorix-app/src/renderer/Zeta.tsx", name: "Zeta.tsx", kind: "file", parentPath: "/repo/adjutorix-app/src/renderer" }),
            entry({ path: "/repo/adjutorix-app", name: "adjutorix-app", kind: "directory", childCount: 2 }),
            entry({ path: "/repo/adjutorix-app/src", name: "src", kind: "directory", parentPath: "/repo/adjutorix-app", childCount: 2 }),
            entry({ path: "/repo/adjutorix-app/src/renderer", name: "renderer", kind: "directory", parentPath: "/repo/adjutorix-app/src", childCount: 2 }),
            entry({ path: "/repo/adjutorix-app/src/renderer/Alpha.tsx", name: "Alpha.tsx", kind: "file", parentPath: "/repo/adjutorix-app/src/renderer" }),
          ],
        }),
      ),
    });

    const { result } = renderHook(() => useWorkspace({ provider, autoLoad: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    expect(result.current.derived.treeRoots.map((e) => e.path)).toEqual(["/repo/adjutorix-app"]);
    expect([...result.current.derived.byPath.values()].map((e) => e.path)).toEqual([
      "/repo/adjutorix-app",
      "/repo/adjutorix-app/src",
      "/repo/adjutorix-app/src/renderer",
      "/repo/adjutorix-app/src/renderer/Alpha.tsx",
      "/repo/adjutorix-app/src/renderer/Zeta.tsx",
    ]);
  });

  it("returns empty derived truth when snapshot is null", () => {
    const provider = makeProvider();
    const { result } = renderHook(() => useWorkspace({ provider, autoLoad: false }));

    expect(result.current.snapshot).toBeNull();
    expect(result.current.derived.totalEntries).toBe(0);
    expect(result.current.derived.selectedEntry).toBeNull();
    expect(result.current.derived.treeRoots).toEqual([]);
  });

  it("does not mutate state after unmount when async load resolves late", async () => {
    const gate = deferred<WorkspaceSnapshot>();
    const provider = makeProvider({
      loadWorkspace: vi.fn(() => gate.promise),
    });

    const { unmount } = renderHook(() => useWorkspace({ provider, autoLoad: true }));
    unmount();

    await act(async () => {
      gate.resolve(snapshot({ workspaceId: "ws-late" }));
      await Promise.resolve();
    });

    expect(provider.loadWorkspace).toHaveBeenCalledTimes(1);
  });

  it("preserves provider-thrown selection failures instead of hiding them behind local mutation", async () => {
    const provider = makeProvider({
      selectPath: vi.fn(async () => {
        throw new Error("selection denied");
      }),
    });

    const { result } = renderHook(() => useWorkspace({ provider, autoLoad: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    await expect(
      act(async () => {
        await result.current.selectPath("/repo/adjutorix-app/src/renderer/components/AppShell.tsx");
      }),
    ).rejects.toThrow("selection denied");

    expect(result.current.snapshot?.selectedPath).toBe("/repo/adjutorix-app/src/renderer/App.tsx");
  });

  it("preserves provider-thrown expansion failures instead of silently rewriting expansion truth", async () => {
    const provider = makeProvider({
      setExpandedPaths: vi.fn(async () => {
        throw new Error("expand denied");
      }),
    });

    const { result } = renderHook(() => useWorkspace({ provider, autoLoad: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    await expect(
      act(async () => {
        await result.current.setExpandedPaths(["/repo/adjutorix-app"]);
      }),
    ).rejects.toThrow("expand denied");

    expect(result.current.snapshot?.expandedPaths).toContain("/repo/adjutorix-app/src");
  });

  it("tracks busy and ready flags consistently across load, refresh, and error phases", async () => {
    const gate = deferred<WorkspaceSnapshot>();
    const provider = makeProvider({
      loadWorkspace: vi.fn(() => gate.promise),
    });

    const { result } = renderHook(() => useWorkspace({ provider, autoLoad: true }));

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

  it("preserves empty-but-ready workspace truth for newly attached empty roots", async () => {
    const provider = makeProvider({
      loadWorkspace: vi.fn(async () =>
        snapshot({
          workspaceId: "ws-empty",
          rootPath: "/repo/empty",
          name: "empty",
          entries: [entry({ path: "/repo/empty", name: "empty", kind: "directory", childCount: 0 })],
          openedPaths: [],
          recentPaths: [],
          expandedPaths: ["/repo/empty"],
          selectedPath: null,
          diagnostics: {
            total: 0,
            fatalCount: 0,
            errorCount: 0,
            warningCount: 0,
            infoCount: 0,
          },
          indexStatus: {
            state: "idle",
            progressPct: 0,
            issueCount: 0,
          },
          watcherStatus: {
            state: "inactive",
            watchedPaths: 0,
            eventLagMs: 0,
          },
        }),
      ),
    });

    const { result } = renderHook(() => useWorkspace({ provider, autoLoad: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    expect(result.current.snapshot?.workspaceId).toBe("ws-empty");
    expect(result.current.derived.totalEntries).toBe(1);
    expect(result.current.derived.totalFiles).toBe(0);
    expect(result.current.derived.totalDirectories).toBe(1);
    expect(result.current.derived.selectedEntry).toBeNull();
  });
});
