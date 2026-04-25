import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import AppShell from "../../src/renderer/components/AppShell";

describe("AppShell overlay layers", () => {
  it("does not create pointer-active fullscreen wrappers for absent overlay or modal layers", () => {
    const { container } = render(
      <AppShell
        {...({
          appTitle: "Adjutorix",
          subtitle: "Governed execution surface",
          health: "healthy",
          currentView: "overview",
          loading: false,
          bottomPanelVisible: true,
          statusChips: [],
          banners: [],
          toasts: [],
          headerActions: <div data-testid="header-actions" />,
          leftRail: <div data-testid="left-rail" />,
          primaryContent: <div data-testid="primary-content" />,
          overlayLayer: null,
          modalLayer: null,
        } as any)}
      />,
    );

    const offenders = Array.from(container.querySelectorAll("div")).filter((node) => {
      const className = typeof node.className === "string" ? node.className : "";
      return (
        (className.includes("absolute inset-0 z-40") || className.includes("absolute inset-0 z-50")) &&
        node.children.length > 0
      );
    });

    expect(offenders).toHaveLength(0);
    expect(container.innerHTML).not.toContain("pointer-events-auto");
  });
});
