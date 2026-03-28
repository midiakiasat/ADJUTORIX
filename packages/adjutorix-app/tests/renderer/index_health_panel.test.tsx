import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * ADJUTORIX APP — TESTS / RENDERER / index_health_panel.test.tsx
 *
 * Canonical index-health panel renderer contract suite.
 *
 * Purpose:
 * - verify that IndexHealthPanel preserves governed indexing truth around index state,
 *   freshness, coverage, watcher lag, issue pressure, rebuild posture, and explicit refresh/rebuild actions
 * - verify that index state remains an operator-facing evidence surface rather than decorative telemetry
 * - verify that healthy, stale, building, failed, loading, and empty-workspace states remain explicit
 *
 * Test philosophy:
 * - no snapshots
 * - assert operator-visible state semantics and callback routing
 * - prefer freshness/coverage/watcher contracts over implementation details
 *
 * Notes:
 * - this suite assumes IndexHealthPanel exports a default React component from the renderer tree
 * - if the production prop surface evolves, update buildProps() first
 */

import IndexHealthPanel from "../../../src/renderer/components/IndexHealthPanel";

type IndexHealthPanelProps = React.ComponentProps<typeof IndexHealthPanel>;

function buildProps(overrides: Partial<IndexHealthPanelProps> = {}): IndexHealthPanelProps {
  return {
    title: "Index health",
    subtitle: "Governed indexing, freshness, and watcher health surface",
    loading: false,
    health: "healthy",
    workspaceId: "ws-7",
    workspaceRoot: "/repo/adjutorix-app",
    indexState: "ready",
    watchState: "watching",
    trustLevel: "trusted",
    coverage: {
      indexedFiles: 128,
      eligibleFiles: 132,
      ignoredFiles: 41,
      hiddenFiles: 3,
      coveragePct: 96.97,
    },
    freshness: {
      updatedAtMs: 1711000000000,
      ageMs: 8000,
      staleThresholdMs: 60000,
      lagMs: 11,
    },
    issues: {
      total: 2,
      warningCount: 2,
      errorCount: 0,
      examples: [
        "2 files skipped due to transient read lock.",
        "Watcher lag briefly exceeded nominal threshold but recovered.",
      ],
    },
    notes: [
      "Index is current enough for search, outline, and diagnostics projection.",
      "Watcher lag remains visible because freshness cannot be inferred from state label alone.",
    ],
    metrics: {
      buildsCompleted: 12,
      rebuildRequests: 1,
      lastBuildDurationMs: 1540,
      watcherEvents: 487,
      pendingFsEvents: 0,
    },
    canRefresh: true,
    canRebuild: true,
    onRefreshRequested: vi.fn(),
    onRebuildRequested: vi.fn(),
    ...overrides,
  } as IndexHealthPanelProps;
}

describe("IndexHealthPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the canonical index-health shell with title, subtitle, workspace identity, and state", () => {
    render(<IndexHealthPanel {...buildProps()} />);

    expect(screen.getByText(/Index health/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed indexing, freshness, and watcher health surface/i)).toBeInTheDocument();
    expect(screen.getByText(/ws-7/i)).toBeInTheDocument();
    expect(screen.getByText(/\/repo\/adjutorix-app/i)).toBeInTheDocument();
    expect(screen.getByText(/ready/i)).toBeInTheDocument();
    expect(screen.getByText(/watching/i)).toBeInTheDocument();
  });

  it("surfaces health and trust posture explicitly instead of flattening them into index state", () => {
    render(<IndexHealthPanel {...buildProps()} />);

    expect(screen.getByText(/healthy/i)).toBeInTheDocument();
    expect(screen.getByText(/trusted/i)).toBeInTheDocument();
  });

  it("surfaces coverage explicitly so indexed, eligible, ignored, and hidden file counts remain visible", () => {
    render(<IndexHealthPanel {...buildProps()} />);

    expect(screen.getByText(/indexed/i)).toBeInTheDocument();
    expect(screen.getByText(/eligible/i)).toBeInTheDocument();
    expect(screen.getByText(/ignored/i)).toBeInTheDocument();
    expect(screen.getByText(/hidden/i)).toBeInTheDocument();
    expect(screen.getByText(/96\.97/i)).toBeInTheDocument();
  });

  it("surfaces freshness and watcher lag explicitly instead of relying on coarse ready/stale labels", () => {
    render(<IndexHealthPanel {...buildProps()} />);

    expect(screen.getByText(/fresh/i)).toBeInTheDocument();
    expect(screen.getByText(/lag/i)).toBeInTheDocument();
    expect(screen.getByText(/60000/i)).toBeInTheDocument();
    expect(screen.getByText(/11/i)).toBeInTheDocument();
  });

  it("surfaces issue summaries explicitly so warnings do not disappear behind green state", () => {
    render(<IndexHealthPanel {...buildProps()} />);

    expect(screen.getByText(/2 files skipped due to transient read lock/i)).toBeInTheDocument();
    expect(screen.getByText(/Watcher lag briefly exceeded nominal threshold/i)).toBeInTheDocument();
    expect(screen.getAllByText(/2/i).length).toBeGreaterThanOrEqual(1);
  });

  it("surfaces notes explicitly so index interpretability is not reduced to numeric metrics", () => {
    render(<IndexHealthPanel {...buildProps()} />);

    expect(screen.getByText(/Index is current enough for search, outline, and diagnostics projection/i)).toBeInTheDocument();
    expect(screen.getByText(/Watcher lag remains visible/i)).toBeInTheDocument();
  });

  it("keeps operational metrics visible as facts about builds, rebuilds, duration, watcher events, and pending fs events", () => {
    render(<IndexHealthPanel {...buildProps()} />);

    expect(screen.getByText(/builds/i)).toBeInTheDocument();
    expect(screen.getByText(/rebuild/i)).toBeInTheDocument();
    expect(screen.getByText(/duration/i)).toBeInTheDocument();
    expect(screen.getByText(/watcher/i)).toBeInTheDocument();
    expect(screen.getByText(/pending/i)).toBeInTheDocument();
  });

  it("wires refresh and rebuild actions explicitly", () => {
    const props = buildProps();
    render(<IndexHealthPanel {...props} />);

    const buttons = screen.getAllByRole("button");
    const refreshButton = buttons.find((button) => /refresh/i.test(button.textContent ?? ""));
    const rebuildButton = buttons.find((button) => /rebuild/i.test(button.textContent ?? ""));

    expect(refreshButton).toBeDefined();
    expect(rebuildButton).toBeDefined();

    fireEvent.click(refreshButton!);
    fireEvent.click(rebuildButton!);

    expect(props.onRefreshRequested).toHaveBeenCalledTimes(1);
    expect(props.onRebuildRequested).toHaveBeenCalledTimes(1);
  });

  it("does not advertise refresh or rebuild as enabled when capability gates are closed", () => {
    render(
      <IndexHealthPanel
        {...buildProps({
          canRefresh: false,
          canRebuild: false,
        })}
      />,
    );

    const buttons = screen.getAllByRole("button");
    const refreshButton = buttons.find((button) => /refresh/i.test(button.textContent ?? ""));
    const rebuildButton = buttons.find((button) => /rebuild/i.test(button.textContent ?? ""));

    expect(refreshButton).toBeDisabled();
    expect(rebuildButton).toBeDisabled();
  });

  it("surfaces stale posture explicitly when freshness exceeds threshold", () => {
    render(
      <IndexHealthPanel
        {...buildProps({
          health: "degraded",
          indexState: "stale",
          freshness: {
            updatedAtMs: 1710990000000,
            ageMs: 120000,
            staleThresholdMs: 60000,
            lagMs: 240,
          },
          notes: ["Index is stale and should be refreshed before relying on search completeness."],
        })}
      />,
    );

    expect(screen.getByText(/stale/i)).toBeInTheDocument();
    expect(screen.getByText(/Index is stale and should be refreshed/i)).toBeInTheDocument();
  });

  it("surfaces building posture explicitly instead of reusing ready-shell assumptions", () => {
    render(
      <IndexHealthPanel
        {...buildProps({
          indexState: "building",
          watchState: "watching",
          notes: ["Index rebuild in progress; search coverage may be incomplete during hydration."],
          metrics: {
            buildsCompleted: 12,
            rebuildRequests: 2,
            lastBuildDurationMs: 1540,
            watcherEvents: 487,
            pendingFsEvents: 19,
          },
        })}
      />,
    );

    expect(screen.getByText(/building/i)).toBeInTheDocument();
    expect(screen.getByText(/Index rebuild in progress/i)).toBeInTheDocument();
  });

  it("surfaces failed index posture explicitly when coverage cannot be trusted", () => {
    render(
      <IndexHealthPanel
        {...buildProps({
          health: "unhealthy",
          indexState: "failed",
          watchState: "failed",
          issues: {
            total: 3,
            warningCount: 1,
            errorCount: 2,
            examples: [
              "Index snapshot could not be persisted.",
              "Watcher bootstrap failed for workspace root.",
            ],
          },
          notes: ["Index failed; search, outline, and diagnostics coverage may be incomplete or stale."],
        })}
      />,
    );

    expect(screen.getByText(/failed/i)).toBeInTheDocument();
    expect(screen.getByText(/Index snapshot could not be persisted/i)).toBeInTheDocument();
    expect(screen.getByText(/Watcher bootstrap failed/i)).toBeInTheDocument();
  });

  it("supports empty-workspace posture explicitly when no files are yet eligible for indexing", () => {
    render(
      <IndexHealthPanel
        {...buildProps({
          workspaceId: "ws-empty",
          workspaceRoot: "/repo/empty",
          indexState: "idle",
          watchState: "inactive",
          coverage: {
            indexedFiles: 0,
            eligibleFiles: 0,
            ignoredFiles: 0,
            hiddenFiles: 0,
            coveragePct: 0,
          },
          issues: {
            total: 0,
            warningCount: 0,
            errorCount: 0,
            examples: [],
          },
          notes: ["No indexable files are currently available in the selected workspace."],
          metrics: {
            buildsCompleted: 0,
            rebuildRequests: 0,
            lastBuildDurationMs: 0,
            watcherEvents: 0,
            pendingFsEvents: 0,
          },
        })}
      />,
    );

    expect(screen.getByText(/No indexable files are currently available/i)).toBeInTheDocument();
    expect(screen.getByText(/inactive/i)).toBeInTheDocument();
  });

  it("renders loading posture explicitly without dropping the index-health shell contract", () => {
    render(
      <IndexHealthPanel
        {...buildProps({
          loading: true,
        })}
      />,
    );

    expect(screen.getByText(/Index health/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed indexing, freshness, and watcher health surface/i)).toBeInTheDocument();
  });

  it("does not collapse the panel into only a status badge; coverage, freshness, issues, notes, metrics, and controls remain distinct", () => {
    render(<IndexHealthPanel {...buildProps()} />);

    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/coverage/i)).toBeInTheDocument();
    expect(screen.getByText(/lag/i)).toBeInTheDocument();
    expect(screen.getByText(/Index is current enough/i)).toBeInTheDocument();
  });
});
