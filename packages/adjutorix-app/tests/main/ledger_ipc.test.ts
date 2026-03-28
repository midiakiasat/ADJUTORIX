import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / MAIN / ledger_ipc.test.ts
 *
 * Canonical ledger-IPC contract suite.
 *
 * Purpose:
 * - verify that main-process ledger IPC preserves one authoritative boundary for ledger snapshot,
 *   refresh, entry selection, graph/edge/event delivery, and replay/rollback lineage projection
 *   to renderer surfaces
 * - verify that request/response contracts, event fanout, policy gating, shape validation,
 *   transaction identity, edge semantics, replayability, and unsubscribe cleanup remain deterministic
 * - verify that stale or malformed ledger events cannot desynchronize renderer ledger truth
 *   from main-process canonical lineage
 *
 * Test philosophy:
 * - no snapshots
 * - assert orchestration semantics, event routing, lifecycle guarantees, and limiting cases directly
 * - prefer lineage drift, cleanup, and shape-drift counterexamples over happy-path only coverage
 *
 * Notes:
 * - this suite assumes src/main/ipc/ledger_ipc exports the functions and types referenced below
 * - if the production module exports differ slightly, update adapters first rather than weakening intent
 */

import {
  createLedgerIpc,
  type LedgerIpcEnvironment,
  type LedgerSnapshot,
  type LedgerEntry,
  type LedgerEdge,
  type LedgerEventPayload,
} from "../../../src/main/ipc/ledger_ipc";

function entry(partial: Partial<LedgerEntry> & Pick<LedgerEntry, "seq" | "id" | "type" | "status" | "title" | "summary">): LedgerEntry {
  return {
    createdAtMs: 1711000000000,
    references: {},
    ...partial,
  } as LedgerEntry;
}

function edge(partial: Partial<LedgerEdge> & Pick<LedgerEdge, "id" | "fromSeq" | "toSeq" | "type">): LedgerEdge {
  return {
    ...partial,
  } as LedgerEdge;
}

function snapshot(overrides: Partial<LedgerSnapshot> = {}): LedgerSnapshot {
  return {
    ledgerId: "ledger-42",
    headSeq: 19,
    selectedSeq: 18,
    replayable: true,
    metrics: {
      totalEntries: 5,
      totalEdges: 4,
      pendingEntries: 0,
      failedEntries: 1,
      replayEdges: 1,
      rollbackEdges: 1,
    },
    entries: [
      entry({
        seq: 15,
        id: "entry-15",
        type: "patch-proposed",
        status: "succeeded",
        title: "Patch proposed",
        summary: "Patch patch-42 proposed for renderer shell refactor.",
        references: {
          patchId: "patch-42",
          requestId: "req-15",
        },
      }),
      entry({
        seq: 16,
        id: "entry-16",
        type: "verify-started",
        status: "succeeded",
        title: "Verify started",
        summary: "Verification verify-42 started for patch-42.",
        references: {
          verifyId: "verify-42",
          patchId: "patch-42",
          jobId: "job-verify-42",
        },
      }),
      entry({
        seq: 17,
        id: "entry-17",
        type: "verify-finished",
        status: "failed",
        title: "Verify finished",
        summary: "Replay mismatch detected during verify completion.",
        references: {
          verifyId: "verify-42",
          patchId: "patch-42",
          jobId: "job-verify-42",
        },
      }),
      entry({
        seq: 18,
        id: "entry-18",
        type: "rollback-requested",
        status: "pending",
        title: "Rollback requested",
        summary: "Rollback candidate requested after failed replay evidence.",
        references: {
          verifyId: "verify-42",
          patchId: "patch-42",
          requestId: "rollback-18",
        },
      }),
      entry({
        seq: 19,
        id: "entry-19",
        type: "approval-recorded",
        status: "succeeded",
        title: "Approval recorded",
        summary: "Restricted approval recorded for non-apply remediation branch.",
        references: {
          approvalId: "approval-19",
          patchId: "patch-42",
        },
      }),
    ],
    edges: [
      edge({ id: "edge-15-16", fromSeq: 15, toSeq: 16, type: "caused-by" }),
      edge({ id: "edge-16-17", fromSeq: 16, toSeq: 17, type: "verifies" }),
      edge({ id: "edge-17-18", fromSeq: 17, toSeq: 18, type: "rolls-back" }),
      edge({ id: "edge-18-19", fromSeq: 18, toSeq: 19, type: "approves" }),
    ],
    notes: [
      "Ledger remains replayable, but failed verify evidence blocks direct apply continuity.",
      "Rollback lineage remains visible and must not be collapsed into generic status history.",
    ],
    health: {
      level: "healthy",
      reasons: [],
    },
    metadata: {
      provider: "ledger-service",
    },
    ...overrides,
  } as LedgerSnapshot;
}

function env(overrides: Partial<LedgerIpcEnvironment> = {}): LedgerIpcEnvironment {
  const listeners = new Map<string, Set<(payload: LedgerEventPayload) => void>>();

  return {
    ledgerService: {
      loadLedger: vi.fn(async () => snapshot()),
      refreshLedger: vi.fn(async () => snapshot({ metadata: { refreshed: true } })),
      selectEntry: vi.fn(async () => undefined),
      subscribe: vi.fn((ledgerId: string, listener: (payload: LedgerEventPayload) => void) => {
        if (!listeners.has(ledgerId)) listeners.set(ledgerId, new Set());
        listeners.get(ledgerId)!.add(listener);
        return () => listeners.get(ledgerId)?.delete(listener);
      }),
      emit: (ledgerId: string, payload: LedgerEventPayload) => {
        listeners.get(ledgerId)?.forEach((listener) => listener(payload));
      },
    },
    policy: {
      evaluate: vi.fn(() => ({ allowed: true, violations: [] })),
    },
    sender: {
      sendToWebContents: vi.fn(),
    },
    ...overrides,
  } as unknown as LedgerIpcEnvironment;
}

describe("main/ipc/ledger_ipc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads a ledger snapshot through IPC with canonical response shape", async () => {
    const environment = env();
    const ipc = createLedgerIpc(environment);

    const result = await ipc.handleLoadLedger({
      requestId: "req-load-1",
      payload: { ledgerId: "ledger-42" },
      webContentsId: 7,
    });

    expect(environment.ledgerService.loadLedger).toHaveBeenCalledWith("ledger-42");
    expect(result.ok).toBe(true);
    expect(result.result.ledgerId).toBe("ledger-42");
    expect(result.result.headSeq).toBe(19);
    expect(result.result.selectedSeq).toBe(18);
  });

  it("refreshes a ledger snapshot through IPC without changing canonical ledger identity", async () => {
    const environment = env();
    const ipc = createLedgerIpc(environment);

    const result = await ipc.handleRefreshLedger({
      requestId: "req-refresh-1",
      payload: { ledgerId: "ledger-42" },
      webContentsId: 7,
    });

    expect(environment.ledgerService.refreshLedger).toHaveBeenCalledWith("ledger-42");
    expect(result.ok).toBe(true);
    expect(result.result.ledgerId).toBe("ledger-42");
    expect(result.result.metadata).toEqual(expect.objectContaining({ refreshed: true }));
  });

  it("routes entry selection through the ledger service and returns normalized success", async () => {
    const environment = env();
    const ipc = createLedgerIpc(environment);

    const result = await ipc.handleSelectEntry({
      requestId: "req-select-1",
      payload: {
        ledgerId: "ledger-42",
        seq: 19,
      },
      webContentsId: 7,
    });

    expect(environment.ledgerService.selectEntry).toHaveBeenCalledWith("ledger-42", 19);
    expect(result.ok).toBe(true);
  });

  it("rejects policy-denied ledger loads before reaching the ledger service", async () => {
    const environment = env({
      policy: {
        evaluate: vi.fn(() => ({ allowed: false, violations: [{ code: "AUTHORITY_DENIED" }] })),
      },
    });
    const ipc = createLedgerIpc(environment);

    const result = await ipc.handleLoadLedger({
      requestId: "req-load-2",
      payload: { ledgerId: "ledger-42" },
      webContentsId: 7,
    });

    expect(environment.ledgerService.loadLedger).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("LEDGER_IPC_POLICY_DENIED");
  });

  it("rejects malformed selection payloads without calling the ledger service", async () => {
    const environment = env();
    const ipc = createLedgerIpc(environment);

    const result = await ipc.handleSelectEntry({
      requestId: "req-select-2",
      payload: {
        ledgerId: "ledger-42",
      } as unknown as { ledgerId: string; seq: number },
      webContentsId: 7,
    });

    expect(environment.ledgerService.selectEntry).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("INVALID_LEDGER_REQUEST");
  });

  it("normalizes ledger-service failures into structured IPC errors instead of leaking raw exceptions", async () => {
    const environment = env({
      ledgerService: {
        ...env().ledgerService,
        loadLedger: vi.fn(async () => {
          throw new Error("ledger service unavailable");
        }),
      },
    });
    const ipc = createLedgerIpc(environment);

    const result = await ipc.handleLoadLedger({
      requestId: "req-load-3",
      payload: { ledgerId: "ledger-42" },
      webContentsId: 7,
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("LEDGER_IPC_HANDLER_FAILED");
    expect(result.error.message).toContain("ledger service unavailable");
  });

  it("subscribes a renderer to ledger events and fans out snapshot events to the correct webContents", async () => {
    const environment = env();
    const ipc = createLedgerIpc(environment);

    const sub = await ipc.handleSubscribeLedger({
      requestId: "req-sub-1",
      payload: { ledgerId: "ledger-42" },
      webContentsId: 7,
    });

    expect(sub.ok).toBe(true);
    expect(environment.ledgerService.subscribe).toHaveBeenCalledWith("ledger-42", expect.any(Function));

    environment.ledgerService.emit("ledger-42", {
      type: "ledger-snapshot",
      snapshot: snapshot({ ledgerId: "ledger-42", replayable: false, headSeq: 20 }),
    });

    expect(environment.sender.sendToWebContents).toHaveBeenCalledWith(
      7,
      "ledger:event",
      expect.objectContaining({
        type: "ledger-snapshot",
        snapshot: expect.objectContaining({ replayable: false, headSeq: 20 }),
      }),
    );
  });

  it("fans out entry, edge, selection, replayability, metrics, and health events without mutating semantic shape", async () => {
    const environment = env();
    const ipc = createLedgerIpc(environment);

    await ipc.handleSubscribeLedger({
      requestId: "req-sub-2",
      payload: { ledgerId: "ledger-42" },
      webContentsId: 9,
    });

    environment.ledgerService.emit("ledger-42", {
      type: "ledger-entry",
      entry: entry({
        seq: 20,
        id: "entry-20",
        type: "verify-restarted",
        status: "pending",
        title: "Verify restarted",
        summary: "Verify rerun scheduled after replay failure remediation.",
        references: {
          verifyId: "verify-43",
          patchId: "patch-42",
        },
      }),
    });
    environment.ledgerService.emit("ledger-42", {
      type: "ledger-edge",
      edge: edge({
        id: "edge-19-20",
        fromSeq: 19,
        toSeq: 20,
        type: "caused-by",
      }),
    });
    environment.ledgerService.emit("ledger-42", {
      type: "ledger-selection",
      selectedSeq: 20,
    });
    environment.ledgerService.emit("ledger-42", {
      type: "ledger-replayability",
      replayable: false,
      lineageComplete: false,
      ledgerContinuity: "broken",
    });
    environment.ledgerService.emit("ledger-42", {
      type: "ledger-metrics",
      metrics: {
        totalEntries: 6,
        totalEdges: 5,
        pendingEntries: 1,
        failedEntries: 1,
        replayEdges: 2,
        rollbackEdges: 1,
      },
    });
    environment.ledgerService.emit("ledger-42", {
      type: "ledger-health",
      health: {
        level: "degraded",
        reasons: ["lineage reconstruction stale"],
      },
    });

    const payloads = (environment.sender.sendToWebContents as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => call[0] === 9 && call[1] === "ledger:event")
      .map((call) => call[2]);

    expect(payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "ledger-entry", entry: expect.objectContaining({ seq: 20, id: "entry-20" }) }),
        expect.objectContaining({ type: "ledger-edge", edge: expect.objectContaining({ id: "edge-19-20", type: "caused-by" }) }),
        expect.objectContaining({ type: "ledger-selection", selectedSeq: 20 }),
        expect.objectContaining({ type: "ledger-replayability", replayable: false, lineageComplete: false, ledgerContinuity: "broken" }),
        expect.objectContaining({ type: "ledger-metrics", metrics: expect.objectContaining({ totalEntries: 6, pendingEntries: 1 }) }),
        expect.objectContaining({ type: "ledger-health", health: expect.objectContaining({ level: "degraded" }) }),
      ]),
    );
  });

  it("does not fan out events for one ledger to renderers subscribed to a different ledger id", async () => {
    const environment = env();
    const ipc = createLedgerIpc(environment);

    await ipc.handleSubscribeLedger({
      requestId: "req-sub-3",
      payload: { ledgerId: "ledger-42" },
      webContentsId: 7,
    });
    await ipc.handleSubscribeLedger({
      requestId: "req-sub-4",
      payload: { ledgerId: "ledger-99" },
      webContentsId: 8,
    });

    environment.ledgerService.emit("ledger-42", {
      type: "ledger-selection",
      selectedSeq: 19,
    });

    const calls = (environment.sender.sendToWebContents as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((call) => call[0] === 7)).toBe(true);
    expect(calls.some((call) => call[0] === 8)).toBe(false);
  });

  it("supports multiple subscribers on the same ledger and fans out identical events to each", async () => {
    const environment = env();
    const ipc = createLedgerIpc(environment);

    await ipc.handleSubscribeLedger({
      requestId: "req-sub-5",
      payload: { ledgerId: "ledger-42" },
      webContentsId: 11,
    });
    await ipc.handleSubscribeLedger({
      requestId: "req-sub-6",
      payload: { ledgerId: "ledger-42" },
      webContentsId: 12,
    });

    environment.ledgerService.emit("ledger-42", {
      type: "ledger-health",
      health: { level: "degraded", reasons: ["replay gap detected"] },
    });

    expect(environment.sender.sendToWebContents).toHaveBeenCalledWith(
      11,
      "ledger:event",
      expect.objectContaining({ type: "ledger-health" }),
    );
    expect(environment.sender.sendToWebContents).toHaveBeenCalledWith(
      12,
      "ledger:event",
      expect.objectContaining({ type: "ledger-health" }),
    );
  });

  it("unsubscribes deterministically so later ledger events no longer reach that renderer", async () => {
    const environment = env();
    const ipc = createLedgerIpc(environment);

    const sub = await ipc.handleSubscribeLedger({
      requestId: "req-sub-7",
      payload: { ledgerId: "ledger-42" },
      webContentsId: 13,
    });

    expect(sub.ok).toBe(true);

    const unsub = await ipc.handleUnsubscribeLedger({
      requestId: "req-unsub-1",
      payload: { ledgerId: "ledger-42" },
      webContentsId: 13,
    });

    expect(unsub.ok).toBe(true);

    environment.ledgerService.emit("ledger-42", {
      type: "ledger-entry",
      entry: entry({
        seq: 99,
        id: "entry-after-unsub",
        type: "noop",
        status: "succeeded",
        title: "should not arrive",
        summary: "nope",
      }),
    });

    const calls = (environment.sender.sendToWebContents as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((call) => call[0] === 13)).toBe(false);
  });

  it("treats duplicate subscribe requests from the same renderer and ledger id idempotently", async () => {
    const environment = env();
    const ipc = createLedgerIpc(environment);

    await ipc.handleSubscribeLedger({
      requestId: "req-sub-8",
      payload: { ledgerId: "ledger-42" },
      webContentsId: 14,
    });
    await ipc.handleSubscribeLedger({
      requestId: "req-sub-9",
      payload: { ledgerId: "ledger-42" },
      webContentsId: 14,
    });

    environment.ledgerService.emit("ledger-42", {
      type: "ledger-selection",
      selectedSeq: 18,
    });

    const calls = (environment.sender.sendToWebContents as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0] === 14 && call[1] === "ledger:event",
    );

    expect(calls).toHaveLength(1);
  });

  it("rejects subscribe requests denied by policy before wiring listeners", async () => {
    const environment = env({
      policy: {
        evaluate: vi.fn(() => ({ allowed: false, violations: [{ code: "TRUST_DENIED" }] })),
      },
    });
    const ipc = createLedgerIpc(environment);

    const result = await ipc.handleSubscribeLedger({
      requestId: "req-sub-10",
      payload: { ledgerId: "ledger-42" },
      webContentsId: 15,
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("LEDGER_IPC_POLICY_DENIED");
    expect(environment.ledgerService.subscribe).not.toHaveBeenCalled();
  });

  it("normalizes malformed emitted ledger events instead of forwarding invalid shapes directly to renderer", async () => {
    const environment = env();
    const ipc = createLedgerIpc(environment);

    await ipc.handleSubscribeLedger({
      requestId: "req-sub-11",
      payload: { ledgerId: "ledger-42" },
      webContentsId: 16,
    });

    environment.ledgerService.emit("ledger-42", {
      type: "ledger-selection",
      selectedSeq: null,
    } as unknown as LedgerEventPayload);

    expect(environment.sender.sendToWebContents).not.toHaveBeenCalled();
  });

  it("cleans up all subscriptions on dispose so later emissions cannot leak into dead registries", async () => {
    const environment = env();
    const ipc = createLedgerIpc(environment);

    await ipc.handleSubscribeLedger({
      requestId: "req-sub-12",
      payload: { ledgerId: "ledger-42" },
      webContentsId: 17,
    });

    ipc.dispose();

    environment.ledgerService.emit("ledger-42", {
      type: "ledger-health",
      health: { level: "degraded", reasons: ["disposed registry should stay silent"] },
    });

    expect(environment.sender.sendToWebContents).not.toHaveBeenCalled();
  });

  it("returns deterministic identical request verdicts for identical ledger loads", async () => {
    const environment = env();
    const ipc = createLedgerIpc(environment);

    const a = await ipc.handleLoadLedger({
      requestId: "req-load-4a",
      payload: { ledgerId: "ledger-42" },
      webContentsId: 7,
    });
    const b = await ipc.handleLoadLedger({
      requestId: "req-load-4b",
      payload: { ledgerId: "ledger-42" },
      webContentsId: 7,
    });

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.result).toEqual(b.result);
  });
});
