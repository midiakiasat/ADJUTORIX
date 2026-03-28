import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * ADJUTORIX APP — TESTS / RENDERER / ledger_panel.test.tsx
 *
 * Canonical ledger-panel renderer contract suite.
 *
 * Purpose:
 * - verify that LedgerPanel preserves governed ledger truth around transaction order,
 *   selected entry identity, causal/replay/approval edges, patch/job/verify provenance,
 *   rollback visibility, and explicit navigation/open/reveal actions
 * - verify that ledger rendering remains a projection of canonical transaction history rather than
 *   a generic chronological feed with lost lineage semantics
 * - verify that empty, loading, degraded, replayable, and blocked states remain explicit
 *
 * Test philosophy:
 * - no snapshots
 * - assert operator-visible structure, lineage semantics, and callback routing
 * - prefer transaction and edge contracts over implementation details
 *
 * Notes:
 * - this suite assumes LedgerPanel exports a default React component from the renderer tree
 * - if the production prop surface evolves, update buildProps() first
 */

import LedgerPanel from "../../../src/renderer/components/LedgerPanel";

type LedgerPanelProps = React.ComponentProps<typeof LedgerPanel>;

function buildProps(overrides: Partial<LedgerPanelProps> = {}): LedgerPanelProps {
  return {
    title: "Ledger",
    subtitle: "Governed transaction, lineage, and replay surface",
    loading: false,
    health: "healthy",
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
      {
        seq: 15,
        id: "entry-15",
        type: "patch-proposed",
        status: "succeeded",
        title: "Patch proposed",
        summary: "Patch patch-42 proposed for renderer shell refactor.",
        createdAtMs: 1711000000000,
        references: {
          patchId: "patch-42",
          requestId: "req-15",
        },
      },
      {
        seq: 16,
        id: "entry-16",
        type: "verify-started",
        status: "succeeded",
        title: "Verify started",
        summary: "Verification verify-42 started for patch-42.",
        createdAtMs: 1711000001000,
        references: {
          verifyId: "verify-42",
          patchId: "patch-42",
          jobId: "job-verify-42",
        },
      },
      {
        seq: 17,
        id: "entry-17",
        type: "verify-finished",
        status: "failed",
        title: "Verify finished",
        summary: "Replay mismatch detected during verify completion.",
        createdAtMs: 1711000002000,
        references: {
          verifyId: "verify-42",
          patchId: "patch-42",
          jobId: "job-verify-42",
        },
      },
      {
        seq: 18,
        id: "entry-18",
        type: "rollback-requested",
        status: "pending",
        title: "Rollback requested",
        summary: "Rollback candidate requested after failed replay evidence.",
        createdAtMs: 1711000003000,
        references: {
          verifyId: "verify-42",
          patchId: "patch-42",
          requestId: "rollback-18",
        },
      },
      {
        seq: 19,
        id: "entry-19",
        type: "approval-recorded",
        status: "succeeded",
        title: "Approval recorded",
        summary: "Restricted approval recorded for non-apply remediation branch.",
        createdAtMs: 1711000004000,
        references: {
          approvalId: "approval-19",
          patchId: "patch-42",
        },
      },
    ],
    edges: [
      {
        id: "edge-15-16",
        fromSeq: 15,
        toSeq: 16,
        type: "caused-by",
      },
      {
        id: "edge-16-17",
        fromSeq: 16,
        toSeq: 17,
        type: "verifies",
      },
      {
        id: "edge-17-18",
        fromSeq: 17,
        toSeq: 18,
        type: "rolls-back",
      },
      {
        id: "edge-18-19",
        fromSeq: 18,
        toSeq: 19,
        type: "approves",
      },
    ],
    notes: [
      "Ledger remains replayable, but failed verify evidence blocks direct apply continuity.",
      "Rollback lineage remains visible and must not be collapsed into generic status history.",
    ],
    canSelectEntry: true,
    canOpenEntry: true,
    canRevealEntry: true,
    canRefresh: true,
    onSelectEntry: vi.fn(),
    onOpenEntryRequested: vi.fn(),
    onRevealEntryRequested: vi.fn(),
    onRefreshRequested: vi.fn(),
    ...overrides,
  } as LedgerPanelProps;
}

describe("LedgerPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the canonical ledger shell with title, subtitle, ledger identity, and transaction entries", () => {
    render(<LedgerPanel {...buildProps()} />);

    expect(screen.getByText(/Ledger/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed transaction, lineage, and replay surface/i)).toBeInTheDocument();
    expect(screen.getByText(/ledger-42/i)).toBeInTheDocument();
    expect(screen.getByText(/Patch proposed/i)).toBeInTheDocument();
    expect(screen.getByText(/Verify started/i)).toBeInTheDocument();
    expect(screen.getByText(/Verify finished/i)).toBeInTheDocument();
    expect(screen.getByText(/Rollback requested/i)).toBeInTheDocument();
    expect(screen.getByText(/Approval recorded/i)).toBeInTheDocument();
  });

  it("surfaces transaction order explicitly through sequence identity instead of flattening chronology", () => {
    render(<LedgerPanel {...buildProps()} />);

    expect(screen.getByText(/15/i)).toBeInTheDocument();
    expect(screen.getByText(/16/i)).toBeInTheDocument();
    expect(screen.getByText(/17/i)).toBeInTheDocument();
    expect(screen.getByText(/18/i)).toBeInTheDocument();
    expect(screen.getByText(/19/i)).toBeInTheDocument();
  });

  it("surfaces entry statuses explicitly so succeeded, failed, and pending remain distinct", () => {
    render(<LedgerPanel {...buildProps()} />);

    expect(screen.getByText(/succeeded/i)).toBeInTheDocument();
    expect(screen.getByText(/failed/i)).toBeInTheDocument();
    expect(screen.getByText(/pending/i)).toBeInTheDocument();
  });

  it("surfaces lineage edges explicitly so causal, verify, rollback, and approval relationships remain visible", () => {
    render(<LedgerPanel {...buildProps()} />);

    expect(screen.getByText(/caused-by/i)).toBeInTheDocument();
    expect(screen.getByText(/verifies/i)).toBeInTheDocument();
    expect(screen.getByText(/rolls-back/i)).toBeInTheDocument();
    expect(screen.getByText(/approves/i)).toBeInTheDocument();
  });

  it("surfaces provenance references explicitly for patch, verify, job, approval, and request linkage", () => {
    render(<LedgerPanel {...buildProps()} />);

    expect(screen.getAllByText(/patch-42/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/verify-42/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/job-verify-42/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/approval-19/i)).toBeInTheDocument();
    expect(screen.getByText(/rollback-18/i)).toBeInTheDocument();
  });

  it("surfaces replayable posture explicitly instead of hiding replay relevance in summary only", () => {
    render(<LedgerPanel {...buildProps()} />);

    expect(screen.getByText(/replayable/i)).toBeInTheDocument();
  });

  it("surfaces ledger notes explicitly so rollback and replay constraints remain operator-visible", () => {
    render(<LedgerPanel {...buildProps()} />);

    expect(screen.getByText(/Ledger remains replayable, but failed verify evidence blocks direct apply continuity/i)).toBeInTheDocument();
    expect(screen.getByText(/Rollback lineage remains visible and must not be collapsed into generic status history/i)).toBeInTheDocument();
  });

  it("wires entry selection to the explicit callback instead of silently mutating local focus", () => {
    const props = buildProps();
    render(<LedgerPanel {...props} />);

    fireEvent.click(screen.getByText(/Approval recorded/i));

    expect(props.onSelectEntry).toHaveBeenCalledTimes(1);
    expect(props.onSelectEntry).toHaveBeenCalledWith(19);
  });

  it("wires open, reveal, and refresh actions explicitly", () => {
    const props = buildProps();
    render(<LedgerPanel {...props} />);

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

    expect(props.onOpenEntryRequested).toHaveBeenCalled();
    expect(props.onRevealEntryRequested).toHaveBeenCalled();
    expect(props.onRefreshRequested).toHaveBeenCalled();
  });

  it("does not advertise open or reveal actions as enabled when capability gates are closed", () => {
    render(
      <LedgerPanel
        {...buildProps({
          canOpenEntry: false,
          canRevealEntry: false,
        })}
      />,
    );

    const buttons = screen.getAllByRole("button");
    const openButton = buttons.find((button) => /open/i.test(button.textContent ?? ""));
    const revealButton = buttons.find((button) => /reveal/i.test(button.textContent ?? ""));

    expect(openButton).toBeDisabled();
    expect(revealButton).toBeDisabled();
  });

  it("surfaces degraded health posture explicitly instead of assuming ledger integrity", () => {
    render(
      <LedgerPanel
        {...buildProps({
          health: "degraded",
        })}
      />,
    );

    expect(screen.getByText(/degraded/i)).toBeInTheDocument();
  });

  it("keeps metrics operator-visible as facts about entries, edges, failures, pending state, replay, and rollback", () => {
    render(<LedgerPanel {...buildProps()} />);

    expect(screen.getByText(/total/i)).toBeInTheDocument();
    expect(screen.getByText(/edges/i)).toBeInTheDocument();
    expect(screen.getByText(/pending/i)).toBeInTheDocument();
    expect(screen.getByText(/failed/i)).toBeInTheDocument();
    expect(screen.getByText(/replay/i)).toBeInTheDocument();
    expect(screen.getByText(/rollback/i)).toBeInTheDocument();
  });

  it("supports non-replayable posture explicitly when replay continuity is unavailable", () => {
    render(
      <LedgerPanel
        {...buildProps({
          replayable: false,
          notes: ["Replay continuity is unavailable because ledger edge reconstruction failed."],
        })}
      />,
    );

    expect(screen.getByText(/Replay continuity is unavailable because ledger edge reconstruction failed/i)).toBeInTheDocument();
  });

  it("renders empty ledger posture explicitly when no entries exist yet", () => {
    render(
      <LedgerPanel
        {...buildProps({
          entries: [],
          edges: [],
          selectedSeq: null,
          headSeq: 0,
          notes: ["No ledger entries have been recorded yet."],
          metrics: {
            totalEntries: 0,
            totalEdges: 0,
            pendingEntries: 0,
            failedEntries: 0,
            replayEdges: 0,
            rollbackEdges: 0,
          },
        })}
      />,
    );

    expect(screen.getByText(/No ledger entries have been recorded yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/Patch proposed/i)).not.toBeInTheDocument();
  });

  it("renders loading posture explicitly without dropping the ledger shell contract", () => {
    render(
      <LedgerPanel
        {...buildProps({
          loading: true,
        })}
      />,
    );

    expect(screen.getByText(/Ledger/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed transaction, lineage, and replay surface/i)).toBeInTheDocument();
  });

  it("does not collapse the ledger shell into only a chronological list; notes, metrics, edges, and controls remain distinct", () => {
    render(<LedgerPanel {...buildProps()} />);

    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText(/caused-by/i)).toBeInTheDocument();
    expect(screen.getByText(/Ledger remains replayable/i)).toBeInTheDocument();
    expect(screen.getByText(/Approval recorded/i)).toBeInTheDocument();
  });

  it("supports selecting a failed verification entry explicitly through the same governed callback path", () => {
    const props = buildProps();
    render(<LedgerPanel {...props} />);

    fireEvent.click(screen.getByText(/Verify finished/i));
    expect(props.onSelectEntry).toHaveBeenCalledWith(17);
  });
});
