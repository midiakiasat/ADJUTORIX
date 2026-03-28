import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * ADJUTORIX APP — TESTS / RENDERER / search_panel.test.tsx
 *
 * Canonical search-panel renderer contract suite.
 *
 * Purpose:
 * - verify that SearchPanel preserves governed search truth around query input, scope,
 *   result provenance, path identity, match context, selection, and explicit open/reveal actions
 * - verify that search results remain a projection of canonical workspace/index state rather than
 *   a local UI-only filter with ambiguous paths or hidden result classes
 * - verify that operator-visible search posture remains explicit under loading, empty, degraded,
 *   and indexed/unindexed states
 *
 * Test philosophy:
 * - no snapshots
 * - assert operator-visible structure, scope semantics, result identity, and callback routing
 * - prefer search-state contracts over implementation details or transient DOM shape
 *
 * Notes:
 * - this suite assumes SearchPanel exports a default React component from the renderer tree
 * - if the production prop surface evolves, update buildProps() first
 */

import SearchPanel from "../../../src/renderer/components/SearchPanel";

type SearchPanelProps = React.ComponentProps<typeof SearchPanel>;

function buildProps(overrides: Partial<SearchPanelProps> = {}): SearchPanelProps {
  return {
    title: "Search",
    subtitle: "Governed workspace and index search surface",
    loading: false,
    query: "AppShell",
    scope: "workspace",
    health: "healthy",
    indexState: "ready",
    totalResultCount: 3,
    selectedResultId: "result-1",
    filters: {
      caseSensitive: false,
      wholeWord: false,
      regex: false,
      includeIgnored: false,
      includeHidden: false,
    },
    results: [
      {
        id: "result-1",
        path: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
        label: "AppShell.tsx",
        description: "src/renderer/components",
        lineNumber: 42,
        column: 7,
        kind: "content",
        excerpt: "export default function AppShell() {",
        matchRanges: [{ start: 24, end: 32 }],
      },
      {
        id: "result-2",
        path: "/repo/adjutorix-app/src/renderer/App.tsx",
        label: "App.tsx",
        description: "src/renderer",
        lineNumber: 12,
        column: 15,
        kind: "content",
        excerpt: "return <AppShell />;",
        matchRanges: [{ start: 8, end: 16 }],
      },
      {
        id: "result-3",
        path: "/repo/adjutorix-app/src/renderer/components/AppShell.test.tsx",
        label: "AppShell.test.tsx",
        description: "src/renderer/components",
        lineNumber: 3,
        column: 1,
        kind: "path",
        excerpt: "packages/adjutorix-app/tests/renderer/app_shell.test.tsx",
        matchRanges: [{ start: 0, end: 8 }],
      },
    ],
    metrics: {
      indexedFiles: 128,
      searchedFiles: 53,
      contentMatches: 2,
      pathMatches: 1,
    },
    onQueryChange: vi.fn(),
    onScopeChange: vi.fn(),
    onSelectResult: vi.fn(),
    onOpenResult: vi.fn(),
    onRevealResult: vi.fn(),
    onToggleCaseSensitive: vi.fn(),
    onToggleWholeWord: vi.fn(),
    onToggleRegex: vi.fn(),
    onToggleIncludeIgnored: vi.fn(),
    onToggleIncludeHidden: vi.fn(),
    onRefreshRequested: vi.fn(),
    ...overrides,
  } as SearchPanelProps;
}

describe("SearchPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the canonical search shell with title, subtitle, query, and result set", () => {
    render(<SearchPanel {...buildProps()} />);

    expect(screen.getByText(/Search/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed workspace and index search surface/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue("AppShell")).toBeInTheDocument();
    expect(screen.getByText("AppShell.tsx")).toBeInTheDocument();
    expect(screen.getByText("App.tsx")).toBeInTheDocument();
    expect(screen.getByText("AppShell.test.tsx")).toBeInTheDocument();
  });

  it("preserves file-path identity and path disambiguation for results with related names", () => {
    render(<SearchPanel {...buildProps()} />);

    expect(screen.getByText(/src\/renderer\/components/i)).toBeInTheDocument();
    expect(screen.getByText(/src\/renderer/i)).toBeInTheDocument();
    expect(screen.getByText(/\/repo\/adjutorix-app\/src\/renderer\/components\/AppShell\.tsx/i)).toBeInTheDocument();
  });

  it("surfaces line and column context explicitly for content results", () => {
    render(<SearchPanel {...buildProps()} />);

    expect(screen.getByText(/42/i)).toBeInTheDocument();
    expect(screen.getByText(/12/i)).toBeInTheDocument();
    expect(screen.getByText(/AppShell\(\)/i)).toBeInTheDocument();
    expect(screen.getByText(/<AppShell/i)).toBeInTheDocument();
  });

  it("distinguishes content matches from path matches instead of flattening result classes", () => {
    render(<SearchPanel {...buildProps()} />);

    expect(screen.getByText(/content/i)).toBeInTheDocument();
    expect(screen.getByText(/path/i)).toBeInTheDocument();
  });

  it("wires query changes to the explicit callback instead of mutating local shadow state", () => {
    const props = buildProps();
    render(<SearchPanel {...props} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "ledger" } });

    expect(props.onQueryChange).toHaveBeenCalledTimes(1);
    expect(props.onQueryChange).toHaveBeenCalledWith("ledger");
  });

  it("wires scope changes to the explicit callback so search domain stays governed", () => {
    const props = buildProps();
    render(<SearchPanel {...props} />);

    const scopeButton = screen.getAllByRole("button").find((button) => /scope/i.test(button.textContent ?? "") || /workspace/i.test(button.textContent ?? ""));
    expect(scopeButton).toBeDefined();

    fireEvent.click(scopeButton!);
    expect(props.onScopeChange).toHaveBeenCalled();
  });

  it("wires result selection to the explicit callback instead of silently mutating row focus", () => {
    const props = buildProps();
    render(<SearchPanel {...props} />);

    fireEvent.click(screen.getByText("App.tsx"));

    expect(props.onSelectResult).toHaveBeenCalledTimes(1);
    expect(props.onSelectResult).toHaveBeenCalledWith("result-2");
  });

  it("wires open and reveal actions as distinct operator intents for the selected result", () => {
    const props = buildProps();
    render(<SearchPanel {...props} />);

    const buttons = screen.getAllByRole("button");
    const openButton = buttons.find((button) => /open/i.test(button.textContent ?? ""));
    const revealButton = buttons.find((button) => /reveal/i.test(button.textContent ?? ""));

    expect(openButton).toBeDefined();
    expect(revealButton).toBeDefined();

    fireEvent.click(openButton!);
    fireEvent.click(revealButton!);

    expect(props.onOpenResult).toHaveBeenCalled();
    expect(props.onRevealResult).toHaveBeenCalled();
  });

  it("wires case, word, regex, hidden, and ignored toggles explicitly", () => {
    const props = buildProps();
    render(<SearchPanel {...props} />);

    const buttons = screen.getAllByRole("button");
    const caseButton = buttons.find((button) => /case/i.test(button.textContent ?? ""));
    const wordButton = buttons.find((button) => /whole/i.test(button.textContent ?? "") || /word/i.test(button.textContent ?? ""));
    const regexButton = buttons.find((button) => /regex/i.test(button.textContent ?? ""));
    const ignoredButton = buttons.find((button) => /ignored/i.test(button.textContent ?? ""));
    const hiddenButton = buttons.find((button) => /hidden/i.test(button.textContent ?? ""));

    expect(caseButton).toBeDefined();
    expect(wordButton).toBeDefined();
    expect(regexButton).toBeDefined();
    expect(ignoredButton).toBeDefined();
    expect(hiddenButton).toBeDefined();

    fireEvent.click(caseButton!);
    fireEvent.click(wordButton!);
    fireEvent.click(regexButton!);
    fireEvent.click(ignoredButton!);
    fireEvent.click(hiddenButton!);

    expect(props.onToggleCaseSensitive).toHaveBeenCalledTimes(1);
    expect(props.onToggleWholeWord).toHaveBeenCalledTimes(1);
    expect(props.onToggleRegex).toHaveBeenCalledTimes(1);
    expect(props.onToggleIncludeIgnored).toHaveBeenCalledTimes(1);
    expect(props.onToggleIncludeHidden).toHaveBeenCalledTimes(1);
  });

  it("wires refresh control explicitly instead of treating result state as self-healing", () => {
    const props = buildProps();
    render(<SearchPanel {...props} />);

    const refreshButton = screen.getAllByRole("button").find((button) => /refresh/i.test(button.textContent ?? ""));
    expect(refreshButton).toBeDefined();

    fireEvent.click(refreshButton!);
    expect(props.onRefreshRequested).toHaveBeenCalledTimes(1);
  });

  it("surfaces index-ready posture explicitly so search trust is visible", () => {
    render(<SearchPanel {...buildProps({ indexState: "ready" })} />);

    expect(screen.getByText(/ready/i)).toBeInTheDocument();
  });

  it("surfaces stale or degraded index posture explicitly instead of pretending all results are current", () => {
    render(
      <SearchPanel
        {...buildProps({
          health: "degraded",
          indexState: "stale",
        })}
      />,
    );

    expect(screen.getByText(/degraded/i)).toBeInTheDocument();
    expect(screen.getByText(/stale/i)).toBeInTheDocument();
  });

  it("renders loading posture explicitly without dropping the search shell contract", () => {
    render(
      <SearchPanel
        {...buildProps({
          loading: true,
        })}
      />,
    );

    expect(screen.getByText(/Search/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue("AppShell")).toBeInTheDocument();
  });

  it("renders empty-result posture explicitly when query is valid but nothing matches", () => {
    render(
      <SearchPanel
        {...buildProps({
          query: "nonexistent-symbol",
          results: [],
          totalResultCount: 0,
          metrics: {
            indexedFiles: 128,
            searchedFiles: 128,
            contentMatches: 0,
            pathMatches: 0,
          },
        })}
      />,
    );

    expect(screen.getByDisplayValue("nonexistent-symbol")).toBeInTheDocument();
    expect(screen.queryByText("AppShell.tsx")).not.toBeInTheDocument();
  });

  it("preserves duplicate basename disambiguation when two different files share the same filename", () => {
    render(
      <SearchPanel
        {...buildProps({
          results: [
            {
              id: "dup-a",
              path: "/repo/a/src/index.ts",
              label: "index.ts",
              description: "a/src",
              lineNumber: 1,
              column: 1,
              kind: "content",
              excerpt: "export const a = 1;",
              matchRanges: [{ start: 13, end: 14 }],
            },
            {
              id: "dup-b",
              path: "/repo/b/src/index.ts",
              label: "index.ts",
              description: "b/src",
              lineNumber: 2,
              column: 3,
              kind: "content",
              excerpt: "export const b = 2;",
              matchRanges: [{ start: 13, end: 14 }],
            },
          ],
          totalResultCount: 2,
          selectedResultId: "dup-a",
        })}
      />,
    );

    expect(screen.getAllByText("index.ts").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/a\/src/i)).toBeInTheDocument();
    expect(screen.getByText(/b\/src/i)).toBeInTheDocument();
  });

  it("keeps metrics operator-visible as facts about indexed and searched scope", () => {
    render(<SearchPanel {...buildProps()} />);

    expect(screen.getByText(/indexed/i)).toBeInTheDocument();
    expect(screen.getByText(/searched/i)).toBeInTheDocument();
    expect(screen.getByText(/content/i)).toBeInTheDocument();
    expect(screen.getByText(/path/i)).toBeInTheDocument();
  });

  it("does not collapse search shell into only a query box; results, metrics, and controls remain distinct surfaces", () => {
    render(<SearchPanel {...buildProps()} />);

    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(screen.getByText("AppShell.tsx")).toBeInTheDocument();
    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(4);
  });
});
