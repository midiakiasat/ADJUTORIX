import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * ADJUTORIX APP — TESTS / RENDERER / transaction_graph_panel.test.tsx
 *
 * Canonical transaction-graph panel renderer contract suite.
 *
 * Purpose:
 * - verify that TransactionGraphPanel preserves governed topology truth around transaction nodes,
 *   typed edges, selected lineage, replay and rollback branches, blocked/apply states,
 *   and explicit navigation/open/reveal actions
 * - verify that the graph remains a projection of canonical ledger structure rather than a decorative diagram
 * - verify that loading, empty, degraded, and filtered/selected states remain explicit and operator-visible
 *
 * Test philosophy:
 * - no snapshots
 * - assert operator-visible graph semantics, topology labels, and callback routing
 * - prefer node/edge lineage contracts over implementation details or rendering library specifics
 *
 * Notes:
 * - this suite assumes TransactionGraphPanel exports a default React component from the renderer tree
 * - if the production prop surface evolves, update buildProps() first
 */

import TransactionGraphPanel from "../../../src/renderer/components/TransactionGraphPanel";

type TransactionGraphPanelProps = React.ComponentProps<typeof TransactionGraphPanel>;

function buildProps(overrides: Partial<TransactionGraphPanelProps> = {}): TransactionGraphPanelProps {
  return {
    title: "Transaction graph",
    subtitle: "Governed topology, lineage, replay, and rollback graph surface",
    loading: false,
    health: "healthy",
    ledgerId: "ledger-42",
    selectedNodeId: "node-18",
    selectedEdgeId: "edge-17-18",
    replayable: true,
    graphMode: "lineage",
    nodes: [
      {
        id: "node-15",
        seq: 15,
        label: "Patch proposed",
        kind: "patch-proposed",
        status: "succeeded",
        patchId: "patch-42",
        x: 120,
        y: 80,
      },
      {
        id: "node-16",
        seq: 16,
        label: "Verify started",
        kind: "verify-started",
        status: "succeeded",
        verifyId: "verify-42",
        jobId: "job-verify-42",
        x: 320,
        y: 80,
      },
      {
        id: "node-17",
        seq: 17,
        label: "Verify failed",
        kind: "verify-finished",
        status: "failed",
        verifyId: "verify-42",
        jobId: "job-verify-42",
        x: 520,
        y: 80,
      },
      {
        id: "node-18",
        seq: 18,
        label: "Rollback requested",
        kind: "rollback-requested",
        status: "pending",
        patchId: "patch-42",
        x: 520,
        y: 250,
      },
      {
        id: "node-19",
        seq: 19,
        label: "Approval recorded",
        kind: "approval-recorded",
        status: "succeeded",
        approvalId: "approval-19",
        patchId: "patch-42",
        x: 720,
        y: 250,
      },
    ],
    edges: [
      {
        id: "edge-15-16",
        fromNodeId: "node-15",
        toNodeId: "node-16",
        type: "caused-by",
        status: "active",
      },
      {
        id: "edge-16-17",
        fromNodeId: "node-16",
        toNodeId: "node-17",
        type: "verifies",
        status: "active",
      },
      {
        id: "edge-17-18",
        fromNodeId: "node-17",
        toNodeId: "node-18",
        type: "rolls-back",
        status: "blocked",
      },
      {
        id: "edge-18-19",
        fromNodeId: "node-18",
        toNodeId: "node-19",
        type: "approves",
        status: "active",
      },
    ],
    metrics: {
      totalNodes: 5,
      totalEdges: 4,
      failedNodes: 1,
      pendingNodes: 1,
      replayEdges: 1,
      rollbackEdges: 1,
    },
    notes: [
      "Graph remains replayable, but failed verification branches block direct apply continuity.",
      "Rollback lineage must remain visible as a typed branch, not a generic chronological continuation.",
    ],
    canSelectNode: true,
    canSelectEdge: true,
    canOpenNode: true,
    canRevealNode: true,
    canRefresh: true,
    onSelectNode: vi.fn(),
    onSelectEdge: vi.fn(),
    onOpenNodeRequested: vi.fn(),
    onRevealNodeRequested: vi.fn(),
    onRefreshRequested: vi.fn(),
    ...overrides,
  } as TransactionGraphPanelProps;
}

describe("TransactionGraphPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the canonical graph shell with title, subtitle, ledger identity, nodes, and edges", () => {
    render(<TransactionGraphPanel {...buildProps()} />);

    expect(screen.getByText(/Transaction graph/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed topology, lineage, replay, and rollback graph surface/i)).toBeInTheDocument();
    expect(screen.getByText(/ledger-42/i)).toBeInTheDocument();
    expect(screen.getByText(/Patch proposed/i)).toBeInTheDocument();
    expect(screen.getByText(/Verify started/i)).toBeInTheDocument();
    expect(screen.getByText(/Verify failed/i)).toBeInTheDocument();
    expect(screen.getByText(/Rollback requested/i)).toBeInTheDocument();
    expect(screen.getByText(/Approval recorded/i)).toBeInTheDocument();
  });

  it("surfaces node statuses explicitly so succeeded, failed, and pending remain distinct in topology", () => {
    render(<TransactionGraphPanel {...buildProps()} />);

    expect(screen.getByText(/succeeded/i)).toBeInTheDocument();
    expect(screen.getByText(/failed/i)).toBeInTheDocument();
    expect(screen.getByText(/pending/i)).toBeInTheDocument();
  });

  it("surfaces typed edges explicitly so causal, verify, rollback, and approval semantics do not collapse", () => {
    render(<TransactionGraphPanel {...buildProps()} />);

    expect(screen.getByText(/caused-by/i)).toBeInTheDocument();
    expect(screen.getByText(/verifies/i)).toBeInTheDocument();
    expect(screen.getByText(/rolls-back/i)).toBeInTheDocument();
    expect(screen.getByText(/approves/i)).toBeInTheDocument();
  });

  it("surfaces selected node and edge identity explicitly instead of hiding focus inside graph rendering internals", () => {
    render(<TransactionGraphPanel {...buildProps()} />);

    expect(screen.getByText(/node-18/i)).toBeInTheDocument();
    expect(screen.getByText(/edge-17-18/i)).toBeInTheDocument();
  });

  it("surfaces replayable posture explicitly instead of hiding replay relevance behind generic graph mode", () => {
    render(<TransactionGraphPanel {...buildProps()} />);

    expect(screen.getByText(/replayable/i)).toBeInTheDocument();
  });

  it("surfaces graph notes explicitly so replay blockage and rollback lineage remain operator-visible", () => {
    render(<TransactionGraphPanel {...buildProps()} />);

    expect(screen.getByText(/Graph remains replayable, but failed verification branches block direct apply continuity/i)).toBeInTheDocument();
    expect(screen.getByText(/Rollback lineage must remain visible as a typed branch/i)).toBeInTheDocument();
  });

  it("wires node selection to the explicit callback instead of silently mutating local graph focus", () => {
    const props = buildProps();
    render(<TransactionGraphPanel {...props} />);

    fireEvent.click(screen.getByText(/Approval recorded/i));

    expect(props.onSelectNode).toHaveBeenCalledTimes(1);
    expect(props.onSelectNode).toHaveBeenCalledWith("node-19");
  });

  it("wires edge selection to the explicit callback", () => {
    const props = buildProps();
    render(<TransactionGraphPanel {...props} />);

    fireEvent.click(screen.getByText(/rolls-back/i));

    expect(props.onSelectEdge).toHaveBeenCalledTimes(1);
    expect(props.onSelectEdge).toHaveBeenCalledWith("edge-17-18");
  });

  it("wires open, reveal, and refresh actions explicitly", () => {
    const props = buildProps();
    render(<TransactionGraphPanel {...props} />);

    const buttons = screen.getAllByRole("button");
    const openButton = buttons.find((button) => /open/i.test(button.textContent ?? ""));
    const revealButton = buttons.find((button) => /reveal/i.test(button.textContent ?? ""));
    const refreshButton = buttons.find((button) => /refresh/i.test(button.textContent ?? ""));

    expect(openButton).toBeDefined();
    expect(revealButton).toBeDefined();
    expect(refreshButton).toBeDefined();

    fireEvent.click(openButton!);
    fireEvent.click(revealButton!);
    fireEvent.click(refreshButton!);

    expect(props.onOpenNodeRequested).toHaveBeenCalled();
    expect(props.onRevealNodeRequested).toHaveBeenCalled();
    expect(props.onRefreshRequested).toHaveBeenCalled();
  });

  it("does not advertise open or reveal actions as enabled when capability gates are closed", () => {
    render(
      <TransactionGraphPanel
        {...buildProps({
          canOpenNode: false,
          canRevealNode: false,
        })}
      />,
    );

    const buttons = screen.getAllByRole("button");
    const openButton = buttons.find((button) => /open/i.test(button.textContent ?? ""));
    const revealButton = buttons.find((button) => /reveal/i.test(button.textContent ?? ""));

    expect(openButton).toBeDisabled();
    expect(revealButton).toBeDisabled();
  });

  it("surfaces blocked branch semantics explicitly instead of drawing all edges as equivalent transitions", () => {
    render(<TransactionGraphPanel {...buildProps()} />);

    expect(screen.getByText(/blocked/i)).toBeInTheDocument();
  });

  it("surfaces degraded health posture explicitly instead of assuming graph freshness", () => {
    render(
      <TransactionGraphPanel
        {...buildProps({
          health: "degraded",
        })}
      />,
    );

    expect(screen.getByText(/degraded/i)).toBeInTheDocument();
  });

  it("keeps metrics operator-visible as facts about nodes, edges, failures, pending state, replay, and rollback", () => {
    render(<TransactionGraphPanel {...buildProps()} />);

    expect(screen.getByText(/total/i)).toBeInTheDocument();
    expect(screen.getByText(/nodes/i)).toBeInTheDocument();
    expect(screen.getByText(/edges/i)).toBeInTheDocument();
    expect(screen.getByText(/failed/i)).toBeInTheDocument();
    expect(screen.getByText(/pending/i)).toBeInTheDocument();
    expect(screen.getByText(/rollback/i)).toBeInTheDocument();
  });

  it("supports non-replayable posture explicitly when replay continuity is unavailable", () => {
    render(
      <TransactionGraphPanel
        {...buildProps({
          replayable: false,
          notes: ["Replay continuity is unavailable because edge reconstruction failed for the selected branch."],
        })}
      />,
    );

    expect(screen.getByText(/Replay continuity is unavailable because edge reconstruction failed/i)).toBeInTheDocument();
  });

  it("supports alternate graph modes explicitly without losing topology identity", () => {
    render(
      <TransactionGraphPanel
        {...buildProps({
          graphMode: "replay",
        })}
      />,
    );

    expect(screen.getByText(/replay/i)).toBeInTheDocument();
    expect(screen.getByText(/Verify failed/i)).toBeInTheDocument();
  });

  it("renders empty graph posture explicitly when no nodes exist yet", () => {
    render(
      <TransactionGraphPanel
        {...buildProps({
          nodes: [],
          edges: [],
          selectedNodeId: null,
          selectedEdgeId: null,
          notes: ["No transaction graph has been constructed yet."],
          metrics: {
            totalNodes: 0,
            totalEdges: 0,
            failedNodes: 0,
            pendingNodes: 0,
            replayEdges: 0,
            rollbackEdges: 0,
          },
        })}
      />,
    );

    expect(screen.getByText(/No transaction graph has been constructed yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/Patch proposed/i)).not.toBeInTheDocument();
  });

  it("renders loading posture explicitly without dropping the graph shell contract", () => {
    render(
      <TransactionGraphPanel
        {...buildProps({
          loading: true,
        })}
      />,
    );

    expect(screen.getByText(/Transaction graph/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed topology, lineage, replay, and rollback graph surface/i)).toBeInTheDocument();
  });

  it("does not collapse the graph shell into only topology labels; notes, metrics, controls, and selection remain distinct", () => {
    render(<TransactionGraphPanel {...buildProps()} />);

    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText(/caused-by/i)).toBeInTheDocument();
    expect(screen.getByText(/Graph remains replayable/i)).toBeInTheDocument();
    expect(screen.getByText(/node-18/i)).toBeInTheDocument();
  });

  it("supports selecting a failed verification node explicitly through the same governed callback path", () => {
    const props = buildProps();
    render(<TransactionGraphPanel {...props} />);

    fireEvent.click(screen.getByText(/Verify failed/i));
    expect(props.onSelectNode).toHaveBeenCalledWith("node-17");
  });
});
