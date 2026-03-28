import type { LedgerArtifact } from "../ledger/artifact.js";
import type { LedgerEdge } from "../ledger/edges.js";
import type { LedgerTransaction } from "../ledger/transaction.js";
import type { RpcMethod } from "./protocol.js";

export interface SystemHealthResult {
  readonly ok: boolean;
  readonly nonce: string;
  readonly respondedAt: string;
  readonly serverTime: string;
}

export interface WorkspaceOpenResult {
  readonly workspaceId: string;
  readonly path: string;
  readonly trusted: boolean;
  readonly indexState: "missing" | "building" | "ready";
}

export interface WorkspaceScanResult {
  readonly workspaceId: string;
  readonly fileCount: number;
  readonly ignoredCount: number;
  readonly diagnosticCount: number;
}

export interface LedgerCurrentResult {
  readonly workspaceId: string;
  readonly headSequence: number;
  readonly latestTransactionId?: string;
}

export interface LedgerRangeResult {
  readonly workspaceId: string;
  readonly transactions: readonly LedgerTransaction[];
  readonly artifacts: readonly LedgerArtifact[];
  readonly edges: readonly LedgerEdge[];
}

export interface PatchValidateResult {
  readonly patchId: string;
  readonly valid: boolean;
  readonly conflicts: readonly string[];
  readonly summary: string;
}

export interface PatchApplyResult {
  readonly transactionId: string;
  readonly state: "scheduled" | "running" | "applied" | "failed";
  readonly dryRun: boolean;
  readonly previewArtifacts: readonly string[];
}

export interface PatchRejectResult {
  readonly patchId: string;
  readonly rejected: boolean;
  readonly reason: string;
}

export interface PatchRollbackResult {
  readonly transactionId: string;
  readonly rollbackTransactionId: string;
}

export interface VerifyRunResult {
  readonly verificationId: string;
  readonly transactionId?: string;
  readonly status: "queued" | "running" | "completed";
}

export interface VerifyStatusResult {
  readonly verificationId: string;
  readonly status: "queued" | "running" | "completed" | "failed";
  readonly summaryArtifactId?: string;
}

export interface RecoveryResumeResult {
  readonly workspaceId: string;
  readonly resumedTransactionId?: string;
  readonly status: "idle" | "resumed" | "nothing-to-resume";
}

export interface GovernanceCheckResult {
  readonly allowed: boolean;
  readonly reasons: readonly string[];
}

export interface ParsedProblem {
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly path?: string;
  readonly line?: number;
  readonly column?: number;
}

export interface DiagnosticsParseResult {
  readonly tool: string;
  readonly problemCount: number;
  readonly problems: readonly ParsedProblem[];
}

export interface TransactionStatusResult {
  readonly transactionId: string;
  readonly state: string;
}

export interface RpcResponseResultByMethod {
  readonly "system.health": SystemHealthResult;
  readonly "workspace.open": WorkspaceOpenResult;
  readonly "workspace.scan": WorkspaceScanResult;
  readonly "ledger.current": LedgerCurrentResult;
  readonly "ledger.range": LedgerRangeResult;
  readonly "patch.validate": PatchValidateResult;
  readonly "patch.apply": PatchApplyResult;
  readonly "patch.reject": PatchRejectResult;
  readonly "patch.rollback": PatchRollbackResult;
  readonly "verify.run": VerifyRunResult;
  readonly "verify.status": VerifyStatusResult;
  readonly "recovery.resume": RecoveryResumeResult;
  readonly "governance.check": GovernanceCheckResult;
  readonly "diagnostics.parse": DiagnosticsParseResult;
  readonly "transaction.status": TransactionStatusResult;
}

export type RpcResponseResult<M extends RpcMethod> = RpcResponseResultByMethod[M];
