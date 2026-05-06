import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * ADJUTORIX APP — TESTS / RENDERER / file_tree_pane.test.tsx
 *
 * Canonical file-tree renderer contract suite.
 *
 * Purpose:
 * - verify that FileTreePane preserves governed workspace visibility, hierarchy, selection,
 *   expansion, ignored/hidden semantics, and operator-triggered navigation actions
 * - verify that the tree remains a projection of workspace truth rather than a local shadow model
 * - verify that status-bearing entry attributes remain visible and actionable under mixed conditions
 *
 * Test philosophy:
 * - assert operator-visible structure and callback wiring, not snapshots
 * - test hierarchy, filtering, and entry-state semantics as behavioral contracts
 * - use representative workspace trees with nested directories, ignored files, hidden files,
 *   and selected/opened paths
 *
 * Notes:
 * - this suite assumes FileTreePane exports a default React component from the renderer tree
 * - if the production prop surface evolves, update buildProps() first
 */

import FileTreePane from "../../src/renderer/components/FileTreePane";

type FileTreePaneProps = React.ComponentProps<typeof FileTreePane>;

function buildProps(overrides: Partial<FileTreePaneProps> = {}): FileTreePaneProps {
  return {
    title: "Workspace tree",
    subtitle: "Governed file visibility and selection surface",
    loading: false,
    workspaceRoot: "/repo/adjutorix-app",
    entries: [
      {
        path: "/repo/adjutorix-app",
        name: "adjutorix-app",
        kind: "directory",
        parentPath: null,
        depth: 0,
        hidden: false,
        ignored: false,
        childCount: 4,
      },
      {
        path: "/repo/adjutorix-app/src",
        name: "src",
        kind: "directory",
        parentPath: "/repo/adjutorix-app",
        depth: 1,
        hidden: false,
        ignored: false,
        childCount: 3,
      },
      {
        path: "/repo/adjutorix-app/src/renderer",
        name: "renderer",
        kind: "directory",
        parentPath: "/repo/adjutorix-app/src",
        depth: 2,
        hidden: false,
        ignored: false,
        childCount: 2,
      },
      {
        path: "/repo/adjutorix-app/src/renderer/App.tsx",
        name: "App.tsx",
        kind: "file",
        parentPath: "/repo/adjutorix-app/src/renderer",
        depth: 3,
        hidden: false,
        ignored: false,
        extension: ".tsx",
        sizeBytes: 4096,
      },
      {
        path: "/repo/adjutorix-app/src/renderer/components",
        name: "components",
        kind: "directory",
        parentPath: "/repo/adjutorix-app/src/renderer",
        depth: 3,
        hidden: false,
        ignored: false,
        childCount: 1,
      },
      {
        path: "/repo/adjutorix-app/src/renderer/components/FileTreePane.tsx",
        name: "FileTreePane.tsx",
        kind: "file",
        parentPath: "/repo/adjutorix-app/src/renderer/components",
        depth: 4,
        hidden: false,
        ignored: false,
        extension: ".tsx",
        sizeBytes: 8192,
      },
      {
        path: "/repo/adjutorix-app/.env.local",
        name: ".env.local",
        kind: "file",
        parentPath: "/repo/adjutorix-app",
        depth: 1,
        hidden: true,
        ignored: false,
        extension: ".local",
        sizeBytes: 256,
      },
      {
        path: "/repo/adjutorix-app/node_modules",
        name: "node_modules",
        kind: "directory",
        parentPath: "/repo/adjutorix-app",
        depth: 1,
        hidden: false,
        ignored: true,
        childCount: 1200,
      },
      {
        path: "/repo/adjutorix-app/README.md",
        name: "README.md",
        kind: "file",
        parentPath: "/repo/adjutorix-app",
        depth: 1,
        hidden: false,
        ignored: false,
        extension: ".md",
        sizeBytes: 1024,
      },
    ],
    selectedPath: "/repo/adjutorix-app/src/renderer/App.tsx",
    openedPaths: [
      "/repo/adjutorix-app/src/renderer/App.tsx",
      "/repo/adjutorix-app/src/renderer/components/FileTreePane.tsx",
    ],
    expandedPaths: [
      "/repo/adjutorix-app",
      "/repo/adjutorix-app/src",
      "/repo/adjutorix-app/src/renderer",
      "/repo/adjutorix-app/src/renderer/components",
    ],
    showHidden: true,
    showIgnored: true,
    filterQuery: "",
    health: "healthy",
    metrics: {
      totalEntries: 9,
      visibleEntries: 9,
      hiddenEntries: 1,
      ignoredEntries: 1,
      openedEntries: 2,
    },
    onSelectPath: vi.fn(),
    onToggleExpandedPath: vi.fn(),
    onOpenPath: vi.fn(),
    onRevealInTree: vi.fn(),
    onFilterQueryChange: vi.fn(),
    onToggleShowHidden: vi.fn(),
    onToggleShowIgnored: vi.fn(),
    onRefreshRequested: vi.fn(),
    ...overrides,
  } as FileTreePaneProps;
}

describe("FileTreePane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the canonical tree shell with title, subtitle, and core workspace entries", () => {
    render(<FileTreePane {...buildProps()} />);

    expect(screen.getByText(/Workspace tree/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed file visibility and selection surface/i)).toBeInTheDocument();
    expect(screen.getByText("adjutorix-app")).toBeInTheDocument();
    expect(screen.getByText("src")).toBeInTheDocument();
    expect(screen.getByText("renderer")).toBeInTheDocument();
    expect(screen.getByText("App.tsx")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
  });

  it("surfaces hidden and ignored entries when both visibility toggles are enabled", () => {
    render(<FileTreePane {...buildProps()} />);

    expect(screen.getByText(".env.local")).toBeInTheDocument();
    expect(screen.getByText("node_modules")).toBeInTheDocument();
  });

  it("suppresses hidden entries when showHidden is false", () => {
    render(
      <FileTreePane
        {...buildProps({
          showHidden: false,
          entries: buildProps().entries.filter((entry) => !entry.hidden),
          metrics: {
            ...buildProps().metrics,
            visibleEntries: 8,
          },
        })}
      />,
    );

    expect(screen.queryByText(".env.local")).not.toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
  });

  it("suppresses ignored entries when showIgnored is false", () => {
    render(
      <FileTreePane
        {...buildProps({
          showIgnored: false,
          entries: buildProps().entries.filter((entry) => !entry.ignored),
          metrics: {
            ...buildProps().metrics,
            visibleEntries: 8,
          },
        })}
      />,
    );

    expect(screen.queryByText("node_modules")).not.toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
  });

  it("wires primary filter query changes to the explicit callback", () => {
    const props = buildProps();
    render(<FileTreePane {...props} />);

    const filterInput = screen.getByRole("textbox");
    fireEvent.change(filterInput, { target: { value: "App" } });

    expect(props.onFilterQueryChange).toHaveBeenCalledTimes(1);
    expect(props.onFilterQueryChange).toHaveBeenCalledWith("App");
  });

  it("wires show-hidden and show-ignored toggles to explicit callbacks", () => {
    const props = buildProps();
    render(<FileTreePane {...props} />);

    const buttons = screen.getAllByRole("button");
    const showHiddenButton = buttons.find((button) => /hidden/i.test(button.textContent ?? ""));
    const showIgnoredButton = buttons.find((button) => /ignored/i.test(button.textContent ?? ""));

    expect(showHiddenButton).toBeDefined();
    expect(showIgnoredButton).toBeDefined();

    fireEvent.click(showHiddenButton!);
    fireEvent.click(showIgnoredButton!);

    expect(props.onToggleShowHidden).toHaveBeenCalledTimes(1);
    expect(props.onToggleShowIgnored).toHaveBeenCalledTimes(1);
  });

  it("wires refresh control explicitly instead of burying reload behind passive render state", () => {
    const props = buildProps();
    render(<FileTreePane {...props} />);

    const refreshButton = screen.getAllByRole("button").find((button) => /refresh/i.test(button.textContent ?? ""));
    expect(refreshButton).toBeDefined();

    fireEvent.click(refreshButton!);
    expect(props.onRefreshRequested).toHaveBeenCalledTimes(1);
  });

  it("wires path selection to the explicit select callback for file entries", () => {
    const props = buildProps();
    render(<FileTreePane {...props} />);

    const fileRow = screen.getByText("App.tsx");
    fireEvent.click(fileRow);

    expect(props.onSelectPath).toHaveBeenCalled();
    expect(props.onSelectPath).toHaveBeenCalledWith("/repo/adjutorix-app/src/renderer/App.tsx");
  });

  it("opens file entries on single click while keeping directory clicks selection-only", () => {
    const props = buildProps();
    render(<FileTreePane {...props} />);

    fireEvent.click(screen.getByText("App.tsx"));

    expect(props.onSelectPath).toHaveBeenCalledWith("/repo/adjutorix-app/src/renderer/App.tsx");
    expect(props.onOpenPath).toHaveBeenCalledWith("/repo/adjutorix-app/src/renderer/App.tsx");

    vi.clearAllMocks();

    fireEvent.click(screen.getByText("src"));

    expect(props.onSelectPath).toHaveBeenCalledWith("/repo/adjutorix-app/src");
    expect(props.onOpenPath).not.toHaveBeenCalled();
  });

  it("wires directory expansion toggles explicitly instead of mutating local tree state silently", () => {
    const props = buildProps();
    render(<FileTreePane {...props} />);

    const directoryRow = screen.getByText("renderer");
    fireEvent.doubleClick(directoryRow);

    expect(props.onToggleExpandedPath).toHaveBeenCalled();
    expect(props.onToggleExpandedPath).toHaveBeenCalledWith("/repo/adjutorix-app/src/renderer");
  });

  it("keeps selected and opened files simultaneously visible so the operator can distinguish focus from openness", () => {
    render(<FileTreePane {...buildProps()} />);

    expect(screen.getByText("App.tsx")).toBeInTheDocument();
    expect(screen.getByText("FileTreePane.tsx")).toBeInTheDocument();
  });

  it("preserves nested hierarchy visibility for expanded ancestor paths", () => {
    render(<FileTreePane {...buildProps()} />);

    const root = screen.getByText("adjutorix-app");
    const src = screen.getByText("src");
    const renderer = screen.getByText("renderer");
    const components = screen.getByText("components");
    const nestedFile = screen.getByText("FileTreePane.tsx");

    expect(root).toBeInTheDocument();
    expect(src).toBeInTheDocument();
    expect(renderer).toBeInTheDocument();
    expect(components).toBeInTheDocument();
    expect(nestedFile).toBeInTheDocument();
  });

  it("does not leak collapsed descendants when a parent is not expanded", () => {
    render(
      <FileTreePane
        {...buildProps({
          expandedPaths: ["/repo/adjutorix-app"],
          entries: buildProps().entries.filter(
            (entry) =>
              entry.path === "/repo/adjutorix-app" ||
              entry.parentPath === "/repo/adjutorix-app",
          ),
        })}
      />,
    );

    expect(screen.getByText("src")).toBeInTheDocument();
    expect(screen.queryByText("renderer")).not.toBeInTheDocument();
    expect(screen.queryByText("App.tsx")).not.toBeInTheDocument();
  });

  it("surfaces metrics for total, hidden, ignored, and opened entries as operator-facing facts", () => {
    render(<FileTreePane {...buildProps()} />);

    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("Hidden")).toBeInTheDocument();
    expect(screen.getByText("Ignored")).toBeInTheDocument();
    expect(screen.getByText("Opened")).toBeInTheDocument();
  });

  it("renders a degraded health posture explicitly instead of reusing the healthy empty-state shell", () => {
    render(
      <FileTreePane
        {...buildProps({
          health: "degraded",
          metrics: {
            ...buildProps().metrics,
            ignoredEntries: 4,
          },
        })}
      />,
    );

    expect(screen.getByText(/degraded/i)).toBeInTheDocument();
  });

  it("renders an empty tree state explicitly when no entries are available", () => {
    render(
      <FileTreePane
        {...buildProps({
          entries: [],
          metrics: {
            totalEntries: 0,
            visibleEntries: 0,
            hiddenEntries: 0,
            ignoredEntries: 0,
            openedEntries: 0,
          },
          selectedPath: null,
          openedPaths: [],
          expandedPaths: [],
        })}
      />,
    );

    expect(screen.queryByText("App.tsx")).not.toBeInTheDocument();
    expect(screen.getByText(/workspace tree/i)).toBeInTheDocument();
  });

  it("renders a loading posture explicitly without pretending the tree is ready", () => {
    render(
      <FileTreePane
        {...buildProps({
          loading: true,
        })}
      />,
    );

    expect(screen.getByText(/workspace tree/i)).toBeInTheDocument();
  });

  it("supports reveal and open actions as distinct operator intents for a selected path", () => {
    const props = buildProps();
    render(<FileTreePane {...props} />);

    const buttons = screen.getAllByRole("button");
    const revealButton = buttons.find((button) => /reveal/i.test(button.textContent ?? ""));
    const openButton = buttons.find((button) => /open/i.test(button.textContent ?? "") && !/open workspace/i.test(button.textContent ?? ""));

    expect(revealButton).toBeDefined();
    expect(openButton).toBeDefined();

    fireEvent.click(revealButton!);
    fireEvent.click(openButton!);

    expect(props.onRevealInTree).toHaveBeenCalled();
    expect(props.onOpenPath).toHaveBeenCalled();
  });

  it("retains both file and directory rows under the same parent without flattening type semantics", () => {
    render(<FileTreePane {...buildProps()} />);

    expect(screen.getByText("components")).toBeInTheDocument();
    expect(screen.getByText("App.tsx")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
  });

  it("does not conflate hidden with ignored entries when both exist under the same workspace root", () => {
    render(<FileTreePane {...buildProps()} />);

    const hiddenEntry = screen.getByText(".env.local");
    const ignoredEntry = screen.getByText("node_modules");

    expect(hiddenEntry).toBeInTheDocument();
    expect(ignoredEntry).toBeInTheDocument();
    expect(hiddenEntry.textContent).not.toEqual(ignoredEntry.textContent);
  });

  it("keeps workspace root visible as the anchor node rather than only rendering descendants", () => {
    render(<FileTreePane {...buildProps()} />);

    expect(screen.getByText("adjutorix-app")).toBeInTheDocument();
    expect(screen.getByText(/\/repo\/adjutorix-app/i)).toBeInTheDocument();
  });

  it("preserves operator-visible search narrowing when entries are filtered upstream", () => {
    render(
      <FileTreePane
        {...buildProps({
          filterQuery: "FileTree",
          entries: buildProps().entries.filter((entry) => entry.name.includes("FileTree") || entry.kind === "directory"),
          metrics: {
            ...buildProps().metrics,
            visibleEntries: 5,
          },
        })}
      />,
    );

    expect(screen.getByText("FileTreePane.tsx")).toBeInTheDocument();
    expect(screen.queryByText("README.md")).not.toBeInTheDocument();
  });

  it("keeps action wiring stable when the selected path is a directory instead of a file", () => {
    const props = buildProps({
      selectedPath: "/repo/adjutorix-app/src/renderer",
    });

    render(<FileTreePane {...props} />);

    fireEvent.click(screen.getByText("renderer"));
    expect(props.onSelectPath).toHaveBeenCalledWith("/repo/adjutorix-app/src/renderer");
  });

  it("renders enough visible structure to distinguish shell controls, metrics, and tree rows as separate surfaces", () => {
    render(<FileTreePane {...buildProps()} />);

    const allButtons = screen.getAllByRole("button");
    expect(allButtons.length).toBeGreaterThanOrEqual(3);

    expect(screen.getByText("App.tsx")).toBeInTheDocument();
    expect(screen.getByText("Opened")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });
});
