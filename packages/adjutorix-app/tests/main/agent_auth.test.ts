import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / MAIN / agent_auth.test.ts
 *
 * Canonical auth-state, token-source, rotation, and request-projection suite.
 *
 * Objective:
 * - enforce one authoritative authentication truth across bootstrap, memory cache,
 *   persisted token store, env overrides, rotation, invalidation, and request header generation
 * - ensure stale loads, empty tokens, conflicting sources, failed rotations, and invalidation
 *   cannot leave downstream subsystems with contradictory auth state
 * - preserve deterministic behavior: identical source inputs produce identical effective auth state
 *
 * Notes:
 * - this suite assumes src/main/services/agent_auth exports the functions and types referenced below
 * - if production exports differ, adapt the test harness first rather than weakening the contract intent
 */

import {
  createAgentAuth,
  type AgentAuthEnvironment,
  type AgentAuthState,
  type AgentAuthHealth,
} from "../../../src/main/services/agent_auth";

function authState(overrides: Partial<AgentAuthState> = {}): AgentAuthState {
  return {
    status: "unknown",
    token: null,
    source: "none",
    loadedAtMs: null,
    rotatedAtMs: null,
    invalidatedAtMs: null,
    lastError: null,
    ...overrides,
  } as AgentAuthState;
}

function authHealth(overrides: Partial<AgentAuthHealth> = {}): AgentAuthHealth {
  return {
    level: "healthy",
    reasons: [],
    hasToken: true,
    canAuthorizeRequests: true,
    ...overrides,
  } as AgentAuthHealth;
}

function makeEnv(overrides: Partial<AgentAuthEnvironment> = {}): AgentAuthEnvironment {
  let persistedToken: string | null = "token-from-store";
  let envToken: string | null = null;

  return {
    store: {
      loadToken: vi.fn(async () => persistedToken),
      saveToken: vi.fn(async (token: string) => {
        persistedToken = token;
      }),
      clearToken: vi.fn(async () => {
        persistedToken = null;
      }),
      peekPersistedTokenForTest: () => persistedToken,
    },
    source: {
      readEnvToken: vi.fn(() => envToken),
      setEnvTokenForTest: (value: string | null) => {
        envToken = value;
      },
      fetchBootstrapToken: vi.fn(async () => "token-from-bootstrap"),
      rotateToken: vi.fn(async (_oldToken: string) => "token-rotated"),
    },
    clock: {
      now: vi.fn(() => 1711000000000),
    },
    policy: {
      preferEnvToken: true,
      persistBootstrapToken: true,
      persistRotatedToken: true,
      treatEmptyTokenAsMissing: true,
      allowBootstrapWhenMissing: true,
      allowRotationWhenMissing: false,
    },
    ...overrides,
  } as unknown as AgentAuthEnvironment;
}

describe("main/services/agent_auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads persisted token into available auth state when no higher-priority env token exists", async () => {
    const environment = makeEnv();
    const auth = createAgentAuth(environment);

    const result = await auth.load();

    expect(environment.store.loadToken).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("available");
    expect(result.token).toBe("token-from-store");
    expect(result.source).toBe("store");
    expect(result.loadedAtMs).toBe(1711000000000);
  });

  it("prefers env token over store token when policy enables env precedence", async () => {
    const environment = makeEnv();
    environment.source.setEnvTokenForTest("token-from-env");
    const auth = createAgentAuth(environment);

    const result = await auth.load();

    expect(result.status).toBe("available");
    expect(result.token).toBe("token-from-env");
    expect(result.source).toBe("env");
  });

  it("falls back to persisted token when env token is absent", async () => {
    const environment = makeEnv();
    environment.source.setEnvTokenForTest(null);
    const auth = createAgentAuth(environment);

    const result = await auth.load();

    expect(result.token).toBe("token-from-store");
    expect(result.source).toBe("store");
  });

  it("treats empty env token as missing rather than valid auth when empty tokens are disallowed", async () => {
    const environment = makeEnv();
    environment.source.setEnvTokenForTest("");
    const auth = createAgentAuth(environment);

    const result = await auth.load();

    expect(result.status).toBe("available");
    expect(result.token).toBe("token-from-store");
    expect(result.source).toBe("store");
  });

  it("treats empty stored token as missing rather than usable auth material", async () => {
    const environment = makeEnv({
      store: {
        ...makeEnv().store,
        loadToken: vi.fn(async () => ""),
        saveToken: vi.fn(async () => undefined),
        clearToken: vi.fn(async () => undefined),
      },
    });
    const auth = createAgentAuth(environment);

    const result = await auth.load();

    expect(result.status).toBe("missing");
    expect(result.token).toBeNull();
    expect(result.source).toBe("none");
  });

  it("bootstraps token when no source has one and bootstrap is allowed", async () => {
    const base = makeEnv();
    const environment = makeEnv({
      store: {
        ...base.store,
        loadToken: vi.fn(async () => null),
        saveToken: base.store.saveToken,
        clearToken: base.store.clearToken,
      },
    });
    const auth = createAgentAuth(environment);

    const result = await auth.bootstrap();

    expect(environment.source.fetchBootstrapToken).toHaveBeenCalledTimes(1);
    expect(environment.store.saveToken).toHaveBeenCalledWith("token-from-bootstrap");
    expect(result.status).toBe("available");
    expect(result.token).toBe("token-from-bootstrap");
    expect(result.source).toBe("bootstrap");
  });

  it("fails closed when bootstrap returns empty token", async () => {
    const base = makeEnv();
    const environment = makeEnv({
      store: {
        ...base.store,
        loadToken: vi.fn(async () => null),
        saveToken: base.store.saveToken,
        clearToken: base.store.clearToken,
      },
      source: {
        ...base.source,
        fetchBootstrapToken: vi.fn(async () => ""),
      },
    });
    const auth = createAgentAuth(environment);

    const result = await auth.bootstrap();

    expect(result.status).toBe("missing");
    expect(result.token).toBeNull();
    expect(String(result.lastError).toLowerCase()).toContain("empty");
  });

  it("does not bootstrap when policy forbids bootstrap on missing auth", async () => {
    const base = makeEnv();
    const environment = makeEnv({
      store: {
        ...base.store,
        loadToken: vi.fn(async () => null),
        saveToken: base.store.saveToken,
        clearToken: base.store.clearToken,
      },
      policy: {
        ...base.policy,
        allowBootstrapWhenMissing: false,
      },
    });
    const auth = createAgentAuth(environment);

    const result = await auth.bootstrap();

    expect(environment.source.fetchBootstrapToken).not.toHaveBeenCalled();
    expect(result.status).toBe("missing");
  });

  it("rotates existing token and persists rotated token when rotation succeeds", async () => {
    const environment = makeEnv();
    const auth = createAgentAuth(environment);
    await auth.load();

    const result = await auth.rotate();

    expect(environment.source.rotateToken).toHaveBeenCalledWith("token-from-store");
    expect(environment.store.saveToken).toHaveBeenCalledWith("token-rotated");
    expect(result.status).toBe("available");
    expect(result.token).toBe("token-rotated");
    expect(result.source).toBe("rotation");
    expect(result.rotatedAtMs).toBe(1711000000000);
  });

  it("does not persist rotated token when policy disables rotation persistence", async () => {
    const base = makeEnv();
    const environment = makeEnv({
      policy: {
        ...base.policy,
        persistRotatedToken: false,
      },
    });
    const auth = createAgentAuth(environment);
    await auth.load();

    const result = await auth.rotate();

    expect(result.token).toBe("token-rotated");
    expect(environment.store.saveToken).not.toHaveBeenCalledWith("token-rotated");
  });

  it("does not allow rotation from missing auth when policy forbids it", async () => {
    const base = makeEnv();
    const environment = makeEnv({
      store: {
        ...base.store,
        loadToken: vi.fn(async () => null),
        saveToken: base.store.saveToken,
        clearToken: base.store.clearToken,
      },
      policy: {
        ...base.policy,
        allowRotationWhenMissing: false,
      },
    });
    const auth = createAgentAuth(environment);
    await auth.load();

    await expect(auth.rotate()).rejects.toThrow();
    expect(environment.source.rotateToken).not.toHaveBeenCalled();
  });

  it("preserves prior valid token when rotation fails instead of downgrading to contradictory missing state", async () => {
    const base = makeEnv();
    const environment = makeEnv({
      source: {
        ...base.source,
        rotateToken: vi.fn(async () => {
          throw new Error("rotation failed");
        }),
      },
    });
    const auth = createAgentAuth(environment);
    await auth.load();

    await expect(auth.rotate()).rejects.toThrow("rotation failed");
    expect(auth.getState().token).toBe("token-from-store");
    expect(auth.getState().status).toBe("available");
  });

  it("invalidates auth by clearing memory and persistent store", async () => {
    const environment = makeEnv();
    const auth = createAgentAuth(environment);
    await auth.load();

    await auth.invalidate("token rejected");

    expect(environment.store.clearToken).toHaveBeenCalledTimes(1);
    expect(auth.getState().status).toBe("invalid");
    expect(auth.getState().token).toBeNull();
    expect(auth.getState().lastError).toBe("token rejected");
    expect(auth.getState().invalidatedAtMs).toBe(1711000000000);
  });

  it("builds bearer authorization header only when valid token exists", async () => {
    const auth = createAgentAuth(makeEnv());
    await auth.load();

    expect(auth.getAuthHeaders()).toEqual({ Authorization: "Bearer token-from-store" });

    await auth.invalidate("bad token");
    expect(auth.getAuthHeaders()).toEqual({});
  });

  it("reports healthy auth when token exists and requests can be authorized", async () => {
    const auth = createAgentAuth(makeEnv());
    await auth.load();

    const result = auth.getHealth();
    expect(result.level).toBe("healthy");
    expect(result.hasToken).toBe(true);
    expect(result.canAuthorizeRequests).toBe(true);
  });

  it("reports degraded or unhealthy auth when token is missing or invalid", async () => {
    const base = makeEnv();
    const environment = makeEnv({
      store: {
        ...base.store,
        loadToken: vi.fn(async () => null),
        saveToken: base.store.saveToken,
        clearToken: base.store.clearToken,
      },
    });
    const auth = createAgentAuth(environment);

    await auth.load();
    const missing = auth.getHealth();
    expect(["degraded", "unhealthy"]).toContain(missing.level);
    expect(missing.hasToken).toBe(false);

    await auth.invalidate("rejected");
    const invalid = auth.getHealth();
    expect(["degraded", "unhealthy"]).toContain(invalid.level);
    expect(invalid.canAuthorizeRequests).toBe(false);
  });

  it("caches loaded auth state and does not reload store on repeated load calls unless refreshed", async () => {
    const environment = makeEnv();
    const auth = createAgentAuth(environment);

    await auth.load();
    await auth.load();

    expect(environment.store.loadToken).toHaveBeenCalledTimes(1);
  });

  it("refreshes auth from authoritative sources when explicitly requested", async () => {
    const environment = makeEnv();
    const auth = createAgentAuth(environment);

    await auth.load();
    environment.source.setEnvTokenForTest("token-from-env-refresh");

    const refreshed = await auth.refresh();

    expect(environment.store.loadToken).toHaveBeenCalledTimes(2);
    expect(refreshed.token).toBe("token-from-env-refresh");
    expect(refreshed.source).toBe("env");
  });

  it("does not let stale overlapping loads overwrite newer refreshed auth state", async () => {
    let resolveA!: (value: string | null) => void;
    let resolveB!: (value: string | null) => void;

    const loadA = new Promise<string | null>((resolve) => {
      resolveA = resolve;
    });
    const loadB = new Promise<string | null>((resolve) => {
      resolveB = resolve;
    });

    const base = makeEnv();
    const loadToken = vi
      .fn()
      .mockImplementationOnce(async () => loadA)
      .mockImplementationOnce(async () => loadB);

    const auth = createAgentAuth(
      makeEnv({
        store: {
          ...base.store,
          loadToken,
          saveToken: base.store.saveToken,
          clearToken: base.store.clearToken,
        },
      }),
    );

    const first = auth.load();
    const second = auth.refresh();

    resolveB("newer-token");
    await second;

    resolveA("stale-token");
    await first;

    expect(auth.getState().token).toBe("newer-token");
  });

  it("preserves deterministic auth projection for identical inputs", async () => {
    const a = createAgentAuth(makeEnv());
    const b = createAgentAuth(makeEnv());

    const first = await a.load();
    const second = await b.load();

    expect(second).toEqual(first);
    expect(b.getAuthHeaders()).toEqual(a.getAuthHeaders());
  });
});
