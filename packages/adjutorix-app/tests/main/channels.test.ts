import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * ADJUTORIX APP — TESTS / MAIN / channels.test.ts
 *
 * Canonical IPC channels contract suite.
 *
 * Purpose:
 * - verify that the main-process channel registry preserves one authoritative IPC surface
 *   between preload/renderer requests and privileged main-process handlers
 * - verify that channel names, request/response contracts, handler registration,
 *   invoke-vs-send semantics, payload validation, error normalization, and policy integration
 *   remain deterministic
 * - verify that unknown channels, malformed payloads, duplicate registration, and handler failures
 *   fail safely instead of widening capability or returning ambiguous results
 *
 * Test philosophy:
 * - no snapshots
 * - assert registry, validation, and dispatch semantics directly
 * - prefer counterexamples and boundary drift failure modes over happy-path only coverage
 *
 * Notes:
 * - this suite assumes src/main/ipc/channels exports the functions and types referenced below
 * - if the production module exports differ slightly, update the adapters first rather than weakening intent
 */

import {
  CHANNEL_DEFINITIONS,
  listRegisteredChannels,
  getChannelDefinition,
  validateChannelRequest,
  createChannelRegistry,
  type ChannelContext,
  type ChannelRequestEnvelope,
} from "../../../src/main/ipc/channels";

function ctx(overrides: Partial<ChannelContext> = {}): ChannelContext {
  return {
    webContentsId: 7,
    origin: "app://adjutorix",
    source: "renderer",
    workspaceId: "ws-1",
    trustedSurface: true,
    ...overrides,
  } as ChannelContext;
}

function envelope(overrides: Partial<ChannelRequestEnvelope> = {}): ChannelRequestEnvelope {
  return {
    channel: "workspace:open-file",
    requestId: "req-1",
    payload: {
      path: "/repo/adjutorix-app/src/renderer/App.tsx",
    },
    ...overrides,
  } as ChannelRequestEnvelope;
}

describe("main/ipc/channels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("CHANNEL_DEFINITIONS", () => {
    it("exposes a non-empty deterministic channel registry with unique names", () => {
      expect(Array.isArray(CHANNEL_DEFINITIONS)).toBe(true);
      expect(CHANNEL_DEFINITIONS.length).toBeGreaterThan(0);

      const names = CHANNEL_DEFINITIONS.map((d) => d.channel);
      expect(new Set(names).size).toBe(names.length);
    });

    it("marks every channel with explicit transport and mutability semantics", () => {
      for (const def of CHANNEL_DEFINITIONS) {
        expect(def.channel).toBeTruthy();
        expect(["invoke", "send", "event"]).toContain(def.transport);
        expect(["read", "write", "execute", "meta"]).toContain(def.mutationClass);
      }
    });

    it("does not allow hidden channels outside the exported registry listing", () => {
      const listed = listRegisteredChannels();
      expect(listed.map((d) => d.channel)).toEqual(CHANNEL_DEFINITIONS.map((d) => d.channel));
    });
  });

  describe("getChannelDefinition", () => {
    it("returns canonical definitions for known channels", () => {
      const def = getChannelDefinition("workspace:open-file");
      expect(def.channel).toBe("workspace:open-file");
      expect(def.transport).toBeTruthy();
    });

    it("throws or fails safely for unknown channels instead of inventing permissive defaults", () => {
      expect(() => getChannelDefinition("unknown:channel")).toThrow();
    });
  });

  describe("validateChannelRequest", () => {
    it("accepts a valid workspace open-file invoke payload", () => {
      const result = validateChannelRequest(envelope(), ctx());
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("rejects missing requestId so replies can never become ambiguous", () => {
      const result = validateChannelRequest(
        envelope({ requestId: "" }),
        ctx(),
      );

      expect(result.ok).toBe(false);
      expect(result.errors.map((e) => e.code)).toContain("REQUEST_ID_REQUIRED");
    });

    it("rejects unknown channels at validation time before dispatch", () => {
      const result = validateChannelRequest(
        envelope({ channel: "unknown:channel" }),
        ctx(),
      );

      expect(result.ok).toBe(false);
      expect(result.errors.map((e) => e.code)).toContain("UNKNOWN_CHANNEL");
    });

    it("rejects malformed open-file payloads without required path fields", () => {
      const result = validateChannelRequest(
        envelope({ payload: {} }),
        ctx(),
      );

      expect(result.ok).toBe(false);
      expect(result.errors.map((e) => e.code)).toContain("INVALID_PAYLOAD");
    });

    it("rejects non-object payloads for object-typed channels", () => {
      const result = validateChannelRequest(
        envelope({ payload: "not-an-object" as unknown as Record<string, unknown> }),
        ctx(),
      );

      expect(result.ok).toBe(false);
      expect(result.errors.map((e) => e.code)).toContain("INVALID_PAYLOAD_TYPE");
    });

    it("rejects write-class channels when payload is missing explicit mutation intent fields", () => {
      const result = validateChannelRequest(
        envelope({
          channel: "workspace:write-file",
          payload: {
            path: "/repo/adjutorix-app/src/renderer/App.tsx",
            contents: "mutated",
          },
        }),
        ctx(),
      );

      expect(result.ok).toBe(false);
      expect(result.errors.map((e) => e.code)).toContain("EXPLICIT_INTENT_REQUIRED");
    });

    it("accepts write-class channels only with explicit intent metadata present", () => {
      const result = validateChannelRequest(
        envelope({
          channel: "workspace:write-file",
          payload: {
            path: "/repo/adjutorix-app/src/renderer/App.tsx",
            contents: "mutated",
            explicitIntent: true,
          },
        }),
        ctx(),
      );

      expect(result.ok).toBe(true);
    });

    it("rejects shell execution payloads lacking explicit command fields", () => {
      const result = validateChannelRequest(
        envelope({
          channel: "shell:run",
          payload: {
            cwd: "/repo/adjutorix-app",
            explicitIntent: true,
          },
        }),
        ctx(),
      );

      expect(result.ok).toBe(false);
      expect(result.errors.map((e) => e.code)).toContain("COMMAND_REQUIRED");
    });

    it("rejects transport-shape mismatches where event-like channels are invoked as request/response channels", () => {
      const def = CHANNEL_DEFINITIONS.find((d) => d.transport === "event");
      if (!def) {
        expect(true).toBe(true);
        return;
      }

      const result = validateChannelRequest(
        envelope({ channel: def.channel }),
        ctx(),
      );

      expect(result.ok).toBe(false);
      expect(result.errors.map((e) => e.code)).toContain("TRANSPORT_MISMATCH");
    });
  });

  describe("createChannelRegistry", () => {
    it("registers invoke handlers for every invoke-class channel exactly once", () => {
      const ipcMain = {
        handle: vi.fn(),
        on: vi.fn(),
        removeHandler: vi.fn(),
      };

      const registry = createChannelRegistry({ ipcMain });
      registry.registerAll();

      const invokeChannels = CHANNEL_DEFINITIONS.filter((d) => d.transport === "invoke");
      expect(ipcMain.handle).toHaveBeenCalledTimes(invokeChannels.length);
    });

    it("registers send/event handlers for every send-class channel exactly once", () => {
      const ipcMain = {
        handle: vi.fn(),
        on: vi.fn(),
        removeHandler: vi.fn(),
      };

      const registry = createChannelRegistry({ ipcMain });
      registry.registerAll();

      const nonInvokeChannels = CHANNEL_DEFINITIONS.filter((d) => d.transport !== "invoke");
      expect(ipcMain.on).toHaveBeenCalledTimes(nonInvokeChannels.length);
    });

    it("does not permit duplicate registerAll calls to multiply handler registration", () => {
      const ipcMain = {
        handle: vi.fn(),
        on: vi.fn(),
        removeHandler: vi.fn(),
      };

      const registry = createChannelRegistry({ ipcMain });
      registry.registerAll();
      registry.registerAll();

      const invokeChannels = CHANNEL_DEFINITIONS.filter((d) => d.transport === "invoke");
      const nonInvokeChannels = CHANNEL_DEFINITIONS.filter((d) => d.transport !== "invoke");

      expect(ipcMain.handle).toHaveBeenCalledTimes(invokeChannels.length);
      expect(ipcMain.on).toHaveBeenCalledTimes(nonInvokeChannels.length);
    });

    it("unregisters handlers deterministically on dispose", () => {
      const ipcMain = {
        handle: vi.fn(),
        on: vi.fn(),
        removeHandler: vi.fn(),
        off: vi.fn(),
      };

      const registry = createChannelRegistry({ ipcMain });
      registry.registerAll();
      registry.dispose();

      const invokeChannels = CHANNEL_DEFINITIONS.filter((d) => d.transport === "invoke");
      expect(ipcMain.removeHandler).toHaveBeenCalledTimes(invokeChannels.length);
    });
  });

  describe("dispatch semantics", () => {
    it("dispatches a valid invoke request to the matching handler and returns a normalized success envelope", async () => {
      const ipcMain = {
        handle: vi.fn(),
        on: vi.fn(),
        removeHandler: vi.fn(),
      };

      const handlers = {
        "workspace:open-file": vi.fn(async ({ payload }: { payload: { path: string } }) => ({
          opened: true,
          path: payload.path,
        })),
      };

      const registry = createChannelRegistry({ ipcMain, handlers });
      const result = await registry.dispatchInvoke(envelope(), ctx());

      expect(result.ok).toBe(true);
      expect(result.result).toEqual({
        opened: true,
        path: "/repo/adjutorix-app/src/renderer/App.tsx",
      });
      expect(handlers["workspace:open-file"]).toHaveBeenCalledTimes(1);
    });

    it("returns normalized validation errors instead of reaching handlers on invalid requests", async () => {
      const ipcMain = {
        handle: vi.fn(),
        on: vi.fn(),
        removeHandler: vi.fn(),
      };

      const handlers = {
        "workspace:open-file": vi.fn(),
      };

      const registry = createChannelRegistry({ ipcMain, handlers });
      const result = await registry.dispatchInvoke(
        envelope({ payload: {} }),
        ctx(),
      );

      expect(result.ok).toBe(false);
      expect(result.error.code).toBe("INVALID_CHANNEL_REQUEST");
      expect(handlers["workspace:open-file"]).not.toHaveBeenCalled();
    });

    it("normalizes thrown handler failures into structured channel errors instead of leaking raw exceptions", async () => {
      const ipcMain = {
        handle: vi.fn(),
        on: vi.fn(),
        removeHandler: vi.fn(),
      };

      const handlers = {
        "workspace:open-file": vi.fn(async () => {
          throw new Error("disk failure");
        }),
      };

      const registry = createChannelRegistry({ ipcMain, handlers });
      const result = await registry.dispatchInvoke(envelope(), ctx());

      expect(result.ok).toBe(false);
      expect(result.error.code).toBe("CHANNEL_HANDLER_FAILED");
      expect(result.error.message).toContain("disk failure");
    });

    it("rejects invoke dispatch for send/event channels as a limiting-case transport mismatch", async () => {
      const ipcMain = {
        handle: vi.fn(),
        on: vi.fn(),
        removeHandler: vi.fn(),
      };

      const sendLike = CHANNEL_DEFINITIONS.find((d) => d.transport !== "invoke");
      if (!sendLike) {
        expect(true).toBe(true);
        return;
      }

      const registry = createChannelRegistry({ ipcMain, handlers: {} });
      const result = await registry.dispatchInvoke(
        envelope({ channel: sendLike.channel }),
        ctx(),
      );

      expect(result.ok).toBe(false);
      expect(result.error.code).toBe("TRANSPORT_MISMATCH");
    });
  });

  describe("policy integration", () => {
    it("invokes the policy gate before handler execution so allowed-looking payloads still respect main-process policy", async () => {
      const ipcMain = {
        handle: vi.fn(),
        on: vi.fn(),
        removeHandler: vi.fn(),
      };

      const policy = {
        evaluate: vi.fn(() => ({ allowed: false, violations: [{ code: "AUTHORITY_DENIED" }] })),
      };

      const handler = vi.fn();
      const registry = createChannelRegistry({
        ipcMain,
        handlers: { "workspace:open-file": handler },
        policy,
      });

      const result = await registry.dispatchInvoke(envelope(), ctx());

      expect(policy.evaluate).toHaveBeenCalledTimes(1);
      expect(handler).not.toHaveBeenCalled();
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe("CHANNEL_POLICY_DENIED");
    });

    it("passes validated request context into the policy gate with channel identity preserved", async () => {
      const ipcMain = {
        handle: vi.fn(),
        on: vi.fn(),
        removeHandler: vi.fn(),
      };

      const policy = {
        evaluate: vi.fn(() => ({ allowed: true, violations: [] })),
      };

      const handler = vi.fn(async () => ({ ok: true }));
      const registry = createChannelRegistry({
        ipcMain,
        handlers: { "workspace:open-file": handler },
        policy,
      });

      await registry.dispatchInvoke(envelope(), ctx());

      expect(policy.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({ channel: "workspace:open-file" }),
        }),
      );
    });
  });

  describe("cross-channel registry guarantees", () => {
    it("does not let one channel reuse another channel's payload contract", () => {
      const openResult = validateChannelRequest(
        envelope({
          channel: "workspace:open-file",
          payload: { path: "/repo/adjutorix-app/src/renderer/App.tsx" },
        }),
        ctx(),
      );

      const writeResult = validateChannelRequest(
        envelope({
          channel: "workspace:write-file",
          payload: { path: "/repo/adjutorix-app/src/renderer/App.tsx" },
        }),
        ctx(),
      );

      expect(openResult.ok).toBe(true);
      expect(writeResult.ok).toBe(false);
    });

    it("preserves deterministic identical verdicts for identical channel requests", () => {
      const a = validateChannelRequest(envelope(), ctx());
      const b = validateChannelRequest(envelope(), ctx());
      expect(b).toEqual(a);
    });

    it("fails closed when no handler exists for a known invoke channel", async () => {
      const ipcMain = {
        handle: vi.fn(),
        on: vi.fn(),
        removeHandler: vi.fn(),
      };

      const registry = createChannelRegistry({ ipcMain, handlers: {} });
      const result = await registry.dispatchInvoke(envelope(), ctx());

      expect(result.ok).toBe(false);
      expect(result.error.code).toBe("HANDLER_NOT_REGISTERED");
    });
  });
});
