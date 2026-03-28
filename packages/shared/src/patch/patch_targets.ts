export type PatchTargetKind = "file" | "directory";

export interface PatchTarget {
  readonly kind: PatchTargetKind;
  readonly path: string;
  readonly existsBefore: boolean;
  readonly existsAfter: boolean;
}

function assertRelativePath(path: string, field: string): void {
  if (path.trim().length === 0) {
    throw new Error(`${field} must be non-empty`);
  }
  if (path.startsWith("/") || path.includes("..")) {
    throw new Error(`${field} must remain within workspace boundaries`);
  }
}

export function assertPatchTarget(value: PatchTarget): void {
  if (!["file", "directory"].includes(value.kind)) {
    throw new Error("patchTarget.kind is invalid");
  }
  assertRelativePath(value.path, "patchTarget.path");
}

export function uniquePatchTargetPaths(values: readonly PatchTarget[]): string[] {
  return [...new Set(values.map((value) => value.path))].sort((left, right) => left.localeCompare(right));
}
