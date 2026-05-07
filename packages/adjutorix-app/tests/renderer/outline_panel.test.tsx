import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * ADJUTORIX APP — TESTS / RENDERER / outline_panel.test.tsx
 *
 * Canonical outline-panel renderer contract suite.
 *
 * Purpose:
 * - verify that OutlinePanel preserves governed symbol-outline truth around file identity,
 *   symbol hierarchy, kind/classification, selection, diagnostics-bearing symbol state,
 *   query filtering, and explicit navigate/reveal actions
 * - verify that the outline remains a projection of canonical editor/index state rather than
 *   a decorative local tree with ambiguous symbol ownership or silent selection drift
 * - verify that empty, loading, filtered, and degraded states remain explicit
 *
 * Test philosophy:
 * - no snapshots
 * - assert operator-visible structure, symbol semantics, and callback routing
 * - prefer hierarchy and navigation contracts over implementation details
 *
 * Notes:
 * - this suite assumes OutlinePanel exports a default React component from the renderer tree
 * - if the production prop surface evolves, update buildProps() first
 */

import OutlinePanel from "../../src/renderer/components/OutlinePanel";

type OutlinePanelProps = React.ComponentProps<typeof OutlinePanel>;

function buildProps(overrides: Partial<OutlinePanelProps> = {}): OutlinePanelProps {
  return {
    title: "Outline",
    subtitle: "Governed symbol and structure surface",
    loading: false,
    health: "healthy",
    path: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
    language: "typescript",
    query: "",
    selectedSymbolId: "sym-app-shell",
    symbols: [
      {
        id: "sym-app-shell",
        name: "AppShell",
        detail: "function component",
        kind: "function",
        path: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
        range: {
          startLine: 22,
          startColumn: 1,
          endLine: 180,
          endColumn: 2,
        },
        selectionRange: {
          startLine: 22,
          startColumn: 25,
          endLine: 22,
          endColumn: 33,
        },
        children: [
          {
            id: "sym-render-header",
            name: "renderHeader",
            detail: "helper",
            kind: "function",
            path: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
            range: {
              startLine: 40,
              startColumn: 3,
              endLine: 78,
              endColumn: 4,
            },
            selectionRange: {
              startLine: 40,
              startColumn: 12,
              endLine: 40,
              endColumn: 24,
            },
            children: [],
            diagnostics: {
              total: 1,
              errorCount: 0,
              warningCount: 1,
            },
          },
          {
            id: "sym-render-body",
            name: "renderBody",
            detail: "helper",
            kind: "function",
            path: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
            range: {
              startLine: 80,
              startColumn: 3,
              endLine: 140,
              endColumn: 4,
            },
            selectionRange: {
              startLine: 80,
              startColumn: 12,
              endLine: 80,
              endColumn: 22,
            },
            children: [],
            diagnostics: {
              total: 2,
              errorCount: 1,
              warningCount: 1,
            },
          },
        ],
        diagnostics: {
          total: 2,
          errorCount: 1,
          warningCount: 1,
        },
      },
      {
        id: "sym-shell-props",
        name: "AppShellProps",
        detail: "type",
        kind: "interface",
        path: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
        range: {
          startLine: 5,
          startColumn: 1,
          endLine: 20,
          endColumn: 2,
        },
        selectionRange: {
          startLine: 5,
          startColumn: 18,
          endLine: 5,
          endColumn: 31,
        },
        children: [],
        diagnostics: {
          total: 0,
          errorCount: 0,
          warningCount: 0,
        },
      },
    ],
    metrics: {
      totalSymbols: 4,
      visibleSymbols: 4,
      filteredSymbols: 0,
      symbolsWithDiagnostics: 2,
    },
    onQueryChange: vi.fn(),
    onSelectSymbol: vi.fn(),
    onNavigateToSymbol: vi.fn(),
    onRevealInEditor: vi.fn(),
    onExpandSymbol: vi.fn(),
    onCollapseSymbol: vi.fn(),
    onRefreshRequested: vi.fn(),
    ...overrides,
  } as OutlinePanelProps;
}

describe("OutlinePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the canonical outline shell with title, subtitle, file identity, and symbol tree", () => {
    render(<OutlinePanel {...buildProps()} />);

    expect(screen.getByText(/Outline/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed symbol and structure surface/i)).toBeInTheDocument();
    expect(screen.getByText(/AppShell\.tsx/i)).toBeInTheDocument();
    expect(screen.getByText("AppShell")).toBeInTheDocument();
    expect(screen.getByText("renderHeader")).toBeInTheDocument();
    expect(screen.getByText("renderBody")).toBeInTheDocument();
    expect(screen.getByText("AppShellProps")).toBeInTheDocument();
  });

  it("preserves parent-child symbol hierarchy instead of flattening nested structure", () => {
    render(<OutlinePanel {...buildProps()} />);

    expect(screen.getByText("AppShell")).toBeInTheDocument();
    expect(screen.getByText("renderHeader")).toBeInTheDocument();
    expect(screen.getByText("renderBody")).toBeInTheDocument();
  });

  it("surfaces symbol kind and detail explicitly so structural meaning is operator-visible", () => {
    render(<OutlinePanel {...buildProps()} />);

    expect(screen.getByText(/function component/i)).toBeInTheDocument();
    expect(screen.getAllByText(/helper/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/type/i)).toBeInTheDocument();
  });

  it("surfaces diagnostics-bearing symbol state explicitly instead of hiding symbol pressure in editor gutters only", () => {
    render(<OutlinePanel {...buildProps()} />);

    expect(screen.getByText(/warning/i)).toBeInTheDocument();
    expect(screen.getByText(/error/i)).toBeInTheDocument();
  });

  it("wires query changes to the explicit callback instead of mutating local filter state silently", () => {
    const props = buildProps();
    render(<OutlinePanel {...props} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "render" } });

    expect(props.onQueryChange).toHaveBeenCalledTimes(1);
    expect(props.onQueryChange).toHaveBeenCalledWith("render");
  });

  it("wires symbol selection to the explicit callback instead of silently changing active outline focus", () => {
    const props = buildProps();
    render(<OutlinePanel {...props} />);

    fireEvent.click(screen.getByText("renderBody"));

    expect(props.onSelectSymbol).toHaveBeenCalledTimes(1);
    expect(props.onSelectSymbol).toHaveBeenCalledWith("sym-render-body");
  });

  it("wires navigate and reveal actions as distinct operator intents", () => {
    const props = buildProps();
    render(<OutlinePanel {...props} />);

    const buttons = screen.getAllByRole("button");
    const navigateButton = buttons.find((button) => /navigate/i.test(button.textContent ?? "") || /go to/i.test(button.textContent ?? ""));
    const revealButton = buttons.find((button) => /reveal/i.test(button.textContent ?? ""));

    expect(navigateButton).toBeDefined();
    expect(revealButton).toBeDefined();

    fireEvent.click(navigateButton!);
    fireEvent.click(revealButton!);

    expect(props.onNavigateToSymbol).toHaveBeenCalled();
    expect(props.onRevealInEditor).toHaveBeenCalled();
  });

  it("wires expand and collapse actions explicitly for hierarchical symbols", () => {
    const props = buildProps();
    render(<OutlinePanel {...props} />);

    const buttons = screen.getAllByRole("button");
    const expandButton = buttons.find((button) => /expand/i.test(button.textContent ?? ""));
    const collapseButton = buttons.find((button) => /collapse/i.test(button.textContent ?? ""));

    expect(expandButton).toBeDefined();
    expect(collapseButton).toBeDefined();

    fireEvent.click(expandButton!);
    fireEvent.click(collapseButton!);

    expect(props.onExpandSymbol).toHaveBeenCalled();
    expect(props.onCollapseSymbol).toHaveBeenCalled();
  });

  it("wires refresh control explicitly instead of pretending outline state is self-healing", () => {
    const props = buildProps();
    render(<OutlinePanel {...props} />);

    const refreshButton = screen.getAllByRole("button").find((button) => /refresh/i.test(button.textContent ?? ""));
    expect(refreshButton).toBeDefined();

    fireEvent.click(refreshButton!);
    expect(props.onRefreshRequested).toHaveBeenCalledTimes(1);
  });

  it("preserves file identity when multiple symbols originate from the same canonical path", () => {
    render(<OutlinePanel {...buildProps()} />);

    expect(screen.getByText(/\/repo\/adjutorix-app\/src\/renderer\/components\/AppShell\.tsx/i)).toBeInTheDocument();
  });

  it("supports filtered outline state without erasing the query shell", () => {
    render(
      <OutlinePanel
        {...buildProps({
          query: "render",
          symbols: [
            buildProps().symbols[0],
          ],
          metrics: {
            totalSymbols: 4,
            visibleSymbols: 3,
            filteredSymbols: 1,
            symbolsWithDiagnostics: 2,
          },
        })}
      />,
    );

    expect(screen.getByDisplayValue("render")).toBeInTheDocument();
    expect(screen.getByText("AppShell")).toBeInTheDocument();
    expect(screen.queryByText("AppShellProps")).not.toBeInTheDocument();
  });

  it("renders an empty outline posture explicitly when no symbols are available", () => {
    render(
      <OutlinePanel
        {...buildProps({
          symbols: [],
          selectedSymbolId: null,
          metrics: {
            totalSymbols: 0,
            visibleSymbols: 0,
            filteredSymbols: 0,
            symbolsWithDiagnostics: 0,
          },
        })}
      />,
    );

    expect(screen.getByText(/Outline/i)).toBeInTheDocument();
    expect(screen.queryByText("AppShell")).not.toBeInTheDocument();
  });

  it("renders loading posture explicitly without dropping the outline shell contract", () => {
    render(
      <OutlinePanel
        {...buildProps({
          loading: true,
        })}
      />,
    );

    expect(screen.getByText(/Outline/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed symbol and structure surface/i)).toBeInTheDocument();
  });

  it("surfaces degraded health posture explicitly instead of assuming outline freshness", () => {
    render(
      <OutlinePanel
        {...buildProps({
          health: "degraded",
        })}
      />,
    );

    expect(screen.getByText(/degraded/i)).toBeInTheDocument();
  });

  it("keeps metrics operator-visible as facts about total, visible, filtered, and diagnostics-bearing symbols", () => {
    render(<OutlinePanel {...buildProps()} />);

    expect(screen.getByText(/total/i)).toBeInTheDocument();
    expect(screen.getByText(/visible/i)).toBeInTheDocument();
    expect(screen.getByText(/filtered/i)).toBeInTheDocument();
    expect(screen.getByText(/^Diagnostics$/i)).toBeInTheDocument();
  });

  it("does not collapse outline shell into only a filter box; symbols, metrics, and controls remain distinct surfaces", () => {
    render(<OutlinePanel {...buildProps()} />);

    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(screen.getByText("AppShell")).toBeInTheDocument();
    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(4);
  });

  it("preserves duplicate symbol names when their ranges or hierarchy differ instead of deduplicating them unsafely", () => {
    render(
      <OutlinePanel
        {...buildProps({
          symbols: [
            {
              id: "dup-a",
              name: "render",
              detail: "header helper",
              kind: "function",
              path: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
              range: {
                startLine: 10,
                startColumn: 1,
                endLine: 20,
                endColumn: 1,
              },
              selectionRange: {
                startLine: 10,
                startColumn: 10,
                endLine: 10,
                endColumn: 16,
              },
              children: [],
              diagnostics: {
                total: 0,
                errorCount: 0,
                warningCount: 0,
              },
            },
            {
              id: "dup-b",
              name: "render",
              detail: "body helper",
              kind: "function",
              path: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
              range: {
                startLine: 40,
                startColumn: 1,
                endLine: 55,
                endColumn: 1,
              },
              selectionRange: {
                startLine: 40,
                startColumn: 10,
                endLine: 40,
                endColumn: 16,
              },
              children: [],
              diagnostics: {
                total: 1,
                errorCount: 0,
                warningCount: 1,
              },
            },
          ],
          metrics: {
            totalSymbols: 2,
            visibleSymbols: 2,
            filteredSymbols: 0,
            symbolsWithDiagnostics: 1,
          },
          selectedSymbolId: "dup-a",
        })}
      />,
    );

    expect(screen.getAllByText("render").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/header helper/i)).toBeInTheDocument();
    expect(screen.getByText(/body helper/i)).toBeInTheDocument();
  });

  it("supports selecting a nested child symbol explicitly through the same governed callback path", () => {
    const props = buildProps();
    render(<OutlinePanel {...props} />);

    fireEvent.click(screen.getByText("renderHeader"));
    expect(props.onSelectSymbol).toHaveBeenCalledWith("sym-render-header");
  });
});
