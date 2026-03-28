import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * ADJUTORIX APP — TESTS / RENDERER / provider_status.test.tsx
 *
 * Canonical provider-status renderer contract suite.
 *
 * Purpose:
 * - verify that ProviderStatus preserves governed provider truth around connection state,
 *   auth posture, trust level, provider/model provenance, endpoint identity, latency,
 *   degradation signals, and explicit reconnect/refresh actions
 * - verify that provider state remains an operator-facing evidence surface rather than
 *   decorative connectivity chrome
 * - verify that disconnected, degraded, healthy, loading, and restricted states remain explicit
 *
 * Test philosophy:
 * - no snapshots
 * - assert operator-visible status semantics and callback routing
 * - prefer provenance and capability contracts over implementation details
 *
 * Notes:
 * - this suite assumes ProviderStatus exports a default React component from the renderer tree
 * - if the production prop surface evolves, update buildProps() first
 */

import ProviderStatus from "../../../src/renderer/components/ProviderStatus";

type ProviderStatusProps = React.ComponentProps<typeof ProviderStatus>;

function buildProps(overrides: Partial<ProviderStatusProps> = {}): ProviderStatusProps {
  return {
    title: "Provider status",
    subtitle: "Governed provider, model, auth, and endpoint health surface",
    loading: false,
    health: "healthy",
    connectionState: "connected",
    authState: "available",
    trustLevel: "trusted",
    providerLabel: "Local Agent",
    modelLabel: "adjutorix-core",
    endpointLabel: "http://127.0.0.1:8000/rpc",
    protocolVersion: "1",
    sessionId: "agent-session-42",
    latencyMs: 84,
    pendingRequestCount: 1,
    notes: [
      "Provider is connected with valid auth and trusted local endpoint identity.",
      "Pending request count remains visible so latency and stream state are not inferred from color only.",
    ],
    metrics: {
      reconnectAttempts: 0,
      successfulRequests: 28,
      failedRequests: 1,
      pendingRequests: 1,
    },
    canReconnect: true,
    canRefresh: true,
    onReconnectRequested: vi.fn(),
    onRefreshRequested: vi.fn(),
    ...overrides,
  } as ProviderStatusProps;
}

describe("ProviderStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the canonical provider shell with title, subtitle, provider, model, and endpoint identity", () => {
    render(<ProviderStatus {...buildProps()} />);

    expect(screen.getByText(/Provider status/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed provider, model, auth, and endpoint health surface/i)).toBeInTheDocument();
    expect(screen.getByText(/Local Agent/i)).toBeInTheDocument();
    expect(screen.getByText(/adjutorix-core/i)).toBeInTheDocument();
    expect(screen.getByText(/http:\/\/127\.0\.0\.1:8000\/rpc/i)).toBeInTheDocument();
    expect(screen.getByText(/agent-session-42/i)).toBeInTheDocument();
  });

  it("surfaces connection, auth, trust, and health posture explicitly instead of collapsing them into one badge", () => {
    render(<ProviderStatus {...buildProps()} />);

    expect(screen.getByText(/connected/i)).toBeInTheDocument();
    expect(screen.getByText(/available/i)).toBeInTheDocument();
    expect(screen.getByText(/trusted/i)).toBeInTheDocument();
    expect(screen.getByText(/healthy/i)).toBeInTheDocument();
  });

  it("surfaces protocol version, latency, and pending request count as operator-visible facts", () => {
    render(<ProviderStatus {...buildProps()} />);

    expect(screen.getByText(/84/i)).toBeInTheDocument();
    expect(screen.getByText(/^1$/)).toBeInTheDocument();
    expect(screen.getAllByText(/1/i).length).toBeGreaterThanOrEqual(1);
  });

  it("surfaces notes explicitly so provenance and pending activity are not inferred from color only", () => {
    render(<ProviderStatus {...buildProps()} />);

    expect(screen.getByText(/Provider is connected with valid auth/i)).toBeInTheDocument();
    expect(screen.getByText(/Pending request count remains visible/i)).toBeInTheDocument();
  });

  it("keeps metrics operator-visible as facts about reconnects and request success/failure", () => {
    render(<ProviderStatus {...buildProps()} />);

    expect(screen.getByText(/reconnect/i)).toBeInTheDocument();
    expect(screen.getByText(/successful/i)).toBeInTheDocument();
    expect(screen.getByText(/failed/i)).toBeInTheDocument();
    expect(screen.getByText(/pending/i)).toBeInTheDocument();
  });

  it("wires reconnect and refresh actions explicitly", () => {
    const props = buildProps();
    render(<ProviderStatus {...props} />);

    const buttons = screen.getAllByRole("button");
    const reconnectButton = buttons.find((button) => /reconnect/i.test(button.textContent ?? ""));
    const refreshButton = buttons.find((button) => /refresh/i.test(button.textContent ?? ""));

    expect(reconnectButton).toBeDefined();
    expect(refreshButton).toBeDefined();

    fireEvent.click(reconnectButton!);
    fireEvent.click(refreshButton!);

    expect(props.onReconnectRequested).toHaveBeenCalledTimes(1);
    expect(props.onRefreshRequested).toHaveBeenCalledTimes(1);
  });

  it("does not advertise reconnect or refresh as enabled when capability gates are closed", () => {
    render(
      <ProviderStatus
        {...buildProps({
          canReconnect: false,
          canRefresh: false,
        })}
      />,
    );

    const buttons = screen.getAllByRole("button");
    const reconnectButton = buttons.find((button) => /reconnect/i.test(button.textContent ?? ""));
    const refreshButton = buttons.find((button) => /refresh/i.test(button.textContent ?? ""));

    expect(reconnectButton).toBeDisabled();
    expect(refreshButton).toBeDisabled();
  });

  it("surfaces disconnected posture explicitly instead of reusing connected-shell assumptions", () => {
    render(
      <ProviderStatus
        {...buildProps({
          connectionState: "disconnected",
          health: "degraded",
          notes: ["Provider connection is down; reconnect before issuing model-backed requests."],
        })}
      />,
    );

    expect(screen.getByText(/disconnected/i)).toBeInTheDocument();
    expect(screen.getByText(/Provider connection is down/i)).toBeInTheDocument();
  });

  it("surfaces reconnecting posture explicitly when the provider is attempting recovery", () => {
    render(
      <ProviderStatus
        {...buildProps({
          connectionState: "reconnecting",
          metrics: {
            reconnectAttempts: 3,
            successfulRequests: 28,
            failedRequests: 2,
            pendingRequests: 0,
          },
        })}
      />,
    );

    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument();
    expect(screen.getByText(/3/i)).toBeInTheDocument();
  });

  it("surfaces missing or invalid auth posture explicitly instead of implying provider readiness", () => {
    render(
      <ProviderStatus
        {...buildProps({
          authState: "invalid",
          trustLevel: "restricted",
          health: "degraded",
          notes: ["Provider endpoint is reachable but auth is invalid for governed requests."],
        })}
      />,
    );

    expect(screen.getByText(/invalid/i)).toBeInTheDocument();
    expect(screen.getByText(/restricted/i)).toBeInTheDocument();
    expect(screen.getByText(/auth is invalid/i)).toBeInTheDocument();
  });

  it("surfaces restricted trust posture explicitly instead of flattening it into generic health", () => {
    render(
      <ProviderStatus
        {...buildProps({
          trustLevel: "restricted",
        })}
      />,
    );

    expect(screen.getByText(/restricted/i)).toBeInTheDocument();
  });

  it("renders loading posture explicitly without dropping the provider shell contract", () => {
    render(
      <ProviderStatus
        {...buildProps({
          loading: true,
        })}
      />,
    );

    expect(screen.getByText(/Provider status/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed provider, model, auth, and endpoint health surface/i)).toBeInTheDocument();
  });

  it("does not collapse the provider shell into only a badge; metrics, notes, identity, and controls remain distinct", () => {
    render(<ProviderStatus {...buildProps()} />);

    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Local Agent/i)).toBeInTheDocument();
    expect(screen.getByText(/Provider is connected with valid auth/i)).toBeInTheDocument();
    expect(screen.getByText(/successful/i)).toBeInTheDocument();
  });
});
