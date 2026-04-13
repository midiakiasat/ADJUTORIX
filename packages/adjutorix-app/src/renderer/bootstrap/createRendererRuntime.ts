
type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function envelope(channel: string, data: JsonObject) {
  return {
    ok: true as const,
    data,
    meta: {
      channel,
      requestHash: `compat:${channel}`,
    },
  };
}

function unavailable(channel: string, message: string) {
  return {
    ok: false as const,
    error: {
      code: "COMPAT_UNAVAILABLE",
      message,
    },
    meta: {
      channel,
      requestHash: `compat:${channel}`,
    },
  };
}

function normalizeEventPayload(payload: unknown) {
  if (isObject(payload)) {
    return {
      kind: typeof payload.kind === "string" ? payload.kind : "legacy",
      snapshot: isObject(payload.snapshot) ? payload.snapshot : {},
      detail: isObject(payload.detail) ? payload.detail : payload,
    };
  }
  return {
    kind: "legacy",
    snapshot: {},
    detail: { value: payload as unknown },
  };
}

function wrapSubscription(channel: string, subscribe: unknown) {
  return {
    subscribe(callback: (payload: any) => void) {
      let active = true;
      let lastPayload: unknown = null;

      const unsubscribe =
        typeof subscribe === "function"
          ? subscribe((payload: unknown) => {
              lastPayload = payload;
              callback(normalizeEventPayload(payload));
            })
          : undefined;

      return {
        active,
        channel,
        lastPayload,
        unsubscribe: () => {
          active = false;
          if (typeof unsubscribe === "function") unsubscribe();
        },
      };
    },
  };
}



function isCanonicalBridgeCandidate(bridge: any) {
  return Boolean(
    bridge &&
      typeof bridge.manifest?.version === "number" &&
      typeof bridge.manifest?.bridgeName === "string" &&
      (typeof bridge.manifest?.bridgeVersion === "string" || typeof bridge.manifest?.bridgeVersion === "number") &&
      typeof bridge.runtime?.snapshot === "function" &&
      typeof bridge.workspace?.health === "function" &&
      typeof bridge.agent?.health === "function" &&
      typeof bridge.diagnostics?.runtime === "function" &&
      typeof bridge.workspace?.open === "function"
  );
}

function hasEventSurface(value: any) {
  return typeof value?.subscribe === "function" || typeof value?.events?.subscribe === "function";
}

function isLegacyBridgeCandidate(bridge: any) {
  return Boolean(
    bridge &&
      bridge.runtime &&
      bridge.workspace &&
      bridge.patch &&
      bridge.verify &&
      bridge.ledger &&
      bridge.diagnostics &&
      bridge.agent &&
      (typeof bridge.workspace?.load === "function" || typeof bridge.workspace?.refresh === "function") &&
      (typeof bridge.agent?.connect === "function" || typeof bridge.agent?.health === "function") &&
      (typeof bridge.diagnostics?.load === "function" || typeof bridge.diagnostics?.runtime === "function") &&
      hasEventSurface(bridge.workspace) &&
      hasEventSurface(bridge.patch) &&
      hasEventSurface(bridge.verify) &&
      hasEventSurface(bridge.diagnostics) &&
      hasEventSurface(bridge.agent)
  );
}

function buildCompatApi(bridge: any) {
  const safeBridge = bridge ?? {};
  const capabilities = [
    "runtime.snapshot",
    "workspace.open",
    "workspace.reveal",
    "workspace.health",
    "patch.preview",
    "patch.apply",
    "verify.run",
    "verify.status",
    "ledger.current",
    "diagnostics.runtime",
    "agent.health",
    "session.restore",
    "session.load",
  ];

  const manifest = {
    version: 1 as const,
    name: "adjutorixApi",
    bridgeVersion: 1,
    bridgeName: "adjutorix-test-compat",
    capabilities,
  };

  return {
    manifest,
    runtime: {
      snapshot: async () => {
        const restored =
          (await safeBridge.session?.restore?.().catch?.(() => undefined)) ??
          (await safeBridge.session?.load?.().catch?.(() => undefined));

        const session =
          isObject((restored as any)?.session)
            ? ((restored as any).session as Record<string, unknown>)
            : isObject(restored)
              ? (restored as Record<string, unknown>)
              : {};

        const workspaceId =
          typeof session.workspaceId === "string" ? session.workspaceId : undefined;
        const selectedPath =
          typeof session.selectedPath === "string" ? session.selectedPath : undefined;
        const verifyId =
          typeof session.verifyId === "string" ? session.verifyId : undefined;
        const ledgerId =
          typeof session.ledgerId === "string" ? session.ledgerId : undefined;
        const patchId =
          typeof session.patchId === "string" ? session.patchId : undefined;

        const [workspace, agent, verify, ledger, diagnostics, settings, shell, patch] = await Promise.all([
          safeBridge.workspace?.load?.(
            workspaceId ? { workspaceId } : undefined
          ),
          safeBridge.agent?.connect?.(),
          safeBridge.verify?.load?.(
            verifyId ? { verifyId } : undefined
          ),
          safeBridge.ledger?.load?.(
            ledgerId ? { ledgerId } : undefined
          ),
          safeBridge.diagnostics?.load?.(
            workspaceId || selectedPath
              ? {
                  ...(workspaceId ? { workspaceId } : {}),
                  ...(selectedPath ? { selectedPath } : {}),
                }
              : undefined
          ),
          safeBridge.settings?.load?.(),
          safeBridge.shell?.status?.(),
          safeBridge.patch?.load?.(
            patchId ? { patchId } : undefined
          ),
        ]);

        return envelope("adjutorix:runtime:snapshot", {
          workspace: isObject(workspace) ? workspace : {},
          agent: isObject(agent) ? agent : {},
          verify: isObject(verify) ? verify : {},
          ledger: isObject(ledger) ? ledger : {},
          diagnostics: isObject(diagnostics) ? diagnostics : {},
          settings: isObject(settings) ? settings : {},
          shell: isObject(shell) ? shell : {},
          patch: isObject(patch) ? patch : {},
          session: isObject(session) ? session : {},
        });
      },
    },
    session: {
      restore: async () =>
        envelope("adjutorix:session:restore", (await safeBridge.session?.restore?.()) ?? {}),
      load: async () =>
        envelope("adjutorix:session:load", (await safeBridge.session?.load?.()) ?? {}),
      clear: async () =>
        unavailable("adjutorix:session:clear", "session clear not modeled in compat bridge"),
    },
    workspace: {
      load: async () => envelope("adjutorix:workspace:load", (await safeBridge.workspace?.load?.()) ?? {}),
      refresh: async () =>
        envelope(
          "adjutorix:workspace:refresh",
          (await (safeBridge.workspace?.refresh?.() ?? safeBridge.workspace?.load?.())) ?? {},
        ),
      selectPath: async (input: JsonObject) =>
        envelope("adjutorix:workspace:selectPath", (await safeBridge.workspace?.selectPath?.(input)) ?? {}),
      setExpandedPaths: async (input: JsonObject) =>
        envelope(
          "adjutorix:workspace:setExpandedPaths",
          (await safeBridge.workspace?.setExpandedPaths?.(input)) ?? {},
        ),
      subscribe:
        typeof safeBridge.workspace?.subscribe === "function"
          ? ((callback: (payload: any) => void) => {
              const sub = safeBridge.workspace?.subscribe?.((payload: unknown) => callback(payload as any));
              if (typeof sub === "function") return sub;
              if (sub && typeof (sub as any).unsubscribe === "function") return () => (sub as any).unsubscribe();
              return () => {};
            })
          : undefined,
      open: async (_input: JsonObject) => {
        await safeBridge.workspace?.open?.();
        const loaded = await safeBridge.workspace?.load?.();
        return envelope(
          "adjutorix:workspace:open",
          isObject(loaded) ? loaded : {},
        );
      },
      close: async () => envelope("adjutorix:workspace:close", {}),
      reveal: async (_input: JsonObject) => envelope("adjutorix:workspace:reveal", {}),
      health: async () => envelope("adjutorix:workspace:health", (await safeBridge.workspace?.load?.()) ?? {}),
      trust: {
        read: async () => unavailable("adjutorix:workspace:trust:read", "workspace trust not modeled in compat bridge"),
        set: async (_input: JsonObject) => unavailable("adjutorix:workspace:trust:set", "workspace trust not modeled in compat bridge"),
      },
      events: wrapSubscription("adjutorix:event:workspace", safeBridge.workspace?.subscribe),
    },
    patch: {
      preview: async (_input: JsonObject) => envelope("adjutorix:patch:preview", (await bridge.patch?.load?.()) ?? {}),
      approve: async (_input: JsonObject) => unavailable("adjutorix:patch:approve", "patch approve not modeled in compat bridge"),
      apply: async (_input: JsonObject) => envelope("adjutorix:patch:apply", {}),
      clear: async () => unavailable("adjutorix:patch:clear", "patch clear not modeled in compat bridge"),
      events: wrapSubscription("adjutorix:event:patch", safeBridge.patch?.subscribe),
    },
    verify: {
      run: async (_input: JsonObject) => envelope("adjutorix:verify:run", (await safeBridge.verify?.load?.()) ?? {}),
      status: async (_input?: JsonObject) => envelope("adjutorix:verify:status", (await safeBridge.verify?.load?.()) ?? {}),
      bind: async (_input: JsonObject) => unavailable("adjutorix:verify:bindResult", "verify bind not modeled in compat bridge"),
      events: wrapSubscription("adjutorix:event:verify", safeBridge.verify?.subscribe),
    },
    ledger: {
      current: async () => envelope("adjutorix:ledger:current", (await safeBridge.ledger?.load?.()) ?? {}),
      timeline: async (_input?: JsonObject) => unavailable("adjutorix:ledger:timeline", "ledger timeline not modeled in compat bridge"),
      entry: async (_input: JsonObject) => unavailable("adjutorix:ledger:entry", "ledger entry not modeled in compat bridge"),
      heads: async () => unavailable("adjutorix:ledger:heads", "ledger heads not modeled in compat bridge"),
      stats: async () => unavailable("adjutorix:ledger:stats", "ledger stats not modeled in compat bridge"),
    },
    diagnostics: {
      runtime: async () => envelope("adjutorix:diagnostics:runtimeSnapshot", (await safeBridge.diagnostics?.load?.()) ?? {}),
      startup: async () => unavailable("adjutorix:diagnostics:startupReport", "diagnostics startup not modeled in compat bridge"),
      observability: async () => unavailable("adjutorix:diagnostics:observabilityBundle", "diagnostics observability not modeled in compat bridge"),
      logTail: async (_input: JsonObject) => unavailable("adjutorix:diagnostics:logTail", "diagnostics log tail not modeled in compat bridge"),
      crashContext: async () => unavailable("adjutorix:diagnostics:crashContext", "diagnostics crash context not modeled in compat bridge"),
      export: async (_input?: JsonObject) => unavailable("adjutorix:diagnostics:exportBundle", "diagnostics export not modeled in compat bridge"),
      events: wrapSubscription("adjutorix:event:diagnostics", safeBridge.diagnostics?.subscribe),
    },
    agent: {
      health: async () => envelope("adjutorix:agent:health", (await safeBridge.agent?.connect?.()) ?? {}),
      status: async () => envelope("adjutorix:agent:status", (await safeBridge.agent?.connect?.()) ?? {}),
      start: async (_input?: JsonObject) => envelope("adjutorix:agent:start", {}),
      stop: async (_input?: JsonObject) => envelope("adjutorix:agent:stop", {}),
      events: wrapSubscription("adjutorix:event:agent", safeBridge.agent?.subscribe),
    },
    compatibility: {
      manifest: () => manifest,
      isCompatibleBridgeMeta: (meta: { version: number; bridge: string }) =>
        Boolean(meta) && typeof meta.version === "number" && typeof meta.bridge === "string",
      assertCompatibleBridgeMeta: (meta: { version: number; bridge: string }) => {
        if (!meta || typeof meta.version !== "number" || typeof meta.bridge !== "string") {
          throw new Error("renderer_bootstrap_incompatible_bridge_meta");
        }
      },
      hasCapability: (capability: string) => capabilities.includes(capability),
      listCapabilities: () => [...capabilities],
    },
  };
}

export function createRendererRuntime(input: { bridge: any }) {
  const bridge = input?.bridge;
  const api = isCanonicalBridgeCandidate(bridge) ? bridge : buildCompatApi(bridge);

  return { api, bridge };
}
