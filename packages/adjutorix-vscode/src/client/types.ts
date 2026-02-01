/**
 * JSON-RPC 2.0 base types.
 */

export interface RpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: any;
}

export interface RpcSuccess<T = any> {
  jsonrpc: "2.0";
  id: number | string;
  result: T;
}

export interface RpcFailure {
  jsonrpc: "2.0";
  id: number | string | null;
  error: {
    code: number | string;
    message: string;
    data?: any;
  };
}

export type RpcResponse<T = any> = RpcSuccess<T> | RpcFailure;

/**
 * RPC error wrapper.
 */
export class RpcError extends Error {
  code: number | string;
  data?: any;

  constructor(code: number | string, message: string, data?: any) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}
