export type UnknownRecord = Record<string, unknown>;

export type DiffLineKind = "context" | "added" | "removed" | "modified";
export type DiffDecision = "accepted" | "needs-attention" | "rejected";

export interface DiffLine extends UnknownRecord {
  id: string;
  kind: DiffLineKind;
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  highlighted?: boolean;
}

export interface DiffHunk extends UnknownRecord {
  id: string;
  header: string;
  summary?: string;
  decision?: DiffDecision | string;
  diagnosticsCount?: number;
  diagnosticsSeverity?: string;
  lines: DiffLine[];
}

export interface DiffFile extends UnknownRecord {
  id: string;
  path: string;
  oldPath?: string;
  newPath?: string;
  status: string;
  original: string;
  modified: string;
  addedLines: number;
  removedLines: number;
  diagnosticsCount: number;
  diagnosticsSeverity?: string;
  reviewStatus?: string;
  verifyStatus?: string;
  applyStatus?: string;
  healthStatus?: string;
  largeMessage?: string;
  deniedMessage?: string;
  hunks: DiffHunk[];
}
