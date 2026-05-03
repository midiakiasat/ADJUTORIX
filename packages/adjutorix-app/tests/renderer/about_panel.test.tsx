import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * ADJUTORIX APP — TESTS / RENDERER / about_panel.test.tsx
 *
 * Canonical about-panel renderer contract suite.
 *
 * Purpose:
 * - verify that AboutPanel preserves governed artifact truth around identity, provenance,
 *   build metadata, protocol posture, trust/health semantics, declared invariants, metrics,
 *   and explicit reference-opening/refresh actions
 * - verify that the about surface remains an operator-facing evidence panel rather than
 *   decorative product copy
 * - verify that degraded, restricted, loading, and sparse-metadata states remain explicit
 *
 * Test philosophy:
 * - no snapshots
 * - assert operator-visible provenance semantics and callback routing
 * - prefer artifact identity, invariant, and build contracts over implementation details
 *
 * Notes:
 * - this suite assumes AboutPanel exports a default React component from the renderer tree
 * - if the production prop surface evolves, update buildProps() first
 */

import AboutPanel from "../../src/renderer/components/AboutPanel";

type AboutPanelProps = React.ComponentProps<typeof AboutPanel>;

function buildProps(overrides: Partial<AboutPanelProps> = {}): AboutPanelProps {
  return {
    title: "About ADJUTORIX",
    subtitle:
      "Authoritative identity, provenance, build, runtime, governance, and compatibility posture for the current artifact.",
    health: "healthy",
    trustLevel: "trusted",
    loading: false,
    appName: "ADJUTORIX",
    appTagline: "Governed coding and verification workbench.",
    version: "0.1.0-dev.42",
    buildChannel: "dev",
    buildHash: "abc123def456",
    releaseDate: "2026-03-24",
    protocolVersion: "1",
    repoRevision: "refs/heads/main@abc123def456",
    copyrightLine: "Copyright © 2026 ADJUTORIX",
    licenseName: "Proprietary Evaluation License",
    metrics: [
      { id: "version", label: "Version", value: "0.1.0-dev.42", tone: "good" },
      { id: "channel", label: "Channel", value: "dev", tone: "neutral" },
      { id: "protocol", label: "Protocol", value: "1", tone: "neutral" },
      { id: "build", label: "Build hash", value: "abc123def456", tone: "neutral" },
    ],
    invariants: [
      {
        id: "no-invisible-action",
        title: "No invisible action",
        summary: "Consequential operations must surface through explicit user-visible state or artifacts.",
        severity: "core",
      },
      {
        id: "no-unverifiable-claim",
        title: "No unverifiable claim",
        summary: "Claims about state, lineage, verification, or mutation must bind to inspectable evidence.",
        severity: "core",
      },
      {
        id: "no-ambiguous-state",
        title: "No ambiguous state",
        summary: "Lifecycle and governance posture must remain explicit at all controlled boundaries.",
        severity: "important",
      },
      {
        id: "no-hidden-authority",
        title: "No hidden authority",
        summary: "Authority and capability constraints must remain visible wherever they affect actionability.",
        severity: "important",
      },
    ],
    links: [
      { id: "docs", label: "Documentation", kind: "docs", hrefLabel: "Internal docs surface", enabled: true },
      { id: "repo", label: "Repository lineage", kind: "repo", hrefLabel: "refs/heads/main@abc123def456", enabled: true },
      { id: "license", label: "License", kind: "license", hrefLabel: "Proprietary Evaluation License", enabled: true },
      { id: "protocol", label: "Protocol contract", kind: "protocol", hrefLabel: "RPC/ledger contract v1", enabled: true },
    ],
    sections: [
      {
        id: "identity",
        title: "Artifact identity",
        subtitle: "Exact product/build identity currently loaded in the renderer.",
        icon: "identity",
        fields: [
          { id: "app-name", label: "Application", value: "ADJUTORIX", emphasized: true },
          { id: "tagline", label: "Tagline", value: "Governed coding and verification workbench." },
          { id: "version", label: "Version", value: "0.1.0-dev.42" },
          { id: "channel", label: "Channel", value: "dev" },
        ],
      },
      {
        id: "build",
        title: "Build provenance",
        subtitle: "Build-time identifiers and repository lineage for the running artifact.",
        icon: "build",
        fields: [
          { id: "build-hash", label: "Build hash", value: "abc123def456", emphasized: true },
          { id: "repo-revision", label: "Repository revision", value: "refs/heads/main@abc123def456" },
          { id: "release-date", label: "Release date", value: "2026-03-24" },
          { id: "protocol-version", label: "Protocol version", value: "1" },
        ],
      },
      {
        id: "runtime",
        title: "Runtime posture",
        subtitle: "Declared runtime and compatibility posture for the artifact.",
        icon: "runtime",
        fields: [
          { id: "platform", label: "Platform", value: "darwin-arm64" },
          { id: "node", label: "Node", value: "22.4.0" },
          { id: "electron", label: "Electron", value: "33.2.1" },
          { id: "react", label: "React", value: "19.0.0" },
        ],
      },
      {
        id: "legal",
        title: "Legal and notice context",
        subtitle: "License and attribution posture attached to this artifact.",
        icon: "legal",
        fields: [
          { id: "license", label: "License", value: "Proprietary Evaluation License" },
          { id: "copyright", label: "Copyright", value: "Copyright © 2026 ADJUTORIX" },
        ],
      },
    ],
    onRefreshRequested: vi.fn(),
    onOpenLinkRequested: vi.fn(),
    ...overrides,
  } as AboutPanelProps;
}

describe("AboutPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the canonical about shell with title, subtitle, artifact identity, and provenance surfaces", () => {
    render(<AboutPanel {...buildProps()} />);

    expect(screen.getByText(/About ADJUTORIX/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Authoritative identity, provenance, build, runtime, governance, and compatibility posture/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/^ADJUTORIX$/)).toBeInTheDocument();
    expect(screen.getAllByText(/0\.1\.0-dev\.42/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/abc123def456/i).length).toBeGreaterThanOrEqual(1);
  });

  it("surfaces health and trust posture explicitly instead of reducing artifact state to one badge", () => {
    render(<AboutPanel {...buildProps()} />);

    expect(screen.getByText(/healthy/i)).toBeInTheDocument();
    expect(screen.getByText(/trusted/i)).toBeInTheDocument();
  });

  it("surfaces app identity, tagline, channel, version, and build hash as operator-visible facts", () => {
    render(<AboutPanel {...buildProps()} />);

    expect(screen.getByText(/Governed coding and verification workbench/i)).toBeInTheDocument();
    expect(screen.getAllByText(/^dev$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/0\.1\.0-dev\.42/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/abc123def456/i).length).toBeGreaterThanOrEqual(1);
  });

  it("surfaces protocol version, repository revision, release date, and legal posture explicitly", () => {
    render(<AboutPanel {...buildProps()} />);

    expect(screen.getAllByText(/^1$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/refs\/heads\/main@abc123def456/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/2026-03-24/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Proprietary Evaluation License/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Copyright © 2026 ADJUTORIX/i)).toBeInTheDocument();
  });

  it("surfaces declared invariants explicitly so the panel remains an evidence surface rather than product copy", () => {
    render(<AboutPanel {...buildProps()} />);

    expect(screen.getByText(/No invisible action/i)).toBeInTheDocument();
    expect(screen.getByText(/No unverifiable claim/i)).toBeInTheDocument();
    expect(screen.getByText(/No ambiguous state/i)).toBeInTheDocument();
    expect(screen.getByText(/No hidden authority/i)).toBeInTheDocument();
    expect(screen.getByText(/Consequential operations must surface through explicit user-visible state or artifacts/i)).toBeInTheDocument();
  });

  it("surfaces sectioned provenance and runtime fields explicitly instead of flattening metadata", () => {
    render(<AboutPanel {...buildProps()} />);

    expect(screen.getByText(/Artifact identity/i)).toBeInTheDocument();
    expect(screen.getByText(/Build provenance/i)).toBeInTheDocument();
    expect(screen.getByText(/Runtime posture/i)).toBeInTheDocument();
    expect(screen.getByText(/Legal and notice context/i)).toBeInTheDocument();
    expect(screen.getByText(/darwin-arm64/i)).toBeInTheDocument();
    expect(screen.getByText(/22\.4\.0/i)).toBeInTheDocument();
    expect(screen.getByText(/33\.2\.1/i)).toBeInTheDocument();
    expect(screen.getByText(/19\.0\.0/i)).toBeInTheDocument();
  });

  it("surfaces references explicitly so docs, repository, license, and protocol links remain inspectable", () => {
    render(<AboutPanel {...buildProps()} />);

    expect(screen.getByText(/Documentation/i)).toBeInTheDocument();
    expect(screen.getByText(/Repository lineage/i)).toBeInTheDocument();
    expect(screen.getAllByText(/License/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Protocol contract/i)).toBeInTheDocument();
    expect(screen.getByText(/Internal docs surface/i)).toBeInTheDocument();
    expect(screen.getByText(/RPC\/ledger contract v1/i)).toBeInTheDocument();
  });

  it("keeps metric cards operator-visible as facts about version, channel, protocol, and build", () => {
    render(<AboutPanel {...buildProps()} />);

    expect(screen.getAllByText(/Version/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Channel/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Protocol/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Build hash/i).length).toBeGreaterThanOrEqual(1);
  });

  it("wires refresh explicitly instead of implying metadata self-refreshes", () => {
    const props = buildProps();
    render(<AboutPanel {...props} />);

    const refreshButton = screen.getAllByRole("button").find((button) => button.textContent?.trim() === "");
    expect(refreshButton).toBeDefined();

    fireEvent.click(refreshButton!);
    expect(props.onRefreshRequested).toHaveBeenCalledTimes(1);
  });

  it("wires reference opening explicitly for documentation and provenance links", () => {
    const props = buildProps();
    render(<AboutPanel {...props} />);

    fireEvent.click(screen.getByText(/Documentation/i));
    fireEvent.click(screen.getByText(/Repository lineage/i));

    expect(props.onOpenLinkRequested).toHaveBeenCalledTimes(2);
    expect(props.onOpenLinkRequested).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: "docs", label: "Documentation" }),
    );
    expect(props.onOpenLinkRequested).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: "repo", label: "Repository lineage" }),
    );
  });

  it("surfaces degraded and restricted posture explicitly instead of reusing the healthy trusted shell", () => {
    render(
      <AboutPanel
        {...buildProps({
          health: "degraded",
          trustLevel: "restricted",
        })}
      />,
    );

    expect(screen.getByText(/degraded/i)).toBeInTheDocument();
    expect(screen.getByText(/restricted/i)).toBeInTheDocument();
  });

  it("renders sparse metadata explicitly when optional provenance fields are unavailable", () => {
    render(
      <AboutPanel
        {...buildProps({
          buildHash: null,
          releaseDate: null,
          repoRevision: null,
          protocolVersion: null,
          licenseName: null,
          copyrightLine: null,
          metrics: [
            { id: "version", label: "Version", value: "0.1.0-dev.42", tone: "good" },
            { id: "channel", label: "Channel", value: "dev", tone: "neutral" },
            { id: "protocol", label: "Protocol", value: "unknown", tone: "neutral" },
            { id: "build", label: "Build hash", value: "unknown", tone: "neutral" },
          ],
          sections: [
            {
              id: "build",
              title: "Build provenance",
              subtitle: "Build-time identifiers and repository lineage for the running artifact.",
              icon: "build",
              fields: [
                { id: "build-hash", label: "Build hash", value: "Unknown", emphasized: true },
                { id: "repo-revision", label: "Repository revision", value: "Unknown" },
                { id: "release-date", label: "Release date", value: "Unknown" },
                { id: "protocol-version", label: "Protocol version", value: "Unknown" },
              ],
            },
          ],
          links: [
            { id: "license", label: "License", kind: "license", hrefLabel: "Unknown license", enabled: true },
          ],
        })}
      />,
    );

    expect(screen.getAllByText(/Unknown/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Unknown license/i)).toBeInTheDocument();
  });

  it("renders loading posture explicitly without dropping the about shell contract", () => {
    render(<AboutPanel {...buildProps({ loading: true })} />);

    expect(screen.getByText(/About ADJUTORIX/i)).toBeInTheDocument();
    expect(screen.getByText(/Authoritative identity, provenance, build, runtime, governance, and compatibility posture/i)).toBeInTheDocument();
    expect(screen.getByText(/Hydrating system identity surface/i)).toBeInTheDocument();
  });

  it("does not collapse the about shell into only static copy; metrics, sections, invariants, references, and controls remain distinct", () => {
    render(<AboutPanel {...buildProps()} />);

    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(5);
    expect(screen.getByText(/Artifact identity/i)).toBeInTheDocument();
    expect(screen.getByText(/Core invariants/i)).toBeInTheDocument();
    expect(screen.getByText(/References/i)).toBeInTheDocument();
    expect(screen.getByText(/artifact identity explicit/i)).toBeInTheDocument();
  });
});
