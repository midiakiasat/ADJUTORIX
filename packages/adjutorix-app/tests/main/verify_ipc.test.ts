import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / MAIN / verify_ipc.test.ts
 *
 * Canonical verify-IPC contract suite.
 *
 * Purpose:
 * - verify that main-process verify IPC preserves one authoritative boundary for verification snapshot,
 *   refresh, run initiation, artifact access intent, and live verify-event delivery to renderer surfaces
 * - verify that request/response contracts, event fanout, policy gating, shape validation,
 *   run identity, replay posture, and unsubscribe cleanup remain deterministic
 * - verify that stale or malformed verify events cannot desynchronize renderer verification state
 *   from main-process verification truth
 *
 * Test philosophy:
 * - no snapshots
 * - assert orchestration semantics, event routing, lifecycle guarantees, and limiting cases directly
 * - prefer replay/apply-gate drift, cleanup, and shape-drift counterexamples over happy-path only coverage
 *
 * Notes:
 * - this suite assumes src/main/ipc/verify_ipc exports the functions and types referenced below
 * - if the production module exports differ slightly, update adapters first rather than weakening intent
 */

import {
  createVerifyIpc,
  type VerifyIpcEnvironment,
  type VerifySnapshot,
  type VerifyCheck,
  type VerifyArtifact,
  type VerifyEventPayload,
} from "../../../src/main/ipc/verify_ipc";

function check(partial: Partial<VerifyCheck> & Pick<VerifyCheck, "id" | "title" | "status" | "category" | "summary">): VerifyCheck {
  return {
    ...partial,
  } as VerifyCheck;
}

function artifact(partial: Partial<VerifyArtifact> & Pick<VerifyArtifact, "id" | "label" | "kind" | "path">): VerifyArtifact {
  return {
    ...partial,
  } as VerifyArtifact;
}

function snapshot(overrides: Partial<VerifySnapshot> = {}): VerifySnapshot {
  return {
    verifyId: "verify-42",
    status: "partial",
    phase: "completed",
    replayable: true,
    applyReadinessImpact: "blocked",
    activeJobId: "job-verify-42",
    relatedPatchId: "patch-42",
    startedAtMs: 1711000000000,
    finishedAtMs: 1711000035000,
    summary: {
      totalChecks: 12,
      passedChecks: 9,
      warningChecks: 1,
      failedChecks: 2,
      replayChecks: 3,
    },
    checks: [
      check({ id: "check-1", title: "Patch schema valid", status: "passed", category: "schema", summary: "Patch payload matched canonical schema." }),
      check({ id: "check-2", title: "Replay determinism", status: "failed", category: "replay", summary: "Replay mismatch detected at transaction edge 18 -> 19." }),
      check({ id: "check-3", title: "Apply gate readiness", status: "warning", category: "governance", summary: "Rejected patch files still block apply despite partial verification success." }),
      check({ id: "check-4", title: "Ledger continuity", status: "failed", category: "ledger", summary: "Ledger edge continuity broke after rollback candidate evaluation." }),
    ],
    artifacts: [
      artifact({ id: "artifact-1", label: "verify.log", kind: "log", path: "/repo/adjutorix-app/.adjutorix/verify/verify-42.log" }),
      artifact({ id: "artifact-2", label: "replay-report.json", kind: "report", path: "/repo/adjutorix-app/.adjutorix/verify/replay-report.json" }),
    ],
    notes: [
      "Verification completed with blocking replay and ledger failures.",
      "Apply remains blocked until rejected review items and failed replay checks are resolved.",
    ],
    health: {
      level: "healthy",
      reasons: [],
    },
    metadata: {
      provider: "verify-service",
    },
    ...overrides,
  } as VerifySnapshot;
}

function env(overrides: Partial<VerifyIpcEnvironment> = {}): VerifyIpcEnvironment {
  const listeners = new Map<string, Set<(payload: VerifyEventPayload) => void>>();

  return {
    verifyService: {
      loadVerify: vi.fn(async () => snapshot()),
      refreshVerify: vi.fn(async () => snapshot({ metadata: { refreshed: true } })),
      runVerify: vi.fn(async (_payload: { patchId?: string | null; verifyProfile?: string | null }) => ({
        verifyId: "verify-99",
        status: "running",
        phase: "running",
        replayable: true,
        applyReadinessImpact: "blocked",
        activeJobId: "job-verify-99",
        relatedPatchId: _payload.patchId ?? "patch-42",
        startedAtMs: 1711000100000,
        finishedAtMs: null,
        summary: {
          totalChecks: 0,
          passedChecks: 0,
          warningChecks: 0,
          failedChecks: 0,
          replayChecks: 0,
        },
        checks: [],
        artifacts: [],
        notes: ["Verification queued."],
        health: { level: "healthy", reasons: [] },
        metadata: { provider: "verify-service", verifyProfile: _payload.verifyProfile ?? "default" },
      })),
      subscribe: vi.fn((verifyId: string, listener: (payload: VerifyEventPayload) => void) => {
        if (!listeners.has(verifyId)) listeners.set(verifyId, new Set());
        listeners.get(verifyId)!.add(listener);
        return () => listeners.get(verifyId)?.delete(listener);
      }),
      emit: (verifyId: string, payload: VerifyEventPayload) => {
        listeners.get(verifyId)?.forEach((listener) => listener(payload));
      },
    },
    policy: {
      evaluate: vi.fn(() => ({ allowed: true, violations: [] })),
    },
    sender: {
      sendToWebContents: vi.fn(),
    },
    ...overrides,
  } as unknown as VerifyIpcEnvironment;
}

describe("main/ipc/verify_ipc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads a verify snapshot through IPC with canonical response shape", async () => {
    const environment = env();
    const ipc = createVerifyIpc(environment);

    const result = await ipc.handleLoadVerify({
      requestId: "req-load-1",
      payload: { verifyId: "verify-42" },
      webContentsId: 7,
    });

    expect(environment.verifyService.loadVerify).toHaveBeenCalledWith("verify-42");
    expect(result.ok).toBe(true);
    expect(result.result.verifyId).toBe("verify-42");
    expect(result.result.activeJobId).toBe("job-verify-42");
  });

  it("refreshes a verify snapshot through IPC without changing canonical verify identity", async () => {
    const environment = env();
    const ipc = createVerifyIpc(environment);

    const result = await ipc.handleRefreshVerify({
      requestId: "req-refresh-1",
      payload: { verifyId: "verify-42" },
      webContentsId: 7,
    });

    expect(environment.verifyService.refreshVerify).toHaveBeenCalledWith("verify-42");
    expect(result.ok).toBe(true);
    expect(result.result.verifyId).toBe("verify-42");
    expect(result.result.metadata).toEqual(expect.objectContaining({ refreshed: true }));
  });

  it("routes run-verify through the verify service and returns normalized running verify state", async () => {
    const environment = env();
    const ipc = createVerifyIpc(environment);

    const result = await ipc.handleRunVerify({
      requestId: "req-run-1",
      payload: {
        patchId: "patch-42",
        verifyProfile: "full",
      },
      webContentsId: 7,
    });

    expect(environment.verifyService.runVerify).toHaveBeenCalledWith({
      patchId: "patch-42",
      verifyProfile: "full",
    });
    expect(result.ok).toBe(true);
    expect(result.result.verifyId).toBe("verify-99");
    expect(result.result.phase).toBe("running");
    expect(result.result.metadata).toEqual(expect.objectContaining({ verifyProfile: "full" }));
  });

  it("rejects policy-denied verify loads before reaching the verify service", async () => {
    const environment = env({
      policy: {
        evaluate: vi.fn(() => ({ allowed: false, violations: [{ code: "AUTHORITY_DENIED" }] })),
      },
    });
    const ipc = createVerifyIpc(environment);

    const result = await ipc.handleLoadVerify({
      requestId: "req-load-2",
      payload: { verifyId: "verify-42" },
      webContentsId: 7,
    });

    expect(environment.verifyService.loadVerify).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("VERIFY_IPC_POLICY_DENIED");
  });

  it("rejects malformed run-verify payloads that omit both patch and profile semantics when required", async () => {
    const environment = env();
    const ipc = createVerifyIpc(environment);

    const result = await ipc.handleRunVerify({
      requestId: "req-run-2",
      payload: null as unknown as { patchId?: string | null; verifyProfile?: string | null },
      webContentsId: 7,
    });

    expect(environment.verifyService.runVerify).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("INVALID_VERIFY_REQUEST");
  });

  it("normalizes verify-service failures into structured IPC errors instead of leaking raw exceptions", async () => {
    const environment = env({
      verifyService: {
        ...env().verifyService,
        loadVerify: vi.fn(async () => {
          throw new Error("verify service unavailable");
        }),
      },
    });
    const ipc = createVerifyIpc(environment);

    const result = await ipc.handleLoadVerify({
      requestId: "req-load-3",
      payload: { verifyId: "verify-42" },
      webContentsId: 7,
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("VERIFY_IPC_HANDLER_FAILED");
    expect(result.error.message).toContain("verify service unavailable");
  });

  it("subscribes a renderer to verify events and fans out snapshot events to the correct webContents", async () => {
    const environment = env();
    const ipc = createVerifyIpc(environment);

    const sub = await ipc.handleSubscribeVerify({
      requestId: "req-sub-1",
      payload: { verifyId: "verify-42" },
      webContentsId: 7,
    });

    expect(sub.ok).toBe(true);
    expect(environment.verifyService.subscribe).toHaveBeenCalledWith("verify-42", expect.any(Function));

    environment.verifyService.emit("verify-42", {
      type: "verify-snapshot",
      snapshot: snapshot({ verifyId: "verify-42", status: "passed", phase: "completed" }),
    });

    expect(environment.sender.sendToWebContents).toHaveBeenCalledWith(
      7,
      "verify:event",
      expect.objectContaining({
        type: "verify-snapshot",
        snapshot: expect.objectContaining({ status: "passed" }),
      }),
    );
  });

  it("fans out check, artifact, summary, status, and health events without mutating semantic shape", async () => {
    const environment = env();
    const ipc = createVerifyIpc(environment);

    await ipc.handleSubscribeVerify({
      requestId: "req-sub-2",
      payload: { verifyId: "verify-42" },
      webContentsId: 9,
    });

    environment.verifyService.emit("verify-42", {
      type: "verify-check",
      check: check({ id: "check-9", title: "Replay graph continuity", status: "failed", category: "replay", summary: "Replay graph continuity failed at edge 18 -> 19." }),
    });
    environment.verifyService.emit("verify-42", {
      type: "verify-artifact",
      artifact: artifact({ id: "artifact-9", label: "verify-summary.json", kind: "report", path: "/repo/adjutorix-app/.adjutorix/verify/verify-summary.json" }),
    });
    environment.verifyService.emit("verify-42", {
      type: "verify-summary",
      summary: {
        totalChecks: 13,
        passedChecks: 9,
        warningChecks: 1,
        failedChecks: 3,
        replayChecks: 4,
      },
    });
    environment.verifyService.emit("verify-42", {
      type: "verify-status",
      patch: {
        status: "failed",
        phase: "completed",
        replayable: false,
        applyReadinessImpact: "blocked",
        activeJobId: "job-verify-42",
      },
    });
    environment.verifyService.emit("verify-42", {
      type: "verify-health",
      health: {
        level: "degraded",
        reasons: ["replay evidence stale"],
      },
    });

    const payloads = (environment.sender.sendToWebContents as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => call[0] === 9 && call[1] === "verify:event")
      .map((call) => call[2]);

    expect(payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "verify-check", check: expect.objectContaining({ id: "check-9", status: "failed" }) }),
        expect.objectContaining({ type: "verify-artifact", artifact: expect.objectContaining({ id: "artifact-9", label: "verify-summary.json" }) }),
        expect.objectContaining({ type: "verify-summary", summary: expect.objectContaining({ failedChecks: 3, replayChecks: 4 }) }),
        expect.objectContaining({ type: "verify-status", patch: expect.objectContaining({ status: "failed", replayable: false }) }),
        expect.objectContaining({ type: "verify-health", health: expect.objectContaining({ level: "degraded" }) }),
      ]),
    );
  });

  it("does not fan out events for one verify run to renderers subscribed to a different verify id", async () => {
    const environment = env();
    const ipc = createVerifyIpc(environment);

    await ipc.handleSubscribeVerify({
      requestId: "req-sub-3",
      payload: { verifyId: "verify-42" },
      webContentsId: 7,
    });
    await ipc.handleSubscribeVerify({
      requestId: "req-sub-4",
      payload: { verifyId: "verify-99" },
      webContentsId: 8,
    });

    environment.verifyService.emit("verify-42", {
      type: "verify-status",
      patch: {
        status: "running",
        phase: "running",
        replayable: true,
        applyReadinessImpact: "blocked",
        activeJobId: "job-verify-42",
      },
    });

    const calls = (environment.sender.sendToWebContents as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((call) => call[0] === 7)).toBe(true);
    expect(calls.some((call) => call[0] === 8)).toBe(false);
  });

  it("supports multiple subscribers on the same verify id and fans out identical events to each", async () => {
    const environment = env();
    const ipc = createVerifyIpc(environment);

    await ipc.handleSubscribeVerify({
      requestId: "req-sub-5",
      payload: { verifyId: "verify-42" },
      webContentsId: 11,
    });
    await ipc.handleSubscribeVerify({
      requestId: "req-sub-6",
      payload: { verifyId: "verify-42" },
      webContentsId: 12,
    });

    environment.verifyService.emit("verify-42", {
      type: "verify-health",
      health: { level: "degraded", reasons: ["latency rising"] },
    });

    expect(environment.sender.sendToWebContents).toHaveBeenCalledWith(
      11,
      "verify:event",
      expect.objectContaining({ type: "verify-health" }),
    );
    expect(environment.sender.sendToWebContents).toHaveBeenCalledWith(
      12,
      "verify:event",
      expect.objectContaining({ type: "verify-health" }),
    );
  });

  it("unsubscribes deterministically so later verify events no longer reach that renderer", async () => {
    const environment = env();
    const ipc = createVerifyIpc(environment);

    const sub = await ipc.handleSubscribeVerify({
      requestId: "req-sub-7",
      payload: { verifyId: "verify-42" },
      webContentsId: 13,
    });

    expect(sub.ok).toBe(true);

    const unsub = await ipc.handleUnsubscribeVerify({
      requestId: "req-unsub-1",
      payload: { verifyId: "verify-42" },
      webContentsId: 13,
    });

    expect(unsub.ok).toBe(true);

    environment.verifyService.emit("verify-42", {
      type: "verify-check",
      check: check({ id: "check-after-unsub", title: "should not arrive", status: "failed", category: "replay", summary: "nope" }),
    });

    const calls = (environment.sender.sendToWebContents as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((call) => call[0] === 13)).toBe(false);
  });

  it("treats duplicate subscribe requests from the same renderer and verify id idempotently", async () => {
    const environment = env();
    const ipc = createVerifyIpc(environment);

    await ipc.handleSubscribeVerify({
      requestId: "req-sub-8",
      payload: { verifyId: "verify-42" },
      webContentsId: 14,
    });
    await ipc.handleSubscribeVerify({
      requestId: "req-sub-9",
      payload: { verifyId: "verify-42" },
      webContentsId: 14,
    });

    environment.verifyService.emit("verify-42", {
      type: "verify-summary",
      summary: {
        totalChecks: 12,
        passedChecks: 10,
        warningChecks: 0,
        failedChecks: 2,
        replayChecks: 3,
      },
    });

    const calls = (environment.sender.sendToWebContents as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0] === 14 && call[1] === "verify:event",
    );

    expect(calls).toHaveLength(1);
  });

  it("rejects subscribe requests denied by policy before wiring listeners", async () => {
    const environment = env({
      policy: {
        evaluate: vi.fn(() => ({ allowed: false, violations: [{ code: "TRUST_DENIED" }] })),
      },
    });
    const ipc = createVerifyIpc(environment);

    const result = await ipc.handleSubscribeVerify({
      requestId: "req-sub-10",
      payload: { verifyId: "verify-42" },
      webContentsId: 15,
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("VERIFY_IPC_POLICY_DENIED");
    expect(environment.verifyService.subscribe).not.toHaveBeenCalled();
  });

  it("normalizes malformed emitted verify events instead of forwarding invalid shapes directly to renderer", async () => {
    const environment = env();
    const ipc = createVerifyIpc(environment);

    await ipc.handleSubscribeVerify({
      requestId: "req-sub-11",
      payload: { verifyId: "verify-42" },
      webContentsId: 16,
    });

    environment.verifyService.emit("verify-42", {
      type: "verify-check",
      check: null,
    } as unknown as VerifyEventPayload);

    expect(environment.sender.sendToWebContents).not.toHaveBeenCalled();
  });

  it("cleans up all subscriptions on dispose so later emissions cannot leak into dead registries", async () => {
    const environment = env();
    const ipc = createVerifyIpc(environment);

    await ipc.handleSubscribeVerify({
      requestId: "req-sub-12",
      payload: { verifyId: "verify-42" },
      webContentsId: 17,
    });

    ipc.dispose();

    environment.verifyService.emit("verify-42", {
      type: "verify-health",
      health: { level: "degraded", reasons: ["disposed registry should stay silent"] },
    });

    expect(environment.sender.sendToWebContents).not.toHaveBeenCalled();
  });

  it("returns deterministic identical request verdicts for identical verify loads", async () => {
    const environment = env();
    const ipc = createVerifyIpc(environment);

    const a = await ipc.handleLoadVerify({
      requestId: "req-load-4a",
      payload: { verifyId: "verify-42" },
      webContentsId: 7,
    });
    const b = await ipc.handleLoadVerify({
      requestId: "req-load-4b",
      payload: { verifyId: "verify-42" },
      webContentsId: 7,
    });

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.result).toEqual(b.result);
  });
});
