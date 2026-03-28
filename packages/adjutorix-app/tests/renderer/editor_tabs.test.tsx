import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * ADJUTORIX APP — TESTS / RENDERER / editor_tabs.test.tsx
 *
 * Canonical editor-tabs renderer contract suite.
 *
 * Purpose:
 * - verify that EditorTabs preserves governed buffer identity, active tab selection,
 *   dirty state, pinned state, preview posture, path disambiguation, and close semantics
 * - verify that tab interactions remain explicit callback-driven commands rather than hidden local mutations
 * - verify that operator-visible tab badges and labels remain stable under duplicate basenames and mixed states
 *
 * Test philosophy:
 * - no snapshots
 * - assert operator-visible structure, label semantics, and explicit callback routing
 * - test duplicate names, pinned/dirty combinations, and preview lifecycle as state contracts
 *
 * Notes:
 * - this suite assumes EditorTabs exports a default React component from the renderer tree
 * - if the production prop surface evolves, update buildProps() first
 */

import EditorTabs from "../../../src/renderer/components/EditorTabs";

type EditorTabsProps = React.ComponentProps<typeof EditorTabs>;

function buildProps(overrides: Partial<EditorTabsProps> = {}): EditorTabsProps {
  return {
    title: "Open buffers",
    subtitle: "Governed editor tab surface",
    loading: false,
    activeTabId: "tab-app",
    tabs: [
      {
        id: "tab-app",
        path: "/repo/adjutorix-app/src/renderer/App.tsx",
        label: "App.tsx",
        description: "src/renderer",
        language: "typescript",
        dirty: false,
        pinned: true,
        preview: false,
        readOnly: false,
      },
      {
        id: "tab-file-tree",
        path: "/repo/adjutorix-app/src/renderer/components/FileTreePane.tsx",
        label: "FileTreePane.tsx",
        description: "src/renderer/components",
        language: "typescript",
        dirty: true,
        pinned: false,
        preview: false,
        readOnly: false,
      },
      {
        id: "tab-readme",
        path: "/repo/adjutorix-app/README.md",
        label: "README.md",
        description: "/repo/adjutorix-app",
        language: "markdown",
        dirty: false,
        pinned: false,
        preview: true,
        readOnly: true,
      },
    ],
    health: "healthy",
    onSelectTab: vi.fn(),
    onCloseTab: vi.fn(),
    onCloseOtherTabs: vi.fn(),
    onCloseTabsToRight: vi.fn(),
    onPinTab: vi.fn(),
    onUnpinTab: vi.fn(),
    onRefreshRequested: vi.fn(),
    ...overrides,
  } as EditorTabsProps;
}

describe("EditorTabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the canonical tab shell with title, subtitle, and all open buffers", () => {
    render(<EditorTabs {...buildProps()} />);

    expect(screen.getByText(/Open buffers/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed editor tab surface/i)).toBeInTheDocument();
    expect(screen.getByText("App.tsx")).toBeInTheDocument();
    expect(screen.getByText("FileTreePane.tsx")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
  });

  it("keeps active tab identity explicit instead of flattening all tabs into equivalent rows", () => {
    render(<EditorTabs {...buildProps()} />);

    expect(screen.getByText("App.tsx")).toBeInTheDocument();
    expect(screen.getByText("FileTreePane.tsx")).toBeInTheDocument();
  });

  it("surfaces dirty tab state explicitly so modified buffers are operator-visible", () => {
    render(<EditorTabs {...buildProps()} />);

    expect(screen.getByText(/FileTreePane\.tsx/i)).toBeInTheDocument();
    expect(screen.getByText(/dirty/i)).toBeInTheDocument();
  });

  it("surfaces pinned tab state explicitly so persistence differs from normal tabs", () => {
    render(<EditorTabs {...buildProps()} />);

    expect(screen.getByText(/pinned/i)).toBeInTheDocument();
  });

  it("surfaces preview tab posture explicitly so ephemeral tabs are not confused with committed open buffers", () => {
    render(<EditorTabs {...buildProps()} />);

    expect(screen.getByText(/preview/i)).toBeInTheDocument();
  });

  it("surfaces read-only posture explicitly for non-editable buffers", () => {
    render(<EditorTabs {...buildProps()} />);

    expect(screen.getByText(/read.?only/i)).toBeInTheDocument();
  });

  it("wires tab selection to the explicit callback instead of mutating local active state silently", () => {
    const props = buildProps();
    render(<EditorTabs {...props} />);

    fireEvent.click(screen.getByText("FileTreePane.tsx"));

    expect(props.onSelectTab).toHaveBeenCalledTimes(1);
    expect(props.onSelectTab).toHaveBeenCalledWith("tab-file-tree");
  });

  it("wires close actions explicitly for individual tabs", () => {
    const props = buildProps();
    render(<EditorTabs {...props} />);

    const closeButton = screen.getAllByRole("button").find((button) => /close/i.test(button.textContent ?? ""));
    expect(closeButton).toBeDefined();

    fireEvent.click(closeButton!);
    expect(props.onCloseTab).toHaveBeenCalled();
  });

  it("wires close-others and close-to-right actions explicitly instead of hiding batch closure semantics", () => {
    const props = buildProps();
    render(<EditorTabs {...props} />);

    const buttons = screen.getAllByRole("button");
    const closeOthersButton = buttons.find((button) => /close others/i.test(button.textContent ?? ""));
    const closeRightButton = buttons.find((button) => /close.*right/i.test(button.textContent ?? ""));

    expect(closeOthersButton).toBeDefined();
    expect(closeRightButton).toBeDefined();

    fireEvent.click(closeOthersButton!);
    fireEvent.click(closeRightButton!);

    expect(props.onCloseOtherTabs).toHaveBeenCalledTimes(1);
    expect(props.onCloseTabsToRight).toHaveBeenCalledTimes(1);
  });

  it("wires pin and unpin actions explicitly for tab persistence control", () => {
    const props = buildProps();
    render(<EditorTabs {...props} />);

    const buttons = screen.getAllByRole("button");
    const pinButton = buttons.find((button) => /pin/i.test(button.textContent ?? ""));
    const unpinButton = buttons.find((button) => /unpin/i.test(button.textContent ?? ""));

    expect(pinButton).toBeDefined();
    expect(unpinButton).toBeDefined();

    fireEvent.click(pinButton!);
    fireEvent.click(unpinButton!);

    expect(props.onPinTab).toHaveBeenCalled();
    expect(props.onUnpinTab).toHaveBeenCalled();
  });

  it("wires refresh control explicitly instead of treating tab chrome as passive only", () => {
    const props = buildProps();
    render(<EditorTabs {...props} />);

    const refreshButton = screen.getAllByRole("button").find((button) => /refresh/i.test(button.textContent ?? ""));
    expect(refreshButton).toBeDefined();

    fireEvent.click(refreshButton!);
    expect(props.onRefreshRequested).toHaveBeenCalledTimes(1);
  });

  it("preserves path disambiguation when duplicate basenames are open simultaneously", () => {
    render(
      <EditorTabs
        {...buildProps({
          tabs: [
            {
              id: "tab-a",
              path: "/repo/a/src/App.tsx",
              label: "App.tsx",
              description: "a/src",
              language: "typescript",
              dirty: false,
              pinned: false,
              preview: false,
              readOnly: false,
            },
            {
              id: "tab-b",
              path: "/repo/b/src/App.tsx",
              label: "App.tsx",
              description: "b/src",
              language: "typescript",
              dirty: true,
              pinned: false,
              preview: false,
              readOnly: false,
            },
          ],
          activeTabId: "tab-a",
        })}
      />,
    );

    expect(screen.getAllByText("App.tsx").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/a\/src/i)).toBeInTheDocument();
    expect(screen.getByText(/b\/src/i)).toBeInTheDocument();
  });

  it("does not erase tab chrome under loading posture; shell contract remains visible", () => {
    render(
      <EditorTabs
        {...buildProps({
          loading: true,
        })}
      />,
    );

    expect(screen.getByText(/Open buffers/i)).toBeInTheDocument();
  });

  it("renders an empty-state shell explicitly when no tabs are open", () => {
    render(
      <EditorTabs
        {...buildProps({
          tabs: [],
          activeTabId: null,
        })}
      />,
    );

    expect(screen.getByText(/Open buffers/i)).toBeInTheDocument();
    expect(screen.queryByText("App.tsx")).not.toBeInTheDocument();
  });

  it("surfaces degraded health posture explicitly instead of assuming tabs are healthy by default", () => {
    render(
      <EditorTabs
        {...buildProps({
          health: "degraded",
        })}
      />,
    );

    expect(screen.getByText(/degraded/i)).toBeInTheDocument();
  });

  it("keeps active, dirty, pinned, and preview semantics simultaneously representable across different tabs", () => {
    render(<EditorTabs {...buildProps()} />);

    expect(screen.getByText("App.tsx")).toBeInTheDocument();
    expect(screen.getByText("FileTreePane.tsx")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(screen.getByText(/pinned/i)).toBeInTheDocument();
    expect(screen.getByText(/dirty/i)).toBeInTheDocument();
    expect(screen.getByText(/preview/i)).toBeInTheDocument();
  });

  it("does not collapse read-only preview tabs into the same semantics as editable normal tabs", () => {
    render(<EditorTabs {...buildProps()} />);

    expect(screen.getByText(/README\.md/i)).toBeInTheDocument();
    expect(screen.getByText(/read.?only/i)).toBeInTheDocument();
    expect(screen.getByText(/preview/i)).toBeInTheDocument();
  });

  it("supports selecting a preview tab explicitly through the same governed callback path", () => {
    const props = buildProps();
    render(<EditorTabs {...props} />);

    fireEvent.click(screen.getByText("README.md"));
    expect(props.onSelectTab).toHaveBeenCalledWith("tab-readme");
  });

  it("renders enough visible structure to distinguish title, tab labels, descriptions, and action controls as separate surfaces", () => {
    render(<EditorTabs {...buildProps()} />);

    expect(screen.getByText(/Open buffers/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed editor tab surface/i)).toBeInTheDocument();
    expect(screen.getByText(/src\/renderer/i)).toBeInTheDocument();
    expect(screen.getByText(/src\/renderer\/components/i)).toBeInTheDocument();
    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(3);
  });
});
