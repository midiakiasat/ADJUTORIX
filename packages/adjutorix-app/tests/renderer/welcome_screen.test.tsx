import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * ADJUTORIX APP — TESTS / RENDERER / welcome_screen.test.tsx
 *
 * Canonical welcome-screen contract suite.
 *
 * Purpose:
 * - verify that WelcomeScreen preserves the governed entry contract for workspace admission,
 *   recent workspace recovery, trust/health explanation, and zero-state operator actions
 * - verify that empty-state rendering does not collapse critical actions under decorative content
 * - verify that degraded/trust-constrained states remain explicit instead of silently reusing the
 *   same optimistic empty-state copy
 *
 * Test philosophy:
 * - assert operator-visible structure and callback wiring, not brittle snapshots
 * - treat WelcomeScreen as a control surface for workspace bootstrapping, not a marketing panel
 * - prefer stateful contract assertions over implementation details
 *
 * Notes:
 * - this suite assumes WelcomeScreen exports a default React component from the renderer tree
 * - recent workspace rows and metadata are intentionally modeled as concrete operator-visible facts
 * - if the production prop surface evolves, update buildProps() first
 */

import WelcomeScreen from "../../../src/renderer/components/WelcomeScreen";

type WelcomeScreenProps = React.ComponentProps<typeof WelcomeScreen>;

function buildProps(overrides: Partial<WelcomeScreenProps> = {}): WelcomeScreenProps {
  return {
    title: "Welcome to ADJUTORIX",
    subtitle:
      "Governed workspace bootstrapping surface for opening a trusted repository, resuming prior work, and understanding shell readiness before any agent or patch action.",
    trustLevel: "trusted",
    health: "healthy",
    loading: false,
    workspaceRoot: null,
    recentWorkspaces: [
      {
        id: "recent-1",
        name: "adjutorix-core",
        path: "/repo/adjutorix-core",
        lastOpenedAtMs: 1710000000000,
        trustLevel: "trusted",
        health: "healthy",
        diagnosticsCount: 0,
        pendingReviewCount: 1,
      },
      {
        id: "recent-2",
        name: "adjutorix-app",
        path: "/repo/adjutorix-app",
        lastOpenedAtMs: 1711000000000,
        trustLevel: "restricted",
        health: "degraded",
        diagnosticsCount: 4,
        pendingReviewCount: 2,
      },
    ],
    capabilities: [
      {
        id: "open-workspace",
        title: "Open workspace",
        description: "Choose a repository or working directory to establish governed workspace truth.",
        status: "ready",
      },
      {
        id: "resume-recent",
        title: "Resume recent work",
        description: "Recover a previously indexed or reviewed workspace without re-discovering operator context.",
        status: "ready",
      },
      {
        id: "agent-readiness",
        title: "Agent readiness",
        description: "See provider and auth posture before issuing model-backed commands.",
        status: "ready",
      },
    ],
    notes: [
      "No workspace is currently attached.",
      "Opening a workspace establishes the root for file tree, diagnostics, indexing, and patch review.",
    ],
    onOpenWorkspace: vi.fn(),
    onOpenRecentWorkspace: vi.fn(),
    onShowSettings: vi.fn(),
    onShowAbout: vi.fn(),
    onShowCommandPalette: vi.fn(),
    ...overrides,
  } as WelcomeScreenProps;
}

describe("WelcomeScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the canonical workspace admission shell with title, subtitle, and primary entry actions", () => {
    render(<WelcomeScreen {...buildProps()} />);

    expect(screen.getByText(/Welcome to ADJUTORIX/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Governed workspace bootstrapping surface/i),
    ).toBeInTheDocument();

    expect(screen.getByRole("button", { name: /open workspace/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /settings/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /about/i })).toBeInTheDocument();
  });

  it("surfaces recent workspaces as concrete recovery targets instead of abstract placeholders", () => {
    render(<WelcomeScreen {...buildProps()} />);

    expect(screen.getByText(/adjutorix-core/i)).toBeInTheDocument();
    expect(screen.getByText(/adjutorix-app/i)).toBeInTheDocument();
    expect(screen.getByText(/\/repo\/adjutorix-core/i)).toBeInTheDocument();
    expect(screen.getByText(/\/repo\/adjutorix-app/i)).toBeInTheDocument();
  });

  it("wires the primary open-workspace action to the explicit operator callback", () => {
    const props = buildProps();
    render(<WelcomeScreen {...props} />);

    fireEvent.click(screen.getByRole("button", { name: /open workspace/i }));

    expect(props.onOpenWorkspace).toHaveBeenCalledTimes(1);
  });

  it("wires recent workspace rows to the explicit recovery callback with the selected record", () => {
    const props = buildProps();
    render(<WelcomeScreen {...props} />);

    const recentButton = screen.getByRole("button", { name: /adjutorix-core/i });
    fireEvent.click(recentButton);

    expect(props.onOpenRecentWorkspace).toHaveBeenCalledTimes(1);
    expect(props.onOpenRecentWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "recent-1",
        name: "adjutorix-core",
        path: "/repo/adjutorix-core",
      }),
    );
  });

  it("keeps recent-workspace rows distinct by health and trust posture instead of flattening them into identical cards", () => {
    render(<WelcomeScreen {...buildProps()} />);

    expect(screen.getByText(/trusted/i)).toBeInTheDocument();
    expect(screen.getByText(/restricted/i)).toBeInTheDocument();
    expect(screen.getByText(/healthy/i)).toBeInTheDocument();
    expect(screen.getByText(/degraded/i)).toBeInTheDocument();
  });

  it("renders capability blocks as operational readiness facts rather than decorative marketing copy", () => {
    render(<WelcomeScreen {...buildProps()} />);

    expect(screen.getByText(/Open workspace/i)).toBeInTheDocument();
    expect(screen.getByText(/Resume recent work/i)).toBeInTheDocument();
    expect(screen.getByText(/Agent readiness/i)).toBeInTheDocument();

    expect(screen.getByText(/Choose a repository or working directory/i)).toBeInTheDocument();
    expect(screen.getByText(/Recover a previously indexed or reviewed workspace/i)).toBeInTheDocument();
    expect(screen.getByText(/See provider and auth posture/i)).toBeInTheDocument();
  });

  it("surfaces explanatory notes for empty workspace state instead of only action buttons", () => {
    render(<WelcomeScreen {...buildProps()} />);

    expect(screen.getByText(/No workspace is currently attached/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Opening a workspace establishes the root for file tree, diagnostics, indexing, and patch review/i),
    ).toBeInTheDocument();
  });

  it("routes settings, about, and command palette controls to their explicit callbacks", () => {
    const props = buildProps();
    render(<WelcomeScreen {...props} />);

    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    fireEvent.click(screen.getByRole("button", { name: /about/i }));
    fireEvent.click(screen.getByRole("button", { name: /command palette/i }));

    expect(props.onShowSettings).toHaveBeenCalledTimes(1);
    expect(props.onShowAbout).toHaveBeenCalledTimes(1);
    expect(props.onShowCommandPalette).toHaveBeenCalledTimes(1);
  });

  it("renders a degraded health state explicitly instead of reusing healthy-shell assumptions", () => {
    render(
      <WelcomeScreen
        {...buildProps({
          health: "degraded",
          notes: [
            "Workspace bootstrap remains available.",
            "Index readiness is degraded and recent workspace metadata may be stale.",
          ],
        })}
      />,
    );

    expect(screen.getByText(/degraded/i)).toBeInTheDocument();
    expect(screen.getByText(/Index readiness is degraded/i)).toBeInTheDocument();
  });

  it("renders an untrusted posture explicitly so workspace admission is not visually equivalent to trusted mode", () => {
    render(
      <WelcomeScreen
        {...buildProps({
          trustLevel: "untrusted",
          notes: [
            "Workspace selection is available.",
            "Untrusted posture will constrain agent, apply, and shell-sensitive actions until explicitly upgraded.",
          ],
        })}
      />,
    );

    expect(screen.getByText(/untrusted/i)).toBeInTheDocument();
    expect(screen.getByText(/constrain agent, apply, and shell-sensitive actions/i)).toBeInTheDocument();
  });

  it("shows workspace-root context when an attached workspace already exists", () => {
    render(
      <WelcomeScreen
        {...buildProps({
          workspaceRoot: "/repo/adjutorix-app",
          notes: [
            "A workspace is already attached.",
            "You can reopen another workspace or resume a different reviewed repository.",
          ],
        })}
      />,
    );

    expect(screen.getByText(/\/repo\/adjutorix-app/i)).toBeInTheDocument();
    expect(screen.getByText(/A workspace is already attached/i)).toBeInTheDocument();
  });

  it("does not erase the recent-workspace surface when loading is false and the list is empty; it must explain emptiness", () => {
    render(
      <WelcomeScreen
        {...buildProps({
          recentWorkspaces: [],
          notes: [
            "No recent workspaces have been recorded yet.",
            "Open a workspace to establish your first governed session.",
          ],
        })}
      />,
    );

    expect(screen.getByText(/No recent workspaces have been recorded yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open workspace/i })).toBeInTheDocument();
  });

  it("renders a loading posture explicitly so admission actions can remain visible without pretending state is ready", () => {
    render(
      <WelcomeScreen
        {...buildProps({
          loading: true,
          notes: [
            "Bootstrapping workspace admission context.",
            "Recent workspace and provider posture are still hydrating.",
          ],
        })}
      />,
    );

    expect(screen.getByText(/Bootstrapping workspace admission context/i)).toBeInTheDocument();
    expect(screen.getByText(/Recent workspace and provider posture are still hydrating/i)).toBeInTheDocument();
  });

  it("keeps recent workspace diagnostics and pending review counts operator-visible", () => {
    render(<WelcomeScreen {...buildProps()} />);

    expect(screen.getByText(/diagnostics/i)).toBeInTheDocument();
    expect(screen.getByText(/pending review/i)).toBeInTheDocument();
  });

  it("does not collapse all controls into one primary action; secondary entry controls remain independently reachable", () => {
    render(<WelcomeScreen {...buildProps()} />);

    const buttons = screen.getAllByRole("button");
    const labels = buttons.map((button) => button.textContent?.trim() ?? "").filter(Boolean);

    expect(labels.some((label) => /open workspace/i.test(label))).toBe(true);
    expect(labels.some((label) => /settings/i.test(label))).toBe(true);
    expect(labels.some((label) => /about/i.test(label))).toBe(true);
    expect(labels.some((label) => /command palette/i.test(label))).toBe(true);
    expect(buttons.length).toBeGreaterThanOrEqual(4);
  });

  it("keeps recent workspace identity distinct even when two rows share the same trust or health class", () => {
    render(
      <WelcomeScreen
        {...buildProps({
          recentWorkspaces: [
            {
              id: "recent-a",
              name: "adjutorix-app",
              path: "/repo/a/adjutorix-app",
              lastOpenedAtMs: 1712000000000,
              trustLevel: "trusted",
              health: "healthy",
              diagnosticsCount: 1,
              pendingReviewCount: 0,
            },
            {
              id: "recent-b",
              name: "adjutorix-app",
              path: "/repo/b/adjutorix-app",
              lastOpenedAtMs: 1713000000000,
              trustLevel: "trusted",
              health: "healthy",
              diagnosticsCount: 2,
              pendingReviewCount: 3,
            },
          ],
        })}
      />,
    );

    expect(screen.getByText(/\/repo\/a\/adjutorix-app/i)).toBeInTheDocument();
    expect(screen.getByText(/\/repo\/b\/adjutorix-app/i)).toBeInTheDocument();
  });

  it("exposes enough visible structure to distinguish capabilities, recents, and notes as separate sections", () => {
    render(<WelcomeScreen {...buildProps()} />);

    expect(screen.getByText(/Resume recent work/i)).toBeInTheDocument();
    expect(screen.getByText(/No workspace is currently attached/i)).toBeInTheDocument();
    expect(screen.getByText(/adjutorix-core/i)).toBeInTheDocument();
  });
});
