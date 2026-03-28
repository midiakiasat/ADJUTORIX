import type { RuntimeCapabilityProfile } from "../runtime/capabilities.js";

export interface GovernanceInvariantInput {
  readonly capabilityProfile: RuntimeCapabilityProfile;
  readonly requiresApproval: boolean;
  readonly approved: boolean;
  readonly deniedTargets: readonly string[];
  readonly changedPaths: readonly string[];
}

export interface GovernanceInvariantResult {
  readonly ok: boolean;
  readonly violations: readonly string[];
}

export function evaluateGovernanceInvariant(
  input: GovernanceInvariantInput
): GovernanceInvariantResult {
  const violations: string[] = [];

  if (input.requiresApproval && !input.approved) {
    violations.push("Governed mutation requires approval but approval is absent.");
  }

  for (const denied of input.capabilityProfile.denied) {
    if (input.capabilityProfile.required.includes(denied)) {
      violations.push(`Capability cannot be both required and denied: ${denied}`);
    }
  }

  for (const path of input.changedPaths) {
    if (input.deniedTargets.includes(path)) {
      violations.push(`Changed path intersects denied target: ${path}`);
    }
  }

  return {
    ok: violations.length === 0,
    violations
  };
}
