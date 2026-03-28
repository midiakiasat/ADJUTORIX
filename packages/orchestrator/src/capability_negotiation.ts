import type { RuntimeCapabilityProfile } from "../../shared/src/runtime/capabilities.js";

export interface CapabilityNegotiationRequest {
  readonly required: readonly string[];
  readonly preferred: readonly string[];
  readonly forbidden: readonly string[];
  readonly available: RuntimeCapabilityProfile;
}

export interface CapabilityNegotiationResult {
  readonly granted: readonly string[];
  readonly denied: readonly string[];
  readonly missingRequired: readonly string[];
  readonly ok: boolean;
}

export function negotiateCapabilities(
  request: CapabilityNegotiationRequest
): CapabilityNegotiationResult {
  const available = new Set(request.available.optional);
  const deniedByRuntime = new Set(request.available.denied);
  const forbidden = new Set(request.forbidden);

  const granted: string[] = [];
  const denied: string[] = [];
  const missingRequired: string[] = [];

  for (const capability of request.required) {
    if (deniedByRuntime.has(capability) || forbidden.has(capability)) {
      denied.push(capability);
      missingRequired.push(capability);
      continue;
    }
    if (available.has(capability) || request.available.required.includes(capability)) {
      granted.push(capability);
    } else {
      missingRequired.push(capability);
    }
  }

  for (const capability of request.preferred) {
    if (granted.includes(capability) || denied.includes(capability)) {
      continue;
    }
    if (deniedByRuntime.has(capability) || forbidden.has(capability)) {
      denied.push(capability);
      continue;
    }
    if (available.has(capability) || request.available.required.includes(capability)) {
      granted.push(capability);
    }
  }

  return {
    granted,
    denied,
    missingRequired,
    ok: missingRequired.length === 0
  };
}
