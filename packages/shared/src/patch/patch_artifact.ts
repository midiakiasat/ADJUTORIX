import type { PatchBasis } from "./patch_basis.js";
import { assertPatchBasis } from "./patch_basis.js";
import type { PatchConflict } from "./patch_conflicts.js";
import { assertPatchConflict } from "./patch_conflicts.js";
import type { PatchHunk } from "./patch_hunks.js";
import { assertPatchHunk } from "./patch_hunks.js";
import type { PatchNormalizationPlan } from "./patch_normalization.js";
import type { PatchPreconditions } from "./patch_preconditions.js";
import { assertPatchPreconditions } from "./patch_preconditions.js";
import type { PatchRollbackPlan } from "./patch_rollback.js";
import { assertPatchRollbackPlan } from "./patch_rollback.js";
import type { PatchSummary } from "./patch_summary.js";
import type { PatchTarget } from "./patch_targets.js";
import { assertPatchTarget } from "./patch_targets.js";

export interface PatchArtifact {
  readonly id: string;
  readonly workspaceId: string;
  readonly createdAt: string;
  readonly basis: PatchBasis;
  readonly preconditions: PatchPreconditions;
  readonly targets: readonly PatchTarget[];
  readonly hunks: readonly PatchHunk[];
  readonly conflicts: readonly PatchConflict[];
  readonly normalization: PatchNormalizationPlan;
  readonly summary: PatchSummary;
  readonly rollback?: PatchRollbackPlan;
  readonly metadata: Readonly<Record<string, string>>;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${field} must be non-empty`);
  }
}

export function assertPatchArtifact(value: PatchArtifact): void {
  assertNonEmpty(value.id, "patchArtifact.id");
  assertNonEmpty(value.workspaceId, "patchArtifact.workspaceId");
  assertNonEmpty(value.createdAt, "patchArtifact.createdAt");
  assertPatchBasis(value.basis);
  assertPatchPreconditions(value.preconditions);
  value.targets.forEach(assertPatchTarget);
  value.hunks.forEach((hunk) => assertPatchHunk(hunk));
  value.conflicts.forEach(assertPatchConflict);
  if (value.rollback) {
    assertPatchRollbackPlan(value.rollback);
  }
  for (const [key, entry] of Object.entries(value.metadata)) {
    assertNonEmpty(key, "patchArtifact.metadata key");
    assertNonEmpty(entry, `patchArtifact.metadata.${key}`);
  }
}
