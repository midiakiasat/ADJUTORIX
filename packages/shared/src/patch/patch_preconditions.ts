import type { PatchBasis } from "./patch_basis.js";
import { assertPatchBasis } from "./patch_basis.js";
import type { PatchTarget } from "./patch_targets.js";
import { assertPatchTarget } from "./patch_targets.js";

export interface PatchPreconditions {
  readonly basis: PatchBasis;
  readonly targets: readonly PatchTarget[];
  readonly requiresCleanWorkspace: boolean;
  readonly requiresTrustedWorkspace: boolean;
  readonly requiresVerifyPass: boolean;
}

export function assertPatchPreconditions(value: PatchPreconditions): void {
  assertPatchBasis(value.basis);
  value.targets.forEach(assertPatchTarget);
}
