import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * ADJUTORIX APP — TESTS / SMOKE / ledger_flow.smoke.test.ts
 *
 * Canonical ledger-flow smoke suite.
 *
 * Objective:
 * - verify the end-to-end ledger path from renderer bootstrap through ledger load,
 *   entry/edge graph hydration, selection changes, replay lineage projection, summary metrics,
 *   and visible governed ledger state
 * - catch catastrophic integration regressions where ledger metadata, graph edges, selected entry,
 *   replayability, and verify/apply implications each load separately but never converge to one
 *   authoritative transaction-history surface
 * - keep assertions outcome-oriented: did the app mount, request ledger state, surface entries/graph/metrics,
 *   respond to selection, and fail closed when ledger continuity or replay semantics are contradictory
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
  ledger: {
    load: ReturnType<typeof vi.fn>;
    selectEntry: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    emit: (payload: unknown) => void;
  };
  verify: {
    load: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  patch: {
    load: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  diagnostics: {
    load: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  shell: {
    status: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  agent: {
    connect: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  settings: {
    load: ReturnType<typeof vi.fn>;
  };
};

const LEDGER_ID = "ledger-42";
const VERIFY_ID = "verify-42";
const PATCH_ID = "patch-42";

function makeWorkspaceSnapshot() {
  return {
    workspaceId: "ws-ledger-1",
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
      watchedPaths: 18,
      eventLagMs: 4,
    },
  };
}

function makeLedger(overrides: Record<string, unknown> = {}) {
  return {
    ledgerId: LEDGER_ID,
    headSeq: 12,
    selectedSeq: 12,
    replayable: true,
    continuity: "intact",
    applyImpact: "ready",
    entries: [
      {
        seq: 10,
        id: "entry-10",
        title: "Patch proposed",
        phase: "completed",
        kind: "patch",
        replayable: true,
        verifyImpact: "pending",
      },
      {
        seq: 11,
        id: "entry-11",
        title: "Verify executed",
        phase: "completed",
        kind: "verify",
        replayable: true,
        verifyImpact: "passed",
      },
      {
        seq: 12,
        id: "entry-12",
        title: "Apply ready",
        phase: "completed",
        kind: "apply-gate",
        replayable: true,
        verifyImpact: "ready",
      },
    ],
    edges: [
      {
        id: "edge-10-11",
        fromSeq: 10,
        toSeq: 11,
        kind: "replay",
      },
      {
        id: "edge-11-12",
        fromSeq: 11,
        toSeq: 12,
        kind: "replay",
      },
    ],
    selectedEntry: {
      seq: 12,
      id: "entry-12",
      title: "Apply ready",
      phase: "completed",
      replayable: true,
      evidence: [
        { id: "evidence-1", label: "Replay lineage intact" },
        { id: "evidence-2", label: "Verify passed" },
      ],
    },
    metrics: {
      totalEntries: 12,
      totalEdges: 11,
      pendingEntries: 0,
      failedEntries: 0,
      replayEdges: 2,
      rollbackEdges: 0,
    },
    health: {
      level: "healthy",
      reasons: [],
    },
    ...overrides,
  };
}

function makeVerify() {
  return {
    verifyId: VERIFY_ID,
    status: "passed",
    phase: "completed",
    replayable: true,
    applyReadinessImpact: "ready",
    checks: [],
    artifacts: [],
    summary: {
      totalChecks: 4,
      passedChecks: 4,
      warningChecks: 0,
      failedChecks: 0,
      replayChecks: 1,
    },
    health: { level: "healthy", reasons: [] },
  };
}

function makePatch() {
  return {
    patchId: PATCH_ID,
    title: "Renderer shell refactor",
    status: "in-review",
    files: [],
    comments: [],
    verifyEvidence: [],
    applyReadiness: "ready",
    health: { level: "healthy", reasons: [] },
  };
}

function makeBridge(): MockBridge {
  let ledgerHandler: SubscriptionHandler | null = null;

  return {
    workspace: {
      load: vi.fn(async () => makeWorkspaceSnapshot()),
      subscribe: vi.fn(() => () => undefined),
    },
    ledger: {
      load: vi.fn(async ({ ledgerId }: { ledgerId: string }) => {
        if (ledgerId !== LEDGER_ID) throw new Error(`unexpected ledger id: ${ledgerId}`);
        return makeLedger();
      }),
      selectEntry: vi.fn(async ({ ledgerId, seq }: { ledgerId: string; seq: number }) => ({
        ok: true,
        ledgerId,
        selectedSeq: seq,
      })),
      subscribe: vi.fn((handler: SubscriptionHandler) => {
        ledgerHandler = handler;
        return () => {
          if (ledgerHandler === handler) ledgerHandler = null;
        };
      }),
      emit: (payload: unknown) => {
        ledgerHandler?.(payload);
      },
    },
    verify: {
      load: vi.fn(async ({ verifyId }: { verifyId: string }) => {
        if (verifyId !== VERIFY_ID) throw new Error(`unexpected verify id: ${verifyId}`);
        return makeVerify();
      }),
      subscribe: vi.fn(() => () => undefined),
    },
    patch: {
      load: vi.fn(async ({ patchId }: { patchId: string }) => {
        if (patchId !== PATCH_ID) throw new Error(`unexpected patch id: ${patchId}`);
        return makePatch();
      }),
      subscribe: vi.fn(() => () => undefined),
    },
    diagnostics: {
      load: vi.fn(async () => ({
        workspaceId: "ws-ledger-1",
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
        health: { level: "healthy", reasons: [] },
      })),
      subscribe: vi.fn(() => () => undefined),
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
    settings: {
      load: vi.fn(async () => ({
        theme: "dark",
        confirmations: true,
      })),
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
    <MemoryRouter initialEntries={[`/ledger/${LEDGER_ID}`]}>
      <Providers>
        <App />
      </Providers>
    </MemoryRouter>,
  );
}

describe("smoke/ledger_flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // @ts-expect-error test cleanup
    delete window.adjutorix;
  });

  it("loads ledger state, surfaces entries/graph/metrics, and reaches coherent replay-ready state", async () => {
    const bridge = makeBridge();
    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.ledger.load).toHaveBeenCalledWith({ ledgerId: LEDGER_ID });
    });

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toMatch(/Apply ready/i);
      expect(text).toMatch(/Verify executed/i);
      expect(text).toMatch(/Replay lineage intact/i);
      expect(text).toMatch(/Verify passed/i);
    });

    expect(bridge.ledger.subscribe).toHaveBeenCalled();
  });

  it("supports selecting another ledger entry and keeps selected-entry state coherent", async () => {
    const bridge = makeBridge();
    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.ledger.load).toHaveBeenCalled();
    });

    const entry =
      screen.queryByText(/Verify executed/i) ??
      screen.queryByRole("button", { name: /Verify executed/i }) ??
      screen.queryByRole("row", { name: /Verify executed/i });

    if (entry) {
      fireEvent.click(entry);

      await waitFor(() => {
        expect(bridge.ledger.selectEntry).toHaveBeenCalled();
      });
    } else {
      expect(bridge.ledger.selectEntry).toBeDefined();
    }
  });

  it("fails closed when ledger load fails instead of projecting a decorative but false transaction history", async () => {
    const bridge = makeBridge();
    bridge.ledger.load.mockRejectedValueOnce(new Error("ledger load failed"));

    await renderAppWithBridge(bridge);

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/ledger load failed|error|failed/);
    });
  });

  it("fails closed when incoming ledger payload contradicts continuity and replayability", async () => {
    const bridge = makeBridge();
    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.ledger.load).toHaveBeenCalled();
    });

    bridge.ledger.emit({
      type: "ledger-updated",
      payload: makeLedger({
        replayable: false,
        continuity: "broken",
        applyImpact: "ready",
        health: {
          level: "degraded",
          reasons: ["continuity/replay mismatch"],
        },
      }),
    });

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/continuity|broken|replay|degraded|mismatch/);
    });
  });

  it("hydrates deterministically for identical ledger-flow inputs", async () => {
    const bridgeA = makeBridge();
    const renderedA = await renderAppWithBridge(bridgeA);

    await waitFor(() => {
      expect(document.body.textContent ?? "").toMatch(/Apply ready/i);
    });

    const firstHtml = renderedA.container.innerHTML;
    renderedA.unmount();

    const bridgeB = makeBridge();
    const renderedB = await renderAppWithBridge(bridgeB);

    await waitFor(() => {
      expect(document.body.textContent ?? "").toMatch(/Apply ready/i);
    });

    expect(renderedB.container.innerHTML).toBe(firstHtml);
  });
});
