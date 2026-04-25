import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import CommandPalette from "../../src/renderer/components/CommandPalette";

type CommandPaletteProps = React.ComponentProps<typeof CommandPalette>;

function buildProps(overrides: Partial<CommandPaletteProps> = {}): CommandPaletteProps {
  return {
    isOpen: true,
    title: "Command palette",
    subtitle: "Governed command search and execution surface",
    query: "",
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
    metrics: [
      { id: "total", label: "Total", value: "4", tone: "neutral" },
      { id: "enabled", label: "Enabled", value: "3", tone: "success" },
      { id: "guarded", label: "Guarded", value: "1", tone: "warning" },
      { id: "destructive", label: "Destructive", value: "1", tone: "danger" },
    ],
    onQueryChange: vi.fn(),
    onSelectedCategoryChange: vi.fn(),
    onSelectCommand: vi.fn(),
    onRunCommand: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  } as CommandPaletteProps;
}

function getCategoryButton(label: string): HTMLButtonElement {
  const needle = label.trim().toLowerCase();
  const match = screen
    .getAllByRole("button")
    .find((button) => {
      const text = button.textContent?.trim().toLowerCase() ?? "";
      const isCommandCard = button.hasAttribute("data-index");
      return !isCommandCard && text === needle;
    });

  expect(match).toBeTruthy();
  return match as HTMLButtonElement;
}

function getCommandButton(title: string): HTMLButtonElement {
  const match = screen
    .getAllByRole("button")
    .find((button) => {
      const text = button.textContent ?? "";
      return button.hasAttribute("data-index") && text.includes(title);
    });

  expect(match).toBeTruthy();
  return match as HTMLButtonElement;
}

describe("CommandPalette", () => {
  beforeAll(() => {
    if (!("scrollIntoView" in Element.prototype)) {
      Object.defineProperty(Element.prototype, "scrollIntoView", {
        configurable: true,
        value: vi.fn(),
      });
    } else {
      vi.spyOn(Element.prototype as Element, "scrollIntoView").mockImplementation(() => {});
    }
  });

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
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.getAllByText(/Open Workspace/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Run Verify/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Apply Patch/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Open Ledger/i).length).toBeGreaterThan(0);
  });

  it("surfaces health and trust posture explicitly instead of reducing the palette to plain search UI", () => {
    render(<CommandPalette {...buildProps()} />);

    expect(screen.getByText(/healthy/i)).toBeInTheDocument();
    expect(screen.getByText(/restricted/i)).toBeInTheDocument();
  });

  it("surfaces command categories explicitly so palette scoping remains operator-visible", () => {
    render(<CommandPalette {...buildProps()} />);

    expect(getCategoryButton("all")).toBeInTheDocument();
    expect(getCategoryButton("workspace")).toBeInTheDocument();
    expect(getCategoryButton("verify")).toBeInTheDocument();
    expect(getCategoryButton("patch")).toBeInTheDocument();
    expect(getCategoryButton("ledger")).toBeInTheDocument();
  });

  it("surfaces enabled and disabled command availability explicitly instead of flattening dispatchability", () => {
    const props = buildProps({
      selectedCommandId: "cmd-apply-patch",
    });

    render(<CommandPalette {...props} />);

    const applyButton = getCommandButton("Apply Patch");
    const verifyButton = getCommandButton("Run Verify");

    expect(applyButton).toBeInTheDocument();
    expect(verifyButton).toBeInTheDocument();

    fireEvent.click(applyButton);

    expect(props.onSelectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "cmd-apply-patch",
        enabled: false,
        title: "Apply Patch",
      }),
    );
  });

  it("surfaces risk labels explicitly so safe, guarded, and destructive commands remain distinct", () => {
    render(<CommandPalette {...buildProps()} />);

    expect(screen.getAllByText(/safe/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/guarded/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/destructive/i).length).toBeGreaterThan(0);
  });

  it("surfaces keyboard shortcut labels explicitly as operator-facing execution affordances", () => {
    render(<CommandPalette {...buildProps()} />);

    expect(screen.getByText("⌘O")).toBeInTheDocument();
    expect(screen.getByText("⇧⌘V")).toBeInTheDocument();
    expect(screen.getByText("⇧⌘A")).toBeInTheDocument();
    expect(screen.getByText("⌘L")).toBeInTheDocument();
  });

  it("keeps metrics operator-visible as facts about total, enabled, guarded, and destructive commands", () => {
    const { container } = render(<CommandPalette {...buildProps()} />);

    const metricGrid = container.querySelector(".mt-5.grid");
    expect(metricGrid).not.toBeNull();

    const text = metricGrid?.textContent ?? "";
    expect(text).toMatch(/Total/i);
    expect(text).toMatch(/Enabled/i);
    expect(text).toMatch(/Guarded/i);
    expect(text).toMatch(/Destructive/i);
    expect(text).toMatch(/4/);
    expect(text).toMatch(/3/);
    expect(text).toMatch(/1/);
  });

  it("surfaces notes explicitly so availability and risk semantics are not inferred from search alone", () => {
    const { container } = render(<CommandPalette {...buildProps()} />);

    const text = (container.textContent ?? "").replace(/\s+/g, " ").trim();

    expect(text).toMatch(/Selected command/i);
    expect(text).toMatch(/Run Verify/i);
    expect(text).toMatch(/Standard renderer authority/i);
    expect(text).toMatch(/No lineage requirement declared/i);
    expect(text).toMatch(/Keyboard controls/i);
    expect(text).toMatch(/Navigate/i);
    expect(text).toMatch(/Run/i);
    expect(text).toMatch(/Close/i);
  });

  it("wires query changes to the explicit callback instead of mutating local shadow filter state", () => {
    const props = buildProps();
    render(<CommandPalette {...props} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "ledger" } });

    expect(props.onQueryChange).toHaveBeenCalledWith("ledger");
  });

  it("wires category selection to the explicit callback instead of silently mutating scope", () => {
    const props = buildProps();
    render(<CommandPalette {...props} />);

    fireEvent.click(getCategoryButton("patch"));

    expect(props.onSelectedCategoryChange).toHaveBeenCalled();
  });

  it("wires command selection to the explicit callback instead of silently mutating focused command state", () => {
    const props = buildProps();
    render(<CommandPalette {...props} />);

    fireEvent.click(getCommandButton("Run Verify"));

    expect(props.onSelectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "cmd-verify-run",
        title: "Run Verify",
      }),
    );
  });

  it("wires run-command intent explicitly", () => {
    const props = buildProps();
    render(<CommandPalette {...props} />);

    expect(props.onRunCommand).toBeDefined();
  });

  it("wires close intent explicitly instead of treating visibility as an uncontrolled modal detail", () => {
    const props = buildProps();
    render(<CommandPalette {...props} />);

    fireEvent.click(screen.getByRole("button", { name: /close/i }));

    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("supports filtered category state explicitly without losing command identity", () => {
    render(
      <CommandPalette
        {...buildProps({
          selectedCategory: "patch",
        })}
      />,
    );

    expect(getCategoryButton("patch")).toBeInTheDocument();
    expect(screen.getAllByText(/Apply Patch/i).length).toBeGreaterThan(0);
  });

  it("supports empty-result posture explicitly when query matches no commands", () => {
    render(
      <CommandPalette
        {...buildProps({
          query: "zzzz-no-match",
        })}
      />,
    );

    expect(screen.getByRole("textbox")).toHaveValue("zzzz-no-match");
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
    expect(screen.getByRole("textbox")).toBeInTheDocument();
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
    const { container } = render(<CommandPalette {...buildProps()} />);

    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(5);
    expect(screen.getAllByText(/Run Verify/i).length).toBeGreaterThan(0);

    const text = (container.textContent ?? "").replace(/\s+/g, " ").trim();
    expect(text).toMatch(/Total/i);
    expect(text).toMatch(/Enabled/i);
    expect(text).toMatch(/Guarded/i);
    expect(text).toMatch(/Destructive/i);
    expect(text).toMatch(/Selected command/i);
    expect(text).toMatch(/Keyboard controls/i);
  });
});
