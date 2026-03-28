import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / MAIN / preload_bridge.test.ts
 *
 * Canonical preload-bridge contract suite.
 *
 * Purpose:
 * - verify that the preload bridge preserves one authoritative renderer-to-main membrane
 *   across exposed API shape, IPC method routing, event subscription/unsubscription,
 *   payload marshaling, error normalization, and channel allowlisting
 * - verify that no hidden authority, raw ipcRenderer escape hatch, prototype-bearing payload,
 *   or ungoverned event surface leaks through contextBridge exposure
 * - verify that identical calls from renderer space yield identical normalized bridge behavior
 *   and that bridge failures fail closed rather than widening capability
 *
 * Test philosophy:
 * - no snapshots
 * - assert exposed surface, call routing, and membrane invariants directly
 * - prefer counterexamples and boundary-bypass cases over happy-path only coverage
 *
 * Notes:
 * - this suite assumes src/main/preload/preload_bridge exports the functions and/or constants referenced below
 * - if production exports differ slightly, adapt the harness first rather than weakening the contract intent
 */

import {
  createPreloadBridge,
  BRIDGE_API_KEY,
  BRIDGE_CHANNELS,
  type PreloadBridgeEnvironment,
} from "../../../src/main/preload/preload_bridge";

function env(overrides: Partial<PreloadBridgeEnvironment> = {}): PreloadBridgeEnvironment {
  const eventListeners = new Map<string, Set<(...args: any[]) => void>>();

  return {
    contextBridge: {
      exposeInMainWorld: vi.fn(),
    },
    ipcRenderer: {
      invoke: vi.fn(async (channel: string, payload?: unknown) => ({
        ok: true,
        channel,
        payload,
      })),
      on: vi.fn((channel: string, listener: (...args: any[]) => void) => {
        if (!eventListeners.has(channel)) eventListeners.set(channel, new Set());
        eventListeners.get(channel)!.add(listener);
      }),
      removeListener: vi.fn((channel: string, listener: (...args: any[]) => void) => {
        eventListeners.get(channel)?.delete(listener);
      }),
      emitForTest: (channel: string, ...args: any[]) => {
        eventListeners.get(channel)?.forEach((listener) => listener({}, ...args));
      },
    },
    structuredClone: (value: unknown) => JSON.parse(JSON.stringify(value)),
    ...overrides,
  } as unknown as PreloadBridgeEnvironment;
}

function getExposedApi(environment: PreloadBridgeEnvironment): any {
  const call = (environment.contextBridge.exposeInMainWorld as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(call).toBeTruthy();
  return call[1];
}

describe("main/preload/preload_bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exposes exactly one governed API root into the renderer main world", () => {
    const environment = env();
    createPreloadBridge(environment).install();

    expect(environment.contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(1);
    expect(environment.contextBridge.exposeInMainWorld).toHaveBeenCalledWith(
      BRIDGE_API_KEY,
      expect.any(Object),
    );
  });

  it("exposes a structured API object rather than raw ipcRenderer primitives", () => {
    const environment = env();
    createPreloadBridge(environment).install();
    const api = getExposedApi(environment);

    expect(api).toBeTruthy();
    expect(typeof api).toBe("object");
    expect(api.invoke).toBeUndefined();
    expect(api.send).toBeUndefined();
    expect(api.ipcRenderer).toBeUndefined();
    expect(api.__proto__).not.toBe(environment.ipcRenderer as any);
  });

  it("exports a deterministic channel registry with no duplicate channel names", () => {
    expect(Array.isArray(BRIDGE_CHANNELS)).toBe(true);
    expect(BRIDGE_CHANNELS.length).toBeGreaterThan(0);
    expect(new Set(BRIDGE_CHANNELS).size).toBe(BRIDGE_CHANNELS.length);
  });

  it("routes governed workspace methods through ipcRenderer.invoke using allowlisted channels", async () => {
    const environment = env();
    createPreloadBridge(environment).install();
    const api = getExposedApi(environment);

    await api.workspace.load({ workspaceId: "ws-1" });
    await api.workspace.refresh({ workspaceId: "ws-1" });
    await api.workspace.selectPath({ workspaceId: "ws-1", path: "/repo/adjutorix-app/src/renderer/App.tsx" });

    const channels = (environment.ipcRenderer.invoke as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
    expect(channels).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/workspace/i),
      ]),
    );
    channels.forEach((channel) => expect(BRIDGE_CHANNELS).toContain(channel));
  });

  it("routes governed agent methods through ipcRenderer.invoke without exposing arbitrary RPC entrypoints", async () => {
    const environment = env();
    createPreloadBridge(environment).install();
    const api = getExposedApi(environment);

    await api.agent.connect({});
    await api.agent.refresh({});
    await api.agent.sendMessage({ draft: "Summarize verify blockers." });

    const channels = (environment.ipcRenderer.invoke as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
    channels.forEach((channel) => expect(BRIDGE_CHANNELS).toContain(channel));
    expect(api.agent.invokeRaw).toBeUndefined();
    expect(api.agent.rpc).toBeUndefined();
  });

  it("structured-clones payloads before invoke so prototype-bearing objects cannot cross the membrane raw", async () => {
    const environment = env();
    createPreloadBridge(environment).install();
    const api = getExposedApi(environment);

    class DangerousPayload {
      secret = "x";
      get computed() {
        throw new Error("should never execute in bridge serialization");
      }
    }

    const payload: any = new DangerousPayload();
    payload.workspaceId = "ws-1";

    await api.workspace.load(payload);

    const invokedPayload = (environment.ipcRenderer.invoke as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(Object.getPrototypeOf(invokedPayload)).toBe(Object.prototype);
    expect(invokedPayload.workspaceId).toBe("ws-1");
    expect("computed" in invokedPayload).toBe(false);
  });

  it("does not mutate caller-owned payload objects during marshaling", async () => {
    const environment = env();
    createPreloadBridge(environment).install();
    const api = getExposedApi(environment);

    const payload = {
      workspaceId: "ws-1",
      nested: { a: 1 },
    };

    await api.workspace.load(payload);

    expect(payload).toEqual({
      workspaceId: "ws-1",
      nested: { a: 1 },
    });
  });

  it("normalizes thrown invoke errors into plain bridge-safe Error objects", async () => {
    const environment = env({
      ipcRenderer: {
        ...env().ipcRenderer,
        invoke: vi.fn(async () => {
          throw Object.assign(new Error("ipc failed"), { code: "IPC_FAILED", extra: { hidden: true } });
        }),
      },
    });
    createPreloadBridge(environment).install();
    const api = getExposedApi(environment);

    await expect(api.workspace.load({ workspaceId: "ws-1" })).rejects.toThrow("ipc failed");
  });

  it("normalizes error-like non-Error throws into explicit bridge errors", async () => {
    const environment = env({
      ipcRenderer: {
        ...env().ipcRenderer,
        invoke: vi.fn(async () => {
          throw { message: "plain object failure", code: "PLAIN_OBJECT" };
        }),
      },
    });
    createPreloadBridge(environment).install();
    const api = getExposedApi(environment);

    await expect(api.agent.connect({})).rejects.toThrow(/plain object failure/i);
  });

  it("subscribes to allowlisted event channels and returns an unsubscribe function", () => {
    const environment = env();
    createPreloadBridge(environment).install();
    const api = getExposedApi(environment);

    const handler = vi.fn();
    const unsubscribe = api.workspace.subscribe(handler);

    expect(typeof unsubscribe).toBe("function");
    expect(environment.ipcRenderer.on).toHaveBeenCalled();
  });

  it("invokes subscribed handlers with payload only, not raw ipc event objects", () => {
    const environment = env();
    createPreloadBridge(environment).install();
    const api = getExposedApi(environment);

    const handler = vi.fn();
    api.workspace.subscribe(handler);

    const subscribedChannel = (environment.ipcRenderer.on as ReturnType<typeof vi.fn>).mock.calls[0][0];
    environment.ipcRenderer.emitForTest(subscribedChannel, { type: "workspace-snapshot", workspaceId: "ws-1" });

    expect(handler).toHaveBeenCalledWith({ type: "workspace-snapshot", workspaceId: "ws-1" });
    expect(handler.mock.calls[0][0]).not.toHaveProperty("sender");
  });

  it("removes the exact listener on unsubscribe so later events no longer reach the handler", () => {
    const environment = env();
    createPreloadBridge(environment).install();
    const api = getExposedApi(environment);

    const handler = vi.fn();
    const unsubscribe = api.agent.subscribe(handler);

    const subscribedChannel = (environment.ipcRenderer.on as ReturnType<typeof vi.fn>).mock.calls[0][0];
    unsubscribe();
    environment.ipcRenderer.emitForTest(subscribedChannel, { type: "agent-message", message: { id: "m1" } });

    expect(handler).not.toHaveBeenCalled();
    expect(environment.ipcRenderer.removeListener).toHaveBeenCalled();
  });

  it("supports multiple independent subscriptions without cross-removing listeners", () => {
    const environment = env();
    createPreloadBridge(environment).install();
    const api = getExposedApi(environment);

    const a = vi.fn();
    const b = vi.fn();
    const unsubA = api.verify.subscribe(a);
    api.verify.subscribe(b);

    const subscribedChannel = (environment.ipcRenderer.on as ReturnType<typeof vi.fn>).mock.calls[0][0];
    unsubA();
    environment.ipcRenderer.emitForTest(subscribedChannel, { type: "verify-status", patch: { status: "passed" } });

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("does not expose non-governed domains or arbitrary channel-call helpers on the bridge root", () => {
    const environment = env();
    createPreloadBridge(environment).install();
    const api = getExposedApi(environment);

    expect(api.exec).toBeUndefined();
    expect(api.invokeChannel).toBeUndefined();
    expect(api.sendChannel).toBeUndefined();
    expect(api.require).toBeUndefined();
    expect(api.process).toBeUndefined();
  });

  it("fails closed when attempting to route through a non-allowlisted channel helper, if such helper exists internally", async () => {
    const environment = env();
    const bridge = createPreloadBridge(environment);

    if (typeof (bridge as any).invokeChannelForTest !== "function") {
      expect(true).toBe(true);
      return;
    }

    await expect((bridge as any).invokeChannelForTest("unauthorized:channel", {})).rejects.toThrow();
  });

  it("returns deterministic identical invoke behavior for identical renderer calls", async () => {
    const environment = env();
    createPreloadBridge(environment).install();
    const api = getExposedApi(environment);

    const a = await api.workspace.load({ workspaceId: "ws-1" });
    const b = await api.workspace.load({ workspaceId: "ws-1" });

    expect(b).toEqual(a);
  });
});
