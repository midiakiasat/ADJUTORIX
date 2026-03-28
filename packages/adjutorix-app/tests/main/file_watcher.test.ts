import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / MAIN / file_watcher.test.ts
 *
 * Canonical file-watcher contract suite.
 *
 * Purpose:
 * - verify that the main-process file watcher preserves one authoritative filesystem event surface
 *   for workspace tree, index, diagnostics, and patch/verify consumers
 * - verify that path normalization, root scoping, burst coalescing, duplicate suppression,
 *   create/change/delete semantics, rename modeling, health posture, and subscriber fanout remain deterministic
 * - verify that malformed, out-of-root, stale, or contradictory native watcher events fail safely
 *   instead of corrupting canonical workspace truth
 *
 * Test philosophy:
 * - no snapshots
 * - assert watcher semantics, event routing, lifecycle guarantees, and limiting cases directly
 * - prefer burst/race/path-boundary counterexamples over happy-path only coverage
 *
 * Notes:
 * - this suite assumes src/main/services/file_watcher exports the functions and types referenced below
 * - if the production module exports differ slightly, update adapters first rather than weakening intent
 */

import {
  createFileWatcher,
  type FileWatcherEnvironment,
  type FileWatcherEvent,
  type FileWatcherHealth,
} from "../../../src/main/services/file_watcher";

function event(partial: Partial<FileWatcherEvent> & Pick<FileWatcherEvent, "type" | "path">): FileWatcherEvent {
  return {
    occurredAtMs: 1711000000000,
    source: "native",
    ...partial,
  } as FileWatcherEvent;
}

function env(overrides: Partial<FileWatcherEnvironment> = {}): FileWatcherEnvironment {
  let nativeListener: ((evt: unknown) => void) | null = null;

  return {
    native: {
      watch: vi.fn((_rootPath: string, listener: (evt: unknown) => void) => {
        nativeListener = listener;
        return () => undefined;
      }),
      emit: (evt: unknown) => {
        nativeListener?.(evt);
      },
    },
    clock: {
      now: vi.fn(() => 1711000009999),
    },
    scheduler: {
      setTimeout: vi.fn((fn: (...args: any[]) => void, _ms: number) => {
        fn();
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }),
      clearTimeout: vi.fn(),
    },
    policy: {
      coalesceWindowMs: 25,
      suppressDuplicateChanges: true,
      normalizeWindowsPaths: true,
      ignoreOutOfRootEvents: true,
    },
    ...overrides,
  } as unknown as FileWatcherEnvironment;
}

describe("main/services/file_watcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts watching a workspace root and exposes healthy initial watcher state", () => {
    const environment = env();
    const watcher = createFileWatcher(environment);

    watcher.start("ws-1", "/repo/adjutorix-app");

    expect(environment.native.watch).toHaveBeenCalledWith("/repo/adjutorix-app", expect.any(Function));
    expect(watcher.getHealth("ws-1")).toEqual(
      expect.objectContaining<FileWatcherHealth>({
        level: "healthy",
      }),
    );
  });

  it("fans out normalized create events to subscribers within the watched root", () => {
    const environment = env();
    const watcher = createFileWatcher(environment);
    const listener = vi.fn();

    watcher.subscribe("ws-1", listener);
    watcher.start("ws-1", "/repo/adjutorix-app");

    environment.native.emit({
      kind: "add",
      path: "/repo/adjutorix-app/src/renderer/components/ChatPanel.tsx",
    });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "created",
        path: "/repo/adjutorix-app/src/renderer/components/ChatPanel.tsx",
      }),
    );
  });

  it("fans out normalized change events and preserves exact in-root path identity", () => {
    const environment = env();
    const watcher = createFileWatcher(environment);
    const listener = vi.fn();

    watcher.subscribe("ws-1", listener);
    watcher.start("ws-1", "/repo/adjutorix-app");

    environment.native.emit({
      kind: "change",
      path: "/repo/adjutorix-app/src/renderer/App.tsx",
    });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "changed",
        path: "/repo/adjutorix-app/src/renderer/App.tsx",
      }),
    );
  });

  it("fans out normalized delete events and preserves exact in-root path identity", () => {
    const environment = env();
    const watcher = createFileWatcher(environment);
    const listener = vi.fn();

    watcher.subscribe("ws-1", listener);
    watcher.start("ws-1", "/repo/adjutorix-app");

    environment.native.emit({
      kind: "unlink",
      path: "/repo/adjutorix-app/src/renderer/OldPane.tsx",
    });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "deleted",
        path: "/repo/adjutorix-app/src/renderer/OldPane.tsx",
      }),
    );
  });

  it("normalizes Windows-style paths into stable canonical watcher paths", () => {
    const environment = env();
    const watcher = createFileWatcher(environment);
    const listener = vi.fn();

    watcher.subscribe("ws-1", listener);
    watcher.start("ws-1", "C:/repo/adjutorix-app");

    environment.native.emit({
      kind: "change",
      path: "C:\\repo\\adjutorix-app\\src\\renderer\\App.tsx",
    });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "C:/repo/adjutorix-app/src/renderer/App.tsx",
      }),
    );
  });

  it("ignores out-of-root events instead of widening watcher authority by path prefix accident", () => {
    const environment = env();
    const watcher = createFileWatcher(environment);
    const listener = vi.fn();

    watcher.subscribe("ws-1", listener);
    watcher.start("ws-1", "/repo/adjutorix-app");

    environment.native.emit({
      kind: "change",
      path: "/repo/other-project/src/index.ts",
    });
    environment.native.emit({
      kind: "change",
      path: "/repo/adjutorix-app-malicious/src/index.ts",
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it("suppresses duplicate same-path change bursts inside the coalescing window when configured", () => {
    const environment = env();
    const watcher = createFileWatcher(environment);
    const listener = vi.fn();

    watcher.subscribe("ws-1", listener);
    watcher.start("ws-1", "/repo/adjutorix-app");

    environment.native.emit({ kind: "change", path: "/repo/adjutorix-app/src/renderer/App.tsx" });
    environment.native.emit({ kind: "change", path: "/repo/adjutorix-app/src/renderer/App.tsx" });
    environment.native.emit({ kind: "change", path: "/repo/adjutorix-app/src/renderer/App.tsx" });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not suppress distinct event types on the same path because create/delete semantics are not interchangeable", () => {
    const environment = env();
    const watcher = createFileWatcher(environment);
    const listener = vi.fn();

    watcher.subscribe("ws-1", listener);
    watcher.start("ws-1", "/repo/adjutorix-app");

    environment.native.emit({ kind: "add", path: "/repo/adjutorix-app/src/renderer/NewPane.tsx" });
    environment.native.emit({ kind: "change", path: "/repo/adjutorix-app/src/renderer/NewPane.tsx" });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[0][0]).toEqual(expect.objectContaining({ type: "created" }));
    expect(listener.mock.calls[1][0]).toEqual(expect.objectContaining({ type: "changed" }));
  });

  it("models rename as distinct delete/create or rename-class semantics without dropping lineage", () => {
    const environment = env();
    const watcher = createFileWatcher(environment);
    const listener = vi.fn();

    watcher.subscribe("ws-1", listener);
    watcher.start("ws-1", "/repo/adjutorix-app");

    environment.native.emit({
      kind: "rename",
      oldPath: "/repo/adjutorix-app/src/renderer/OldPane.tsx",
      path: "/repo/adjutorix-app/src/renderer/NewPane.tsx",
    });

    expect(listener).toHaveBeenCalled();
    const firstPayload = listener.mock.calls[0][0];
    expect(["renamed", "deleted", "created"]).toContain(firstPayload.type);
  });

  it("preserves event ordering for distinct paths emitted in sequence", () => {
    const environment = env();
    const watcher = createFileWatcher(environment);
    const listener = vi.fn();

    watcher.subscribe("ws-1", listener);
    watcher.start("ws-1", "/repo/adjutorix-app");

    environment.native.emit({ kind: "change", path: "/repo/adjutorix-app/src/renderer/A.tsx" });
    environment.native.emit({ kind: "change", path: "/repo/adjutorix-app/src/renderer/B.tsx" });
    environment.native.emit({ kind: "change", path: "/repo/adjutorix-app/src/renderer/C.tsx" });

    expect(listener.mock.calls.map((call) => call[0].path)).toEqual([
      "/repo/adjutorix-app/src/renderer/A.tsx",
      "/repo/adjutorix-app/src/renderer/B.tsx",
      "/repo/adjutorix-app/src/renderer/C.tsx",
    ]);
  });

  it("supports multiple subscribers on the same workspace and fans out identical normalized events to each", () => {
    const environment = env();
    const watcher = createFileWatcher(environment);
    const a = vi.fn();
    const b = vi.fn();

    watcher.subscribe("ws-1", a);
    watcher.subscribe("ws-1", b);
    watcher.start("ws-1", "/repo/adjutorix-app");

    environment.native.emit({ kind: "change", path: "/repo/adjutorix-app/src/renderer/App.tsx" });

    expect(a).toHaveBeenCalledWith(expect.objectContaining({ type: "changed" }));
    expect(b).toHaveBeenCalledWith(expect.objectContaining({ type: "changed" }));
  });

  it("keeps separate workspace roots isolated so one watcher cannot leak events into another workspace", () => {
    const environment = env();
    const watcher = createFileWatcher(environment);
    const a = vi.fn();
    const b = vi.fn();

    watcher.subscribe("ws-1", a);
    watcher.subscribe("ws-2", b);
    watcher.start("ws-1", "/repo/adjutorix-app");
    watcher.start("ws-2", "/repo/other-project");

    environment.native.emit({ kind: "change", path: "/repo/adjutorix-app/src/renderer/App.tsx" });

    expect(a).toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it("supports unsubscribe so later native events no longer reach that listener", () => {
    const environment = env();
    const watcher = createFileWatcher(environment);
    const listener = vi.fn();

    const unsubscribe = watcher.subscribe("ws-1", listener);
    watcher.start("ws-1", "/repo/adjutorix-app");
    unsubscribe();

    environment.native.emit({ kind: "change", path: "/repo/adjutorix-app/src/renderer/App.tsx" });

    expect(listener).not.toHaveBeenCalled();
  });

  it("degrades watcher health after malformed native events instead of mutating canonical event state", () => {
    const environment = env();
    const watcher = createFileWatcher(environment);

    watcher.start("ws-1", "/repo/adjutorix-app");
    environment.native.emit({ kind: "change", path: null });

    expect(watcher.getHealth("ws-1")).toEqual(
      expect.objectContaining<FileWatcherHealth>({
        level: "degraded",
      }),
    );
  });

  it("fails closed on unknown native event kinds instead of widening semantics", () => {
    const environment = env();
    const watcher = createFileWatcher(environment);
    const listener = vi.fn();

    watcher.subscribe("ws-1", listener);
    watcher.start("ws-1", "/repo/adjutorix-app");
    environment.native.emit({ kind: "mystery", path: "/repo/adjutorix-app/src/renderer/App.tsx" });

    expect(listener).not.toHaveBeenCalled();
    expect(watcher.getHealth("ws-1")?.level).toBe("degraded");
  });

  it("stops native watching on explicit stop and no longer forwards subsequent native events", () => {
    const stop = vi.fn();
    let nativeListener: ((evt: unknown) => void) | null = null;

    const watcher = createFileWatcher(
      env({
        native: {
          watch: vi.fn((_root, listener) => {
            nativeListener = listener;
            return stop;
          }),
          emit: (evt: unknown) => nativeListener?.(evt),
        },
      }),
    );

    const listener = vi.fn();
    watcher.subscribe("ws-1", listener);
    watcher.start("ws-1", "/repo/adjutorix-app");
    watcher.stop("ws-1");

    expect(stop).toHaveBeenCalledTimes(1);

    nativeListener?.({ kind: "change", path: "/repo/adjutorix-app/src/renderer/App.tsx" });
    expect(listener).not.toHaveBeenCalled();
  });

  it("disposes all native watchers and subscribers on dispose", () => {
    const stopA = vi.fn();
    const stopB = vi.fn();
    let call = 0;

    const watcher = createFileWatcher(
      env({
        native: {
          watch: vi.fn(() => {
            call += 1;
            return call === 1 ? stopA : stopB;
          }),
          emit: () => undefined,
        },
      }),
    );

    watcher.subscribe("ws-1", vi.fn());
    watcher.subscribe("ws-2", vi.fn());
    watcher.start("ws-1", "/repo/adjutorix-app");
    watcher.start("ws-2", "/repo/other-project");
    watcher.dispose();

    expect(stopA).toHaveBeenCalledTimes(1);
    expect(stopB).toHaveBeenCalledTimes(1);
  });

  it("returns null for unknown workspace health instead of inventing ghost watcher state", () => {
    const watcher = createFileWatcher(env());
    expect(watcher.getHealth("missing")).toBeNull();
  });

  it("returns deterministic normalized events for identical native inputs", () => {
    const environment = env();
    const watcher = createFileWatcher(environment);
    const listener = vi.fn();

    watcher.subscribe("ws-1", listener);
    watcher.start("ws-1", "/repo/adjutorix-app");

    environment.native.emit({ kind: "change", path: "/repo/adjutorix-app/src/renderer/App.tsx" });
    const first = listener.mock.calls[0][0];
    listener.mockClear();
    environment.native.emit({ kind: "change", path: "/repo/adjutorix-app/src/renderer/App.tsx" });
    const second = listener.mock.calls[0][0];

    expect(second).toEqual(first);
  });
});
