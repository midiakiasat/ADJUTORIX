export type PatchConflictKind =
  | "basis_mismatch"
  | "stale_snapshot"
  | "target_missing"
  | "target_changed"
  | "overlap"
  | "policy_denied";

export interface PatchConflict {
  readonly kind: PatchConflictKind;
  readonly path?: string;
  readonly message: string;
  readonly fatal: boolean;
}

export function assertPatchConflict(value: PatchConflict): void {
  if (
    ![
      "basis_mismatch",
      "stale_snapshot",
      "target_missing",
      "target_changed",
      "overlap",
      "policy_denied"
    ].includes(value.kind)
  ) {
    throw new Error("patchConflict.kind is invalid");
  }
  if (value.message.trim().length === 0) {
    throw new Error("patchConflict.message must be non-empty");
  }
  if (value.path !== undefined && value.path.trim().length === 0) {
    throw new Error("patchConflict.path must be non-empty when present");
  }
}

export function hasFatalPatchConflict(conflicts: readonly PatchConflict[]): boolean {
  return conflicts.some((conflict) => conflict.fatal);
}
