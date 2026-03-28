export type WorkspaceEntryKind = "file" | "directory" | "symlink";

export interface WorkspaceFileEntry {
  readonly path: string;
  readonly kind: WorkspaceEntryKind;
  readonly sizeBytes: number;
  readonly ignored: boolean;
  readonly executable?: boolean;
  readonly mtimeUtc?: string;
}

function assertRelativePath(path: string, field: string): void {
  if (path.trim().length === 0) {
    throw new Error(`${field} must be non-empty`);
  }
  if (path.startsWith("/") || path.includes("..")) {
    throw new Error(`${field} must remain inside the workspace`);
  }
}

export function assertWorkspaceFileEntry(value: WorkspaceFileEntry): void {
  assertRelativePath(value.path, "workspaceFile.path");
  if (!["file", "directory", "symlink"].includes(value.kind)) {
    throw new Error("workspaceFile.kind is invalid");
  }
  if (!Number.isInteger(value.sizeBytes) || value.sizeBytes < 0) {
    throw new Error("workspaceFile.sizeBytes must be an integer >= 0");
  }
  if (value.mtimeUtc !== undefined && value.mtimeUtc.trim().length === 0) {
    throw new Error("workspaceFile.mtimeUtc must be non-empty when present");
  }
}

export function sortWorkspaceEntries(values: readonly WorkspaceFileEntry[]): WorkspaceFileEntry[] {
  return [...values].sort((left, right) => left.path.localeCompare(right.path));
}
