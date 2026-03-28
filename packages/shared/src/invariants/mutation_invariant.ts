import type { PatchArtifact } from "../patch/patch_artifact.js";

export interface MutationInvariantResult {
  readonly ok: boolean;
  readonly violations: readonly string[];
}

export interface MutationInvariantInput {
  readonly directWriteDetected: boolean;
  readonly patchArtifact?: PatchArtifact;
  readonly governedPaths: readonly string[];
  readonly changedPaths: readonly string[];
}

export function evaluateMutationInvariant(
  input: MutationInvariantInput
): MutationInvariantResult {
  const violations: string[] = [];

  if (input.directWriteDetected) {
    violations.push("Direct workspace mutation detected outside controlled patch flow.");
  }

  if (input.changedPaths.length > 0 && !input.patchArtifact) {
    violations.push("Changed paths exist without a patch artifact.");
  }

  if (input.patchArtifact) {
    const targetSet = new Set(input.patchArtifact.targets.map((target) => target.path));
    for (const changedPath of input.changedPaths) {
      if (!targetSet.has(changedPath)) {
        violations.push(`Changed path is outside patch target set: ${changedPath}`);
      }
    }

    for (const governedPath of input.governedPaths) {
      if (input.changedPaths.includes(governedPath) && !targetSet.has(governedPath)) {
        violations.push(`Governed path changed without explicit patch coverage: ${governedPath}`);
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations
  };
}
