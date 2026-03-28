import type { PatchHunk } from "./patch_hunks.js";

export interface PatchNormalizationPlan {
  readonly normalizedTargets: readonly string[];
  readonly hunks: readonly PatchHunk[];
}

export function normalizePatchPath(path: string): string {
  return path.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

export function createPatchNormalizationPlan(input: {
  readonly targets: readonly string[];
  readonly hunks: readonly PatchHunk[];
}): PatchNormalizationPlan {
  return {
    normalizedTargets: input.targets.map(normalizePatchPath),
    hunks: input.hunks
  };
}
