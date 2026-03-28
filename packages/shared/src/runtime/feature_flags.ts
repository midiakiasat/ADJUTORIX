export interface FeatureFlagDefinition {
  readonly key: string;
  readonly defaultValue: boolean;
  readonly description: string;
  readonly mutableAtRuntime: boolean;
}

export interface FeatureFlagState {
  readonly key: string;
  readonly enabled: boolean;
}

export const FEATURE_FLAG_DEFINITIONS: readonly FeatureFlagDefinition[] = [
  {
    key: "strict_governance",
    defaultValue: true,
    description: "Enforce governed mutation paths without bypass.",
    mutableAtRuntime: false
  },
  {
    key: "deterministic_replay_guard",
    defaultValue: true,
    description: "Reject replay execution when ledger determinism cannot be established.",
    mutableAtRuntime: false
  },
  {
    key: "index_background_refresh",
    defaultValue: true,
    description: "Allow workspace index refresh after successful bootstrap.",
    mutableAtRuntime: true
  },
  {
    key: "verify_artifact_persistence",
    defaultValue: true,
    description: "Persist verification summaries and logs as first-class artifacts.",
    mutableAtRuntime: false
  },
  {
    key: "diagnostic_linking",
    defaultValue: true,
    description: "Link diagnostics to workspace-relative paths and positions.",
    mutableAtRuntime: true
  }
] as const;

export function assertFeatureFlagKey(value: string): void {
  if (!FEATURE_FLAG_DEFINITIONS.some((entry) => entry.key === value)) {
    throw new Error(`unknown feature flag: ${value}`);
  }
}

export function buildDefaultFeatureFlags(): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const definition of FEATURE_FLAG_DEFINITIONS) {
    result[definition.key] = definition.defaultValue;
  }
  return result;
}

export function normalizeFeatureFlags(
  overrides: Readonly<Record<string, boolean | undefined>>
): Record<string, boolean> {
  const normalized = buildDefaultFeatureFlags();
  for (const definition of FEATURE_FLAG_DEFINITIONS) {
    const override = overrides[definition.key];
    if (override !== undefined) {
      normalized[definition.key] = override;
    }
  }
  return normalized;
}

export function assertFeatureFlagStateMap(
  value: Readonly<Record<string, boolean>>
): void {
  for (const key of Object.keys(value)) {
    assertFeatureFlagKey(key);
    if (typeof value[key] !== "boolean") {
      throw new Error(`feature flag ${key} must be boolean`);
    }
  }
}
