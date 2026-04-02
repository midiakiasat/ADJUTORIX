import * as crypto from "node:crypto";

/**
 * ADJUTORIX APP — MAIN / SHELL / shell_status.ts
 *
 * Canonical shell subsystem health and readiness evaluator for the Electron main process.
 *
 * Purpose:
 * - provide one deterministic status/health model for the shell execution subsystem
 * - fuse command-runner state, environment fingerprint drift, recent command outcomes,
 *   policy posture, and execution safety into a single auditable report
 * - prevent callers from inventing ad hoc readiness checks such as “runner idle”,
 *   “PATH looks okay”, or “last command worked” in isolation
 * - expose capability-specific readiness for verify, diagnostics, migrations, smoke tests,
 *   and governed local tooling execution
 *
 * Scope:
 * - command-runner liveness and availability
 * - recent execution success/failure patterns
 * - timeout/kill churn and nonzero exits
 * - environment fingerprint equality/drift severity
 * - cwd/shell/policy constraints that materially affect execution
 * - operational readiness for different shell-backed workflows
 *
 * Hard invariants:
 * - identical input snapshots produce identical status hashes
 * - fatal blockers dominate degraded warnings
 * - environment drift is explicit, never silently ignored
 * - readiness is capability-specific, not a single vague boolean
 * - evaluation is pure and read-only
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

export type ShellStatusLevel = "healthy" | "degraded" | "unhealthy" | "offline";
export type ShellStatusSeverity = "info" | "warn" | "error" | "fatal";
export type ShellStatusCategory =
  | "runner"
  | "execution"
  | "environment"
  | "policy"
  | "capacity"
  | "consistency";

export type ShellRunnerSnapshot = {
  health: "idle" | "running" | "timed-out" | "stopped" | "exited" | "error";
  pid: number | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  timeoutAtMs: number | null;
  exitCode: number | null;
  exitSignal: string | null;
  exitKind: "clean" | "nonzero" | "signal" | "timeout" | "spawn-error" | "unknown" | null;
  requestHash: string | null;
  commandHash: string | null;
  description: string | null;
  childPresent: boolean;
  disposed: boolean;
  timedOut: boolean;
  spawnError: string | null;
};

export type ShellPolicySnapshot = {
  allowShell: boolean;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  gracefulStopSignal: string;
  gracefulStopWaitMs: number;
  maxStdoutLines: number;
  maxStderrLines: number;
  maxLineLength: number;
  persistLogs: boolean;
  logRoot: string;
  inheritProcessEnv: boolean;
  cwdAllowlistCount: number;
  redactPatternCount: number;
};

export type ShellExecutionSample = {
  ok: boolean;
  exitKind: "clean" | "nonzero" | "signal" | "timeout" | "spawn-error" | "unknown";
  durationMs: number;
  endedAtMs: number;
  timedOut: boolean;
  commandHash: string;
};

export type ShellEnvironmentFingerprint = {
  hash: string;
};

export type ShellEnvironmentComparison = {
  equal: boolean;
  driftCount: number;
  drifts: Array<{
    kind: "platform" | "runtime" | "path" | "locale" | "shell" | "workspace" | "toolchain" | "environment-variable" | "unknown";
    severity: "info" | "warn" | "error";
    key: string;
    message: string;
  }>;
};

export type ShellStatusInputs = {
  runner: ShellRunnerSnapshot;
  policy: ShellPolicySnapshot;
  environmentCurrent: ShellEnvironmentFingerprint | null;
  environmentBaseline: ShellEnvironmentFingerprint | null;
  environmentComparison: ShellEnvironmentComparison | null;
  recentExecutions: ShellExecutionSample[];
};

export type ShellStatusCheck = {
  id: string;
  category: ShellStatusCategory;
  severity: ShellStatusSeverity;
  ok: boolean;
  message: string;
  detail: Record<string, JsonValue>;
};

export type ShellCapabilityReadiness = {
  verify: boolean;
  diagnostics: boolean;
  migrations: boolean;
  smoke: boolean;
  localTooling: boolean;
};

export type ShellStatusReport = {
  schema: 1;
  level: ShellStatusLevel;
  online: boolean;
  usable: boolean;
  confidence: number;
  capabilityReadiness: ShellCapabilityReadiness;
  counts: {
    total: number;
    info: number;
    warn: number;
    error: number;
    fatal: number;
    failed: number;
  };
  checks: ShellStatusCheck[];
  evidence: {
    runnerFingerprint: string;
    policyFingerprint: string;
    environmentFingerprint: string | null;
    baselineFingerprint: string | null;
    stateFingerprint: string;
  };
  hash: string;
};

export type ShellStatusPolicy = {
  maxRecommendedDurationMs: number;
  maxRecentFailureRate: number;
  maxConsecutiveTimeouts: number;
  requireEnvironmentBaseline: boolean;
  pathDriftSeverityIsError: boolean;
  shellDriftSeverityIsWarning: boolean;
  requireNonDisposedRunner: boolean;
  requireIdleOrRunning: boolean;
};

export type ShellStatusAuditRecord = {
  schema: 1;
  ts_ms: number;
  action: "evaluate";
  decision: "allow" | "deny";
  reason: string;
  detail: Record<string, JsonValue>;
  hash: string;
};

export type ShellStatusAuditFn = (record: ShellStatusAuditRecord) => void;

export type ShellStatusOptions = {
  policy?: Partial<ShellStatusPolicy>;
  audit?: ShellStatusAuditFn;
  now?: () => number;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const DEFAULT_POLICY: ShellStatusPolicy = {
  maxRecommendedDurationMs: 30_000,
  maxRecentFailureRate: 0.35,
  maxConsecutiveTimeouts: 2,
  requireEnvironmentBaseline: true,
  pathDriftSeverityIsError: true,
  shellDriftSeverityIsWarning: true,
  requireNonDisposedRunner: true,
  requireIdleOrRunning: true,
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`main:shell:shell_status:${message}`);
}

function stableJson(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(normalize);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) out[key] = normalize((v as Record<string, unknown>)[key]);
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
  category: ShellStatusCategory,
  severity: ShellStatusSeverity,
  ok: boolean,
  message: string,
  detail: Record<string, JsonValue> = {},
): ShellStatusCheck {
  return {
    id,
    category,
    severity,
    ok,
    message,
    detail: JSON.parse(stableJson(detail)) as Record<string, JsonValue>,
  };
}

function countChecks(checks: ShellStatusCheck[]) {
  return {
    total: checks.length,
    info: checks.filter((c) => c.severity === "info").length,
    warn: checks.filter((c) => c.severity === "warn").length,
    error: checks.filter((c) => c.severity === "error").length,
    fatal: checks.filter((c) => c.severity === "fatal").length,
    failed: checks.filter((c) => !c.ok).length,
  };
}

function reportHash(core: Omit<ShellStatusReport, "hash">): string {
  return sha256(stableJson(core));
}

function auditHash(core: Omit<ShellStatusAuditRecord, "hash">): string {
  return sha256(stableJson(core));
}

// -----------------------------------------------------------------------------
// SERVICE
// -----------------------------------------------------------------------------

export class ShellStatusService {
  private readonly policy: ShellStatusPolicy;
  private readonly audit?: ShellStatusAuditFn;
  private readonly now?: () => number;

  constructor(options: ShellStatusOptions = {}) {
    this.policy = { ...DEFAULT_POLICY, ...(options.policy ?? {}) };
    this.audit = options.audit;
    this.now = options.now;
  }

  evaluate(inputs: ShellStatusInputs): ShellStatusReport {
    const checks: ShellStatusCheck[] = [];
    const ts = nowMs(this.now);

    // -----------------------------------------------------------------------
    // RUNNER
    // -----------------------------------------------------------------------
    checks.push(check(
      "runner.not_disposed",
      "runner",
      !inputs.runner.disposed ? "info" : "fatal",
      !inputs.runner.disposed,
      "Command runner must not be disposed.",
      { disposed: inputs.runner.disposed },
    ));

    checks.push(check(
      "runner.health_operable",
      "runner",
      ["idle", "running"].includes(inputs.runner.health) ? "info" : inputs.runner.health === "exited" ? "warn" : "error",
      !this.policy.requireIdleOrRunning || ["idle", "running"].includes(inputs.runner.health),
      "Runner health should be operable for new shell activity.",
      {
        health: inputs.runner.health,
        pid: inputs.runner.pid,
        childPresent: inputs.runner.childPresent,
      },
    ));

    checks.push(check(
      "runner.spawn_error_absent",
      "runner",
      inputs.runner.spawnError === null ? "info" : "error",
      inputs.runner.spawnError === null,
      "Runner should not carry a spawn error state.",
      { spawnError: inputs.runner.spawnError },
    ));

    // -----------------------------------------------------------------------
    // POLICY
n    // -----------------------------------------------------------------------
    checks.push(check(
      "policy.timeout_ordering_valid",
      "policy",
      inputs.policy.defaultTimeoutMs <= inputs.policy.maxTimeoutMs ? "info" : "fatal",
      inputs.policy.defaultTimeoutMs <= inputs.policy.maxTimeoutMs,
      "Default timeout must not exceed maximum timeout.",
      {
        defaultTimeoutMs: inputs.policy.defaultTimeoutMs,
        maxTimeoutMs: inputs.policy.maxTimeoutMs,
      },
    ));

    checks.push(check(
      "policy.capture_bounds_present",
      "capacity",
      inputs.policy.maxStdoutLines > 0 && inputs.policy.maxStderrLines > 0 && inputs.policy.maxLineLength > 0 ? "info" : "fatal",
      inputs.policy.maxStdoutLines > 0 && inputs.policy.maxStderrLines > 0 && inputs.policy.maxLineLength > 0,
      "Output capture bounds must be positive.",
      {
        maxStdoutLines: inputs.policy.maxStdoutLines,
        maxStderrLines: inputs.policy.maxStderrLines,
        maxLineLength: inputs.policy.maxLineLength,
      },
    ));

    checks.push(check(
      "policy_cwd_allowlist_present",
      "policy",
      inputs.policy.cwdAllowlistCount > 0 ? "info" : "error",
      inputs.policy.cwdAllowlistCount > 0,
      "At least one cwd allowlist entry should exist.",
      { cwdAllowlistCount: inputs.policy.cwdAllowlistCount },
    ));

    // -----------------------------------------------------------------------
    // ENVIRONMENT
    // -----------------------------------------------------------------------
    if (this.policy.requireEnvironmentBaseline) {
      checks.push(check(
        "environment.baseline_present",
        "environment",
        inputs.environmentBaseline ? "info" : "warn",
        inputs.environmentBaseline !== null,
        "Environment baseline fingerprint should be present.",
      ));
    }

    checks.push(check(
      "environment.current_present",
      "environment",
      inputs.environmentCurrent ? "info" : "error",
      inputs.environmentCurrent !== null,
      "Current environment fingerprint should be present.",
    ));

    if (inputs.environmentComparison) {
      const hasPathDrift = inputs.environmentComparison.drifts.some((d) => d.kind === "path");
      const hasShellDrift = inputs.environmentComparison.drifts.some((d) => d.kind === "shell");
      const equal = inputs.environmentComparison.equal;

      checks.push(check(
        "environment.equal_or_known_drift",
        "environment",
        equal ? "info" : hasPathDrift && this.policy.pathDriftSeverityIsError ? "error" : hasShellDrift && this.policy.shellDriftSeverityIsWarning ? "warn" : "warn",
        equal || (!hasPathDrift || !this.policy.pathDriftSeverityIsError),
        "Environment comparison should not indicate material drift.",
        {
          equal,
          driftCount: inputs.environmentComparison.driftCount,
          driftKinds: inputs.environmentComparison.drifts.map((d) => d.kind),
        },
      ));
    } else {
      checks.push(check(
        "environment.comparison_present",
        "environment",
        "warn",
        false,
        "Environment comparison should be available when a baseline exists.",
      ));
    }

    // -----------------------------------------------------------------------
    // EXECUTION HISTORY
    // -----------------------------------------------------------------------
    const recent = inputs.recentExecutions;
    const failures = recent.filter((r) => !r.ok).length;
    const failureRate = recent.length === 0 ? 0 : failures / recent.length;
    const consecutiveTimeouts = countTrailingTimeouts(recent);
    const slowCount = recent.filter((r) => r.durationMs > this.policy.maxRecommendedDurationMs).length;

    checks.push(check(
      "execution.failure_rate_bounded",
      "execution",
      failureRate <= this.policy.maxRecentFailureRate ? "info" : "warn",
      failureRate <= this.policy.maxRecentFailureRate,
      "Recent shell execution failure rate should remain bounded.",
      {
        sampleSize: recent.length,
        failures,
        failureRate,
        limit: this.policy.maxRecentFailureRate,
      },
    ));

    checks.push(check(
      "execution.consecutive_timeouts_bounded",
      "execution",
      consecutiveTimeouts <= this.policy.maxConsecutiveTimeouts ? "info" : "error",
      consecutiveTimeouts <= this.policy.maxConsecutiveTimeouts,
      "Consecutive timeouts should remain bounded.",
      {
        consecutiveTimeouts,
        limit: this.policy.maxConsecutiveTimeouts,
      },
    ));

    checks.push(check(
      "execution.runtime_latency_reasonable",
      "execution",
      slowCount === 0 ? "info" : "warn",
      slowCount === 0,
      "Recent shell executions should remain within recommended duration.",
      {
        slowCount,
        thresholdMs: this.policy.maxRecommendedDurationMs,
      },
    ));

    // -----------------------------------------------------------------------
    // CONSISTENCY
    // -----------------------------------------------------------------------
    checks.push(check(
      "consistency.child_state_alignment",
      "consistency",
      !(inputs.runner.childPresent && inputs.runner.health === "idle") ? "info" : "error",
      !(inputs.runner.childPresent && inputs.runner.health === "idle"),
      "Runner child presence must align with runner health.",
      {
        childPresent: inputs.runner.childPresent,
        health: inputs.runner.health,
      },
    ));

    checks.push(check(
      "consistency.timeout_state_alignment",
      "consistency",
      !(inputs.runner.timedOut && inputs.runner.exitKind && inputs.runner.exitKind !== "timeout") ? "info" : "error",
      !(inputs.runner.timedOut && inputs.runner.exitKind && inputs.runner.exitKind !== "timeout"),
      "Timed-out flag must align with timeout exit kind.",
      {
        timedOut: inputs.runner.timedOut,
        exitKind: inputs.runner.exitKind,
      },
    ));

    // -----------------------------------------------------------------------
    // DERIVED LEVEL / CAPABILITIES
    // -----------------------------------------------------------------------
    const hasFatal = checks.some((c) => !c.ok && c.severity === "fatal");
    const hasError = checks.some((c) => !c.ok && c.severity === "error");
    const hasWarn = checks.some((c) => !c.ok && c.severity === "warn");

    let level: ShellStatusLevel;
    if (inputs.runner.disposed || inputs.runner.health === "stopped") {
      level = "offline";
    } else if (hasFatal || hasError) {
      level = "unhealthy";
    } else if (hasWarn) {
      level = "degraded";
    } else {
      level = "healthy";
    }

    const environmentReady = !!inputs.environmentCurrent && (!this.policy.requireEnvironmentBaseline || !!inputs.environmentBaseline) && (!inputs.environmentComparison || inputs.environmentComparison.equal || !inputs.environmentComparison.drifts.some((d) => d.kind === "path" && this.policy.pathDriftSeverityIsError));
    const runnerReady = !inputs.runner.disposed && ["idle", "running"].includes(inputs.runner.health);
    const executionReady = consecutiveTimeouts <= this.policy.maxConsecutiveTimeouts && failureRate <= this.policy.maxRecentFailureRate;

    const capabilityReadiness: ShellCapabilityReadiness = {
      verify: runnerReady && environmentReady && executionReady,
      diagnostics: runnerReady && environmentReady,
      migrations: runnerReady && environmentReady && executionReady,
      smoke: runnerReady && environmentReady && executionReady,
      localTooling: runnerReady && environmentReady,
    };

    const online = !inputs.runner.disposed && inputs.runner.health !== "stopped";
    const usable = Object.values(capabilityReadiness).some(Boolean);

    let confidence = 0.35;
    if (runnerReady) confidence += 0.2;
    if (environmentReady) confidence += 0.2;
    if (recent.length > 0) confidence += failureRate === 0 ? 0.15 : Math.max(0, 0.15 - failureRate * 0.2);
    if (consecutiveTimeouts === 0) confidence += 0.1;
    confidence = Math.max(0, Math.min(1, confidence));

    const counts = countChecks(checks);
    const core: Omit<ShellStatusReport, "hash"> = {
      schema: 1,
      level,
      online,
      usable,
      confidence,
      capabilityReadiness,
      counts,
      checks,
      evidence: {
        runnerFingerprint: sha256(stableJson(inputs.runner)),
        policyFingerprint: sha256(stableJson(inputs.policy)),
        environmentFingerprint: inputs.environmentCurrent?.hash ?? null,
        baselineFingerprint: inputs.environmentBaseline?.hash ?? null,
        stateFingerprint: sha256(stableJson(inputs)),
      },
    };

    const report: ShellStatusReport = {
      ...core,
      hash: reportHash(core),
    };

    this.audit?.({
      schema: 1,
      ts_ms: ts,
      action: "evaluate",
      decision: level === "healthy" || level === "degraded" ? "allow" : "deny",
      reason: level === "healthy"
        ? "shell_status_healthy"
        : level === "degraded"
          ? "shell_status_degraded"
          : level === "offline"
            ? "shell_status_offline"
            : "shell_status_unhealthy",
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
          ? "shell_status_healthy"
          : level === "degraded"
            ? "shell_status_degraded"
            : level === "offline"
              ? "shell_status_offline"
              : "shell_status_unhealthy",
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

function countTrailingTimeouts(samples: ShellExecutionSample[]): number {
  let count = 0;
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    if (samples[i].timedOut || samples[i].exitKind === "timeout") count += 1;
    else break;
  }
  return count;
}

// -----------------------------------------------------------------------------
// FACTORY / VALIDATION
// -----------------------------------------------------------------------------

export function createShellStatusService(options: ShellStatusOptions = {}): ShellStatusService {
  return new ShellStatusService(options);
}

export function defaultShellStatusPolicy(): ShellStatusPolicy {
  return { ...DEFAULT_POLICY };
}

export function validateShellStatusReport(report: ShellStatusReport): void {
  assert(report.schema === 1, "report_schema_invalid");
  const core: Omit<ShellStatusReport, "hash"> = {
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
