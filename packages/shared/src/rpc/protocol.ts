export const JSON_RPC_VERSION = "2.0" as const;

export type JsonRpcVersion = typeof JSON_RPC_VERSION;
export type JsonRpcId = string | number | null;

export const RPC_METHODS = [
  "system.health",
  "workspace.open",
  "workspace.scan",
  "ledger.current",
  "ledger.range",
  "patch.validate",
  "patch.apply",
  "patch.reject",
  "patch.rollback",
  "verify.run",
  "verify.status",
  "recovery.resume",
  "governance.check",
  "diagnostics.parse",
  "transaction.status"
] as const;

export type RpcMethod = (typeof RPC_METHODS)[number];

export interface RpcRequestEnvelope<M extends RpcMethod = RpcMethod, P = unknown> {
  readonly jsonrpc: JsonRpcVersion;
  readonly id: JsonRpcId;
  readonly method: M;
  readonly params: P;
}

export interface RpcSuccessEnvelope<R = unknown> {
  readonly jsonrpc: JsonRpcVersion;
  readonly id: JsonRpcId;
  readonly result: R;
}

export interface RpcErrorObject {
  readonly code: number;
  readonly type: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface RpcErrorEnvelope {
  readonly jsonrpc: JsonRpcVersion;
  readonly id: JsonRpcId;
  readonly error: RpcErrorObject;
}

export type RpcResponseEnvelope<R = unknown> = RpcSuccessEnvelope<R> | RpcErrorEnvelope;

export function isRpcMethod(value: string): value is RpcMethod {
  return (RPC_METHODS as readonly string[]).includes(value);
}

export function createRequestEnvelope<M extends RpcMethod, P>(
  id: JsonRpcId,
  method: M,
  params: P
): RpcRequestEnvelope<M, P> {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    method,
    params
  };
}

export function createSuccessEnvelope<R>(id: JsonRpcId, result: R): RpcSuccessEnvelope<R> {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    result
  };
}

export function createErrorEnvelope(
  id: JsonRpcId,
  error: RpcErrorObject
): RpcErrorEnvelope {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    error
  };
}
