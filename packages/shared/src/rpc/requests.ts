import type { RpcMethod } from "./protocol.js";

export interface SystemHealthParams {
  readonly nonce: string;
  readonly requestedAt: string;
}

export interface WorkspaceOpenParams {
  readonly path: string;
  readonly trusted?: boolean;
  readonly reindex?: boolean;
}

export interface WorkspaceScanParams {
  readonly workspaceId: string;
  readonly includeHidden?: boolean;
  readonly maxFiles?: number;
}

export interface LedgerCurrentParams {
  readonly workspaceId: string;
}

export interface LedgerRangeParams {
  readonly workspaceId: string;
  readonly fromSequence?: number;
  readonly toSequence?: number;
  readonly limit?: number;
}

export interface PatchValidateParams {
  readonly workspaceId: string;
  readonly artifactPath: string;
  readonly basisSequence?: number;
  readonly strict?: boolean;
}

export interface PatchApplyParams {
  readonly workspaceId: string;
  readonly patchId: string;
  readonly confirmationToken?: string;
  readonly dryRun?: boolean;
}

export interface PatchRejectParams {
  readonly workspaceId: string;
  readonly patchId: string;
  readonly reason: string;
}

export interface PatchRollbackParams {
  readonly workspaceId: string;
  readonly transactionId: string;
  readonly targetSequence?: number;
}

export interface VerifyRunParams {
  readonly workspaceId: string;
  readonly scope: "workspace" | "selection" | "transaction";
  readonly targets?: readonly string[];
  readonly transactionId?: string;
}

export interface VerifyStatusParams {
  readonly verificationId: string;
}

export interface RecoveryResumeParams {
  readonly workspaceId: string;
  readonly transactionId?: string;
}

export interface GovernanceCheckParams {
  readonly workspaceId: string;
  readonly target: string;
  readonly operation: string;
}

export interface DiagnosticsParseParams {
  readonly tool: string;
  readonly rawOutput: string;
}

export interface TransactionStatusParams {
  readonly transactionId: string;
}

export interface RpcRequestParamsByMethod {
  readonly "system.health": SystemHealthParams;
  readonly "workspace.open": WorkspaceOpenParams;
  readonly "workspace.scan": WorkspaceScanParams;
  readonly "ledger.current": LedgerCurrentParams;
  readonly "ledger.range": LedgerRangeParams;
  readonly "patch.validate": PatchValidateParams;
  readonly "patch.apply": PatchApplyParams;
  readonly "patch.reject": PatchRejectParams;
  readonly "patch.rollback": PatchRollbackParams;
  readonly "verify.run": VerifyRunParams;
  readonly "verify.status": VerifyStatusParams;
  readonly "recovery.resume": RecoveryResumeParams;
  readonly "governance.check": GovernanceCheckParams;
  readonly "diagnostics.parse": DiagnosticsParseParams;
  readonly "transaction.status": TransactionStatusParams;
}

export type RpcRequestParams<M extends RpcMethod> = RpcRequestParamsByMethod[M];
