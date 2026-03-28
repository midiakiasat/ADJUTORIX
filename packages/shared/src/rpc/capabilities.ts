export const RPC_CAPABILITIES = [
  "workspace.open",
  "workspace.scan",
  "ledger.read",
  "patch.validate",
  "patch.apply",
  "patch.reject",
  "patch.rollback",
  "verify.run",
  "verify.read",
  "governance.read",
  "governance.enforce",
  "recovery.run",
  "diagnostics.parse",
  "transaction.read"
] as const;

export type RpcCapability = (typeof RPC_CAPABILITIES)[number];

export interface RpcCapabilitySet {
  readonly protocolVersion: string;
  readonly capabilities: readonly RpcCapability[];
  readonly optionalCapabilities: readonly RpcCapability[];
}

function assertUnique(values: readonly string[], field: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`${field} must not contain duplicates: ${value}`);
    }
    seen.add(value);
  }
}

export function assertRpcCapability(value: string): asserts value is RpcCapability {
  if (!(RPC_CAPABILITIES as readonly string[]).includes(value)) {
    throw new Error(`unsupported capability: ${value}`);
  }
}

export function assertRpcCapabilitySet(value: RpcCapabilitySet): void {
  if (value.protocolVersion.trim().length === 0) {
    throw new Error("capabilitySet.protocolVersion must be non-empty");
  }
  assertUnique(value.capabilities, "capabilitySet.capabilities");
  assertUnique(value.optionalCapabilities, "capabilitySet.optionalCapabilities");

  for (const capability of value.capabilities) {
    assertRpcCapability(capability);
  }

  for (const capability of value.optionalCapabilities) {
    assertRpcCapability(capability);
  }
}

export function supportsCapability(
  capabilitySet: RpcCapabilitySet,
  capability: RpcCapability
): boolean {
  return capabilitySet.capabilities.includes(capability);
}

export function intersectCapabilities(
  required: readonly RpcCapability[],
  offered: readonly RpcCapability[]
): RpcCapability[] {
  const offeredSet = new Set<RpcCapability>(offered);
  return required.filter((value) => offeredSet.has(value));
}
