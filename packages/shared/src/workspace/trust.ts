export type WorkspaceTrustLevel = "untrusted" | "trusted" | "governed";

export interface WorkspaceTrustRecord {
  readonly workspaceId: string;
  readonly rootPath: string;
  readonly level: WorkspaceTrustLevel;
  readonly grantedAt?: string;
  readonly grantedBy?: string;
  readonly reason?: string;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${field} must be non-empty`);
  }
}

export function assertWorkspaceTrustRecord(value: WorkspaceTrustRecord): void {
  assertNonEmpty(value.workspaceId, "workspaceTrust.workspaceId");
  assertNonEmpty(value.rootPath, "workspaceTrust.rootPath");
  if (!["untrusted", "trusted", "governed"].includes(value.level)) {
    throw new Error("workspaceTrust.level is invalid");
  }
  if (value.grantedAt !== undefined) {
    assertNonEmpty(value.grantedAt, "workspaceTrust.grantedAt");
  }
  if (value.grantedBy !== undefined) {
    assertNonEmpty(value.grantedBy, "workspaceTrust.grantedBy");
  }
  if (value.reason !== undefined) {
    assertNonEmpty(value.reason, "workspaceTrust.reason");
  }
}

export function isWorkspaceTrusted(value: WorkspaceTrustRecord): boolean {
  return value.level === "trusted" || value.level === "governed";
}
