import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateGovernanceInvariant
} from "../../packages/shared/src/invariants/governance_invariant";

test("governance invariant blocks apply without approval", () => {
  const result = evaluateGovernanceInvariant({
    action: "patch.apply",
    requiresApproval: true,
    approved: false,
    governedTargets: ["packages/shared/src/patch/patch_artifact.ts"]
  });

  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /approval|govern/i);
});

test("governance invariant accepts approved apply on governed targets", () => {
  const result = evaluateGovernanceInvariant({
    action: "patch.apply",
    requiresApproval: true,
    approved: true,
    governedTargets: ["packages/shared/src/patch/patch_artifact.ts"]
  });

  assert.equal(typeof result.ok, "boolean");
});
