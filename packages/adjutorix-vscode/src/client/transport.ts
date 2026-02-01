import fetch from "node-fetch";
import { readAdjutorixToken } from "./token";
import type { RpcResponse } from "./types";

/**
 * POST JSON-RPC to the agent with Authorization from ~/.adjutorix/token.
 * Use this (or Transport.send) for every /rpc call so auth is applied in one place.
 * Returns the JSON-RPC envelope; decode with RpcClient or check response.error / response.result.
 */
export async function postJsonRpc<T = any>(
  url: string,
  payload: unknown
): Promise<RpcResponse<T>> {
  const token = await readAdjutorixToken();
  if (!token) {
    throw new Error("Adjutorix token missing: ~/.adjutorix/token");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const raw = await res.text().catch(() => "");
  let data: any = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {}

  if (!res.ok) {
    const rpcErr = data?.error;
    const msg = rpcErr
      ? (rpcErr.message || "") +
        (rpcErr.data?.traceback ? "\n" + rpcErr.data.traceback : "")
      : raw || res.statusText;
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }

  if (!data || typeof data !== "object") {
    throw new Error(`Invalid RPC response: ${raw || "<empty body>"}`);
  }

  if (data.jsonrpc !== "2.0" || data.id === undefined) {
    throw new Error(`Invalid RPC response: ${raw}`);
  }

  return data as RpcResponse<T>;
}

/**
 * Transport layer for JSON-RPC over HTTP.
 * Uses keep-alive and attaches Authorization on every request.
 * Returns the JSON-RPC envelope; RpcClient.call() is the single decoder.
 */
export class Transport {
  private endpoint: string;
  private controller: AbortController | null = null;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  setEndpoint(endpoint: string) {
    this.endpoint = endpoint;
  }

  close() {
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
  }

  async send<T = any>(payload: any): Promise<RpcResponse<T>> {
    this.controller = new AbortController();

    const token = await readAdjutorixToken();
    if (!token) {
      throw new Error("Adjutorix token missing: ~/.adjutorix/token");
    }

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: this.controller.signal,
    });

    const raw = await res.text().catch(() => "");
    let data: any = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {}

    if (!res.ok) {
      const rpcErr = data?.error;
      const msg = rpcErr
        ? (rpcErr.message || "") +
          (rpcErr.data?.traceback ? "\n" + rpcErr.data.traceback : "")
        : raw || res.statusText;
      throw new Error(`HTTP ${res.status}: ${msg}`);
    }

    if (!data || typeof data !== "object") {
      throw new Error(`Invalid RPC response: ${raw || "<empty body>"}`);
    }

    if (data.jsonrpc !== "2.0" || data.id === undefined) {
      throw new Error(`Invalid RPC response: ${raw}`);
    }

    return data as RpcResponse<T>;
  }
}
