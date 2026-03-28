export interface RuntimeTimeouts {
  readonly agentStartupMs: number;
  readonly workspaceOpenMs: number;
  readonly workspaceScanMs: number;
  readonly patchValidateMs: number;
  readonly patchApplyMs: number;
  readonly verifyRunMs: number;
  readonly diagnosticsParseMs: number;
  readonly recoveryResumeMs: number;
}

export const DEFAULT_RUNTIME_TIMEOUTS: RuntimeTimeouts = {
  agentStartupMs: 30000,
  workspaceOpenMs: 15000,
  workspaceScanMs: 60000,
  patchValidateMs: 30000,
  patchApplyMs: 120000,
  verifyRunMs: 600000,
  diagnosticsParseMs: 10000,
  recoveryResumeMs: 120000
};

function assertTimeout(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer millisecond value`);
  }
}

export function assertRuntimeTimeouts(value: RuntimeTimeouts): void {
  assertTimeout(value.agentStartupMs, "runtimeTimeouts.agentStartupMs");
  assertTimeout(value.workspaceOpenMs, "runtimeTimeouts.workspaceOpenMs");
  assertTimeout(value.workspaceScanMs, "runtimeTimeouts.workspaceScanMs");
  assertTimeout(value.patchValidateMs, "runtimeTimeouts.patchValidateMs");
  assertTimeout(value.patchApplyMs, "runtimeTimeouts.patchApplyMs");
  assertTimeout(value.verifyRunMs, "runtimeTimeouts.verifyRunMs");
  assertTimeout(value.diagnosticsParseMs, "runtimeTimeouts.diagnosticsParseMs");
  assertTimeout(value.recoveryResumeMs, "runtimeTimeouts.recoveryResumeMs");
}

export function mergeRuntimeTimeouts(
  base: RuntimeTimeouts,
  override: Partial<RuntimeTimeouts>
): RuntimeTimeouts {
  const merged: RuntimeTimeouts = {
    ...base,
    ...override
  };
  assertRuntimeTimeouts(merged);
  return merged;
}
