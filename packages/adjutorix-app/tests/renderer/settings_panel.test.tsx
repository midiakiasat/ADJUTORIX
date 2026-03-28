import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * ADJUTORIX APP — TESTS / RENDERER / settings_panel.test.tsx
 *
 * Canonical settings-panel renderer contract suite.
 *
 * Purpose:
 * - verify that SettingsPanel preserves governed settings truth around grouped setting identity,
 *   draft state, dirty posture, validation failures, read-only constraints, save/reset semantics,
 *   and explicit operator actions
 * - verify that settings remain a projection of canonical configuration state rather than drifting
 *   into untracked local form state
 * - verify that loading, empty, degraded, read-only, and invalid-draft states remain explicit
 *
 * Test philosophy:
 * - no snapshots
 * - assert operator-visible structure, settings semantics, and callback routing
 * - prefer setting identity, group structure, and draft/save contracts over implementation details
 *
 * Notes:
 * - this suite assumes SettingsPanel exports a default React component from the renderer tree
 * - if the production prop surface evolves, update buildProps() first
 */

import SettingsPanel from "../../../src/renderer/components/SettingsPanel";

type SettingsPanelProps = React.ComponentProps<typeof SettingsPanel>;

function buildProps(overrides: Partial<SettingsPanelProps> = {}): SettingsPanelProps {
  return {
    title: "Settings",
    subtitle: "Governed runtime, workspace, and execution configuration surface",
    health: "healthy",
    loading: false,
    dirty: true,
    readOnly: false,
    settings: [
      {
        id: "group-workspace",
        type: "group",
        title: "Workspace",
        description: "Workspace trust, hidden-file visibility, and indexing behavior.",
        items: [
          {
            id: "show-hidden-files",
            type: "boolean",
            label: "Show hidden files",
            description: "Expose hidden filesystem entries in the workspace tree.",
            value: true,
            draftValue: false,
            defaultValue: false,
            dirty: true,
            valid: true,
          },
          {
            id: "index-auto-refresh",
            type: "boolean",
            label: "Auto refresh index",
            description: "Refresh index automatically when watcher state remains healthy.",
            value: true,
            draftValue: true,
            defaultValue: true,
            dirty: false,
            valid: true,
          },
        ],
      },
      {
        id: "group-agent",
        type: "group",
        title: "Agent",
        description: "Provider endpoint, command safety, and reconnect behavior.",
        items: [
          {
            id: "agent-endpoint",
            type: "text",
            label: "Agent endpoint",
            description: "RPC endpoint for the local governed agent.",
            value: "http://127.0.0.1:8000/rpc",
            draftValue: "http://127.0.0.1:8001/rpc",
            defaultValue: "http://127.0.0.1:8000/rpc",
            dirty: true,
            valid: false,
            validationMessage: "Endpoint must resolve to an allowed local RPC target.",
          },
          {
            id: "command-confirmation",
            type: "select",
            label: "Command confirmation policy",
            description: "Required confirmation level before risky shell execution.",
            value: "guarded",
            draftValue: "strict",
            defaultValue: "guarded",
            dirty: true,
            valid: true,
            options: [
              { value: "permissive", label: "Permissive" },
              { value: "guarded", label: "Guarded" },
              { value: "strict", label: "Strict" },
            ],
          },
        ],
      },
      {
        id: "group-editor",
        type: "group",
        title: "Editor",
        description: "Editor formatting, read-only fallback, and large-file degradation behavior.",
        items: [
          {
            id: "large-file-policy",
            type: "select",
            label: "Large file policy",
            description: "How large files are handled inside Monaco-backed panes.",
            value: "degrade",
            draftValue: "degrade",
            defaultValue: "degrade",
            dirty: false,
            valid: true,
            options: [
              { value: "allow", label: "Allow" },
              { value: "degrade", label: "Degrade" },
              { value: "deny", label: "Deny" },
            ],
          },
        ],
      },
    ],
    onRefreshRequested: vi.fn(),
    onSaveRequested: vi.fn(),
    onResetRequested: vi.fn(),
    onDraftValueChange: vi.fn(),
    ...overrides,
  } as SettingsPanelProps;
}

describe("SettingsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the canonical settings shell with title, subtitle, and grouped configuration surfaces", () => {
    render(<SettingsPanel {...buildProps()} />);

    expect(screen.getByText(/Settings/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed runtime, workspace, and execution configuration surface/i)).toBeInTheDocument();
    expect(screen.getByText(/Workspace/i)).toBeInTheDocument();
    expect(screen.getByText(/Agent/i)).toBeInTheDocument();
    expect(screen.getByText(/Editor/i)).toBeInTheDocument();
  });

  it("surfaces grouped setting descriptions explicitly so configuration remains operationally interpretable", () => {
    render(<SettingsPanel {...buildProps()} />);

    expect(screen.getByText(/Workspace trust, hidden-file visibility, and indexing behavior/i)).toBeInTheDocument();
    expect(screen.getByText(/Provider endpoint, command safety, and reconnect behavior/i)).toBeInTheDocument();
    expect(screen.getByText(/Editor formatting, read-only fallback, and large-file degradation behavior/i)).toBeInTheDocument();
  });

  it("surfaces setting labels and descriptions explicitly instead of reducing settings to raw inputs", () => {
    render(<SettingsPanel {...buildProps()} />);

    expect(screen.getByText(/Show hidden files/i)).toBeInTheDocument();
    expect(screen.getByText(/Expose hidden filesystem entries in the workspace tree/i)).toBeInTheDocument();
    expect(screen.getByText(/Agent endpoint/i)).toBeInTheDocument();
    expect(screen.getByText(/RPC endpoint for the local governed agent/i)).toBeInTheDocument();
    expect(screen.getByText(/Command confirmation policy/i)).toBeInTheDocument();
    expect(screen.getByText(/Large file policy/i)).toBeInTheDocument();
  });

  it("surfaces dirty posture explicitly so unsaved draft state is operator-visible", () => {
    render(<SettingsPanel {...buildProps()} />);

    expect(screen.getByText(/dirty/i)).toBeInTheDocument();
  });

  it("surfaces validation failures explicitly instead of hiding invalid draft state in control internals", () => {
    render(<SettingsPanel {...buildProps()} />);

    expect(screen.getByText(/Endpoint must resolve to an allowed local RPC target/i)).toBeInTheDocument();
  });

  it("surfaces health posture explicitly instead of treating settings as pure form chrome", () => {
    render(<SettingsPanel {...buildProps()} />);

    expect(screen.getByText(/healthy/i)).toBeInTheDocument();
  });

  it("renders current and draft text values so draft divergence remains inspectable", () => {
    render(<SettingsPanel {...buildProps()} />);

    expect(screen.getByDisplayValue("http://127.0.0.1:8001/rpc")).toBeInTheDocument();
  });

  it("wires text draft changes to the explicit callback instead of mutating local shadow state", () => {
    const props = buildProps();
    render(<SettingsPanel {...props} />);

    fireEvent.change(screen.getByDisplayValue("http://127.0.0.1:8001/rpc"), {
      target: { value: "http://127.0.0.1:8000/rpc" },
    });

    expect(props.onDraftValueChange).toHaveBeenCalled();
  });

  it("wires boolean draft changes to the explicit callback", () => {
    const props = buildProps();
    render(<SettingsPanel {...props} />);

    const checkbox = screen.getAllByRole("checkbox")[0];
    fireEvent.click(checkbox);

    expect(props.onDraftValueChange).toHaveBeenCalled();
  });

  it("wires select draft changes to the explicit callback", () => {
    const props = buildProps();
    render(<SettingsPanel {...props} />);

    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[0], { target: { value: "guarded" } });

    expect(props.onDraftValueChange).toHaveBeenCalled();
  });

  it("wires refresh, save, and reset actions explicitly", () => {
    const props = buildProps();
    render(<SettingsPanel {...props} />);

    const buttons = screen.getAllByRole("button");
    const refreshButton = buttons.find((button) => /refresh/i.test(button.textContent ?? ""));
    const saveButton = buttons.find((button) => /save/i.test(button.textContent ?? ""));
    const resetButton = buttons.find((button) => /reset/i.test(button.textContent ?? ""));

    expect(refreshButton).toBeDefined();
    expect(saveButton).toBeDefined();
    expect(resetButton).toBeDefined();

    fireEvent.click(refreshButton!);
    fireEvent.click(saveButton!);
    fireEvent.click(resetButton!);

    expect(props.onRefreshRequested).toHaveBeenCalledTimes(1);
    expect(props.onSaveRequested).toHaveBeenCalledTimes(1);
    expect(props.onResetRequested).toHaveBeenCalledTimes(1);
  });

  it("does not advertise save as enabled when the panel is read-only", () => {
    render(
      <SettingsPanel
        {...buildProps({
          readOnly: true,
        })}
      />,
    );

    const saveButton = screen.getAllByRole("button").find((button) => /save/i.test(button.textContent ?? ""));
    expect(saveButton).toBeDisabled();
  });

  it("surfaces read-only posture explicitly instead of silently ignoring edits", () => {
    render(
      <SettingsPanel
        {...buildProps({
          readOnly: true,
          subtitle: "Governed settings are visible but locked by current authority posture.",
        })}
      />,
    );

    expect(screen.getByText(/read.?only/i)).toBeInTheDocument();
    expect(screen.getByText(/locked by current authority posture/i)).toBeInTheDocument();
  });

  it("surfaces degraded health posture explicitly when settings state may be stale or partially invalid", () => {
    render(
      <SettingsPanel
        {...buildProps({
          health: "degraded",
        })}
      />,
    );

    expect(screen.getByText(/degraded/i)).toBeInTheDocument();
  });

  it("supports clean posture explicitly when no unsaved draft state exists", () => {
    render(
      <SettingsPanel
        {...buildProps({
          dirty: false,
          settings: buildProps().settings.map((group) => ({
            ...group,
            items: group.items.map((item: any) => ({
              ...item,
              draftValue: item.value,
              dirty: false,
              valid: true,
              validationMessage: undefined,
            })),
          })),
        })}
      />,
    );

    expect(screen.queryByText(/dirty/i)).not.toBeInTheDocument();
  });

  it("supports empty settings posture explicitly when no configurable groups are available", () => {
    render(
      <SettingsPanel
        {...buildProps({
          settings: [],
          subtitle: "No governed settings are currently exposed for this surface.",
          dirty: false,
        })}
      />,
    );

    expect(screen.getByText(/No governed settings are currently exposed/i)).toBeInTheDocument();
    expect(screen.queryByText(/Workspace/i)).not.toBeInTheDocument();
  });

  it("renders loading posture explicitly without dropping the settings shell contract", () => {
    render(
      <SettingsPanel
        {...buildProps({
          loading: true,
        })}
      />,
    );

    expect(screen.getByText(/Settings/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed runtime, workspace, and execution configuration surface/i)).toBeInTheDocument();
  });

  it("does not collapse the settings shell into only inputs; groups, descriptions, validation, and controls remain distinct", () => {
    render(<SettingsPanel {...buildProps()} />);

    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByRole("checkbox").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole("combobox").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Endpoint must resolve to an allowed local RPC target/i)).toBeInTheDocument();
  });
});
