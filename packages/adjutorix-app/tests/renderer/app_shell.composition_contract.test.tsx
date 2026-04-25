import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import AppShell from "../../src/renderer/components/AppShell";

describe("AppShell composition contract", () => {
  it("renders slot content instead of internally constructing feature panels", () => {
    render(
      <AppShell
        appTitle="Adjutorix"
        subtitle="Governed execution surface"
        health="healthy"
        currentView="workspace"
        loading={false}
        bottomPanelVisible={true}
        rightRailCollapsed={false}
        statusChips={[
          { label: "Phase", value: "ready", tone: "good" },
          { label: "Bridge", value: "online", tone: "good" },
        ]}
        banners={[
          { id: "b1", level: "info", title: "Banner", message: "hello" },
        ]}
        headerActions={<div data-testid="header-actions">header-actions</div>}
        commandBar={<div data-testid="command-bar">command-bar</div>}
        leftRail={<aside data-testid="left-rail">left-rail</aside>}
        primaryContent={<main data-testid="primary-content">primary-content</main>}
        rightRail={<section data-testid="right-rail">right-rail</section>}
        bottomPanel={<section data-testid="bottom-panel">bottom-panel</section>}
        overlayLayer={<div data-testid="overlay-layer">overlay</div>}
        modalLayer={<div data-testid="modal-layer">modal</div>}
        footer={<div data-testid="footer">footer</div>}
      />,
    );

    expect(
      screen.getByRole("heading", { level: 1, name: /^adjutorix$/i }),
    ).toBeInTheDocument();

    expect(screen.getByTestId("header-actions")).toBeInTheDocument();
    expect(screen.getByTestId("command-bar")).toBeInTheDocument();
    expect(screen.getByTestId("left-rail")).toBeInTheDocument();
    expect(screen.getByTestId("primary-content")).toBeInTheDocument();
    expect(screen.getByTestId("bottom-panel")).toBeInTheDocument();
    expect(screen.getByTestId("overlay-layer")).toBeInTheDocument();
    expect(screen.getByTestId("modal-layer")).toBeInTheDocument();
    expect(screen.getByTestId("footer")).toBeInTheDocument();
  });

  it("fires shell callbacks from the exposed shell control surface", () => {
    const onToggleLeftRail = vi.fn();
    const onToggleRightRail = vi.fn();
    const onToggleCommandPalette = vi.fn();

    render(
      <AppShell
        appTitle="Adjutorix"
        subtitle="Governed execution surface"
        health="healthy"
        currentView="overview"
        onToggleLeftRail={onToggleLeftRail}
        onToggleRightRail={onToggleRightRail}
        onToggleCommandPalette={onToggleCommandPalette}
        leftRail={<aside data-testid="left-rail">left-rail</aside>}
        rightRail={<section data-testid="right-rail">right-rail</section>}
        primaryContent={<main data-testid="primary-content">primary-content</main>}
        bottomPanel={<section data-testid="bottom-panel">bottom-panel</section>}
        bottomPanelVisible={true}
      />,
    );

    for (const button of screen.getAllByRole("button")) {
      fireEvent.click(button);
    }

    expect(onToggleLeftRail).toHaveBeenCalled();
    expect(onToggleRightRail).toHaveBeenCalled();
    expect(onToggleCommandPalette).toHaveBeenCalled();
  });

  it("does not synthesize legacy feature-panel test ids", () => {
    render(
      <AppShell
        appTitle="Adjutorix"
        subtitle="Governed execution surface"
        health="healthy"
        currentView="workspace"
        primaryContent={<main data-testid="primary-content">primary-content</main>}
      />,
    );

    for (const legacyId of [
      "file-tree-pane",
      "editor-tabs",
      "monaco-editor-pane",
      "chat-panel",
      "diagnostics-panel",
      "index-health-panel",
      "terminal-panel",
      "ledger-panel",
      "job-panel",
      "patch-review-panel",
      "command-palette",
      "settings-panel",
      "about-panel",
    ]) {
      expect(screen.queryByTestId(legacyId)).not.toBeInTheDocument();
    }
  });
});
