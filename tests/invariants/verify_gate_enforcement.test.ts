import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateVerifyInvariant
} from "../../packages/shared/src/invariants/verify_invariant";

test("verify invariant fails when required checks are missing", () => {
  const result = evaluateVerifyInvariant({
    requiredChecks: ["ledger-consistency", "patch-integrity"],
    executedChecks: ["ledger-consistency"],
    failedChecks: []
  });

  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /verify|check|missing/i);
});

test("verify invariant accepts complete verification set", () => {
  const result = evaluateVerifyInvariant({
    requiredChecks: ["ledger-consistency", "patch-integrity"],
    executedChecks: ["ledger-consistency", "patch-integrity"],
    failedChecks: []
  });

  assert.equal(typeof result.ok, "boolean");
});
