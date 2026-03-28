import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSystemInvariants } from "../../packages/shared/src/invariants/system_invariants";

test("governed target write attempt is surfaced as invariant failure", () => {
  const result = evaluateSystemInvariants({
    mutation: {
      directWriteDetected: true,
      attemptedTargets: ["packages/shared/src/rpc/schema.ts"]
    },
    transaction: {
      id: "tx-governed-001",
      state: "running",
      requestedTargets: ["packages/shared/src/rpc/schema.ts"],
      appliedTargets: ["packages/shared/src/rpc/schema.ts"]
    },
    ledger: {
      missingBasisTransactions: [],
      orphanArtifacts: [],
      duplicateSequences: []
    },
    ordering: {
      outOfOrderEvents: []
    },
    governance: {
      governedTargets: ["packages/shared/src/rpc/schema.ts"]
    },
    verify: {
      requiredChecks: [],
      executedChecks: [],
      failedChecks: []
    }
  });

  assert.equal(typeof result.ok, "boolean");
  assert.equal(result.ok, false);
  assert.ok(result.violations.length > 0);
});
