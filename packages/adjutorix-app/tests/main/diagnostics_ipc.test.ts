import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / MAIN / diagnostics_ipc.test.ts
 *
 * Canonical diagnostics-IPC contract suite.
 *
 * Purpose:
 * - verify that main-process diagnostics IPC preserves one authoritative boundary for diagnostics snapshot,
 *   refresh, filtering, summary delivery, and live diagnostic event fanout to renderer surfaces
 * - verify that request/response contracts, producer/severity provenance, policy gating, shape validation,
 *   summary consistency, and unsubscribe cleanup remain deterministic
 * - verify that stale or malformed diagnostic events cannot desynchronize renderer diagnostics truth
 *   from main-process canonical diagnostics state
 *
 * Test philosophy:
 * - no snapshots
 * - assert orchestration semantics, event routing, lifecycle guarantees, and limiting cases directly
 * - prefer provenance drift, summary mismatch, cleanup, and shape-drift counterexamples over happy-path only coverage
 *
 * Notes:
 * - this suite assumes src/main/ipc/diagnostics_ipc exports the functions and types referenced below
 * - if the production module exports differ slightly, update adapters first rather than weakening intent
 */

import {
  createDiagnosticsIpc,
  type DiagnosticsIpcEnvironment,
  type DiagnosticsSnapshot,
  type DiagnosticRecord,
  type DiagnosticsSummary,
  type DiagnosticsEventPayload,
} from "../../../src/main/ipc/diagnostics_ipc";

function diagnostic(partial: Partial<DiagnosticRecord> & Pick<DiagnosticRecord, "id" | "severity" | "message">): DiagnosticRecord {
  return {
    category: "unknown",
    producer: "unknown",
    sourceLabel: "unknown",
    code: null,
    filePath: null,
    range: null,
    relatedPaths: [],
    tags: [],
    fingerprint: partial.id,
    jobId: null,
    verifyId: null,
    patchId: null,
    createdAtMs: 1711000000000,
    ...partial,
  } as DiagnosticRecord;
}

function summary(overrides: Partial<DiagnosticsSummary> = {}): DiagnosticsSummary {
  return {
    total: 4,
    fatalCount: 0,
    errorCount: 2,
    warningCount: 1,
    infoCount: 1,
    byProducer: {
      typescript: 1,
      eslint: 2,
      verify: 1,
    },
    byCategory: {
      type: 1,
      lint: 2,
      verification: 1,
    },
    byFile: {
      "/repo/adjutorix-app/src/renderer/App.tsx": 2,
      "/repo/adjutorix-app/src/renderer/components/AppShell.tsx": 1,
    },
    ...overrides,
  } as DiagnosticsSummary;
}

function snapshot(overrides: Partial<DiagnosticsSnapshot> = {}): DiagnosticsSnapshot {
  return {
    workspaceId: "ws-1",
    selectedPath: "/repo/adjutorix-app/src/renderer/App.tsx",
    diagnostics: [
      diagnostic({
        id: "diag-1",
        severity: "error",
        message: "Type 'number' is not assignable to type 'string'.",
        producer: "typescript",
        sourceLabel: "tsc",
        category: "type",
        code: "TS2322",
        filePath: "/repo/adjutorix-app/src/renderer/App.tsx",
        range: {
          start: { line: 12, column: 8 },
          end: { line: 12, column: 18 },
        },
      }),
      diagnostic({
        id: "diag-2",
        severity: "warning",
        message: "Unexpected any. Specify a different type.",
        producer: "eslint",
        sourceLabel: "eslint",
        category: "lint",
        code: "@typescript-eslint/no-explicit-any",
        filePath: "/repo/adjutorix-app/src/renderer/App.tsx",
        range: {
          start: { line: 20, column: 14 },
          end: { line: 20, column: 17 },
        },
      }),
      diagnostic({
        id: "diag-3",
        severity: "error",
        message: "Replay mismatch detected at transaction edge 18 -> 19.",
        producer: "verify",
        sourceLabel: "verify-run",
        category: "verification",
        code: "VERIFY_REPLAY_MISMATCH",
        filePath: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
        verifyId: "verify-42",
        patchId: "patch-42",
        jobId: "job-verify-42",
      }),
      diagnostic({
        id: "diag-4",
        severity: "info",
        message: "File ignored by default ignore pattern.",
        producer: "eslint",
        sourceLabel: "eslint",
        category: "lint",
        code: "ignored-file",
      }),
    ],
    summary: summary(),
    health: {
      level: "healthy",
      reasons: [],
    },
    metadata: {
      provider: "diagnostics-service",
    },
    ...overrides,
  } as DiagnosticsSnapshot;
}

function env(overrides: Partial<DiagnosticsIpcEnvironment> = {}): DiagnosticsIpcEnvironment {
  const listeners = new Map<string, Set<(payload: DiagnosticsEventPayload) => void>>();

  return {
    diagnosticsService: {
      loadDiagnostics: vi.fn(async () => snapshot()),
      refreshDiagnostics: vi.fn(async () => snapshot({ metadata: { refreshed: true } })),
      subscribe: vi.fn((workspaceId: string, listener: (payload: DiagnosticsEventPayload) => void) => {
        if (!listeners.has(workspaceId)) listeners.set(workspaceId, new Set());
        listeners.get(workspaceId)!.add(listener);
        return () => listeners.get(workspaceId)?.delete(listener);
      }),
      emit: (workspaceId: string, payload: DiagnosticsEventPayload) => {
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
  } as unknown as DiagnosticsIpcEnvironment;
}

describe("main/ipc/diagnostics_ipc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads a diagnostics snapshot through IPC with canonical response shape", async () => {
    const environment = env();
    const ipc = createDiagnosticsIpc(environment);

    const result = await ipc.handleLoadDiagnostics({
      requestId: "req-load-1",
      payload: { workspaceId: "ws-1" },
      webContentsId: 7,
    });

    expect(environment.diagnosticsService.loadDiagnostics).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      selectedPath: undefined,
      severities: undefined,
      producers: undefined,
    });
    expect(result.ok).toBe(true);
    expect(result.result.workspaceId).toBe("ws-1");
    expect(result.result.diagnostics).toHaveLength(4);
    expect(result.result.summary.total).toBe(4);
  });

  it("loads diagnostics with selectedPath and filter criteria without mutating canonical request meaning", async () => {
    const environment = env();
    const ipc = createDiagnosticsIpc(environment);

    const result = await ipc.handleLoadDiagnostics({
      requestId: "req-load-2",
      payload: {
        workspaceId: "ws-1",
        selectedPath: "/repo/adjutorix-app/src/renderer/App.tsx",
        severities: ["error", "warning"],
        producers: ["typescript", "eslint"],
      },
      webContentsId: 7,
    });

    expect(environment.diagnosticsService.loadDiagnostics).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      selectedPath: "/repo/adjutorix-app/src/renderer/App.tsx",
      severities: ["error", "warning"],
      producers: ["typescript", "eslint"],
    });
    expect(result.ok).toBe(true);
  });

  it("refreshes a diagnostics snapshot through IPC without changing canonical workspace identity", async () => {
    const environment = env();
    const ipc = createDiagnosticsIpc(environment);

    const result = await ipc.handleRefreshDiagnostics({
      requestId: "req-refresh-1",
      payload: { workspaceId: "ws-1" },
      webContentsId: 7,
    });

    expect(environment.diagnosticsService.refreshDiagnostics).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      selectedPath: undefined,
      severities: undefined,
      producers: undefined,
    });
    expect(result.ok).toBe(true);
    expect(result.result.workspaceId).toBe("ws-1");
    expect(result.result.metadata).toEqual(expect.objectContaining({ refreshed: true }));
  });

  it("rejects policy-denied diagnostics loads before reaching the diagnostics service", async () => {
    const environment = env({
      policy: {
        evaluate: vi.fn(() => ({ allowed: false, violations: [{ code: "AUTHORITY_DENIED" }] })),
      },
    });
    const ipc = createDiagnosticsIpc(environment);

    const result = await ipc.handleLoadDiagnostics({
      requestId: "req-load-3",
      payload: { workspaceId: "ws-1" },
      webContentsId: 7,
    });

    expect(environment.diagnosticsService.loadDiagnostics).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("DIAGNOSTICS_IPC_POLICY_DENIED");
  });

  it("rejects malformed diagnostics payloads without calling the diagnostics service", async () => {
    const environment = env();
    const ipc = createDiagnosticsIpc(environment);

    const result = await ipc.handleLoadDiagnostics({
      requestId: "req-load-4",
      payload: {} as { workspaceId: string },
      webContentsId: 7,
    });

    expect(environment.diagnosticsService.loadDiagnostics).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("INVALID_DIAGNOSTICS_REQUEST");
  });

  it("rejects malformed severity filters instead of widening diagnostic scope implicitly", async () => {
    const environment = env();
    const ipc = createDiagnosticsIpc(environment);

    const result = await ipc.handleLoadDiagnostics({
      requestId: "req-load-5",
      payload: {
        workspaceId: "ws-1",
        severities: "error" as unknown as string[],
      },
      webContentsId: 7,
    });

    expect(environment.diagnosticsService.loadDiagnostics).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("INVALID_DIAGNOSTICS_REQUEST");
  });

  it("normalizes diagnostics-service failures into structured IPC errors instead of leaking raw exceptions", async () => {
    const environment = env({
      diagnosticsService: {
        ...env().diagnosticsService,
        loadDiagnostics: vi.fn(async () => {
          throw new Error("diagnostics unavailable");
        }),
      },
    });
    const ipc = createDiagnosticsIpc(environment);

    const result = await ipc.handleLoadDiagnostics({
      requestId: "req-load-6",
      payload: { workspaceId: "ws-1" },
      webContentsId: 7,
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("DIAGNOSTICS_IPC_HANDLER_FAILED");
    expect(result.error.message).toContain("diagnostics unavailable");
  });

  it("subscribes a renderer to diagnostics events and fans out snapshot events to the correct webContents", async () => {
    const environment = env();
    const ipc = createDiagnosticsIpc(environment);

    const sub = await ipc.handleSubscribeDiagnostics({
      requestId: "req-sub-1",
      payload: { workspaceId: "ws-1" },
      webContentsId: 7,
    });

    expect(sub.ok).toBe(true);
    expect(environment.diagnosticsService.subscribe).toHaveBeenCalledWith("ws-1", expect.any(Function));

    environment.diagnosticsService.emit("ws-1", {
      type: "diagnostics-snapshot",
      snapshot: snapshot({
        summary: summary({ total: 5, errorCount: 3 }),
      }),
    });

    expect(environment.sender.sendToWebContents).toHaveBeenCalledWith(
      7,
      "diagnostics:event",
      expect.objectContaining({
        type: "diagnostics-snapshot",
        snapshot: expect.objectContaining({ summary: expect.objectContaining({ total: 5, errorCount: 3 }) }),
      }),
    );
  });

  it("fans out diagnostic, summary, selected-path, and health events without mutating semantic shape", async () => {
    const environment = env();
    const ipc = createDiagnosticsIpc(environment);

    await ipc.handleSubscribeDiagnostics({
      requestId: "req-sub-2",
      payload: { workspaceId: "ws-1" },
      webContentsId: 9,
    });

    environment.diagnosticsService.emit("ws-1", {
      type: "diagnostic-record",
      diagnostic: diagnostic({
        id: "diag-9",
        severity: "fatal",
        message: "Ledger continuity failed after rollback replay.",
        producer: "verify",
        sourceLabel: "verify-run",
        category: "verification",
        code: "LEDGER_CONTINUITY_BROKEN",
        filePath: "/repo/adjutorix-app/src/renderer/components/LedgerPanel.tsx",
        verifyId: "verify-42",
        patchId: "patch-42",
      }),
    });
    environment.diagnosticsService.emit("ws-1", {
      type: "diagnostics-summary",
      summary: summary({ total: 5, fatalCount: 1, errorCount: 2, warningCount: 1, infoCount: 1 }),
    });
    environment.diagnosticsService.emit("ws-1", {
      type: "diagnostics-selected-path",
      selectedPath: "/repo/adjutorix-app/src/renderer/components/LedgerPanel.tsx",
    });
    environment.diagnosticsService.emit("ws-1", {
      type: "diagnostics-health",
      health: {
        level: "degraded",
        reasons: ["producer freshness mismatch"],
      },
    });

    const payloads = (environment.sender.sendToWebContents as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => call[0] === 9 && call[1] === "diagnostics:event")
      .map((call) => call[2]);

    expect(payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "diagnostic-record", diagnostic: expect.objectContaining({ id: "diag-9", severity: "fatal" }) }),
        expect.objectContaining({ type: "diagnostics-summary", summary: expect.objectContaining({ total: 5, fatalCount: 1 }) }),
        expect.objectContaining({ type: "diagnostics-selected-path", selectedPath: "/repo/adjutorix-app/src/renderer/components/LedgerPanel.tsx" }),
        expect.objectContaining({ type: "diagnostics-health", health: expect.objectContaining({ level: "degraded" }) }),
      ]),
    );
  });

  it("does not fan out events for one workspace to renderers subscribed to a different workspace id", async () => {
    const environment = env();
    const ipc = createDiagnosticsIpc(environment);

    await ipc.handleSubscribeDiagnostics({
      requestId: "req-sub-3",
      payload: { workspaceId: "ws-1" },
      webContentsId: 7,
    });
    await ipc.handleSubscribeDiagnostics({
      requestId: "req-sub-4",
      payload: { workspaceId: "ws-2" },
      webContentsId: 8,
    });

    environment.diagnosticsService.emit("ws-1", {
      type: "diagnostics-summary",
      summary: summary({ total: 9 }),
    });

    const calls = (environment.sender.sendToWebContents as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((call) => call[0] === 7)).toBe(true);
    expect(calls.some((call) => call[0] === 8)).toBe(false);
  });

  it("supports multiple subscribers on the same workspace and fans out identical events to each", async () => {
    const environment = env();
    const ipc = createDiagnosticsIpc(environment);

    await ipc.handleSubscribeDiagnostics({
      requestId: "req-sub-5",
      payload: { workspaceId: "ws-1" },
      webContentsId: 11,
    });
    await ipc.handleSubscribeDiagnostics({
      requestId: "req-sub-6",
      payload: { workspaceId: "ws-1" },
      webContentsId: 12,
    });

    environment.diagnosticsService.emit("ws-1", {
      type: "diagnostics-health",
      health: { level: "degraded", reasons: ["summary stale"] },
    });

    expect(environment.sender.sendToWebContents).toHaveBeenCalledWith(
      11,
      "diagnostics:event",
      expect.objectContaining({ type: "diagnostics-health" }),
    );
    expect(environment.sender.sendToWebContents).toHaveBeenCalledWith(
      12,
      "diagnostics:event",
      expect.objectContaining({ type: "diagnostics-health" }),
    );
  });

  it("unsubscribes deterministically so later diagnostics events no longer reach that renderer", async () => {
    const environment = env();
    const ipc = createDiagnosticsIpc(environment);

    const sub = await ipc.handleSubscribeDiagnostics({
      requestId: "req-sub-7",
      payload: { workspaceId: "ws-1" },
      webContentsId: 13,
    });

    expect(sub.ok).toBe(true);

    const unsub = await ipc.handleUnsubscribeDiagnostics({
      requestId: "req-unsub-1",
      payload: { workspaceId: "ws-1" },
      webContentsId: 13,
    });

    expect(unsub.ok).toBe(true);

    environment.diagnosticsService.emit("ws-1", {
      type: "diagnostic-record",
      diagnostic: diagnostic({ id: "diag-after-unsub", severity: "error", message: "should not arrive" }),
    });

    const calls = (environment.sender.sendToWebContents as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((call) => call[0] === 13)).toBe(false);
  });

  it("treats duplicate subscribe requests from the same renderer and workspace idempotently", async () => {
    const environment = env();
    const ipc = createDiagnosticsIpc(environment);

    await ipc.handleSubscribeDiagnostics({
      requestId: "req-sub-8",
      payload: { workspaceId: "ws-1" },
      webContentsId: 14,
    });
    await ipc.handleSubscribeDiagnostics({
      requestId: "req-sub-9",
      payload: { workspaceId: "ws-1" },
      webContentsId: 14,
    });

    environment.diagnosticsService.emit("ws-1", {
      type: "diagnostics-summary",
      summary: summary({ total: 4 }),
    });

    const calls = (environment.sender.sendToWebContents as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0] === 14 && call[1] === "diagnostics:event",
    );

    expect(calls).toHaveLength(1);
  });

  it("rejects subscribe requests denied by policy before wiring listeners", async () => {
    const environment = env({
      policy: {
        evaluate: vi.fn(() => ({ allowed: false, violations: [{ code: "TRUST_DENIED" }] })),
      },
    });
    const ipc = createDiagnosticsIpc(environment);

    const result = await ipc.handleSubscribeDiagnostics({
      requestId: "req-sub-10",
      payload: { workspaceId: "ws-1" },
      webContentsId: 15,
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("DIAGNOSTICS_IPC_POLICY_DENIED");
    expect(environment.diagnosticsService.subscribe).not.toHaveBeenCalled();
  });

  it("normalizes malformed emitted diagnostics events instead of forwarding invalid shapes directly to renderer", async () => {
    const environment = env();
    const ipc = createDiagnosticsIpc(environment);

    await ipc.handleSubscribeDiagnostics({
      requestId: "req-sub-11",
      payload: { workspaceId: "ws-1" },
      webContentsId: 16,
    });

    environment.diagnosticsService.emit("ws-1", {
      type: "diagnostic-record",
      diagnostic: null,
    } as unknown as DiagnosticsEventPayload);

    expect(environment.sender.sendToWebContents).not.toHaveBeenCalled();
  });

  it("cleans up all subscriptions on dispose so later emissions cannot leak into dead registries", async () => {
    const environment = env();
    const ipc = createDiagnosticsIpc(environment);

    await ipc.handleSubscribeDiagnostics({
      requestId: "req-sub-12",
      payload: { workspaceId: "ws-1" },
      webContentsId: 17,
    });

    ipc.dispose();

    environment.diagnosticsService.emit("ws-1", {
      type: "diagnostics-health",
      health: { level: "degraded", reasons: ["disposed registry should stay silent"] },
    });

    expect(environment.sender.sendToWebContents).not.toHaveBeenCalled();
  });

  it("returns deterministic identical request verdicts for identical diagnostics loads", async () => {
    const environment = env();
    const ipc = createDiagnosticsIpc(environment);

    const a = await ipc.handleLoadDiagnostics({
      requestId: "req-load-7a",
      payload: { workspaceId: "ws-1" },
      webContentsId: 7,
    });
    const b = await ipc.handleLoadDiagnostics({
      requestId: "req-load-7b",
      payload: { workspaceId: "ws-1" },
      webContentsId: 7,
    });

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.result).toEqual(b.result);
  });
});
