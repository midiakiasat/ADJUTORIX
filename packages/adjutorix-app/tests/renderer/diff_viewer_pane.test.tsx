import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * ADJUTORIX APP — TESTS / RENDERER / diff_viewer_pane.test.tsx
 *
 * Canonical diff-viewer pane renderer contract suite.
 *
 * Purpose:
 * - verify that DiffViewerPane preserves governed diff truth around original/modified identity,
 *   file lineage, change kind, hunk selection, review posture, large-file degradation,
 *   read-only diff semantics, and explicit navigation/open/reveal actions
 * - verify that the diff surface remains a projection of canonical patch/model state rather than
 *   a decorative code compare widget with ambiguous file ownership or hidden action routing
 * - verify that loading, empty, degraded, preview-only, and selected-hunk states remain explicit
 *
 * Test philosophy:
 * - no snapshots
 * - assert operator-visible structure, diff semantics, and callback routing
 * - prefer file lineage and review/navigation contracts over implementation details
 *
 * Notes:
 * - this suite assumes DiffViewerPane exports a default React component from the renderer tree
 * - Monaco diff/editor integration is mocked so the suite targets pane behavior, not editor internals
 * - if the production prop surface evolves, update buildProps() first
 */

import DiffViewerPane from "../../../src/renderer/components/DiffViewerPane";

type DiffViewerPaneProps = React.ComponentProps<typeof DiffViewerPane>;

vi.mock("@monaco-editor/react", () => ({
  default: (props: Record<string, unknown>) => (
    <section data-testid="monaco-editor-mock">
      <div>MockMonacoEditor</div>
      <pre data-testid="monaco-editor-mock-props">{JSON.stringify(props, null, 2)}</pre>
    </section>
  ),
  DiffEditor: (props: Record<string, unknown>) => (
    <section data-testid="monaco-diff-editor-mock">
      <div>MockMonacoDiffEditor</div>
      <pre data-testid="monaco-diff-editor-mock-props">{JSON.stringify(props, null, 2)}</pre>
    </section>
  ),
}));

function buildProps(overrides: Partial<DiffViewerPaneProps> = {}): DiffViewerPaneProps {
  return {
    title: "Diff viewer",
    subtitle: "Governed original vs modified comparison surface",
    loading: false,
    health: "healthy",
    mode: "diff",
    changeKind: "modify",
    path: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
    oldPath: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
    language: "typescript",
    originalValue: "export function AppShell() {\n  return <div>Old</div>;\n}\n",
    modifiedValue: "export function AppShell() {\n  return <main>New</main>;\n}\n",
    readOnly: true,
    largeFile: {
      enabled: false,
      decision: "allow",
      reason: null,
      previewBytes: null,
    },
    selectedHunkId: "hunk-1",
    hunks: [
      {
        id: "hunk-1",
        header: "@@ -1,3 +1,3 @@",
        oldRange: { startLine: 1, endLine: 3 },
        newRange: { startLine: 1, endLine: 3 },
        addedLineCount: 1,
        deletedLineCount: 1,
      },
      {
        id: "hunk-2",
        header: "@@ -8,4 +8,6 @@",
        oldRange: { startLine: 8, endLine: 11 },
        newRange: { startLine: 8, endLine: 13 },
        addedLineCount: 2,
        deletedLineCount: 0,
      },
    ],
    metrics: {
      totalHunks: 2,
      addedLines: 3,
      deletedLines: 1,
      selectedHunks: 1,
    },
    review: {
      status: "commented",
      verifyStatus: "passed",
      applyReadiness: "warning",
    },
    canOpenFile: true,
    canRevealInTree: true,
    canNavigateToHunk: true,
    canRefresh: true,
    onSelectHunk: vi.fn(),
    onOpenFileRequested: vi.fn(),
    onRevealInTreeRequested: vi.fn(),
    onNavigateToHunkRequested: vi.fn(),
    onRefreshRequested: vi.fn(),
    ...overrides,
  } as DiffViewerPaneProps;
}

describe("DiffViewerPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the canonical diff shell with title, subtitle, file identity, and Monaco diff host", () => {
    render(<DiffViewerPane {...buildProps()} />);

    expect(screen.getAllByText(/Diff viewer/i)[0]).toBeInTheDocument();
    expect(screen.getAllByText(/Governed original vs modified comparison surface/i)[0]).toBeInTheDocument();
    expect(screen.getAllByText(/AppShell\.tsx/i)[0]).toBeInTheDocument();
    expect(screen.getByTestId("monaco-diff-editor-mock")).toBeInTheDocument();
  });

  it("passes canonical original and modified values into the Monaco diff surface", () => {
    render(<DiffViewerPane {...buildProps()} />);

    const propsJson = screen.getByTestId("monaco-diff-editor-mock-props").textContent ?? "{}";
    expect(propsJson).toMatch(/Old/);
    expect(propsJson).toMatch(/New/);
    expect(propsJson).toMatch(/typescript/);
  });

  it("surfaces file lineage explicitly so original and modified ownership remain unambiguous", () => {
    render(<DiffViewerPane {...buildProps()} />);

    expect(screen.getAllByText(/\/repo\/adjutorix-app\/src\/renderer\/components\/AppShell\.tsx/i)[0]).toBeInTheDocument();
    expect(screen.getAllByText(/modify/i)[0]).toBeInTheDocument();
  });

  it("surfaces selected hunk identity and header explicitly instead of hiding review focus in editor internals", () => {
    render(<DiffViewerPane {...buildProps()} />);

    expect(screen.getAllByText(/@@ -1,3 \+1,3 @@/i)[0]).toBeInTheDocument();
    expect(screen.getAllByText(/@@ -8,4 \+8,6 @@/i)[0]).toBeInTheDocument();
  });

  it("surfaces added and deleted line metrics as operator-visible diff facts", () => {
    render(<DiffViewerPane {...buildProps()} />);

    expect(screen.getAllByText(/added/i)[0]).toBeInTheDocument();
    expect(screen.getAllByText(/deleted/i)[0]).toBeInTheDocument();
    expect(screen.getAllByText(/3/i)[0]).toBeInTheDocument();
  });

  it("surfaces review, verify, and apply-readiness posture explicitly instead of reducing the diff to pure code colorization", () => {
    render(<DiffViewerPane {...buildProps()} />);

    expect(screen.getAllByText(/commented/i)[0]).toBeInTheDocument();
    expect(screen.getAllByText(/passed/i)[0]).toBeInTheDocument();
    expect(screen.getAllByText(/warning/i)[0]).toBeInTheDocument();
  });

  it("wires hunk selection to the explicit callback instead of silently mutating local review focus", () => {
    const props = buildProps();
    render(<DiffViewerPane {...props} />);

    fireEvent.click(screen.getByText(/@@ -8,4 \+8,6 @@/i));

    expect(props.onSelectHunk).toHaveBeenCalledTimes(1);
    expect(props.onSelectHunk).toHaveBeenCalledWith("hunk-2");
  });

  it("wires open-file, reveal, navigate, and refresh actions explicitly", () => {
    const props = buildProps();
    render(<DiffViewerPane {...props} />);

    const buttons = screen.getAllByRole("button");
    const openButton = buttons.find((button) => /open/i.test(button.textContent ?? ""));
    const revealButton = buttons.find((button) => /reveal/i.test(button.textContent ?? ""));
    const navigateButton = buttons.find((button) => /navigate/i.test(button.textContent ?? "") || /go to/i.test(button.textContent ?? ""));
    const refreshButton = buttons.find((button) => /refresh/i.test(button.textContent ?? ""));

    expect(openButton).toBeDefined();
    expect(revealButton).toBeDefined();
    expect(navigateButton).toBeDefined();
    expect(refreshButton).toBeDefined();

    fireEvent.click(openButton!);
    fireEvent.click(revealButton!);
    fireEvent.click(navigateButton!);
    fireEvent.click(refreshButton!);

    expect(props.onOpenFileRequested).toHaveBeenCalledTimes(1);
    expect(props.onRevealInTreeRequested).toHaveBeenCalledTimes(1);
    expect(props.onNavigateToHunkRequested).toHaveBeenCalledTimes(1);
    expect(props.onRefreshRequested).toHaveBeenCalledTimes(1);
  });

  it("does not advertise open-file or reveal actions as enabled when capability gates are disabled", () => {
    render(
      <DiffViewerPane
        {...buildProps({
          canOpenFile: false,
          canRevealInTree: false,
        })}
      />,
    );

    const buttons = screen.getAllByRole("button");
    const openButton = buttons.find((button) => /open/i.test(button.textContent ?? ""));
    const revealButton = buttons.find((button) => /reveal/i.test(button.textContent ?? ""));

    expect(openButton).toBeDisabled();
    expect(revealButton).toBeDisabled();
  });

  it("surfaces large-file degraded posture explicitly instead of pretending full diff hydration is safe", () => {
    render(
      <DiffViewerPane
        {...buildProps({
          largeFile: {
            enabled: true,
            decision: "degrade",
            reason: "Large diff forced sampled comparison mode.",
            previewBytes: 65536,
          },
        })}
      />,
    );

    expect(screen.getAllByText(/Large diff forced sampled comparison mode/i)[0]).toBeInTheDocument();
    expect(screen.getAllByText(/large file/i)[0]).toBeInTheDocument();
  });

  it("surfaces denied diff posture explicitly when text comparison is blocked", () => {
    render(
      <DiffViewerPane
        {...buildProps({
          largeFile: {
            enabled: true,
            decision: "deny",
            reason: "Binary-like content denied for textual diff.",
            previewBytes: 0,
          },
        })}
      />,
    );

    expect(screen.getAllByText(/Binary-like content denied for textual diff/i)[0]).toBeInTheDocument();
  });

  it("supports preview mode explicitly without collapsing to editable normal-editor semantics", () => {
    render(
      <DiffViewerPane
        {...buildProps({
          mode: "preview",
        })}
      />,
    );

    expect(screen.getAllByText(/preview/i)[0]).toBeInTheDocument();
  });

  it("supports empty-hunk posture explicitly when a diff file exists but no structured hunks are available", () => {
    render(
      <DiffViewerPane
        {...buildProps({
          hunks: [],
          selectedHunkId: null,
          metrics: {
            totalHunks: 0,
            addedLines: 0,
            deletedLines: 0,
            selectedHunks: 0,
          },
        })}
      />,
    );

    expect(screen.getAllByText(/Diff viewer/i)[0]).toBeInTheDocument();
    expect(screen.queryByText(/@@ -1,3 \+1,3 @@/i)).not.toBeInTheDocument();
  });

  it("renders loading posture explicitly without dropping the diff shell contract", () => {
    render(
      <DiffViewerPane
        {...buildProps({
          loading: true,
        })}
      />,
    );

    expect(screen.getAllByText(/Diff viewer/i)[0]).toBeInTheDocument();
    expect(screen.getAllByText(/Governed original vs modified comparison surface/i)[0]).toBeInTheDocument();
  });

  it("surfaces degraded health posture explicitly instead of assuming diff freshness", () => {
    render(
      <DiffViewerPane
        {...buildProps({
          health: "degraded",
        })}
      />,
    );

    expect(screen.getAllByText(/degraded/i)[0]).toBeInTheDocument();
  });

  it("preserves rename lineage explicitly when old and new paths differ", () => {
    render(
      <DiffViewerPane
        {...buildProps({
          changeKind: "rename",
          oldPath: "/repo/adjutorix-app/src/renderer/OldShell.tsx",
          path: "/repo/adjutorix-app/src/renderer/AppShell.tsx",
        })}
      />,
    );

    expect(screen.getAllByText(/rename/i)[0]).toBeInTheDocument();
    expect(screen.getAllByText(/OldShell\.tsx/i)[0]).toBeInTheDocument();
    expect(screen.getAllByText(/AppShell\.tsx/i)[0]).toBeInTheDocument();
  });

  it("does not collapse the diff shell into only the Monaco surface; metrics, hunks, and controls remain distinct", () => {
    render(<DiffViewerPane {...buildProps()} />);

    expect(screen.getByTestId("monaco-diff-editor-mock")).toBeInTheDocument();
    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(4);
    expect(screen.getAllByText(/@@ -1,3 \+1,3 @@/i)[0]).toBeInTheDocument();
    expect(screen.getAllByText(/added/i)[0]).toBeInTheDocument();
  });
});
