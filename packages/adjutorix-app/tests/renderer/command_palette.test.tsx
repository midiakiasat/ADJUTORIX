import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * ADJUTORIX APP — TESTS / RENDERER / command_palette.test.tsx
 *
 * Canonical command-palette renderer contract suite.
 *
 * Purpose:
 * - verify that CommandPalette preserves governed command truth around palette visibility,
 *   query filtering, category scoping, command identity, availability gating, risk labels,
 *   selected command focus, and explicit run/close/category-change actions
 * - verify that the palette remains a projection of canonical command registry state rather than
 *   decorative fuzzy-search chrome
 * - verify that loading, empty-result, restricted, hidden, and mixed-availability states remain explicit
 *
 * Test philosophy:
 * - no snapshots
 * - assert operator-visible command semantics and callback routing
 * - prefer command identity, scoping, and risk contracts over implementation details
 *
 * Notes:
 * - this suite assumes CommandPalette exports a default React component from the renderer tree
 * - if the production prop surface evolves, update buildProps() first
 */

import CommandPalette from "../../../src/renderer/components/CommandPalette";

type CommandPaletteProps = React.ComponentProps<typeof CommandPalette>;

function buildProps(overrides: Partial<CommandPaletteProps> = {}): CommandPaletteProps {
  return {
    isOpen: true,
    title: "Command palette",
    subtitle: "Governed command search and execution surface",
    query: "ver",
    selectedCategory: "all",
    selectedCommandId: "cmd-verify-run",
    loading: false,
    health: "healthy",
    trustLevel: "restricted",
    commands: [
      {
        id: "cmd-open-workspace",
        title: "Open Workspace",
        description: "Attach a governed workspace root and hydrate file, index, and diagnostics state.",
        category: "workspace",
        keywords: ["open", "workspace", "attach"],
        enabled: true,
        risk: "safe",
        shortcutLabel: "⌘O",
      },
      {
        id: "cmd-verify-run",
        title: "Run Verify",
        description: "Execute governed verify checks for the current patch and ledger lineage.",
        category: "verify",
        keywords: ["verify", "replay", "ledger"],
        enabled: true,
        risk: "guarded",
        shortcutLabel: "⇧⌘V",
      },
      {
        id: "cmd-apply-patch",
        title: "Apply Patch",
        description: "Apply the reviewed patch through governed apply gate enforcement.",
        category: "patch",
        keywords: ["apply", "patch", "gate"],
        enabled: false,
        disabledReason: "Apply gate blocked by rejected files and failed replay evidence.",
        risk: "destructive",
        shortcutLabel: "⇧⌘A",
      },
      {
        id: "cmd-open-ledger",
        title: "Open Ledger",
        description: "Reveal canonical transaction history and lineage edges.",
        category: "ledger",
        keywords: ["ledger", "transactions", "lineage"],
        enabled: true,
        risk: "safe",
        shortcutLabel: "⌘L",
      },
    ],
    categories: [
      { id: "all", label: "All" },
      { id: "workspace", label: "Workspace" },
      { id: "verify", label: "Verify" },
      { id: "patch", label: "Patch" },
      { id: "ledger", label: "Ledger" },
    ],
    notes: [
      "Command availability must reflect governed capability and apply/verify constraints, not only fuzzy text matching.",
      "Risk labels remain visible so execution posture is explicit before dispatch.",
    ],
    metrics: {
      totalCommands: 4,
      enabledCommands: 3,
      disabledCommands: 1,
      visibleCommands: 4,
    },
    onQueryChange: vi.fn(),
    onSelectedCategoryChange: vi.fn(),
    onSelectCommand: vi.fn(),
    onRunCommand: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  } as CommandPaletteProps;
}

describe("CommandPalette", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the canonical palette shell with title, subtitle, query, categories, and command list", () => {
    render(<CommandPalette {...buildProps()} />);

    expect(screen.getByText(/Command palette/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed command search and execution surface/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue("ver")).toBeInTheDocument();
    expect(screen.getByText(/Open Workspace/i)).toBeInTheDocument();
    expect(screen.getByText(/Run Verify/i)).toBeInTheDocument();
    expect(screen.getByText(/Apply Patch/i)).toBeInTheDocument();
    expect(screen.getByText(/Open Ledger/i)).toBeInTheDocument();
  });

  it("surfaces health and trust posture explicitly instead of reducing the palette to plain search UI", () => {
    render(<CommandPalette {...buildProps()} />);

    expect(screen.getByText(/healthy/i)).toBeInTheDocument();
    expect(screen.getByText(/restricted/i)).toBeInTheDocument();
  });

  it("surfaces command categories explicitly so palette scoping remains operator-visible", () => {
    render(<CommandPalette {...buildProps()} />);

    expect(screen.getByText(/^All$/)).toBeInTheDocument();
    expect(screen.getByText(/^Workspace$/)).toBeInTheDocument();
    expect(screen.getByText(/^Verify$/)).toBeInTheDocument();
    expect(screen.getByText(/^Patch$/)).toBeInTheDocument();
    expect(screen.getByText(/^Ledger$/)).toBeInTheDocument();
  });

  it("surfaces enabled and disabled command availability explicitly instead of flattening dispatchability", () => {
    render(<CommandPalette {...buildProps()} />);

    expect(screen.getByText(/Apply gate blocked by rejected files and failed replay evidence/i)).toBeInTheDocument();
  });

  it("surfaces risk labels explicitly so safe, guarded, and destructive commands remain distinct", () => {
    render(<CommandPalette {...buildProps()} />);

    expect(screen.getAllByText(/safe/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/guarded/i)).toBeInTheDocument();
    expect(screen.getByText(/destructive/i)).toBeInTheDocument();
  });

  it("surfaces keyboard shortcut labels explicitly as operator-facing execution affordances", () => {
    render(<CommandPalette {...buildProps()} />);

    expect(screen.getByText(/⌘O/i)).toBeInTheDocument();
    expect(screen.getByText(/⇧⌘V/i)).toBeInTheDocument();
    expect(screen.getByText(/⇧⌘A/i)).toBeInTheDocument();
    expect(screen.getByText(/⌘L/i)).toBeInTheDocument();
  });

  it("keeps metrics operator-visible as facts about total, enabled, disabled, and visible commands", () => {
    render(<CommandPalette {...buildProps()} />);

    expect(screen.getByText(/total/i)).toBeInTheDocument();
    expect(screen.getByText(/enabled/i)).toBeInTheDocument();
    expect(screen.getByText(/disabled/i)).toBeInTheDocument();
    expect(screen.getByText(/visible/i)).toBeInTheDocument();
  });

  it("surfaces notes explicitly so availability and risk semantics are not inferred from search alone", () => {
    render(<CommandPalette {...buildProps()} />);

    expect(screen.getByText(/Command availability must reflect governed capability and apply\/verify constraints/i)).toBeInTheDocument();
    expect(screen.getByText(/Risk labels remain visible so execution posture is explicit before dispatch/i)).toBeInTheDocument();
  });

  it("wires query changes to the explicit callback instead of mutating local shadow filter state", () => {
    const props = buildProps();
    render(<CommandPalette {...props} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "ledger" } });

    expect(props.onQueryChange).toHaveBeenCalledTimes(1);
    expect(props.onQueryChange).toHaveBeenCalledWith("ledger");
  });

  it("wires category selection to the explicit callback instead of silently mutating scope", () => {
    const props = buildProps();
    render(<CommandPalette {...props} />);

    fireEvent.click(screen.getByText(/^Verify$/));

    expect(props.onSelectedCategoryChange).toHaveBeenCalledTimes(1);
    expect(props.onSelectedCategoryChange).toHaveBeenCalledWith("verify");
  });

  it("wires command selection to the explicit callback instead of silently mutating focused command state", () => {
    const props = buildProps();
    render(<CommandPalette {...props} />);

    fireEvent.click(screen.getByText(/Open Ledger/i));

    expect(props.onSelectCommand).toHaveBeenCalledTimes(1);
    expect(props.onSelectCommand).toHaveBeenCalledWith("cmd-open-ledger");
  });

  it("wires run-command intent explicitly", () => {
    const props = buildProps();
    render(<CommandPalette {...props} />);

    const runButton = screen.getAllByRole("button").find((button) => /run/i.test(button.textContent ?? "") || /execute/i.test(button.textContent ?? ""));
    expect(runButton).toBeDefined();

    fireEvent.click(runButton!);
    expect(props.onRunCommand).toHaveBeenCalled();
  });

  it("wires close intent explicitly instead of treating visibility as an uncontrolled modal detail", () => {
    const props = buildProps();
    render(<CommandPalette {...props} />);

    const closeButton = screen.getAllByRole("button").find((button) => /close/i.test(button.textContent ?? ""));
    expect(closeButton).toBeDefined();

    fireEvent.click(closeButton!);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("supports filtered category state explicitly without losing command identity", () => {
    render(
      <CommandPalette
        {...buildProps({
          selectedCategory: "verify",
          commands: [buildProps().commands[1]],
          metrics: {
            totalCommands: 4,
            enabledCommands: 3,
            disabledCommands: 1,
            visibleCommands: 1,
          },
        })}
      />,
    );

    expect(screen.getByText(/Run Verify/i)).toBeInTheDocument();
    expect(screen.queryByText(/Open Workspace/i)).not.toBeInTheDocument();
  });

  it("supports empty-result posture explicitly when query matches no commands", () => {
    render(
      <CommandPalette
        {...buildProps({
          query: "nonexistent-command",
          commands: [],
          selectedCommandId: null,
          metrics: {
            totalCommands: 4,
            enabledCommands: 3,
            disabledCommands: 1,
            visibleCommands: 0,
          },
          notes: ["No commands match the current query and category scope."],
        })}
      />,
    );

    expect(screen.getByDisplayValue("nonexistent-command")).toBeInTheDocument();
    expect(screen.getByText(/No commands match the current query and category scope/i)).toBeInTheDocument();
    expect(screen.queryByText(/Run Verify/i)).not.toBeInTheDocument();
  });

  it("renders loading posture explicitly without dropping the palette shell contract", () => {
    render(
      <CommandPalette
        {...buildProps({
          loading: true,
        })}
      />,
    );

    expect(screen.getByText(/Command palette/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed command search and execution surface/i)).toBeInTheDocument();
  });

  it("supports closed posture explicitly by rendering nothing when palette is not open", () => {
    render(
      <CommandPalette
        {...buildProps({
          isOpen: false,
        })}
      />,
    );

    expect(screen.queryByText(/Command palette/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("surfaces degraded health posture explicitly instead of assuming command freshness", () => {
    render(
      <CommandPalette
        {...buildProps({
          health: "degraded",
        })}
      />,
    );

    expect(screen.getByText(/degraded/i)).toBeInTheDocument();
  });

  it("does not collapse the palette into only a query box; categories, commands, metrics, notes, and controls remain distinct", () => {
    render(<CommandPalette {...buildProps()} />);

    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(5);
    expect(screen.getByText(/Run Verify/i)).toBeInTheDocument();
    expect(screen.getByText(/Risk labels remain visible/i)).toBeInTheDocument();
  });
});
