import {
  RuntimeCapability,
  RuntimeCapabilityProfile,
  assertRuntimeCapabilityProfile
} from "./capabilities.js";
import {
  DEFAULT_RUNTIME_LIMITS,
  RuntimeLimits,
  assertRuntimeLimits,
  mergeRuntimeLimits
} from "./limits.js";
import {
  DEFAULT_RUNTIME_TIMEOUTS,
  RuntimeTimeouts,
  assertRuntimeTimeouts,
  mergeRuntimeTimeouts
} from "./timeouts.js";
import {
  buildDefaultFeatureFlags,
  assertFeatureFlagStateMap
} from "./feature_flags.js";

export interface RuntimeConfig {
  readonly environment: "development" | "test" | "production";
  readonly workspaceRoot?: string;
  readonly capabilityProfile: RuntimeCapabilityProfile;
  readonly grantedCapabilities: readonly RuntimeCapability[];
  readonly featureFlags: Readonly<Record<string, boolean>>;
  readonly limits: RuntimeLimits;
  readonly timeouts: RuntimeTimeouts;
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  environment: "development",
  capabilityProfile: {
    required: ["workspace.read", "ledger.read", "governance.enforce"],
    optional: [
      "workspace.write",
      "workspace.watch",
      "index.read",
      "index.write",
      "ledger.write",
      "patch.validate",
      "patch.apply",
      "patch.rollback",
      "verify.run",
      "verify.read",
      "diagnostics.parse",
      "recovery.run",
      "shell.execute",
      "app.package"
    ],
    denied: []
  },
  grantedCapabilities: [
    "workspace.read",
    "ledger.read",
    "governance.enforce",
    "index.read",
    "diagnostics.parse"
  ],
  featureFlags: buildDefaultFeatureFlags(),
  limits: DEFAULT_RUNTIME_LIMITS,
  timeouts: DEFAULT_RUNTIME_TIMEOUTS
};

function assertEnvironment(value: string): asserts value is RuntimeConfig["environment"] {
  if (!["development", "test", "production"].includes(value)) {
    throw new Error(`unsupported runtime environment: ${value}`);
  }
}

export function assertRuntimeConfig(value: RuntimeConfig): void {
  assertEnvironment(value.environment);
  if (value.workspaceRoot !== undefined && value.workspaceRoot.trim().length === 0) {
    throw new Error("runtimeConfig.workspaceRoot must be non-empty when present");
  }
  assertRuntimeCapabilityProfile(value.capabilityProfile);
  assertFeatureFlagStateMap(value.featureFlags);
  assertRuntimeLimits(value.limits);
  assertRuntimeTimeouts(value.timeouts);

  for (const capability of value.capabilityProfile.required) {
    if (!value.grantedCapabilities.includes(capability)) {
      throw new Error(`missing required granted capability: ${capability}`);
    }
  }
}

export function mergeRuntimeConfig(
  base: RuntimeConfig,
  override: Partial<Omit<RuntimeConfig, "limits" | "timeouts">> & {
    readonly limits?: Partial<RuntimeLimits>;
    readonly timeouts?: Partial<RuntimeTimeouts>;
  }
): RuntimeConfig {
  const merged: RuntimeConfig = {
    ...base,
    ...override,
    limits: mergeRuntimeLimits(base.limits, override.limits ?? {}),
    timeouts: mergeRuntimeTimeouts(base.timeouts, override.timeouts ?? {})
  };
  assertRuntimeConfig(merged);
  return merged;
}
