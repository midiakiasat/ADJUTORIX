import crypto from "node:crypto";

/**
 * ADJUTORIX APP — MAIN / AGENT / agent_health.ts
 *
 * Canonical health and readiness evaluator for the Adjutorix agent.
 *
 * Purpose:
 * - fuse process supervision, auth posture, transport reachability, and RPC viability
 *   into one deterministic health model
 * - provide a single source of truth for whether the agent is merely running,
 *   actually ready, degraded, unhealthy, or unsafe to use
 * - centralize policy gates for UI, IPC, diagnostics, retry behavior, and restart logic
 * - expose stable, auditable health reports rather than ad hoc booleans
 *
 * Scope:
 * - child-process state and restart churn
 * - auth/token readiness
 * - HTTP/JSON-RPC transport health
 * - last probe / last RPC quality
 * - capability readiness (query / verify / patch / diagnostics)
 * - degradation causes, fatal blockers, and confidence
 *
 * Hard invariants:
 * - identical input snapshots produce identical health hashes
 * - fatal blockers always dominate degraded warnings
 * - missing auth, dead process, and dead transport remain distinct conditions
 * - readiness is capability-specific, not one global boolean shortcut
 * - health evaluation is pure and read-only
 * - outputs are serialization-stable and auditable
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type AgentHealthLevel = "healthy" | "degraded" | "unhealthy" | "offline";
export type AgentHealthSeverity = "info" | "warn" | "error" | "fatal";
export type AgentHealthCategory =
  | "process"
  | "auth"
  | "transport"
  | "rpc"
  | "restart"
  | "capacity"
  | "configuration"
  | "consistency";

export type AgentProcessSnapshot = {
  health: "idle" | "starting" | "ready" | "degraded" | "stopped" | "error";
  pid: number | null;
  startedAtMs: number | null;
  readyAtMs: number | null;
  stoppedAtMs: number | null;
  lastExitCode: number | null;
  lastExitSignal: string | null;
  lastExitKind: "clean" | "signal" | "crash" | "unknown" | null;
  restartCount: number;
  consecutiveProbeFailures: number;
  childPresent: boolean;
  disposed: boolean;
};

export type AgentAuthSnapshot = {
  state: "uninitialized" | "ready" | "missing" | "empty" | "invalid" | "unreadable" | "error";
  trust: "none" | "weak" | "usable";
  tokenLoadedAtMs: number | null;
  tokenFingerprint: string | null;
  tokenLength: number | null;
  reason: string;
};

export type AgentClientStateSnapshot = {
  health: "idle" | "ready" | "degraded" | "error";
  tokenLoaded: boolean;
  lastHttpStatus: number | null;
  lastError: string | null;
  lastMethod: string | null;
  lastDurationMs: number | null;
  lastSeenAtMs: number | null;
};

export type AgentProbeSnapshot = {
  ok: boolean;
  status: number | null;
  durationMs: number;
  checkedAtMs: number;
  error: string | null;
};

export type AgentRpcSnapshot = {
  ok: boolean;
  method: string;
  kind?: "transport" | "timeout" | "http" | "auth" | "protocol" | "rpc" | "invalid-response";
  httpStatus: number | null;
  durationMs: number;
  receivedAtMs: number;
  message?: string;
};

export type AgentHealthInputs = {
  agentUrl: string;
  process: AgentProcessSnapshot;
  auth: AgentAuthSnapshot;
  client: AgentClientStateSnapshot;
  lastProbe: AgentProbeSnapshot | null;
  lastRpc: AgentRpcSnapshot | null;
};

export type AgentHealthCheck = {
  id: string;
  category: AgentHealthCategory;
  severity: AgentHealthSeverity;
  ok: boolean;
  message: string;
  detail: Record<string, JsonValue>;
};

export type AgentCapabilityReadiness = {
  query: boolean;
  status: boolean;
  verify: boolean;
  patchPreview: boolean;
  patchApply: boolean;
  diagnostics: boolean;
};

export type AgentHealthReport = {
  schema: 1;
  level: AgentHealthLevel;
  online: boolean;
  usable: boolean;
  confidence: number;
  capabilityReadiness: AgentCapabilityReadiness;
  counts: {
    total: number;
    info: number;
    warn: number;
    error: number;
    fatal: number;
    failed: number;
  };
  checks: AgentHealthCheck[];
  evidence: {
    agentUrl: string;
    processFingerprint: string;
    authFingerprint: string;
    transportFingerprint: string;
    stateFingerprint: string;
  };
  hash: string;
};

export type AgentHealthPolicy = {
  maxRecommendedProbeMs: number;
  maxRecommendedRpcMs: number;
  maxRestartCountBeforeDegraded: number;
  maxConsecutiveProbeFailuresBeforeUnhealthy: number;
  requireUsableAuthForRpc: boolean;
  requireReadyProcessForRpc: boolean;
  requireRecentClientSeenMs: number;
};

export type AgentHealthAuditRecord = {
  schema: 1;
  ts_ms: number;
  action: "evaluate";
  decision: "allow" | "deny";
  reason: string;
  detail: Record<string, JsonValue>;
  hash: string;
};

export type AgentHealthAuditFn = (record: AgentHealthAuditRecord) => void;

export type AgentHealthOptions = {
  policy?: Partial<AgentHealthPolicy>;
  audit?: AgentHealthAuditFn;
  now?: () => number;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const DEFAULT_POLICY: AgentHealthPolicy = {
  maxRecommendedProbeMs: 1500,
  maxRecommendedRpcMs: 3000,
  maxRestartCountBeforeDegraded: 2,
  maxConsecutiveProbeFailuresBeforeUnhealthy: 3,
  requireUsableAuthForRpc: true,
  requireReadyProcessForRpc: true,
  requireRecentClientSeenMs: 5 * 60 * 1000,
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`main:agent:agent_health:${message}`);
  }
}

function stableJson(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(normalize);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      out[key] = normalize((v as Record<string, unknown>)[key]);
    }
    return out;
  };
  return JSON.stringify(normalize(value));
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function nowMs(now?: () => number): number {
  return (now ?? Date.now)();
}

function check(
  id: string,
  category: AgentHealthCategory,
  severity: AgentHealthSeverity,
  ok: boolean,
  message: string,
  detail: Record<string, JsonValue> = {},
): AgentHealthCheck {
  return { id, category, severity, ok, message, detail: JSON.parse(stableJson(detail)) as Record<string, JsonValue> };
}

function countChecks(checks: AgentHealthCheck[]) {
  return {
    total: checks.length,
    info: checks.filter((c) => c.severity === "info").length,
    warn: checks.filter((c) => c.severity === "warn").length,
    error: checks.filter((c) => c.severity === "error").length,
    fatal: checks.filter((c) => c.severity === "fatal").length,
    failed: checks.filter((c) => !c.ok).length,
  };
}

function reportHash(core: Omit<AgentHealthReport, "hash">): string {
  return sha256(stableJson(core));
}

function auditHash(core: Omit<AgentHealthAuditRecord, "hash">): string {
  return sha256(stableJson(core));
}

// -----------------------------------------------------------------------------
// SERVICE
// -----------------------------------------------------------------------------

export class AgentHealthService {
  private readonly policy: AgentHealthPolicy;
  private readonly audit?: AgentHealthAuditFn;
  private readonly now?: () => number;

  constructor(options: AgentHealthOptions = {}) {
    this.policy = { ...DEFAULT_POLICY, ...(options.policy ?? {}) };
    this.audit = options.audit;
    this.now = options.now;
  }

  evaluate(inputs: AgentHealthInputs): AgentHealthReport {
    const checks: AgentHealthCheck[] = [];
    const ts = nowMs(this.now);

    // -----------------------------------------------------------------------
    // PROCESS
    // -----------------------------------------------------------------------
    checks.push(check(
      "process.child_present",
      "process",
      inputs.process.childPresent ? "info" : "fatal",
      inputs.process.childPresent,
      "Managed agent child process should be present.",
      {
        pid: inputs.process.pid,
        health: inputs.process.health,
      },
    ));

    checks.push(check(
      "process.ready_state",
      "process",
      inputs.process.health === "ready" ? "info" : inputs.process.health === "starting" ? "warn" : "error",
      inputs.process.health === "ready",
      "Agent process should report ready state.",
      {
        health: inputs.process.health,
        readyAtMs: inputs.process.readyAtMs,
      },
    ));

    checks.push(check(
      "restart.churn_bound",
      "restart",
      inputs.process.restartCount <= this.policy.maxRestartCountBeforeDegraded ? "info" : "warn",
      inputs.process.restartCount <= this.policy.maxRestartCountBeforeDegraded,
      "Restart churn should remain within recommended bounds.",
      {
        restartCount: inputs.process.restartCount,
        limit: this.policy.maxRestartCountBeforeDegraded,
      },
    ));

    checks.push(check(
      "transport.probe_failure_bound",
      "transport",
      inputs.process.consecutiveProbeFailures < this.policy.maxConsecutiveProbeFailuresBeforeUnhealthy ? "info" : "error",
      inputs.process.consecutiveProbeFailures < this.policy.maxConsecutiveProbeFailuresBeforeUnhealthy,
      "Consecutive probe failures should remain bounded.",
      {
        consecutiveProbeFailures: inputs.process.consecutiveProbeFailures,
        limit: this.policy.maxConsecutiveProbeFailuresBeforeUnhealthy,
      },
    ));

    // -----------------------------------------------------------------------
    // AUTH
    // -----------------------------------------------------------------------
    checks.push(check(
      "auth.token_ready",
      "auth",
      inputs.auth.state === "ready" ? "info" : "fatal",
      inputs.auth.state === "ready",
      "Agent auth token should be loaded and valid.",
      {
        authState: inputs.auth.state,
        trust: inputs.auth.trust,
        tokenLength: inputs.auth.tokenLength,
      },
    ));

    checks.push(check(
      "auth.token_trust_usable",
      "auth",
      inputs.auth.trust === "usable" ? "info" : inputs.auth.trust === "weak" ? "warn" : "error",
      inputs.auth.trust === "usable",
      "Agent auth trust should be usable for stable RPC behavior.",
      {
        trust: inputs.auth.trust,
      },
    ));

    // -----------------------------------------------------------------------
    // TRANSPORT / CLIENT
    // -----------------------------------------------------------------------
    const recentClientSeen =
      inputs.client.lastSeenAtMs !== null &&
      ts - inputs.client.lastSeenAtMs <= this.policy.requireRecentClientSeenMs;

    checks.push(check(
      "transport.client_recent",
      "transport",
      recentClientSeen ? "info" : "warn",
      recentClientSeen,
      "Agent client should have recent contact with the agent.",
      {
        lastSeenAtMs: inputs.client.lastSeenAtMs,
        maxAgeMs: this.policy.requireRecentClientSeenMs,
      },
    ));

    checks.push(check(
      "transport.client_health",
      "transport",
      inputs.client.health === "ready" ? "info" : inputs.client.health === "degraded" ? "warn" : "error",
      inputs.client.health === "ready",
      "Transport/client layer should report ready health.",
      {
        clientHealth: inputs.client.health,
        lastError: inputs.client.lastError,
      },
    ));

    if (inputs.lastProbe) {
      checks.push(check(
        "transport.last_probe_ok",
        "transport",
        inputs.lastProbe.ok ? "info" : "error",
        inputs.lastProbe.ok,
        "Last agent readiness probe should succeed.",
        {
          status: inputs.lastProbe.status,
          durationMs: inputs.lastProbe.durationMs,
          error: inputs.lastProbe.error,
        },
      ));

      checks.push(check(
        "transport.last_probe_latency",
        "transport",
        inputs.lastProbe.durationMs <= this.policy.maxRecommendedProbeMs ? "info" : "warn",
        inputs.lastProbe.durationMs <= this.policy.maxRecommendedProbeMs,
        "Probe latency should remain within recommended bounds.",
        {
          durationMs: inputs.lastProbe.durationMs,
          maxRecommendedProbeMs: this.policy.maxRecommendedProbeMs,
        },
      ));
    } else {
      checks.push(check(
        "transport.probe_present",
        "transport",
        "warn",
        false,
        "At least one readiness probe result should be present.",
      ));
    }

    // -----------------------------------------------------------------------
    // RPC
    // -----------------------------------------------------------------------
    if (inputs.lastRpc) {
      checks.push(check(
        "rpc.last_call_ok",
        "rpc",
        inputs.lastRpc.ok ? "info" : "error",
        inputs.lastRpc.ok,
        "Last RPC call should succeed.",
        {
          method: inputs.lastRpc.method,
          kind: inputs.lastRpc.ok ? null : inputs.lastRpc.kind ?? null,
          httpStatus: inputs.lastRpc.httpStatus,
          message: inputs.lastRpc.ok ? null : inputs.lastRpc.message ?? null,
        },
      ));

      checks.push(check(
        "rpc.last_call_latency",
        "rpc",
        inputs.lastRpc.durationMs <= this.policy.maxRecommendedRpcMs ? "info" : "warn",
        inputs.lastRpc.durationMs <= this.policy.maxRecommendedRpcMs,
        "RPC latency should remain within recommended bounds.",
        {
          durationMs: inputs.lastRpc.durationMs,
          maxRecommendedRpcMs: this.policy.maxRecommendedRpcMs,
          method: inputs.lastRpc.method,
        },
      ));
    } else {
      checks.push(check(
        "rpc.last_call_present",
        "rpc",
        "warn",
        false,
        "At least one RPC result should be present for transport confidence.",
      ));
    }

    // -----------------------------------------------------------------------
    // CONSISTENCY
    // -----------------------------------------------------------------------
    checks.push(check(
      "consistency.client_auth_alignment",
      "consistency",
      inputs.client.tokenLoaded === (inputs.auth.state === "ready") ? "info" : "warn",
      inputs.client.tokenLoaded === (inputs.auth.state === "ready"),
      "Client token-loaded state should align with auth readiness.",
      {
        clientTokenLoaded: inputs.client.tokenLoaded,
        authState: inputs.auth.state,
      },
    ));

    checks.push(check(
      "consistency.process_transport_alignment",
      "consistency",
      !(inputs.process.health === "stopped" && inputs.client.health === "ready") ? "info" : "error",
      !(inputs.process.health === "stopped" && inputs.client.health === "ready"),
      "Transport cannot be healthy if the managed process is stopped.",
      {
        processHealth: inputs.process.health,
        clientHealth: inputs.client.health,
      },
    ));

    // -----------------------------------------------------------------------
    // DERIVED LEVEL / CAPABILITIES
    // -----------------------------------------------------------------------
    const hasFatal = checks.some((c) => !c.ok && c.severity === "fatal");
    const hasError = checks.some((c) => !c.ok && c.severity === "error");
    const hasWarn = checks.some((c) => !c.ok && c.severity === "warn");

    let level: AgentHealthLevel;
    if (!inputs.process.childPresent && inputs.process.health === "stopped") {
      level = "offline";
    } else if (hasFatal || hasError) {
      level = "unhealthy";
    } else if (hasWarn) {
      level = "degraded";
    } else {
      level = "healthy";
    }

    const processReady = !this.policy.requireReadyProcessForRpc || inputs.process.health === "ready";
    const authReady = !this.policy.requireUsableAuthForRpc || inputs.auth.trust === "usable";
    const transportReady = inputs.client.health === "ready" && !!inputs.lastProbe?.ok;
    const rpcReady = transportReady && (inputs.lastRpc ? inputs.lastRpc.ok : true);

    const capabilityReadiness: AgentCapabilityReadiness = {
      query: processReady && authReady && transportReady,
      status: processReady && authReady && transportReady,
      verify: processReady && authReady && transportReady,
      patchPreview: processReady && authReady && transportReady,
      patchApply: processReady && authReady && rpcReady,
      diagnostics: processReady && authReady && transportReady,
    };

    const online = inputs.process.childPresent && inputs.process.health !== "stopped";
    const usable = capabilityReadiness.query || capabilityReadiness.status;

    let confidence = 0.35;
    if (inputs.lastProbe) confidence += inputs.lastProbe.ok ? 0.2 : 0.05;
    if (inputs.lastRpc) confidence += inputs.lastRpc.ok ? 0.2 : 0.05;
    if (inputs.auth.trust === "usable") confidence += 0.15;
    else if (inputs.auth.trust === "weak") confidence += 0.05;
    if (inputs.process.health === "ready") confidence += 0.1;
    confidence = Math.max(0, Math.min(1, confidence));

    const counts = countChecks(checks);
    const core: Omit<AgentHealthReport, "hash"> = {
      schema: 1,
      level,
      online,
      usable,
      confidence,
      capabilityReadiness,
      counts,
      checks,
      evidence: {
        agentUrl: inputs.agentUrl,
        processFingerprint: sha256(stableJson(inputs.process)),
        authFingerprint: sha256(stableJson(inputs.auth)),
        transportFingerprint: sha256(stableJson({
          client: inputs.client,
          lastProbe: inputs.lastProbe,
          lastRpc: inputs.lastRpc,
        })),
        stateFingerprint: sha256(stableJson(inputs)),
      },
    };

    const report: AgentHealthReport = {
      ...core,
      hash: reportHash(core),
    };

    this.audit?.({
      schema: 1,
      ts_ms: ts,
      action: "evaluate",
      decision: level === "healthy" || level === "degraded" ? "allow" : "deny",
      reason: level === "healthy"
        ? "agent_healthy"
        : level === "degraded"
          ? "agent_degraded"
          : level === "offline"
            ? "agent_offline"
            : "agent_unhealthy",
      detail: {
        level,
        online,
        usable,
        failedChecks: checks.filter((c) => !c.ok).map((c) => c.id),
        capabilityReadiness,
      },
      hash: auditHash({
        schema: 1,
        ts_ms: ts,
        action: "evaluate",
        decision: level === "healthy" || level === "degraded" ? "allow" : "deny",
        reason: level === "healthy"
          ? "agent_healthy"
          : level === "degraded"
            ? "agent_degraded"
            : level === "offline"
              ? "agent_offline"
              : "agent_unhealthy",
        detail: {
          level,
          online,
          usable,
          failedChecks: checks.filter((c) => !c.ok).map((c) => c.id),
          capabilityReadiness,
        },
      }),
    });

    return report;
  }
}

// -----------------------------------------------------------------------------
// FACTORY / VALIDATION
// -----------------------------------------------------------------------------

export function createAgentHealthService(options: AgentHealthOptions = {}): AgentHealthService {
  return new AgentHealthService(options);
}

export function defaultAgentHealthPolicy(): AgentHealthPolicy {
  return { ...DEFAULT_POLICY };
}

export function validateAgentHealthReport(report: AgentHealthReport): void {
  assert(report.schema === 1, "report_schema_invalid");
  const core: Omit<AgentHealthReport, "hash"> = {
    schema: report.schema,
    level: report.level,
    online: report.online,
    usable: report.usable,
    confidence: report.confidence,
    capabilityReadiness: report.capabilityReadiness,
    counts: report.counts,
    checks: report.checks,
    evidence: report.evidence,
  };
  assert(report.hash === reportHash(core), "report_hash_drift");
}
