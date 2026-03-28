import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * ADJUTORIX APP — TESTS / RENDERER / job_panel.test.tsx
 *
 * Canonical job-panel renderer contract suite.
 *
 * Purpose:
 * - verify that JobPanel preserves governed execution truth around job identity, queue/run/fail/success
 *   lifecycle, patch/verify/request linkage, selected-job logs, progress, cancellation/retry semantics,
 *   and explicit open/reveal actions
 * - verify that jobs remain a projection of canonical execution state rather than a generic activity feed
 * - verify that loading, empty, degraded, blocked, and mixed-status states remain explicit and operator-visible
 *
 * Test philosophy:
 * - no snapshots
 * - assert operator-visible structure, execution semantics, and callback routing
 * - prefer job lineage and state contracts over implementation details
 *
 * Notes:
 * - this suite assumes JobPanel exports a default React component from the renderer tree
 * - if the production prop surface evolves, update buildProps() first
 */

import JobPanel from "../../../src/renderer/components/JobPanel";

type JobPanelProps = React.ComponentProps<typeof JobPanel>;

function buildProps(overrides: Partial<JobPanelProps> = {}): JobPanelProps {
  return {
    title: "Jobs",
    subtitle: "Governed execution, lifecycle, and evidence surface",
    loading: false,
    health: "healthy",
    selectedJobId: "job-verify-42",
    jobs: [
      {
        id: "job-patch-40",
        title: "Prepare patch review state",
        phase: "succeeded",
        createdAtMs: 1711000000000,
        updatedAtMs: 1711000003000,
        requestId: "req-40",
        metadata: {
          patchId: "patch-40",
          queue: "local",
          progressPct: 100,
        },
      },
      {
        id: "job-verify-42",
        title: "Verify patch-42 replay and governance",
        phase: "running",
        createdAtMs: 1711000010000,
        updatedAtMs: 1711000015000,
        requestId: "req-42",
        metadata: {
          patchId: "patch-42",
          verifyId: "verify-42",
          progressPct: 68,
          queue: "verify",
        },
      },
      {
        id: "job-rollback-18",
        title: "Evaluate rollback candidate",
        phase: "failed",
        createdAtMs: 1711000020000,
        updatedAtMs: 1711000024000,
        requestId: "req-rollback-18",
        metadata: {
          patchId: "patch-42",
          verifyId: "verify-42",
          progressPct: 100,
          queue: "recovery",
        },
      },
      {
        id: "job-index-7",
        title: "Rebuild workspace index",
        phase: "queued",
        createdAtMs: 1711000030000,
        updatedAtMs: 1711000030000,
        requestId: "req-index-7",
        metadata: {
          workspaceId: "ws-7",
          queue: "index",
          progressPct: 0,
        },
      },
    ],
    selectedJob: {
      id: "job-verify-42",
      title: "Verify patch-42 replay and governance",
      phase: "running",
      createdAtMs: 1711000010000,
      updatedAtMs: 1711000015000,
      requestId: "req-42",
      metadata: {
        patchId: "patch-42",
        verifyId: "verify-42",
        progressPct: 68,
        queue: "verify",
        shellCommand: "python -m adjutorix verify --patch patch-42",
      },
    },
    logs: [
      {
        id: "log-1",
        seq: 1,
        level: "info",
        message: "Verification job accepted by scheduler.",
        createdAtMs: 1711000010100,
      },
      {
        id: "log-2",
        seq: 2,
        level: "info",
        message: "Replay determinism checks running.",
        createdAtMs: 1711000011200,
      },
      {
        id: "log-3",
        seq: 3,
        level: "warning",
        message: "Apply gate remains blocked while rejected review files exist.",
        createdAtMs: 1711000012300,
      },
    ],
    metrics: {
      totalJobs: 4,
      queuedJobs: 1,
      runningJobs: 1,
      failedJobs: 1,
      succeededJobs: 1,
      logLines: 3,
    },
    notes: [
      "Running verification remains linked to patch-42 and verify-42; job state must not drift from review and ledger surfaces.",
      "Failed recovery jobs remain visible so rollback lineage and retry intent are inspectable.",
    ],
    canSelectJob: true,
    canCancelJob: true,
    canRetryJob: true,
    canOpenJob: true,
    canRevealJob: true,
    canRefresh: true,
    onSelectJob: vi.fn(),
    onCancelJobRequested: vi.fn(),
    onRetryJobRequested: vi.fn(),
    onOpenJobRequested: vi.fn(),
    onRevealJobRequested: vi.fn(),
    onRefreshRequested: vi.fn(),
    ...overrides,
  } as JobPanelProps;
}

describe("JobPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the canonical job shell with title, subtitle, selected job, and job list", () => {
    render(<JobPanel {...buildProps()} />);

    expect(screen.getByText(/Jobs/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed execution, lifecycle, and evidence surface/i)).toBeInTheDocument();
    expect(screen.getByText(/Prepare patch review state/i)).toBeInTheDocument();
    expect(screen.getByText(/Verify patch-42 replay and governance/i)).toBeInTheDocument();
    expect(screen.getByText(/Evaluate rollback candidate/i)).toBeInTheDocument();
    expect(screen.getByText(/Rebuild workspace index/i)).toBeInTheDocument();
  });

  it("surfaces job phases explicitly so queued, running, failed, and succeeded remain distinct", () => {
    render(<JobPanel {...buildProps()} />);

    expect(screen.getByText(/queued/i)).toBeInTheDocument();
    expect(screen.getByText(/running/i)).toBeInTheDocument();
    expect(screen.getByText(/failed/i)).toBeInTheDocument();
    expect(screen.getByText(/succeeded/i)).toBeInTheDocument();
  });

  it("surfaces selected job lineage explicitly through patch, verify, request, and queue metadata", () => {
    render(<JobPanel {...buildProps()} />);

    expect(screen.getAllByText(/patch-42/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/verify-42/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/req-42/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/verify/i).length).toBeGreaterThanOrEqual(1);
  });

  it("surfaces selected-job log evidence explicitly instead of reducing jobs to status badges only", () => {
    render(<JobPanel {...buildProps()} />);

    expect(screen.getByText(/Verification job accepted by scheduler/i)).toBeInTheDocument();
    expect(screen.getByText(/Replay determinism checks running/i)).toBeInTheDocument();
    expect(screen.getByText(/Apply gate remains blocked/i)).toBeInTheDocument();
  });

  it("keeps progress-bearing job metadata operator-visible as explicit execution facts", () => {
    render(<JobPanel {...buildProps()} />);

    expect(screen.getByText(/68/i)).toBeInTheDocument();
    expect(screen.getByText(/100/i)).toBeInTheDocument();
    expect(screen.getByText(/0/i)).toBeInTheDocument();
  });

  it("surfaces notes explicitly so execution relevance to review and recovery remains visible", () => {
    render(<JobPanel {...buildProps()} />);

    expect(screen.getByText(/job state must not drift from review and ledger surfaces/i)).toBeInTheDocument();
    expect(screen.getByText(/Failed recovery jobs remain visible/i)).toBeInTheDocument();
  });

  it("wires job selection to the explicit callback instead of silently mutating local focus", () => {
    const props = buildProps();
    render(<JobPanel {...props} />);

    fireEvent.click(screen.getByText(/Evaluate rollback candidate/i));

    expect(props.onSelectJob).toHaveBeenCalledTimes(1);
    expect(props.onSelectJob).toHaveBeenCalledWith("job-rollback-18");
  });

  it("wires cancel, retry, open, reveal, and refresh actions explicitly", () => {
    const props = buildProps();
    render(<JobPanel {...props} />);

    const buttons = screen.getAllByRole("button");
    const cancelButton = buttons.find((button) => /cancel/i.test(button.textContent ?? ""));
    const retryButton = buttons.find((button) => /retry/i.test(button.textContent ?? ""));
    const openButton = buttons.find((button) => /open/i.test(button.textContent ?? ""));
    const revealButton = buttons.find((button) => /reveal/i.test(button.textContent ?? ""));
    const refreshButton = buttons.find((button) => /refresh/i.test(button.textContent ?? ""));

    expect(cancelButton).toBeDefined();
    expect(retryButton).toBeDefined();
    expect(openButton).toBeDefined();
    expect(revealButton).toBeDefined();
    expect(refreshButton).toBeDefined();

    fireEvent.click(cancelButton!);
    fireEvent.click(retryButton!);
    fireEvent.click(openButton!);
    fireEvent.click(revealButton!);
    fireEvent.click(refreshButton!);

    expect(props.onCancelJobRequested).toHaveBeenCalled();
    expect(props.onRetryJobRequested).toHaveBeenCalled();
    expect(props.onOpenJobRequested).toHaveBeenCalled();
    expect(props.onRevealJobRequested).toHaveBeenCalled();
    expect(props.onRefreshRequested).toHaveBeenCalled();
  });

  it("does not advertise cancel, retry, open, or reveal as enabled when capability gates are closed", () => {
    render(
      <JobPanel
        {...buildProps({
          canCancelJob: false,
          canRetryJob: false,
          canOpenJob: false,
          canRevealJob: false,
        })}
      />,
    );

    const buttons = screen.getAllByRole("button");
    const cancelButton = buttons.find((button) => /cancel/i.test(button.textContent ?? ""));
    const retryButton = buttons.find((button) => /retry/i.test(button.textContent ?? ""));
    const openButton = buttons.find((button) => /open/i.test(button.textContent ?? ""));
    const revealButton = buttons.find((button) => /reveal/i.test(button.textContent ?? ""));

    expect(cancelButton).toBeDisabled();
    expect(retryButton).toBeDisabled();
    expect(openButton).toBeDisabled();
    expect(revealButton).toBeDisabled();
  });

  it("surfaces degraded health posture explicitly instead of assuming execution freshness", () => {
    render(
      <JobPanel
        {...buildProps({
          health: "degraded",
        })}
      />,
    );

    expect(screen.getByText(/degraded/i)).toBeInTheDocument();
  });

  it("keeps metrics operator-visible as facts about queued, running, failed, succeeded jobs and log lines", () => {
    render(<JobPanel {...buildProps()} />);

    expect(screen.getByText(/total/i)).toBeInTheDocument();
    expect(screen.getByText(/queued/i)).toBeInTheDocument();
    expect(screen.getByText(/running/i)).toBeInTheDocument();
    expect(screen.getByText(/failed/i)).toBeInTheDocument();
    expect(screen.getByText(/succeeded/i)).toBeInTheDocument();
    expect(screen.getByText(/log/i)).toBeInTheDocument();
  });

  it("supports empty job posture explicitly when no jobs have been recorded yet", () => {
    render(
      <JobPanel
        {...buildProps({
          jobs: [],
          selectedJobId: null,
          selectedJob: null,
          logs: [],
          notes: ["No jobs have been recorded yet."],
          metrics: {
            totalJobs: 0,
            queuedJobs: 0,
            runningJobs: 0,
            failedJobs: 0,
            succeededJobs: 0,
            logLines: 0,
          },
        })}
      />,
    );

    expect(screen.getByText(/No jobs have been recorded yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/Prepare patch review state/i)).not.toBeInTheDocument();
  });

  it("renders loading posture explicitly without dropping the job shell contract", () => {
    render(
      <JobPanel
        {...buildProps({
          loading: true,
        })}
      />,
    );

    expect(screen.getByText(/Jobs/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed execution, lifecycle, and evidence surface/i)).toBeInTheDocument();
  });

  it("supports a fully running-focused posture explicitly when the selected job is the active execution", () => {
    render(
      <JobPanel
        {...buildProps({
          jobs: [buildProps().jobs[1]],
          selectedJob: buildProps().selectedJob,
          selectedJobId: "job-verify-42",
          metrics: {
            totalJobs: 1,
            queuedJobs: 0,
            runningJobs: 1,
            failedJobs: 0,
            succeededJobs: 0,
            logLines: 3,
          },
        })}
      />,
    );

    expect(screen.getAllByText(/running/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Verify patch-42 replay and governance/i)).toBeInTheDocument();
  });

  it("does not collapse the job shell into only a list; selected evidence, notes, metrics, and controls remain distinct", () => {
    render(<JobPanel {...buildProps()} />);

    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText(/Verification job accepted by scheduler/i)).toBeInTheDocument();
    expect(screen.getByText(/job state must not drift/i)).toBeInTheDocument();
    expect(screen.getByText(/Prepare patch review state/i)).toBeInTheDocument();
  });
});
