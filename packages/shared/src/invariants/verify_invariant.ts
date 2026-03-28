export interface VerifyInvariantInput {
  readonly requested: boolean;
  readonly completed: boolean;
  readonly success: boolean;
  readonly summaryArtifactPresent: boolean;
  readonly diagnosticsCaptured: boolean;
}

export interface VerifyInvariantResult {
  readonly ok: boolean;
  readonly violations: readonly string[];
}

export function evaluateVerifyInvariant(
  input: VerifyInvariantInput
): VerifyInvariantResult {
  const violations: string[] = [];

  if (input.completed && !input.requested) {
    violations.push("Verification completed without a corresponding request.");
  }

  if (input.success && !input.completed) {
    violations.push("Verification cannot be successful before completion.");
  }

  if (input.completed && !input.summaryArtifactPresent) {
    violations.push("Completed verification is missing summary artifact.");
  }

  if (input.completed && !input.diagnosticsCaptured) {
    violations.push("Completed verification is missing diagnostics capture.");
  }

  return {
    ok: violations.length === 0,
    violations
  };
}
