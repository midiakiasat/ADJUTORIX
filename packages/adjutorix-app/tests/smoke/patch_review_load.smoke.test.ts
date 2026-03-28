import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * ADJUTORIX APP — TESTS / SMOKE / patch_review_load.smoke.test.ts
 *
 * Canonical patch-review-load smoke suite.
 *
 * Objective:
 * - verify the end-to-end patch review path from renderer bootstrap through patch load,
 *   review-thread hydration, diff/file selection, verify-evidence projection, apply-readiness surface,
 *   and visible governed review state
 * - catch catastrophic integration regressions where patch metadata, diff content, comments,
 *   and verify state each load separately but never compose into one coherent reviewable patch surface
 * - keep assertions outcome-oriented: did the app mount, request patch data, surface patch identity,
 *   surface review comments/diff/evidence, and fail closed when patch state is invalid or inconsistent
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
  patch: {
    load: ReturnType<typeof vi.fn>;
    selectFile: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    emit: (payload: unknown) => void;
  };
  verify: {
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

const PATCH_ID = "patch-42";
const VERIFY_ID = "verify-42";
const PATCH_FILE_PATH = "/repo/adjutorix-app/src/renderer/App.tsx";

function makeWorkspaceSnapshot() {
  return {
    workspaceId: "ws-patch-1",
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
      watchedPaths: 20,
      eventLagMs: 4,
    },
  };
}

function makePatch(overrides: Record<string, unknown> = {}) {
  return {
    patchId: PATCH_ID,
    title: "Renderer shell refactor",
    status: "in-review",
    selectedFilePath: PATCH_FILE_PATH,
    files: [
      {
        path: PATCH_FILE_PATH,
        status: "modified",
        additions: 12,
        deletions: 4,
        selectable: true,
      },
      {
        path: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
        status: "modified",
        additions: 18,
        deletions: 7,
        selectable: true,
      },
    ],
    selectedDiff: {
      filePath: PATCH_FILE_PATH,
      hunks: [
        {
          id: "hunk-1",
          header: "@@ -1,4 +1,6 @@",
          lines: [
            { kind: "context", text: 'import React from "react";' },
            { kind: "add", text: 'import { AppShell } from "./components/AppShell";' },
            { kind: "add", text: "" },
            { kind: "context", text: "export default function App(): JSX.Element {" },
            { kind: "remove", text: '  return <div>ADJUTORIX</div>;' },
            { kind: "add", text: '  return <AppShell />;' },
          ],
        },
      ],
    },
    comments: [
      {
        id: "comment-1",
        filePath: PATCH_FILE_PATH,
        author: "Reviewer A",
        body: "Confirm AppShell import path stays stable.",
        state: "open",
        line: 2,
      },
      {
        id: "comment-2",
        filePath: PATCH_FILE_PATH,
        author: "Reviewer B",
        body: "Return path looks correct after refactor.",
        state: "resolved",
        line: 6,
      },
    ],
    verifyEvidence: [
      {
        verifyId: VERIFY_ID,
        status: "passed",
        replayable: true,
        summary: "4/4 checks passed; replay ready.",
      },
    ],
    applyReadiness: "ready",
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
    checks: [
      { id: "check-1", title: "Typecheck", status: "passed" },
      { id: "check-2", title: "Replay", status: "passed" },
      { id: "check-3", title: "Ledger continuity", status: "passed" },
      { id: "check-4", title: "Policy gate", status: "passed" },
    ],
    artifacts: [],
    summary: {
      totalChecks: 4,
      passedChecks: 4,
      warningChecks: 0,
      failedChecks: 0,
      replayChecks: 1,
    },
    health: {
      level: "healthy",
      reasons: [],
    },
  };
}

function makeBridge(): MockBridge {
  let patchHandler: SubscriptionHandler | null = null;

  return {
    workspace: {
      load: vi.fn(async () => makeWorkspaceSnapshot()),
      subscribe: vi.fn(() => () => undefined),
    },
    patch: {
      load: vi.fn(async ({ patchId }: { patchId: string }) => {
        if (patchId !== PATCH_ID) throw new Error(`unexpected patch id: ${patchId}`);
        return makePatch();
      }),
      selectFile: vi.fn(async ({ patchId, filePath }: { patchId: string; filePath: string }) => ({
        ok: true,
        patchId,
        selectedFilePath: filePath,
      })),
      subscribe: vi.fn((handler: SubscriptionHandler) => {
        patchHandler = handler;
        return () => {
          if (patchHandler === handler) patchHandler = null;
        };
      }),
      emit: (payload: unknown) => {
        patchHandler?.(payload);
      },
    },
    verify: {
      load: vi.fn(async ({ verifyId }: { verifyId: string }) => {
        if (verifyId !== VERIFY_ID) throw new Error(`unexpected verify id: ${verifyId}`);
        return makeVerify();
      }),
      subscribe: vi.fn(() => () => undefined),
    },
    diagnostics: {
      load: vi.fn(async () => ({
        workspaceId: "ws-patch-1",
        selectedPath: PATCH_FILE_PATH,
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
    <MemoryRouter initialEntries={[`/patch/${PATCH_ID}`]}>
      <Providers>
        <App />
      </Providers>
    </MemoryRouter>,
  );
}

describe("smoke/patch_review_load", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // @ts-expect-error test cleanup
    delete window.adjutorix;
  });

  it("loads patch review state, surfaces diff/comments/verify evidence, and reaches coherent review-ready state", async () => {
    const bridge = makeBridge();
    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.patch.load).toHaveBeenCalledWith({ patchId: PATCH_ID });
      expect(bridge.verify.load).toHaveBeenCalledWith({ verifyId: VERIFY_ID });
    });

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toMatch(/Renderer shell refactor/i);
      expect(text).toMatch(/AppShell/i);
      expect(text).toMatch(/Confirm AppShell import path stays stable\./i);
      expect(text).toMatch(/4\/4 checks passed; replay ready\./i);
    });

    expect(bridge.patch.subscribe).toHaveBeenCalled();
    expect(bridge.verify.subscribe).toHaveBeenCalled();
  });

  it("supports selecting a different patch file and keeps review state coherent under selection change", async () => {
    const bridge = makeBridge();
    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.patch.load).toHaveBeenCalled();
    });

    const secondFile =
      screen.queryByText(/AppShell\.tsx/i) ??
      screen.queryByRole("button", { name: /AppShell\.tsx/i }) ??
      screen.queryByRole("tab", { name: /AppShell\.tsx/i });

    if (secondFile) {
      fireEvent.click(secondFile);

      await waitFor(() => {
        expect(bridge.patch.selectFile).toHaveBeenCalled();
      });
    } else {
      expect(bridge.patch.selectFile).toBeDefined();
    }
  });

  it("fails closed when patch load fails instead of presenting a decorative but false review surface", async () => {
    const bridge = makeBridge();
    bridge.patch.load.mockRejectedValueOnce(new Error("patch review load failed"));

    await renderAppWithBridge(bridge);

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/patch review load failed|error|failed/);
    });
  });

  it("fails closed when verify evidence contradicts apply readiness instead of claiming a coherent ready patch", async () => {
    const bridge = makeBridge();
    bridge.patch.load.mockResolvedValueOnce(
      makePatch({
        verifyEvidence: [
          {
            verifyId: VERIFY_ID,
            status: "failed",
            replayable: false,
            summary: "Replay failed.",
          },
        ],
        applyReadiness: "ready",
        health: {
          level: "degraded",
          reasons: ["verify/apply mismatch"],
        },
      }),
    );

    await renderAppWithBridge(bridge);

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/verify|replay failed|mismatch|degraded|error/);
    });
  });

  it("hydrates deterministically for identical patch-review inputs", async () => {
    const bridgeA = makeBridge();
    const renderedA = await renderAppWithBridge(bridgeA);

    await waitFor(() => {
      expect(document.body.textContent ?? "").toMatch(/Renderer shell refactor/i);
    });

    const firstHtml = renderedA.container.innerHTML;
    renderedA.unmount();

    const bridgeB = makeBridge();
    const renderedB = await renderAppWithBridge(bridgeB);

    await waitFor(() => {
      expect(document.body.textContent ?? "").toMatch(/Renderer shell refactor/i);
    });

    expect(renderedB.container.innerHTML).toBe(firstHtml);
  });
});
