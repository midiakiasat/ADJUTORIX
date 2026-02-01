import { Transport } from "./transport";
import { RpcRequest, RpcError } from "./types";

/**
 * JSON-RPC 2.0 client for communicating with Adjutorix agent.
 */
export class RpcClient {
  private transport: Transport;
  private idCounter = 1;

  constructor(endpoint: string) {
    this.transport = new Transport(endpoint);
  }

  setEndpoint(endpoint: string) {
    this.transport.setEndpoint(endpoint);
  }

  close() {
    this.transport.close();
  }

  async call<T = any>(method: string, params?: any): Promise<T> {
    const id = this.idCounter++;

    const request: RpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params: params ?? {},
    };

    // Transport already returns RpcResponse<T>; T is the result type
    const response = await this.transport.send<T>(request);

    if (response.error) {
      const code = response.error.code;
      const msg = response.error.message;
      const tb = response.error.data?.traceback;
      const fullMessage = tb ? `${msg}\n${tb}` : msg;
      throw new RpcError(code, fullMessage, response.error.data);
    }

    if (response.result === undefined) {
      throw new Error("Invalid RPC response: missing result");
    }

    return response.result;
  }
}
