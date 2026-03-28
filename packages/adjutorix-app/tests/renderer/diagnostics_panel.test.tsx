import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * ADJUTORIX APP — TESTS / RENDERER / diagnostics_panel.test.tsx
 *
 * Canonical diagnostics-panel renderer contract suite.
 *
 * Purpose:
 * - verify that DiagnosticsPanel preserves governed diagnostic truth around severity,
 *   provenance, file identity, range/location, filtering, selection, grouping, and explicit
 *   open/reveal/navigation actions
 * - verify that diagnostics remain a projection of canonical normalized diagnostic state rather than
 *   a lossy console/log surface
 * - verify that degraded, loading, and empty-result states remain explicit and operator-readable
 *
 * Test philosophy:
 * - no snapshots
 * - assert operator-visible structure, severity semantics, and callback routing
 * - prefer source/provenance and navigation contracts over implementation details
 *
 * Notes:
 * - this suite assumes DiagnosticsPanel exports a default React component from the renderer tree
 * - if the production prop surface evolves, update buildProps() first
 */

import DiagnosticsPanel from "../../../src/renderer/components/DiagnosticsPanel";

type DiagnosticsPanelProps = React.ComponentProps<typeof DiagnosticsPanel>;

function buildProps(overrides: Partial<DiagnosticsPanelProps> = {}): DiagnosticsPanelProps {
  return {
    title: "Diagnostics",
    subtitle: "Governed normalized diagnostics surface",
    loading: false,
    health: "healthy",
    selectedDiagnosticId: "diag-1",
    query: "",
    severityFilter: "all",
    producerFilter: "all",
    fileFilter: null,
    summary: {
      total: 5,
      fatalCount: 1,
      errorCount: 2,
      warningCount: 1,
      infoCount: 1,
      byProducer: {
        typescript: 2,
        eslint: 2,
        verify: 1,
      },
      byCategory: {
        type: 2,
        lint: 2,
        verification: 1,
      },
      byFile: {
        "/repo/adjutorix-app/src/renderer/App.tsx": 3,
        "/repo/adjutorix-app/src/renderer/components/AppShell.tsx": 2,
      },
    },
    diagnostics: [
      {
        id: "diag-1",
        fingerprint: "fp-1",
        severity: "error",
        category: "type",
        producer: "typescript",
        sourceLabel: "tsc",
        message: "Type 'number' is not assignable to type 'string'.",
        code: "TS2322",
        filePath: "/repo/adjutorix-app/src/renderer/App.tsx",
        range: {
          start: { line: 12, column: 8 },
          end: { line: 12, column: 18 },
        },
        relatedPaths: [],
        tags: ["editor", "typecheck"],
        jobId: "job-1",
        verifyId: null,
        patchId: null,
        createdAtMs: 1711000000000,
      },
      {
        id: "diag-2",
        fingerprint: "fp-2",
        severity: "warning",
        category: "lint",
        producer: "eslint",
        sourceLabel: "eslint",
        message: "Unexpected any. Specify a different type.",
        code: "@typescript-eslint/no-explicit-any",
        filePath: "/repo/adjutorix-app/src/renderer/App.tsx",
        range: {
          start: { line: 20, column: 14 },
          end: { line: 20, column: 17 },
        },
        relatedPaths: [],
        tags: ["lint"],
        jobId: null,
        verifyId: null,
        patchId: null,
        createdAtMs: 1711000001000,
      },
      {
        id: "diag-3",
        fingerprint: "fp-3",
        severity: "fatal",
        category: "verification",
        producer: "verify",
        sourceLabel: "verify-run",
        message: "Verification failed: replay mismatch at transaction edge 18 -> 19.",
        code: "VERIFY_REPLAY_MISMATCH",
        filePath: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
        range: {
          start: { line: 88, column: 1 },
          end: { line: 88, column: 32 },
        },
        relatedPaths: ["/repo/adjutorix-app/docs/LEDGER_AND_REPLAY.md"],
        tags: ["verify", "ledger"],
        jobId: "job-verify-4",
        verifyId: "verify-9",
        patchId: "patch-3",
        createdAtMs: 1711000002000,
      },
      {
        id: "diag-4",
        fingerprint: "fp-4",
        severity: "info",
        category: "lint",
        producer: "eslint",
        sourceLabel: "eslint",
        message: "File ignored by default ignore pattern.",
        code: "ignored-file",
        filePath: "/repo/adjutorix-app/node_modules/example/index.js",
        range: null,
        relatedPaths: [],
        tags: ["ignored"],
        jobId: null,
        verifyId: null,
        patchId: null,
        createdAtMs: 1711000003000,
      },
      {
        id: "diag-5",
        fingerprint: "fp-5",
        severity: "error",
        category: "type",
        producer: "typescript",
        sourceLabel: "tsserver",
        message: "Property 'workspace' does not exist on type 'ShellState'.",
        code: "TS2339",
        filePath: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
        range: {
          start: { line: 42, column: 11 },
          end: { line: 42, column: 20 },
        },
        relatedPaths: [],
        tags: ["shell", "state"],
        jobId: null,
        verifyId: null,
        patchId: null,
        createdAtMs: 1711000004000,
      },
    ],
    onQueryChange: vi.fn(),
    onSeverityFilterChange: vi.fn(),
    onProducerFilterChange: vi.fn(),
    onFileFilterChange: vi.fn(),
    onSelectDiagnostic: vi.fn(),
    onOpenDiagnostic: vi.fn(),
    onRevealDiagnostic: vi.fn(),
    onNavigateToDiagnostic: vi.fn(),
    onRefreshRequested: vi.fn(),
    ...overrides,
  } as DiagnosticsPanelProps;
}

describe("DiagnosticsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the canonical diagnostics shell with title, subtitle, summary, and normalized diagnostics", () => {
    render(<DiagnosticsPanel {...buildProps()} />);

    expect(screen.getByText(/Diagnostics/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed normalized diagnostics surface/i)).toBeInTheDocument();
    expect(screen.getByText(/Type 'number' is not assignable to type 'string'/i)).toBeInTheDocument();
    expect(screen.getByText(/Unexpected any/i)).toBeInTheDocument();
    expect(screen.getByText(/Verification failed: replay mismatch/i)).toBeInTheDocument();
  });

  it("surfaces severity classes explicitly so fatal, error, warning, and info remain distinct", () => {
    render(<DiagnosticsPanel {...buildProps()} />);

    expect(screen.getByText(/fatal/i)).toBeInTheDocument();
    expect(screen.getAllByText(/error/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/warning/i)).toBeInTheDocument();
    expect(screen.getByText(/info/i)).toBeInTheDocument();
  });

  it("surfaces producer provenance explicitly so typescript, eslint, and verify do not collapse into one stream", () => {
    render(<DiagnosticsPanel {...buildProps()} />);

    expect(screen.getByText(/tsc/i)).toBeInTheDocument();
    expect(screen.getAllByText(/eslint/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/verify-run/i)).toBeInTheDocument();
  });

  it("preserves file identity and location for file-bound diagnostics", () => {
    render(<DiagnosticsPanel {...buildProps()} />);

    expect(screen.getByText(/\/repo\/adjutorix-app\/src\/renderer\/App\.tsx/i)).toBeInTheDocument();
    expect(screen.getByText(/\/repo\/adjutorix-app\/src\/renderer\/components\/AppShell\.tsx/i)).toBeInTheDocument();
    expect(screen.getByText(/12/i)).toBeInTheDocument();
    expect(screen.getByText(/42/i)).toBeInTheDocument();
  });

  it("surfaces code identifiers explicitly so diagnostics remain actionable and attributable", () => {
    render(<DiagnosticsPanel {...buildProps()} />);

    expect(screen.getByText(/TS2322/i)).toBeInTheDocument();
    expect(screen.getByText(/TS2339/i)).toBeInTheDocument();
    expect(screen.getByText(/VERIFY_REPLAY_MISMATCH/i)).toBeInTheDocument();
  });

  it("wires query changes to the explicit callback instead of mutating local filter state silently", () => {
    const props = buildProps();
    render(<DiagnosticsPanel {...props} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "replay" } });

    expect(props.onQueryChange).toHaveBeenCalledTimes(1);
    expect(props.onQueryChange).toHaveBeenCalledWith("replay");
  });

  it("wires severity, producer, and file filters explicitly", () => {
    const props = buildProps();
    render(<DiagnosticsPanel {...props} />);

    const buttons = screen.getAllByRole("button");
    const severityButton = buttons.find((button) => /severity/i.test(button.textContent ?? "") || /all/i.test(button.textContent ?? ""));
    const producerButton = buttons.find((button) => /producer/i.test(button.textContent ?? ""));
    const fileButton = buttons.find((button) => /file/i.test(button.textContent ?? ""));

    expect(severityButton).toBeDefined();
    expect(producerButton).toBeDefined();
    expect(fileButton).toBeDefined();

    fireEvent.click(severityButton!);
    fireEvent.click(producerButton!);
    fireEvent.click(fileButton!);

    expect(props.onSeverityFilterChange).toHaveBeenCalled();
    expect(props.onProducerFilterChange).toHaveBeenCalled();
    expect(props.onFileFilterChange).toHaveBeenCalled();
  });

  it("wires diagnostic selection to the explicit callback instead of silently shifting focus", () => {
    const props = buildProps();
    render(<DiagnosticsPanel {...props} />);

    fireEvent.click(screen.getByText(/Unexpected any/i));

    expect(props.onSelectDiagnostic).toHaveBeenCalledTimes(1);
    expect(props.onSelectDiagnostic).toHaveBeenCalledWith("diag-2");
  });

  it("wires open, reveal, and navigate actions as distinct operator intents", () => {
    const props = buildProps();
    render(<DiagnosticsPanel {...props} />);

    const buttons = screen.getAllByRole("button");
    const openButton = buttons.find((button) => /open/i.test(button.textContent ?? ""));
    const revealButton = buttons.find((button) => /reveal/i.test(button.textContent ?? ""));
    const navigateButton = buttons.find((button) => /navigate/i.test(button.textContent ?? "") || /go to/i.test(button.textContent ?? ""));

    expect(openButton).toBeDefined();
    expect(revealButton).toBeDefined();
    expect(navigateButton).toBeDefined();

    fireEvent.click(openButton!);
    fireEvent.click(revealButton!);
    fireEvent.click(navigateButton!);

    expect(props.onOpenDiagnostic).toHaveBeenCalled();
    expect(props.onRevealDiagnostic).toHaveBeenCalled();
    expect(props.onNavigateToDiagnostic).toHaveBeenCalled();
  });

  it("wires refresh control explicitly instead of pretending diagnostics refresh themselves", () => {
    const props = buildProps();
    render(<DiagnosticsPanel {...props} />);

    const refreshButton = screen.getAllByRole("button").find((button) => /refresh/i.test(button.textContent ?? ""));
    expect(refreshButton).toBeDefined();

    fireEvent.click(refreshButton!);
    expect(props.onRefreshRequested).toHaveBeenCalledTimes(1);
  });

  it("surfaces related operational provenance like verify and patch references when present", () => {
    render(<DiagnosticsPanel {...buildProps()} />);

    expect(screen.getByText(/job-verify-4/i)).toBeInTheDocument();
    expect(screen.getByText(/verify-9/i)).toBeInTheDocument();
    expect(screen.getByText(/patch-3/i)).toBeInTheDocument();
  });

  it("preserves unbound or non-ranged diagnostics without erasing them from the panel", () => {
    render(<DiagnosticsPanel {...buildProps()} />);

    expect(screen.getByText(/File ignored by default ignore pattern/i)).toBeInTheDocument();
  });

  it("supports filtered result state without erasing the filter shell", () => {
    render(
      <DiagnosticsPanel
        {...buildProps({
          query: "replay",
          diagnostics: [buildProps().diagnostics[2]],
          summary: {
            total: 1,
            fatalCount: 1,
            errorCount: 0,
            warningCount: 0,
            infoCount: 0,
            byProducer: { verify: 1 },
            byCategory: { verification: 1 },
            byFile: {
              "/repo/adjutorix-app/src/renderer/components/AppShell.tsx": 1,
            },
          },
        })}
      />,
    );

    expect(screen.getByDisplayValue("replay")).toBeInTheDocument();
    expect(screen.getByText(/Verification failed: replay mismatch/i)).toBeInTheDocument();
    expect(screen.queryByText(/Unexpected any/i)).not.toBeInTheDocument();
  });

  it("renders empty-result posture explicitly when no diagnostics are present", () => {
    render(
      <DiagnosticsPanel
        {...buildProps({
          diagnostics: [],
          selectedDiagnosticId: null,
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
        })}
      />,
    );

    expect(screen.getByText(/Diagnostics/i)).toBeInTheDocument();
    expect(screen.queryByText(/Type 'number' is not assignable/i)).not.toBeInTheDocument();
  });

  it("renders loading posture explicitly without dropping the diagnostics shell contract", () => {
    render(
      <DiagnosticsPanel
        {...buildProps({
          loading: true,
        })}
      />,
    );

    expect(screen.getByText(/Diagnostics/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed normalized diagnostics surface/i)).toBeInTheDocument();
  });

  it("surfaces degraded health posture explicitly instead of assuming diagnostics freshness", () => {
    render(
      <DiagnosticsPanel
        {...buildProps({
          health: "degraded",
        })}
      />,
    );

    expect(screen.getByText(/degraded/i)).toBeInTheDocument();
  });

  it("keeps summary metrics operator-visible as facts about total and per-severity counts", () => {
    render(<DiagnosticsPanel {...buildProps()} />);

    expect(screen.getByText(/5/i)).toBeInTheDocument();
    expect(screen.getByText(/fatal/i)).toBeInTheDocument();
    expect(screen.getByText(/warning/i)).toBeInTheDocument();
    expect(screen.getByText(/info/i)).toBeInTheDocument();
  });

  it("does not collapse diagnostics shell into only filters; list, summary, and controls remain distinct surfaces", () => {
    render(<DiagnosticsPanel {...buildProps()} />);

    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText(/Type 'number' is not assignable/i)).toBeInTheDocument();
  });

  it("preserves duplicate-message diagnostics when provenance or location differs instead of deduplicating visually unsafe", () => {
    render(
      <DiagnosticsPanel
        {...buildProps({
          diagnostics: [
            {
              id: "dup-1",
              fingerprint: "dup-fp-1",
              severity: "warning",
              category: "lint",
              producer: "eslint",
              sourceLabel: "eslint",
              message: "Unused variable 'x'.",
              code: "no-unused-vars",
              filePath: "/repo/a/src/index.ts",
              range: {
                start: { line: 3, column: 7 },
                end: { line: 3, column: 8 },
              },
              relatedPaths: [],
              tags: [],
              jobId: null,
              verifyId: null,
              patchId: null,
              createdAtMs: 1711000005000,
            },
            {
              id: "dup-2",
              fingerprint: "dup-fp-2",
              severity: "warning",
              category: "lint",
              producer: "eslint",
              sourceLabel: "eslint",
              message: "Unused variable 'x'.",
              code: "no-unused-vars",
              filePath: "/repo/b/src/index.ts",
              range: {
                start: { line: 8, column: 4 },
                end: { line: 8, column: 5 },
              },
              relatedPaths: [],
              tags: [],
              jobId: null,
              verifyId: null,
              patchId: null,
              createdAtMs: 1711000006000,
            },
          ],
          selectedDiagnosticId: "dup-1",
          summary: {
            total: 2,
            fatalCount: 0,
            errorCount: 0,
            warningCount: 2,
            infoCount: 0,
            byProducer: { eslint: 2 },
            byCategory: { lint: 2 },
            byFile: {
              "/repo/a/src/index.ts": 1,
              "/repo/b/src/index.ts": 1,
            },
          },
        })}
      />,
    );

    expect(screen.getAllByText(/Unused variable 'x'\./i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/\/repo\/a\/src\/index\.ts/i)).toBeInTheDocument();
    expect(screen.getByText(/\/repo\/b\/src\/index\.ts/i)).toBeInTheDocument();
  });
});
