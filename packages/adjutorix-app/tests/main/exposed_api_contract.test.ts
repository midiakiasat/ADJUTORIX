import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / MAIN / exposed_api_contract.test.ts
 *
 * Canonical exposed-API contract suite.
 *
 * Purpose:
 * - verify that the renderer-facing API exposed through preload remains structurally stable,
 *   governed, and exactly aligned with the supported main-process contract surface
 * - verify that domain groupings, method signatures, subscription semantics, return normalization,
 *   and capability boundaries do not drift across preload, renderer hooks, and IPC handlers
 * - verify that no hidden authority, raw transport escape hatch, or undeclared domain leaks into
 *   the public renderer API contract
 *
 * Test philosophy:
 * - no snapshots
 * - assert shape, capability, and semantic boundaries directly
 * - prefer counterexamples and drift-detection over happy-path only coverage
 *
 * Notes:
 * - this suite assumes src/main/preload/exposed_api_contract exports the functions and types referenced below
 * - if production exports differ slightly, adapt the harness first rather than weakening the contract intent
 */

import {
  createExposedApiContract,
  EXPOSED_API_DOMAINS,
  EXPOSED_API_METHODS,
  type ExposedApiContractEnvironment,
  type ExposedApiSurface,
} from "../../../src/main/preload/exposed_api_contract";

function env(overrides: Partial<ExposedApiContractEnvironment> = {}): ExposedApiContractEnvironment {
  const invoked: Array<{ domain: string; method: string; payload: unknown }> = [];
  const subscriptions = new Map<string, Set<(payload: unknown) => void>>();

  return {
    bridge: {
      invoke: vi.fn(async (domain: string, method: string, payload?: unknown) => {
        invoked.push({ domain, method, payload });
        return {
          ok: true,
          domain,
          method,
          payload,
        };
      }),
      subscribe: vi.fn((domain: string, event: string, listener: (payload: unknown) => void) => {
        const key = `${domain}:${event}`;
        if (!subscriptions.has(key)) subscriptions.set(key, new Set());
        subscriptions.get(key)!.add(listener);
        return () => subscriptions.get(key)?.delete(listener);
      }),
      emitForTest: (domain: string, event: string, payload: unknown) => {
        const key = `${domain}:${event}`;
        subscriptions.get(key)?.forEach((listener) => listener(payload));
      },
      getInvoked: () => invoked,
    },
    clone: (value: unknown) => JSON.parse(JSON.stringify(value)),
    ...overrides,
  } as unknown as ExposedApiContractEnvironment;
}

function expectMethod(surface: ExposedApiSurface, domain: string, method: string): void {
  expect(surface).toHaveProperty(domain);
  expect((surface as any)[domain]).toHaveProperty(method);
  expect(typeof (surface as any)[domain][method]).toBe("function");
}

describe("main/preload/exposed_api_contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds a structured API surface containing only declared top-level domains", () => {
    const surface = createExposedApiContract(env()).build();

    expect(typeof surface).toBe("object");
    expect(Object.keys(surface).sort()).toEqual([...EXPOSED_API_DOMAINS].sort());
  });

  it("contains deterministic declared methods for each governed domain", () => {
    const surface = createExposedApiContract(env()).build();

    for (const [domain, methods] of Object.entries(EXPOSED_API_METHODS)) {
      for (const method of methods) {
        expectMethod(surface, domain, method);
      }
    }
  });

  it("does not expose undeclared domains or raw bridge escape hatches on the public API root", () => {
    const surface = createExposedApiContract(env()).build() as any;

    expect(surface.invoke).toBeUndefined();
    expect(surface.send).toBeUndefined();
    expect(surface.ipc).toBeUndefined();
    expect(surface.bridge).toBeUndefined();
    expect(surface.transport).toBeUndefined();
    expect(surface.exec).toBeUndefined();
    expect(surface.process).toBeUndefined();
    expect(surface.require).toBeUndefined();
  });

  it("routes workspace methods through the internal bridge with stable domain and method names", async () => {
    const environment = env();
    const surface = createExposedApiContract(environment).build();

    await surface.workspace.load({ workspaceId: "ws-1" });
    await surface.workspace.refresh({ workspaceId: "ws-1" });
    await surface.workspace.selectPath({
      workspaceId: "ws-1",
      path: "/repo/adjutorix-app/src/renderer/App.tsx",
    });

    expect(environment.bridge.invoke).toHaveBeenCalledWith("workspace", "load", { workspaceId: "ws-1" });
    expect(environment.bridge.invoke).toHaveBeenCalledWith("workspace", "refresh", { workspaceId: "ws-1" });
    expect(environment.bridge.invoke).toHaveBeenCalledWith("workspace", "selectPath", {
      workspaceId: "ws-1",
      path: "/repo/adjutorix-app/src/renderer/App.tsx",
    });
  });

  it("routes agent methods through the internal bridge without exposing arbitrary rpc invocation", async () => {
    const environment = env();
    const surface = createExposedApiContract(environment).build() as any;

    await surface.agent.connect({});
    await surface.agent.refresh({});
    await surface.agent.sendMessage({ draft: "Summarize verify blockers." });

    expect(environment.bridge.invoke).toHaveBeenCalledWith("agent", "connect", {});
    expect(environment.bridge.invoke).toHaveBeenCalledWith("agent", "refresh", {});
    expect(environment.bridge.invoke).toHaveBeenCalledWith("agent", "sendMessage", {
      draft: "Summarize verify blockers.",
    });

    expect(surface.agent.invokeRaw).toBeUndefined();
    expect(surface.agent.rpc).toBeUndefined();
  });

  it("routes patch, verify, ledger, diagnostics, and settings methods through their exact declared domains", async () => {
    const environment = env();
    const surface = createExposedApiContract(environment).build();

    await surface.patch.load({ patchId: "patch-42" });
    await surface.verify.load({ verifyId: "verify-42" });
    await surface.ledger.load({ ledgerId: "ledger-42" });
    await surface.diagnostics.load({ workspaceId: "ws-1" });
    await surface.settings.load({});

    expect(environment.bridge.invoke).toHaveBeenCalledWith("patch", "load", { patchId: "patch-42" });
    expect(environment.bridge.invoke).toHaveBeenCalledWith("verify", "load", { verifyId: "verify-42" });
    expect(environment.bridge.invoke).toHaveBeenCalledWith("ledger", "load", { ledgerId: "ledger-42" });
    expect(environment.bridge.invoke).toHaveBeenCalledWith("diagnostics", "load", { workspaceId: "ws-1" });
    expect(environment.bridge.invoke).toHaveBeenCalledWith("settings", "load", {});
  });

  it("clones payloads before bridge invocation so caller-owned objects and prototypes do not cross raw", async () => {
    const environment = env();
    const surface = createExposedApiContract(environment).build();

    class Dangerous {
      workspaceId = "ws-1";
      nested = { a: 1 };
      method() {
        return "no";
      }
    }

    const payload: any = new Dangerous();
    await surface.workspace.load(payload);

    const invoked = environment.bridge.getInvoked()[0]?.payload as any;
    expect(invoked).toEqual({ workspaceId: "ws-1", nested: { a: 1 } });
    expect(typeof invoked.method).toBe("undefined");
    expect(Object.getPrototypeOf(invoked)).toBe(Object.prototype);
    expect(payload).toBeInstanceOf(Dangerous);
  });

  it("returns normalized promise results from bridge invocation without mutating the response envelope", async () => {
    const surface = createExposedApiContract(env()).build();

    const result = await surface.workspace.load({ workspaceId: "ws-1" });

    expect(result).toEqual({
      ok: true,
      domain: "workspace",
      method: "load",
      payload: { workspaceId: "ws-1" },
    });
  });

  it("normalizes thrown bridge failures into ordinary renderer-safe errors", async () => {
    const environment = env({
      bridge: {
        ...env().bridge,
        invoke: vi.fn(async () => {
          throw Object.assign(new Error("bridge failed"), { code: "BRIDGE_FAILED", extra: { hidden: true } });
        }),
      },
    });
    const surface = createExposedApiContract(environment).build();

    await expect(surface.agent.connect({})).rejects.toThrow("bridge failed");
  });

  it("normalizes non-Error thrown values from bridge invocation into explicit errors", async () => {
    const environment = env({
      bridge: {
        ...env().bridge,
        invoke: vi.fn(async () => {
          throw { message: "plain failure", code: "PLAIN_FAILURE" };
        }),
      },
    });
    const surface = createExposedApiContract(environment).build();

    await expect(surface.verify.load({ verifyId: "verify-42" })).rejects.toThrow(/plain failure/i);
  });

  it("provides event subscription helpers that subscribe through the declared domain/event boundary", () => {
    const environment = env();
    const surface = createExposedApiContract(environment).build();

    const handler = vi.fn();
    const unsubscribe = surface.workspace.subscribe(handler);

    expect(typeof unsubscribe).toBe("function");
    expect(environment.bridge.subscribe).toHaveBeenCalled();
  });

  it("invokes subscribed handlers with payload only, not hidden transport metadata", () => {
    const environment = env();
    const surface = createExposedApiContract(environment).build();

    const handler = vi.fn();
    surface.workspace.subscribe(handler);

    environment.bridge.emitForTest("workspace", "event", {
      type: "workspace-snapshot",
      workspaceId: "ws-1",
    });

    expect(handler).toHaveBeenCalledWith({
      type: "workspace-snapshot",
      workspaceId: "ws-1",
    });
  });

  it("removes the exact listener on unsubscribe so later events no longer reach that handler", () => {
    const environment = env();
    const surface = createExposedApiContract(environment).build();

    const handler = vi.fn();
    const unsubscribe = surface.agent.subscribe(handler);
    unsubscribe();

    environment.bridge.emitForTest("agent", "event", {
      type: "agent-message",
      message: { id: "m1" },
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("supports multiple independent subscriptions on the same domain without cross-unsubscribing handlers", () => {
    const environment = env();
    const surface = createExposedApiContract(environment).build();

    const a = vi.fn();
    const b = vi.fn();
    const unsubA = surface.verify.subscribe(a);
    surface.verify.subscribe(b);

    unsubA();
    environment.bridge.emitForTest("verify", "event", {
      type: "verify-status",
      patch: { status: "passed" },
    });

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("does not expose subscriptions for undeclared domains or arbitrary event names on the root surface", () => {
    const surface = createExposedApiContract(env()).build() as any;

    expect(surface.subscribe).toBeUndefined();
    expect(surface.on).toBeUndefined();
    expect(surface.addEventListener).toBeUndefined();
    expect(surface.any).toBeUndefined();
  });

  it("keeps the declared domain/method matrix exact with no duplicate method names inside a domain registry", () => {
    for (const methods of Object.values(EXPOSED_API_METHODS)) {
      expect(new Set(methods).size).toBe(methods.length);
      expect(methods.length).toBeGreaterThan(0);
    }
  });

  it("returns deterministic identical behavior for identical renderer-facing calls", async () => {
    const surface = createExposedApiContract(env()).build();

    const a = await surface.workspace.load({ workspaceId: "ws-1" });
    const b = await surface.workspace.load({ workspaceId: "ws-1" });

    expect(b).toEqual(a);
  });
});
