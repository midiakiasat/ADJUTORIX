import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * ADJUTORIX APP — TESTS / RENDERER / monaco_editor_pane.test.tsx
 *
 * Canonical MonacoEditorPane renderer contract suite.
 *
 * Purpose:
 * - verify that MonacoEditorPane preserves governed editor truth around model identity,
 *   selected path, dirty state, read-only posture, diagnostics pressure, diff/preview posture,
 *   large-file degradation, and explicit operator actions
 * - verify that editor shell actions remain callback-driven rather than hidden inside a Monaco wrapper
 * - verify that content state, status surfaces, and mode switches remain operator-visible
 *
 * Test philosophy:
 * - do not snapshot the editor shell
 * - aggressively mock Monaco integration and assert structural/editor governance contracts
 * - focus on operator-visible semantics and explicit callback routing
 *
 * Notes:
 * - this suite assumes MonacoEditorPane exports a default React component from the renderer tree
 * - the Monaco child/editor implementation is mocked so the test targets pane behavior and contract
 * - if the production prop surface evolves, update buildProps() first
 */

import MonacoEditorPane from "../../../src/renderer/components/MonacoEditorPane";

type MonacoEditorPaneProps = React.ComponentProps<typeof MonacoEditorPane>;

vi.mock("@monaco-editor/react", () => ({
  default: (props: Record<string, unknown>) => (
    <section data-testid="monaco-react-editor">
      <div>MockMonacoEditor</div>
      <pre data-testid="monaco-react-editor-props">{JSON.stringify(props, null, 2)}</pre>
    </section>
  ),
  DiffEditor: (props: Record<string, unknown>) => (
    <section data-testid="monaco-react-diff-editor">
      <div>MockMonacoDiffEditor</div>
      <pre data-testid="monaco-react-diff-editor-props">{JSON.stringify(props, null, 2)}</pre>
    </section>
  ),
}));

function buildProps(overrides: Partial<MonacoEditorPaneProps> = {}): MonacoEditorPaneProps {
  return {
    title: "Editor",
    subtitle: "Governed Monaco editing surface",
    loading: false,
    path: "/repo/adjutorix-app/src/renderer/App.tsx",
    language: "typescript",
    value: "export default function App() {\n  return <div>ADJUTORIX</div>;\n}\n",
    baselineValue: "export default function App() {\n  return <div>ADJUTORIX</div>;\n}\n",
    dirty: false,
    readOnly: false,
    largeFile: {
      enabled: false,
      decision: "allow",
      reason: null,
      previewBytes: null,
    },
    diagnostics: {
      total: 3,
      fatalCount: 0,
      errorCount: 1,
      warningCount: 1,
      infoCount: 1,
    },
    selection: {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
      selectionStartLineNumber: 1,
      selectionStartColumn: 1,
      positionLineNumber: 1,
      positionColumn: 1,
    },
    mode: "editor",
    canSave: true,
    canRevert: true,
    canFormat: true,
    canRevealInTree: true,
    canOpenDiff: true,
    health: "healthy",
    statusBadges: [
      { id: "lang", label: "TypeScript", tone: "accent" },
      { id: "trust", label: "Trusted", tone: "success" },
      { id: "diag", label: "1 Error", tone: "warning" },
    ],
    onChange: vi.fn(),
    onSaveRequested: vi.fn(),
    onRevertRequested: vi.fn(),
    onFormatRequested: vi.fn(),
    onRevealInTreeRequested: vi.fn(),
    onOpenDiffRequested: vi.fn(),
    onRefreshRequested: vi.fn(),
    onSelectionChange: vi.fn(),
    ...overrides,
  } as MonacoEditorPaneProps;
}

describe("MonacoEditorPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the canonical editor shell with title, subtitle, path, and Monaco editor host", () => {
    render(<MonacoEditorPane {...buildProps()} />);

    expect(screen.getByText(/Editor/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed Monaco editing surface/i)).toBeInTheDocument();
    expect(screen.getByText(/\/repo\/adjutorix-app\/src\/renderer\/App\.tsx/i)).toBeInTheDocument();
    expect(screen.getByTestId("monaco-react-editor")).toBeInTheDocument();
  });

  it("passes canonical model inputs into Monaco when in normal editor mode", () => {
    render(<MonacoEditorPane {...buildProps()} />);

    const propsJson = screen.getByTestId("monaco-react-editor-props").textContent ?? "{}";
    expect(propsJson).toMatch(/typescript/);
    expect(propsJson).toMatch(/ADJUTORIX/);
  });

  it("renders diff mode explicitly through the diff editor instead of reusing the standard editor shell", () => {
    render(
      <MonacoEditorPane
        {...buildProps({
          mode: "diff",
          modifiedValue: "export default function App() {\n  return <main>ADJUTORIX</main>;\n}\n",
          originalValue: "export default function App() {\n  return <div>ADJUTORIX</div>;\n}\n",
        })}
      />,
    );

    expect(screen.getByTestId("monaco-react-diff-editor")).toBeInTheDocument();
    expect(screen.queryByTestId("monaco-react-editor")).not.toBeInTheDocument();
  });

  it("surfaces dirty state explicitly instead of hiding it inside Monaco model internals", () => {
    render(
      <MonacoEditorPane
        {...buildProps({
          dirty: true,
          value: "export default function App() {\n  return <section>Changed</section>;\n}\n",
        })}
      />,
    );

    expect(screen.getByText(/dirty/i)).toBeInTheDocument();
  });

  it("surfaces read-only posture explicitly and still renders the current file path", () => {
    render(
      <MonacoEditorPane
        {...buildProps({
          readOnly: true,
          canSave: false,
          canFormat: false,
        })}
      />,
    );

    expect(screen.getByText(/read.?only/i)).toBeInTheDocument();
    expect(screen.getByText(/App\.tsx/i)).toBeInTheDocument();
  });

  it("surfaces large-file degradation explicitly instead of pretending full editing is safe", () => {
    render(
      <MonacoEditorPane
        {...buildProps({
          readOnly: true,
          largeFile: {
            enabled: true,
            decision: "degrade",
            reason: "File exceeds editor hydration threshold; preview-only mode enforced.",
            previewBytes: 65536,
          },
          canSave: false,
          canFormat: false,
        })}
      />,
    );

    expect(screen.getByText(/preview-only mode enforced/i)).toBeInTheDocument();
    expect(screen.getByText(/large file/i)).toBeInTheDocument();
  });

  it("surfaces blocked large-file posture explicitly when editing is denied", () => {
    render(
      <MonacoEditorPane
        {...buildProps({
          mode: "preview",
          readOnly: true,
          largeFile: {
            enabled: true,
            decision: "deny",
            reason: "Binary-like content denied for text editing.",
            previewBytes: 0,
          },
          canSave: false,
          canOpenDiff: false,
        })}
      />,
    );

    expect(screen.getByText(/Binary-like content denied for text editing/i)).toBeInTheDocument();
  });

  it("surfaces diagnostics counts as operator-visible facts rather than editor-internal decorations", () => {
    render(<MonacoEditorPane {...buildProps()} />);

    expect(screen.getByText(/1 Error/i)).toBeInTheDocument();
    expect(screen.getByText(/TypeScript/i)).toBeInTheDocument();
    expect(screen.getByText(/Trusted/i)).toBeInTheDocument();
  });

  it("wires save, revert, format, reveal, diff, and refresh actions to explicit callbacks", () => {
    const props = buildProps({ dirty: true });
    render(<MonacoEditorPane {...props} />);

    const buttons = screen.getAllByRole("button");
    const saveButton = buttons.find((button) => /save/i.test(button.textContent ?? ""));
    const revertButton = buttons.find((button) => /revert/i.test(button.textContent ?? ""));
    const formatButton = buttons.find((button) => /format/i.test(button.textContent ?? ""));
    const revealButton = buttons.find((button) => /reveal/i.test(button.textContent ?? ""));
    const diffButton = buttons.find((button) => /diff/i.test(button.textContent ?? ""));
    const refreshButton = buttons.find((button) => /refresh/i.test(button.textContent ?? ""));

    expect(saveButton).toBeDefined();
    expect(revertButton).toBeDefined();
    expect(formatButton).toBeDefined();
    expect(revealButton).toBeDefined();
    expect(diffButton).toBeDefined();
    expect(refreshButton).toBeDefined();

    fireEvent.click(saveButton!);
    fireEvent.click(revertButton!);
    fireEvent.click(formatButton!);
    fireEvent.click(revealButton!);
    fireEvent.click(diffButton!);
    fireEvent.click(refreshButton!);

    expect(props.onSaveRequested).toHaveBeenCalledTimes(1);
    expect(props.onRevertRequested).toHaveBeenCalledTimes(1);
    expect(props.onFormatRequested).toHaveBeenCalledTimes(1);
    expect(props.onRevealInTreeRequested).toHaveBeenCalledTimes(1);
    expect(props.onOpenDiffRequested).toHaveBeenCalledTimes(1);
    expect(props.onRefreshRequested).toHaveBeenCalledTimes(1);
  });

  it("does not advertise save or format actions as enabled when pane is read-only", () => {
    render(
      <MonacoEditorPane
        {...buildProps({
          readOnly: true,
          canSave: false,
          canFormat: false,
        })}
      />,
    );

    const buttons = screen.getAllByRole("button");
    const saveButton = buttons.find((button) => /save/i.test(button.textContent ?? ""));
    const formatButton = buttons.find((button) => /format/i.test(button.textContent ?? ""));

    expect(saveButton).toBeDisabled();
    expect(formatButton).toBeDisabled();
  });

  it("preserves path identity even when switching between editor and diff modes", () => {
    const { rerender } = render(<MonacoEditorPane {...buildProps()} />);
    expect(screen.getByText(/App\.tsx/i)).toBeInTheDocument();

    rerender(
      <MonacoEditorPane
        {...buildProps({
          mode: "diff",
          modifiedValue: "changed",
          originalValue: "original",
        })}
      />,
    );

    expect(screen.getByText(/App\.tsx/i)).toBeInTheDocument();
    expect(screen.getByTestId("monaco-react-diff-editor")).toBeInTheDocument();
  });

  it("surfaces preview mode explicitly instead of pretending preview is a full editable session", () => {
    render(
      <MonacoEditorPane
        {...buildProps({
          mode: "preview",
          readOnly: true,
          canSave: false,
          canFormat: false,
        })}
      />,
    );

    expect(screen.getByText(/preview/i)).toBeInTheDocument();
  });

  it("renders loading posture explicitly without dropping the editor shell contract", () => {
    render(
      <MonacoEditorPane
        {...buildProps({
          loading: true,
        })}
      />,
    );

    expect(screen.getByText(/Editor/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed Monaco editing surface/i)).toBeInTheDocument();
  });

  it("keeps baseline-aware dirty posture visible when current value diverges from baseline", () => {
    render(
      <MonacoEditorPane
        {...buildProps({
          dirty: true,
          value: "export default function App() {\n  return <aside>Mutated</aside>;\n}\n",
          baselineValue: "export default function App() {\n  return <div>ADJUTORIX</div>;\n}\n",
        })}
      />,
    );

    expect(screen.getByText(/dirty/i)).toBeInTheDocument();
  });

  it("does not erase diagnostics-bearing status when health is degraded", () => {
    render(
      <MonacoEditorPane
        {...buildProps({
          health: "degraded",
          diagnostics: {
            total: 7,
            fatalCount: 1,
            errorCount: 3,
            warningCount: 2,
            infoCount: 1,
          },
          statusBadges: [
            { id: "health", label: "Degraded", tone: "warning" },
            { id: "diag", label: "3 Errors", tone: "danger" },
          ],
        })}
      />,
    );

    expect(screen.getByText(/Degraded/i)).toBeInTheDocument();
    expect(screen.getByText(/3 Errors/i)).toBeInTheDocument();
  });

  it("renders enough visible structure to distinguish title, path, badges, and Monaco surface as separate shells", () => {
    render(<MonacoEditorPane {...buildProps()} />);

    expect(screen.getByText(/Editor/i)).toBeInTheDocument();
    expect(screen.getByText(/App\.tsx/i)).toBeInTheDocument();
    expect(screen.getByText(/TypeScript/i)).toBeInTheDocument();
    expect(screen.getByTestId("monaco-react-editor")).toBeInTheDocument();
  });
});
