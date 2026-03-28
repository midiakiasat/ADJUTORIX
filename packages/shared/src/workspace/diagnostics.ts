export type WorkspaceDiagnosticSeverity = "info" | "warning" | "error";

export interface WorkspaceDiagnostic {
  readonly code: string;
  readonly severity: WorkspaceDiagnosticSeverity;
  readonly message: string;
  readonly path?: string;
  readonly line?: number;
  readonly column?: number;
  readonly source?: string;
}

function assertOptionalPosition(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
    throw new Error(`${field} must be an integer >= 1`);
  }
}

export function assertWorkspaceDiagnostic(value: WorkspaceDiagnostic): void {
  if (value.code.trim().length === 0) {
    throw new Error("workspaceDiagnostic.code must be non-empty");
  }
  if (!["info", "warning", "error"].includes(value.severity)) {
    throw new Error("workspaceDiagnostic.severity is invalid");
  }
  if (value.message.trim().length === 0) {
    throw new Error("workspaceDiagnostic.message must be non-empty");
  }
  if (value.path !== undefined && value.path.trim().length === 0) {
    throw new Error("workspaceDiagnostic.path must be non-empty when present");
  }
  assertOptionalPosition(value.line, "workspaceDiagnostic.line");
  assertOptionalPosition(value.column, "workspaceDiagnostic.column");
}

export function diagnosticSeverityWeight(value: WorkspaceDiagnosticSeverity): number {
  if (value === "error") {
    return 3;
  }
  if (value === "warning") {
    return 2;
  }
  return 1;
}
