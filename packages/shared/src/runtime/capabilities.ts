export const RUNTIME_CAPABILITIES = [
  "workspace.read",
  "workspace.write",
  "workspace.watch",
  "index.read",
  "index.write",
  "ledger.read",
  "ledger.write",
  "patch.validate",
  "patch.apply",
  "patch.rollback",
  "verify.run",
  "verify.read",
  "governance.enforce",
  "diagnostics.parse",
  "recovery.run",
  "shell.execute",
  "app.package"
] as const;

export type RuntimeCapability = (typeof RUNTIME_CAPABILITIES)[number];

export interface RuntimeCapabilityProfile {
  readonly required: readonly RuntimeCapability[];
  readonly optional: readonly RuntimeCapability[];
  readonly denied: readonly RuntimeCapability[];
}

export function isRuntimeCapability(value: string): value is RuntimeCapability {
  return (RUNTIME_CAPABILITIES as readonly string[]).includes(value);
}

export function assertRuntimeCapability(value: string): asserts value is RuntimeCapability {
  if (!isRuntimeCapability(value)) {
    throw new Error(`unsupported runtime capability: ${value}`);
  }
}

function assertUnique(values: readonly string[], field: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`${field} contains duplicate capability: ${value}`);
    }
    seen.add(value);
  }
}

export function assertRuntimeCapabilityProfile(value: RuntimeCapabilityProfile): void {
  assertUnique(value.required, "runtimeCapabilityProfile.required");
  assertUnique(value.optional, "runtimeCapabilityProfile.optional");
  assertUnique(value.denied, "runtimeCapabilityProfile.denied");

  for (const capability of value.required) {
    assertRuntimeCapability(capability);
  }
  for (const capability of value.optional) {
    assertRuntimeCapability(capability);
  }
  for (const capability of value.denied) {
    assertRuntimeCapability(capability);
  }

  for (const capability of value.required) {
    if (value.denied.includes(capability)) {
      throw new Error(`required capability cannot also be denied: ${capability}`);
    }
  }
}

export function resolveGrantedCapabilities(
  profile: RuntimeCapabilityProfile,
  granted: readonly RuntimeCapability[]
): RuntimeCapability[] {
  const grantedSet = new Set<RuntimeCapability>(granted);
  return profile.required
    .concat(profile.optional.filter((value) => grantedSet.has(value)))
    .filter((value, index, array) => !profile.denied.includes(value) && array.indexOf(value) === index);
}
