export interface PatchBasis {
  readonly workspaceId: string;
  readonly baseRevision: string;
  readonly baseSequence?: number;
  readonly generatedAt: string;
  readonly generator: string;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${field} must be non-empty`);
  }
}

export function assertPatchBasis(value: PatchBasis): void {
  assertNonEmpty(value.workspaceId, "patchBasis.workspaceId");
  assertNonEmpty(value.baseRevision, "patchBasis.baseRevision");
  assertNonEmpty(value.generatedAt, "patchBasis.generatedAt");
  assertNonEmpty(value.generator, "patchBasis.generator");
  if (value.baseSequence !== undefined && (!Number.isInteger(value.baseSequence) || value.baseSequence < 0)) {
    throw new Error("patchBasis.baseSequence must be an integer >= 0");
  }
}
