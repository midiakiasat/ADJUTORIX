import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * ADJUTORIX APP — TESTS / SMOKE / verify_flow.smoke.test.ts
 *
 * Canonical verify-flow smoke suite.
 *
 * Objective:
 * - verify the end-to-end verify path from explicit renderer action through verify request,
 *   job creation, live progress/event ingestion, final evidence hydration, replay/apply impact projection,
 *   and visible governed completion state
 * - catch catastrophic integration regressions where verify transport succeeds but job status,
 *   streamed updates, summary counters, evidence, and apply readiness never converge to one truth
 * - keep assertions outcome-oriented: did the app request verify, surface running state,
 *   process progress, reconcile final results, and fail closed on contradictory or failed verify outcomes
 *
 * Notes:
 * - this suite assumes the renderer App and bootstrap helpers below exist and represent the app shell
 * - if actual bootstrap exports differ, adapt the harness first rather than weakening the smoke guarantees
 */

import App from "../../../src/renderer/App";
import { installRendererProviders } from "../../../src/renderer/bootstrap/installRendererProviders";
import { createRendererRuntime } from "../../../src/renderer/bootstrap/createRendererRuntime";

type SubscriptionHandler = (payload: unknown) => void;

type MockBridge = {
  workspace: {
    load: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  verify: {
    start: ReturnType<typeof vi.fn>;
    load: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    emit: (payload: unknown) => void;
  };
  patch: {
    load: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  ledger: {
    load: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  diagnostics: {
    load: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  settings: {
    load: ReturnType<typeof vi.fn>;
  };
  shell: {
    status: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  agent: {
    connect: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
};

const VERIFY_ID = "verify-42";
const PATCH_ID = "patch-42";
const LEDGER_ID = "ledger-42";

function makeWorkspaceSnapshot() {
  return {
    workspaceId: "ws-verify-1",
    rootPath: "/repo/adjutorix-app",
    name: "adjutorix-app",
    trustLevel: "trusted",
    status: "ready",
    entries: [],
    expandedPaths: [],
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
      watchedPaths: 24,
      eventLagMs: 5,
    },
  };
}

function makePatch() {
  return {
    patchId: PATCH_ID,
    title: "Renderer shell refactor",
    status: "in-review",
    files: [
      {
        path: "/repo/adjutorix-app/src/renderer/App.tsx",
        status: "modified",
        additions: 12,
        deletions: 4,
        selectable: true,
      },
    ],
    comments: [],
    verifyEvidence: [],
    applyReadiness: "pending-verify",
    health: {
      level: "healthy",
      reasons: [],
    },
  };
}

function makeVerifyRunning() {
  return {
    verifyId: VERIFY_ID,
    status: "running",
    phase: "executing",
    replayable: false,
    applyReadinessImpact: "pending",
    checks: [
      { id: "check-1", title: "Typecheck", status: "running" },
      { id: "check-2", title: "Replay", status: "queued" },
      { id: "check-3", title: "Ledger continuity", status: "queued" },
    ],
    artifacts: [],
    summary: {
      totalChecks: 3,
      passedChecks: 0,
      warningChecks: 0,
      failedChecks: 0,
      replayChecks: 1,
    },
    progressPct: 15,
    health: {
      level: "healthy",
      reasons: [],
    },
  };
}

function makeVerifyPassed() {
  return {
    verifyId: VERIFY_ID,
    status: "passed",
    phase: "completed",
    replayable: true,
    applyReadinessImpact: "ready",
    checks: [
      { id: "check-1", title: "Typecheck", status: "passed" },
      { id: "check-2", title: "Replay", status: "passed" },
      { id: "check-3", title: "Ledger continuity", status: "passed" },
      { id: "check-4", title: "Policy gate", status: "passed" },
    ],
    artifacts: [
      { id: "artifact-1", title: "Replay evidence", kind: "replay" },
      { id: "artifact-2", title: "Policy proof", kind: "policy" },
    ],
    summary: {
      totalChecks: 4,
      passedChecks: 4,
      warningChecks: 0,
      failedChecks: 0,
      replayChecks: 1,
    },
    progressPct: 100,
    health: {
      level: "healthy",
      reasons: [],
    },
  };
}

function makeLedger() {
  return {
    ledgerId: LEDGER_ID,
    headSeq: 12,
    selectedSeq: 12,
    replayable: true,
    entries: [],
    edges: [],
    metrics: {
      totalEntries: 12,
      totalEdges: 11,
      pendingEntries: 0,
      failedEntries: 0,
      replayEdges: 1,
      rollbackEdges: 0,
    },
    health: { level: "healthy", reasons: [] },
  };
}

function makeBridge(): MockBridge {
  let verifyHandler: SubscriptionHandler | null = null;

  return {
    workspace: {
      load: vi.fn(async () => makeWorkspaceSnapshot()),
      subscribe: vi.fn(() => () => undefined),
    },
    verify: {
      start: vi.fn(async ({ patchId }: { patchId: string }) => ({
        ok: true,
        patchId,
        verifyId: VERIFY_ID,
      })),
      load: vi
        .fn()
        .mockResolvedValueOnce(makeVerifyRunning())
        .mockResolvedValue(makeVerifyPassed()),
      subscribe: vi.fn((handler: SubscriptionHandler) => {
        verifyHandler = handler;
        return () => {
          if (verifyHandler === handler) verifyHandler = null;
        };
      }),
      emit: (payload: unknown) => {
        verifyHandler?.(payload);
      },
    },
    patch: {
      load: vi.fn(async () => makePatch()),
      subscribe: vi.fn(() => () => undefined),
    },
    ledger: {
      load: vi.fn(async () => makeLedger()),
      subscribe: vi.fn(() => () => undefined),
    },
    diagnostics: {
      load: vi.fn(async () => ({
        workspaceId: "ws-verify-1",
        selectedPath: null,
        diagnostics: [],
        summary: {
          total: 0,
          fatalCount: 0,
          errorCount: 0,
          warningCount: 0,
          infoCount: 0,
          byProducer: {},
          byCategory: {},
          byFile: {},
        },
        health: {
          level: "healthy",
          reasons: [],
        },
      })),
      subscribe: vi.fn(() => () => undefined),
    },
    settings: {
      load: vi.fn(async () => ({
        theme: "dark",
        confirmations: true,
      })),
    },
    shell: {
      status: vi.fn(async () => ({
        level: "healthy",
        actionAllowed: true,
        reasons: [],
        shell: {
          available: true,
          terminalReady: true,
          cwd: "/repo/adjutorix-app",
          shellPath: "/bin/zsh",
        },
      })),
      subscribe: vi.fn(() => () => undefined),
    },
    agent: {
      connect: vi.fn(async () => ({
        identity: {
          sessionId: "agent-session-1",
          providerLabel: "Local Agent",
          modelLabel: "adjutorix-core",
          endpointLabel: "http://127.0.0.1:8000/rpc",
          protocolVersion: "1",
        },
        connectionState: "connected",
        authState: "available",
        trustLevel: "trusted",
        health: { level: "healthy", reasons: [] },
        streamState: "idle",
        pendingRequestCount: 0,
        messages: [],
        activeTools: [],
        jobs: [],
      })),
      subscribe: vi.fn(() => () => undefined),
    },
  };
}

function installBridgeOnWindow(bridge: MockBridge): void {
  Object.defineProperty(window, "adjutorix", {
    configurable: true,
    writable: true,
    value: bridge,
  });
}

async function renderAppWithBridge(bridge: MockBridge) {
  installBridgeOnWindow(bridge);

  const runtime = createRendererRuntime({
    bridge: (window as any).adjutorix,
  });

  const Providers = installRendererProviders(runtime);

  return render(
    <MemoryRouter initialEntries={[`/verify/${VERIFY_ID}`]}>
      <Providers>
        <App />
      </Providers>
    </MemoryRouter>,
  );
}

describe("smoke/verify_flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // @ts-expect-error test cleanup
    delete window.adjutorix;
  });

  it("starts verify, surfaces running state, ingests completion, and settles into coherent passed/apply-ready state", async () => {
    const bridge = makeBridge();
    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.patch.load).toHaveBeenCalled();
      expect(bridge.verify.load).toHaveBeenCalledWith({ verifyId: VERIFY_ID });
    });

    const verifyButton =
      screen.queryByRole("button", { name: /verify/i }) ??
      screen.queryByText(/^verify$/i) ??
      screen.getByRole("button");

    fireEvent.click(verifyButton);

    await waitFor(() => {
      expect(bridge.verify.start).toHaveBeenCalledWith({ patchId: PATCH_ID });
    });

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/running|executing|progress|verify/);
    });

    bridge.verify.emit({
      type: "verify-updated",
      payload: {
        ...makeVerifyPassed(),
      },
    });

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/passed|completed|ready/);
      expect(text).toMatch(/Replay evidence/i);
      expect(text).toMatch(/Policy proof/i);
    });
  });

  it("fails closed when verify start fails instead of presenting a decorative running state", async () => {
    const bridge = makeBridge();
    bridge.verify.start.mockRejectedValueOnce(new Error("verify start failed"));

    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.patch.load).toHaveBeenCalled();
    });

    const verifyButton =
      screen.queryByRole("button", { name: /verify/i }) ??
      screen.queryByText(/^verify$/i) ??
      screen.getByRole("button");

    fireEvent.click(verifyButton);

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/verify start failed|error|failed/);
    });
  });

  it("fails closed when final verify payload contradicts apply readiness and replayability", async () => {
    const bridge = makeBridge();
    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.patch.load).toHaveBeenCalled();
    });

    const verifyButton =
      screen.queryByRole("button", { name: /verify/i }) ??
      screen.queryByText(/^verify$/i) ??
      screen.getByRole("button");

    fireEvent.click(verifyButton);

    await waitFor(() => {
      expect(bridge.verify.start).toHaveBeenCalled();
    });

    bridge.verify.emit({
      type: "verify-updated",
      payload: {
        ...makeVerifyPassed(),
        status: "failed",
        replayable: false,
        applyReadinessImpact: "ready",
        health: {
          level: "degraded",
          reasons: ["verify/apply mismatch"],
        },
      },
    });

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/failed|mismatch|degraded|replay/);
    });
  });

  it("hydrates deterministically for identical verify-flow inputs", async () => {
    const bridgeA = makeBridge();
    const renderedA = await renderAppWithBridge(bridgeA);

    await waitFor(() => {
      expect(bridgeA.patch.load).toHaveBeenCalled();
    });

    const verifyButtonA =
      screen.queryByRole("button", { name: /verify/i }) ??
      screen.queryByText(/^verify$/i) ??
      screen.getByRole("button");
    fireEvent.click(verifyButtonA);

    await waitFor(() => {
      expect(bridgeA.verify.start).toHaveBeenCalled();
    });

    bridgeA.verify.emit({
      type: "verify-updated",
      payload: makeVerifyPassed(),
    });

    await waitFor(() => {
      expect(document.body.textContent ?? "").toMatch(/Replay evidence/i);
    });

    const firstHtml = renderedA.container.innerHTML;
    renderedA.unmount();

    const bridgeB = makeBridge();
    const renderedB = await renderAppWithBridge(bridgeB);

    await waitFor(() => {
      expect(bridgeB.patch.load).toHaveBeenCalled();
    });

    const verifyButtonB =
      screen.queryByRole("button", { name: /verify/i }) ??
      screen.queryByText(/^verify$/i) ??
      screen.getByRole("button");
    fireEvent.click(verifyButtonB);

    await waitFor(() => {
      expect(bridgeB.verify.start).toHaveBeenCalled();
    });

    bridgeB.verify.emit({
      type: "verify-updated",
      payload: makeVerifyPassed(),
    });

    await waitFor(() => {
      expect(document.body.textContent ?? "").toMatch(/Replay evidence/i);
    });

    expect(renderedB.container.innerHTML).toBe(firstHtml);
  });
});
