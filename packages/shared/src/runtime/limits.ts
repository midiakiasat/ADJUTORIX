export interface RuntimeLimits {
  readonly maxOpenFiles: number;
  readonly maxWorkspaceFiles: number;
  readonly maxPatchTargets: number;
  readonly maxPatchBytes: number;
  readonly maxVerificationTargets: number;
  readonly maxConcurrentJobs: number;
  readonly maxDiagnosticProblems: number;
  readonly maxArtifactBytes: number;
}

export const DEFAULT_RUNTIME_LIMITS: RuntimeLimits = {
  maxOpenFiles: 128,
  maxWorkspaceFiles: 250000,
  maxPatchTargets: 2000,
  maxPatchBytes: 10 * 1024 * 1024,
  maxVerificationTargets: 5000,
  maxConcurrentJobs: 4,
  maxDiagnosticProblems: 10000,
  maxArtifactBytes: 128 * 1024 * 1024
};

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
}

export function assertRuntimeLimits(value: RuntimeLimits): void {
  assertPositiveInteger(value.maxOpenFiles, "runtimeLimits.maxOpenFiles");
  assertPositiveInteger(value.maxWorkspaceFiles, "runtimeLimits.maxWorkspaceFiles");
  assertPositiveInteger(value.maxPatchTargets, "runtimeLimits.maxPatchTargets");
  assertPositiveInteger(value.maxPatchBytes, "runtimeLimits.maxPatchBytes");
  assertPositiveInteger(value.maxVerificationTargets, "runtimeLimits.maxVerificationTargets");
  assertPositiveInteger(value.maxConcurrentJobs, "runtimeLimits.maxConcurrentJobs");
  assertPositiveInteger(value.maxDiagnosticProblems, "runtimeLimits.maxDiagnosticProblems");
  assertPositiveInteger(value.maxArtifactBytes, "runtimeLimits.maxArtifactBytes");
}

export function mergeRuntimeLimits(
  base: RuntimeLimits,
  override: Partial<RuntimeLimits>
): RuntimeLimits {
  const merged: RuntimeLimits = {
    ...base,
    ...override
  };
  assertRuntimeLimits(merged);
  return merged;
}
