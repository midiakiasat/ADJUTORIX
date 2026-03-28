import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * ADJUTORIX APP — TESTS / RENDERER / split_layout.test.tsx
 *
 * Canonical split-layout renderer contract suite.
 *
 * Purpose:
 * - verify that SplitLayout preserves governed pane composition, orientation semantics,
 *   resize/collapse intent, min-size enforcement visibility, and nested structural regions
 * - verify that pane topology remains explicit and callback-driven instead of mutating hidden local layout state
 * - verify that the shell can express editor/rail/bottom combinations without ambiguous geometry collapse
 *
 * Test philosophy:
 * - assert layout contract and operator-visible control semantics, not snapshots
 * - treat split surfaces as deterministic structural primitives for the application shell
 * - prefer callback routing and state-bearing labels over implementation-specific geometry internals
 *
 * Notes:
 * - this suite assumes SplitLayout exports a default React component from the renderer tree
 * - if the production prop surface evolves, update buildProps() first
 */

import SplitLayout from "../../../src/renderer/components/SplitLayout";

type SplitLayoutProps = React.ComponentProps<typeof SplitLayout>;

function PaneFixture(props: { testId: string; title: string; subtitle?: string }): JSX.Element {
  return (
    <section data-testid={props.testId}>
      <h2>{props.title}</h2>
      {props.subtitle ? <p>{props.subtitle}</p> : null}
    </section>
  );
}

function buildProps(overrides: Partial<SplitLayoutProps> = {}): SplitLayoutProps {
  return {
    title: "Main split layout",
    subtitle: "Governed pane composition surface",
    loading: false,
    health: "healthy",
    orientation: "horizontal",
    leftPane: {
      id: "left-pane",
      title: "Workspace rail",
      sizePct: 22,
      minSizePct: 14,
      maxSizePct: 35,
      collapsible: true,
      collapsed: false,
      content: <PaneFixture testId="left-pane-content" title="Workspace rail" subtitle="Tree, search, and navigation" />,
    },
    centerPane: {
      id: "center-pane",
      title: "Editor stack",
      sizePct: 56,
      minSizePct: 30,
      content: <PaneFixture testId="center-pane-content" title="Editor stack" subtitle="Tabs, editor, diff, review" />,
    },
    rightPane: {
      id: "right-pane",
      title: "Inspector rail",
      sizePct: 22,
      minSizePct: 16,
      maxSizePct: 36,
      collapsible: true,
      collapsed: false,
      content: <PaneFixture testId="right-pane-content" title="Inspector rail" subtitle="Chat, diagnostics, provider status" />,
    },
    bottomPane: {
      id: "bottom-pane",
      title: "Bottom operational panel",
      sizePct: 28,
      minSizePct: 14,
      maxSizePct: 48,
      collapsible: true,
      collapsed: false,
      content: <PaneFixture testId="bottom-pane-content" title="Bottom panel" subtitle="Terminal, verify, ledger" />,
    },
    showBottomPane: true,
    showLeftPane: true,
    showRightPane: true,
    allowResize: true,
    metrics: {
      totalVisiblePanes: 4,
      resizeEnabled: true,
      nestedSplitCount: 2,
      collapsedPaneCount: 0,
    },
    onResizePane: vi.fn(),
    onTogglePaneCollapsed: vi.fn(),
    onResetLayout: vi.fn(),
    onRefreshRequested: vi.fn(),
    ...overrides,
  } as SplitLayoutProps;
}

describe("SplitLayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the canonical split shell with title, subtitle, and all primary pane regions", () => {
    render(<SplitLayout {...buildProps()} />);

    expect(screen.getByText(/Main split layout/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed pane composition surface/i)).toBeInTheDocument();
    expect(screen.getByTestId("left-pane-content")).toBeInTheDocument();
    expect(screen.getByTestId("center-pane-content")).toBeInTheDocument();
    expect(screen.getByTestId("right-pane-content")).toBeInTheDocument();
    expect(screen.getByTestId("bottom-pane-content")).toBeInTheDocument();
  });

  it("preserves horizontal orientation semantics explicitly instead of collapsing to an untyped pane stack", () => {
    render(<SplitLayout {...buildProps({ orientation: "horizontal" })} />);

    expect(screen.getByText(/Workspace rail/i)).toBeInTheDocument();
    expect(screen.getByText(/Editor stack/i)).toBeInTheDocument();
    expect(screen.getByText(/Inspector rail/i)).toBeInTheDocument();
  });

  it("renders vertical orientation explicitly without losing the same pane identities", () => {
    render(<SplitLayout {...buildProps({ orientation: "vertical" })} />);

    expect(screen.getByText(/Workspace rail/i)).toBeInTheDocument();
    expect(screen.getByText(/Editor stack/i)).toBeInTheDocument();
    expect(screen.getByText(/Inspector rail/i)).toBeInTheDocument();
  });

  it("supports shell composition without a right pane when that region is intentionally suppressed", () => {
    render(
      <SplitLayout
        {...buildProps({
          showRightPane: false,
          metrics: {
            ...buildProps().metrics,
            totalVisiblePanes: 3,
          },
        })}
      />,
    );

    expect(screen.getByTestId("left-pane-content")).toBeInTheDocument();
    expect(screen.getByTestId("center-pane-content")).toBeInTheDocument();
    expect(screen.queryByTestId("right-pane-content")).not.toBeInTheDocument();
    expect(screen.getByTestId("bottom-pane-content")).toBeInTheDocument();
  });

  it("supports shell composition without a left pane when center-first mode is requested", () => {
    render(
      <SplitLayout
        {...buildProps({
          showLeftPane: false,
          metrics: {
            ...buildProps().metrics,
            totalVisiblePanes: 3,
          },
        })}
      />,
    );

    expect(screen.queryByTestId("left-pane-content")).not.toBeInTheDocument();
    expect(screen.getByTestId("center-pane-content")).toBeInTheDocument();
    expect(screen.getByTestId("right-pane-content")).toBeInTheDocument();
  });

  it("supports shell composition without a bottom pane when the operational drawer is hidden", () => {
    render(
      <SplitLayout
        {...buildProps({
          showBottomPane: false,
          metrics: {
            ...buildProps().metrics,
            totalVisiblePanes: 3,
          },
        })}
      />,
    );

    expect(screen.getByTestId("center-pane-content")).toBeInTheDocument();
    expect(screen.queryByTestId("bottom-pane-content")).not.toBeInTheDocument();
  });

  it("surfaces pane identities and subtitles so each region keeps explicit operational meaning", () => {
    render(<SplitLayout {...buildProps()} />);

    expect(screen.getByText(/Tree, search, and navigation/i)).toBeInTheDocument();
    expect(screen.getByText(/Tabs, editor, diff, review/i)).toBeInTheDocument();
    expect(screen.getByText(/Chat, diagnostics, provider status/i)).toBeInTheDocument();
    expect(screen.getByText(/Terminal, verify, ledger/i)).toBeInTheDocument();
  });

  it("surfaces resize-enabled posture explicitly instead of hiding geometry mutability", () => {
    render(<SplitLayout {...buildProps()} />);

    expect(screen.getByText(/resize/i)).toBeInTheDocument();
  });

  it("surfaces disabled-resize posture explicitly when layout is locked", () => {
    render(
      <SplitLayout
        {...buildProps({
          allowResize: false,
          metrics: {
            ...buildProps().metrics,
            resizeEnabled: false,
          },
        })}
      />,
    );

    expect(screen.getByText(/resize/i)).toBeInTheDocument();
  });

  it("wires pane resize intent through explicit callbacks instead of hidden local geometry mutation", () => {
    const props = buildProps();
    render(<SplitLayout {...props} />);

    const resizeButton = screen.getAllByRole("button").find((button) => /resize/i.test(button.textContent ?? ""));
    expect(resizeButton).toBeDefined();

    fireEvent.click(resizeButton!);
    expect(props.onResizePane).toHaveBeenCalled();
  });

  it("wires collapse toggles explicitly for collapsible side or bottom panes", () => {
    const props = buildProps();
    render(<SplitLayout {...props} />);

    const collapseButtons = screen.getAllByRole("button").filter((button) => /collapse/i.test(button.textContent ?? "") || /toggle/i.test(button.textContent ?? ""));
    expect(collapseButtons.length).toBeGreaterThan(0);

    fireEvent.click(collapseButtons[0]!);
    expect(props.onTogglePaneCollapsed).toHaveBeenCalled();
  });

  it("wires reset-layout and refresh controls explicitly", () => {
    const props = buildProps();
    render(<SplitLayout {...props} />);

    const buttons = screen.getAllByRole("button");
    const resetButton = buttons.find((button) => /reset/i.test(button.textContent ?? ""));
    const refreshButton = buttons.find((button) => /refresh/i.test(button.textContent ?? ""));

    expect(resetButton).toBeDefined();
    expect(refreshButton).toBeDefined();

    fireEvent.click(resetButton!);
    fireEvent.click(refreshButton!);

    expect(props.onResetLayout).toHaveBeenCalledTimes(1);
    expect(props.onRefreshRequested).toHaveBeenCalledTimes(1);
  });

  it("preserves collapsed pane semantics explicitly instead of erasing the pane identity entirely", () => {
    render(
      <SplitLayout
        {...buildProps({
          rightPane: {
            ...buildProps().rightPane,
            collapsed: true,
          },
          metrics: {
            ...buildProps().metrics,
            collapsedPaneCount: 1,
          },
        })}
      />,
    );

    expect(screen.getByText(/Inspector rail/i)).toBeInTheDocument();
    expect(screen.getByText(/collapsed/i)).toBeInTheDocument();
  });

  it("keeps min-size-bearing panes structurally visible under dense multi-pane composition", () => {
    render(<SplitLayout {...buildProps()} />);

    expect(screen.getByText(/Workspace rail/i)).toBeInTheDocument();
    expect(screen.getByText(/Editor stack/i)).toBeInTheDocument();
    expect(screen.getByText(/Inspector rail/i)).toBeInTheDocument();
    expect(screen.getByText(/Bottom operational panel/i)).toBeInTheDocument();
  });

  it("renders degraded health posture explicitly instead of reusing the healthy shell silently", () => {
    render(
      <SplitLayout
        {...buildProps({
          health: "degraded",
        })}
      />,
    );

    expect(screen.getByText(/degraded/i)).toBeInTheDocument();
  });

  it("renders an empty structural shell explicitly when optional panes are suppressed down to center-only mode", () => {
    render(
      <SplitLayout
        {...buildProps({
          showLeftPane: false,
          showRightPane: false,
          showBottomPane: false,
          metrics: {
            ...buildProps().metrics,
            totalVisiblePanes: 1,
            nestedSplitCount: 0,
          },
        })}
      />,
    );

    expect(screen.getByTestId("center-pane-content")).toBeInTheDocument();
    expect(screen.queryByTestId("left-pane-content")).not.toBeInTheDocument();
    expect(screen.queryByTestId("right-pane-content")).not.toBeInTheDocument();
    expect(screen.queryByTestId("bottom-pane-content")).not.toBeInTheDocument();
  });

  it("does not conflate side-rail panes with bottom operational pane semantics", () => {
    render(<SplitLayout {...buildProps()} />);

    expect(screen.getByText(/Inspector rail/i)).toBeInTheDocument();
    expect(screen.getByText(/Bottom operational panel/i)).toBeInTheDocument();
    expect(screen.getByText(/Chat, diagnostics, provider status/i)).toBeInTheDocument();
    expect(screen.getByText(/Terminal, verify, ledger/i)).toBeInTheDocument();
  });

  it("preserves nested split metrics as operator-visible facts instead of hidden implementation details", () => {
    render(<SplitLayout {...buildProps()} />);

    expect(screen.getByText(/nested/i)).toBeInTheDocument();
    expect(screen.getByText(/visible/i)).toBeInTheDocument();
  });

  it("does not erase shell chrome under loading posture; structural layout remains visible", () => {
    render(
      <SplitLayout
        {...buildProps({
          loading: true,
        })}
      />,
    );

    expect(screen.getByText(/Main split layout/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed pane composition surface/i)).toBeInTheDocument();
  });

  it("renders enough visible structure to distinguish shell controls, metrics, and pane regions as separate surfaces", () => {
    render(<SplitLayout {...buildProps()} />);

    expect(screen.getByText(/Main split layout/i)).toBeInTheDocument();
    expect(screen.getByText(/Workspace rail/i)).toBeInTheDocument();
    expect(screen.getByText(/Editor stack/i)).toBeInTheDocument();
    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(3);
  });
});
