import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * ADJUTORIX APP — TESTS / RENDERER / verify_panel.test.tsx
 *
 * Canonical verify-panel renderer contract suite.
 *
 * Purpose:
 * - verify that VerifyPanel preserves governed verification truth around run identity,
 *   lifecycle phase, outcome, replay posture, evidence summaries, blocking failures,
 *   patch/apply relevance, and explicit rerun/open/reveal actions
 * - verify that verification remains an evidence surface rather than a decorative pass/fail badge
 * - verify that loading, empty, degraded, failed, partial, and ready states remain explicit
 *
 * Test philosophy:
 * - no snapshots
 * - assert operator-visible evidence, status semantics, and callback routing
 * - prefer verification-state contracts over implementation details
 *
 * Notes:
 * - this suite assumes VerifyPanel exports a default React component from the renderer tree
 * - if the production prop surface evolves, update buildProps() first
 */

import VerifyPanel from "../../../src/renderer/components/VerifyPanel";

type VerifyPanelProps = React.ComponentProps<typeof VerifyPanel>;

function buildProps(overrides: Partial<VerifyPanelProps> = {}): VerifyPanelProps {
  return {
    title: "Verify",
    subtitle: "Governed verification and replay evidence surface",
    loading: false,
    health: "healthy",
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
      {
        id: "check-1",
        title: "Patch schema valid",
        status: "passed",
        category: "schema",
        summary: "Patch payload matched canonical schema.",
      },
      {
        id: "check-2",
        title: "Replay determinism",
        status: "failed",
        category: "replay",
        summary: "Replay mismatch detected at transaction edge 18 -> 19.",
      },
      {
        id: "check-3",
        title: "Apply gate readiness",
        status: "warning",
        category: "governance",
        summary: "Rejected patch files still block apply despite partial verification success.",
      },
      {
        id: "check-4",
        title: "Ledger continuity",
        status: "failed",
        category: "ledger",
        summary: "Ledger edge continuity broke after rollback candidate evaluation.",
      },
    ],
    artifacts: [
      {
        id: "artifact-1",
        label: "verify.log",
        kind: "log",
        path: "/repo/adjutorix-app/.adjutorix/verify/verify-42.log",
      },
      {
        id: "artifact-2",
        label: "replay-report.json",
        kind: "report",
        path: "/repo/adjutorix-app/.adjutorix/verify/replay-report.json",
      },
    ],
    notes: [
      "Verification completed with blocking replay and ledger failures.",
      "Apply remains blocked until rejected review items and failed replay checks are resolved.",
    ],
    canRunVerify: true,
    canOpenArtifact: true,
    canRevealArtifact: true,
    canRefresh: true,
    onRunVerifyRequested: vi.fn(),
    onOpenArtifactRequested: vi.fn(),
    onRevealArtifactRequested: vi.fn(),
    onRefreshRequested: vi.fn(),
    ...overrides,
  } as VerifyPanelProps;
}

describe("VerifyPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the canonical verify shell with title, subtitle, verify identity, and evidence sections", () => {
    render(<VerifyPanel {...buildProps()} />);

    expect(screen.getByText(/Verify/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed verification and replay evidence surface/i)).toBeInTheDocument();
    expect(screen.getByText(/verify-42/i)).toBeInTheDocument();
    expect(screen.getByText(/job-verify-42/i)).toBeInTheDocument();
    expect(screen.getByText(/patch-42/i)).toBeInTheDocument();
  });

  it("surfaces verification outcome, lifecycle phase, and apply-readiness impact explicitly", () => {
    render(<VerifyPanel {...buildProps()} />);

    expect(screen.getByText(/partial/i)).toBeInTheDocument();
    expect(screen.getByText(/completed/i)).toBeInTheDocument();
    expect(screen.getByText(/blocked/i)).toBeInTheDocument();
  });

  it("surfaces replay posture explicitly instead of hiding replay relevance behind generic status", () => {
    render(<VerifyPanel {...buildProps()} />);

    expect(screen.getByText(/replay/i)).toBeInTheDocument();
    expect(screen.getByText(/replay mismatch detected at transaction edge 18 -> 19/i)).toBeInTheDocument();
  });

  it("surfaces per-check evidence explicitly so passed, warning, and failed checks remain distinct", () => {
    render(<VerifyPanel {...buildProps()} />);

    expect(screen.getByText(/Patch schema valid/i)).toBeInTheDocument();
    expect(screen.getByText(/Replay determinism/i)).toBeInTheDocument();
    expect(screen.getByText(/Apply gate readiness/i)).toBeInTheDocument();
    expect(screen.getByText(/Ledger continuity/i)).toBeInTheDocument();

    expect(screen.getByText(/passed/i)).toBeInTheDocument();
    expect(screen.getByText(/warning/i)).toBeInTheDocument();
    expect(screen.getAllByText(/failed/i).length).toBeGreaterThanOrEqual(1);
  });

  it("keeps summary metrics operator-visible as facts about passed, failed, warning, and replay checks", () => {
    render(<VerifyPanel {...buildProps()} />);

    expect(screen.getByText(/12/i)).toBeInTheDocument();
    expect(screen.getByText(/9/i)).toBeInTheDocument();
    expect(screen.getByText(/2/i)).toBeInTheDocument();
    expect(screen.getByText(/3/i)).toBeInTheDocument();
  });

  it("surfaces blocking notes explicitly instead of reducing verification to a badge-only summary", () => {
    render(<VerifyPanel {...buildProps()} />);

    expect(screen.getByText(/Verification completed with blocking replay and ledger failures/i)).toBeInTheDocument();
    expect(screen.getByText(/Apply remains blocked until rejected review items and failed replay checks are resolved/i)).toBeInTheDocument();
  });

  it("surfaces artifact identity and paths explicitly so evidence can be inspected", () => {
    render(<VerifyPanel {...buildProps()} />);

    expect(screen.getByText(/verify\.log/i)).toBeInTheDocument();
    expect(screen.getByText(/replay-report\.json/i)).toBeInTheDocument();
    expect(screen.getByText(/\.adjutorix\/verify\/verify-42\.log/i)).toBeInTheDocument();
    expect(screen.getByText(/\.adjutorix\/verify\/replay-report\.json/i)).toBeInTheDocument();
  });

  it("wires rerun verification explicitly instead of implying passive auto-retry", () => {
    const props = buildProps();
    render(<VerifyPanel {...props} />);

    const runButton = screen.getAllByRole("button").find((button) => /run/i.test(button.textContent ?? "") || /verify/i.test(button.textContent ?? ""));
    expect(runButton).toBeDefined();

    fireEvent.click(runButton!);
    expect(props.onRunVerifyRequested).toHaveBeenCalledTimes(1);
  });

  it("wires artifact open, reveal, and refresh actions explicitly", () => {
    const props = buildProps();
    render(<VerifyPanel {...props} />);

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

    expect(props.onOpenArtifactRequested).toHaveBeenCalled();
    expect(props.onRevealArtifactRequested).toHaveBeenCalled();
    expect(props.onRefreshRequested).toHaveBeenCalled();
  });

  it("does not advertise run, open, or reveal capabilities as enabled when gates are closed", () => {
    render(
      <VerifyPanel
        {...buildProps({
          canRunVerify: false,
          canOpenArtifact: false,
          canRevealArtifact: false,
        })}
      />,
    );

    const buttons = screen.getAllByRole("button");
    const runButton = buttons.find((button) => /run/i.test(button.textContent ?? "") || /verify/i.test(button.textContent ?? ""));
    const openButton = buttons.find((button) => /open/i.test(button.textContent ?? ""));
    const revealButton = buttons.find((button) => /reveal/i.test(button.textContent ?? ""));

    expect(runButton).toBeDisabled();
    expect(openButton).toBeDisabled();
    expect(revealButton).toBeDisabled();
  });

  it("surfaces running posture explicitly instead of reusing completed-shell assumptions", () => {
    render(
      <VerifyPanel
        {...buildProps({
          status: "running",
          phase: "running",
          finishedAtMs: null,
          notes: ["Verification is currently executing replay and ledger continuity checks."],
        })}
      />,
    );

    expect(screen.getAllByText(/running/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/currently executing replay and ledger continuity checks/i)).toBeInTheDocument();
  });

  it("surfaces failed posture explicitly when verification fully fails", () => {
    render(
      <VerifyPanel
        {...buildProps({
          status: "failed",
          applyReadinessImpact: "blocked",
          summary: {
            totalChecks: 6,
            passedChecks: 1,
            warningChecks: 0,
            failedChecks: 5,
            replayChecks: 2,
          },
        })}
      />,
    );

    expect(screen.getAllByText(/failed/i).length).toBeGreaterThanOrEqual(1);
  });

  it("surfaces successful ready posture explicitly when all checks pass and apply impact clears", () => {
    render(
      <VerifyPanel
        {...buildProps({
          status: "passed",
          applyReadinessImpact: "ready",
          summary: {
            totalChecks: 8,
            passedChecks: 8,
            warningChecks: 0,
            failedChecks: 0,
            replayChecks: 2,
          },
          checks: [
            {
              id: "ok-1",
              title: "Replay determinism",
              status: "passed",
              category: "replay",
              summary: "Replay matched canonical ledger state.",
            },
          ],
          notes: ["Verification passed and no blocking evidence remains."],
        })}
      />,
    );

    expect(screen.getByText(/passed/i)).toBeInTheDocument();
    expect(screen.getByText(/ready/i)).toBeInTheDocument();
    expect(screen.getByText(/Verification passed and no blocking evidence remains/i)).toBeInTheDocument();
  });

  it("renders empty verification posture explicitly when no checks or artifacts exist yet", () => {
    render(
      <VerifyPanel
        {...buildProps({
          verifyId: null,
          status: "unknown",
          phase: "idle",
          activeJobId: null,
          relatedPatchId: null,
          checks: [],
          artifacts: [],
          notes: ["No verification run has been executed yet."],
          summary: {
            totalChecks: 0,
            passedChecks: 0,
            warningChecks: 0,
            failedChecks: 0,
            replayChecks: 0,
          },
        })}
      />,
    );

    expect(screen.getByText(/No verification run has been executed yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/verify\.log/i)).not.toBeInTheDocument();
  });

  it("renders loading posture explicitly without dropping the verification shell contract", () => {
    render(
      <VerifyPanel
        {...buildProps({
          loading: true,
        })}
      />,
    );

    expect(screen.getByText(/Verify/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed verification and replay evidence surface/i)).toBeInTheDocument();
  });

  it("surfaces degraded health posture explicitly instead of assuming verify freshness", () => {
    render(
      <VerifyPanel
        {...buildProps({
          health: "degraded",
        })}
      />,
    );

    expect(screen.getByText(/degraded/i)).toBeInTheDocument();
  });

  it("does not collapse the verify shell into only status badges; checks, artifacts, notes, and controls remain distinct surfaces", () => {
    render(<VerifyPanel {...buildProps()} />);

    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText(/Replay determinism/i)).toBeInTheDocument();
    expect(screen.getByText(/verify\.log/i)).toBeInTheDocument();
    expect(screen.getByText(/Apply remains blocked/i)).toBeInTheDocument();
  });
});
