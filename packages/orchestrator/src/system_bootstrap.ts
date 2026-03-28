import type { RuntimeGuardDecision } from "./invariant_runtime_guard.js";
import type { StartupAction } from "./startup_plan.js";

export interface BootstrapRequest {
  readonly startupPlan: readonly StartupAction[];
  readonly guardDecision: RuntimeGuardDecision;
}

export interface BootstrapResult {
  readonly ok: boolean;
  readonly activatedServices: readonly string[];
  readonly reason?: string;
}

export function bootstrapSystem(request: BootstrapRequest): BootstrapResult {
  if (!request.guardDecision.allowed) {
    return {
      ok: false,
      activatedServices: [],
      reason: request.guardDecision.reason ?? "runtime guard denied bootstrap"
    };
  }

  return {
    ok: true,
    activatedServices: request.startupPlan.map((entry) => entry.service)
  };
}
