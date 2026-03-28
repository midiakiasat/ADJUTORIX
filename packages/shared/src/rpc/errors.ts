import type { RpcErrorObject } from "./protocol.js";

export const RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  policyDenied: 1001,
  verificationFailed: 1002,
  conflictDetected: 1003,
  staleSnapshot: 1004,
  capabilityDenied: 1005,
  workspaceUntrusted: 1006,
  notFound: 1007
} as const;

export type RpcErrorType =
  | "parse_error"
  | "invalid_request"
  | "method_not_found"
  | "invalid_params"
  | "internal_error"
  | "policy_denied"
  | "verification_failed"
  | "conflict_detected"
  | "stale_snapshot"
  | "capability_denied"
  | "workspace_untrusted"
  | "not_found";

export interface RpcErrorDetails extends Readonly<Record<string, unknown>> {}

export function createRpcError(
  type: RpcErrorType,
  message: string,
  details?: RpcErrorDetails
): RpcErrorObject {
  const codeByType: Record<RpcErrorType, number> = {
    parse_error: RPC_ERROR_CODES.parseError,
    invalid_request: RPC_ERROR_CODES.invalidRequest,
    method_not_found: RPC_ERROR_CODES.methodNotFound,
    invalid_params: RPC_ERROR_CODES.invalidParams,
    internal_error: RPC_ERROR_CODES.internalError,
    policy_denied: RPC_ERROR_CODES.policyDenied,
    verification_failed: RPC_ERROR_CODES.verificationFailed,
    conflict_detected: RPC_ERROR_CODES.conflictDetected,
    stale_snapshot: RPC_ERROR_CODES.staleSnapshot,
    capability_denied: RPC_ERROR_CODES.capabilityDenied,
    workspace_untrusted: RPC_ERROR_CODES.workspaceUntrusted,
    not_found: RPC_ERROR_CODES.notFound
  };

  return {
    code: codeByType[type],
    type,
    message,
    ...(details ? { details } : {})
  };
}

export function isTerminalRpcError(type: RpcErrorType): boolean {
  return [
    "policy_denied",
    "verification_failed",
    "conflict_detected",
    "stale_snapshot",
    "capability_denied",
    "workspace_untrusted",
    "not_found"
  ].includes(type);
}
