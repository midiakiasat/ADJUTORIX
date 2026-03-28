export interface WorkspaceHealthSnapshot {
  readonly workspaceId: string;
  readonly indexed: boolean;
  readonly trusted: boolean;
  readonly fileCount: number;
  readonly ignoredCount: number;
  readonly diagnosticErrorCount: number;
  readonly diagnosticWarningCount: number;
  readonly staleSnapshot: boolean;
}

export function assertWorkspaceHealthSnapshot(value: WorkspaceHealthSnapshot): void {
  if (value.workspaceId.trim().length === 0) {
    throw new Error("workspaceHealth.workspaceId must be non-empty");
  }
  for (const [field, entry] of Object.entries({
    fileCount: value.fileCount,
    ignoredCount: value.ignoredCount,
    diagnosticErrorCount: value.diagnosticErrorCount,
    diagnosticWarningCount: value.diagnosticWarningCount
  })) {
    if (!Number.isInteger(entry) || entry < 0) {
      throw new Error(`workspaceHealth.${field} must be an integer >= 0`);
    }
  }
}

export function workspaceIsOperational(value: WorkspaceHealthSnapshot): boolean {
  return value.indexed && value.trusted && !value.staleSnapshot && value.diagnosticErrorCount === 0;
}
