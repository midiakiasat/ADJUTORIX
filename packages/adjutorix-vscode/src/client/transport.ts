import fetch from "node-fetch";
import { readAdjutorixToken } from "./token";

/**
 * POST JSON-RPC to the agent with Authorization from ~/.adjutorix/token.
 * Use this (or Transport.send) for every /rpc call so auth is applied in one place.
 */
export async function postJsonRpc<T = any>(
  url: string,
  payload: unknown
): Promise<T> {
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

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Adjutorix RPC failed (${res.status}): ${text || res.statusText}`
    );
  }

  return res.json() as Promise<T>;
}

/**
 * Transport layer for JSON-RPC over HTTP.
 * Uses keep-alive and attaches Authorization on every request.
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

  async send<T = any>(payload: any): Promise<T> {
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

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Adjutorix RPC failed (${res.status}): ${text || res.statusText}`
      );
    }

    const data = (await res.json()) as T;
    return data;
  }
}
