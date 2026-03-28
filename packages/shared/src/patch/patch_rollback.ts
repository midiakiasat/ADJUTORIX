export interface PatchRollbackPlan {
  readonly patchId: string;
  readonly rollbackPatchId: string;
  readonly transactionId?: string;
  readonly strategy: "reverse-apply" | "restore-snapshot" | "manual";
  readonly reason: string;
  readonly targetPaths: readonly string[];
}

export function assertPatchRollbackPlan(value: PatchRollbackPlan): void {
  if (value.patchId.trim().length === 0) {
    throw new Error("patchRollbackPlan.patchId must be non-empty");
  }
  if (value.rollbackPatchId.trim().length === 0) {
    throw new Error("patchRollbackPlan.rollbackPatchId must be non-empty");
  }
  if (!["reverse-apply", "restore-snapshot", "manual"].includes(value.strategy)) {
    throw new Error("patchRollbackPlan.strategy is invalid");
  }
  if (value.reason.trim().length === 0) {
    throw new Error("patchRollbackPlan.reason must be non-empty");
  }
}
