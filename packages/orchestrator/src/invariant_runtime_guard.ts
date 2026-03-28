import type { SystemInvariantReport } from "../../shared/src/invariants/system_invariants.js";

export interface RuntimeGuardDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

export function enforceInvariantRuntimeGuard(
  report: SystemInvariantReport
): RuntimeGuardDecision {
  if (!report.ok) {
    return {
      allowed: false,
      reason: report.violations.join(" | ")
    };
  }

  return {
    allowed: true
  };
}
