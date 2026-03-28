import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateSystemInvariants
} from "../../packages/shared/src/invariants/system_invariants";

test("system invariants surface renderer isolation violations", () => {
  const result = evaluateSystemInvariants({
    mutation: {
      actor: "renderer",
      mode: "direct-write",
      requestedWrites: ["packages/shared/src/rpc/schema.ts"],
      forbiddenWrites: ["packages/shared/src/rpc/schema.ts"]
    },
    transaction: {
      id: "tx-001",
      state: "running",
      sequence: 1,
      createdAt: "2026-03-28T15:30:00.000Z"
    },
    ledger: {
      transactions: [],
      artifacts: [],
      edges: []
    },
    ordering: {
      transitions: [{ name: "renderer.write", sequence: 1 }]
    },
    governance: {
      action: "renderer.write",
      requiresApproval: true,
      approved: false,
      governedTargets: ["packages/shared/src/rpc/schema.ts"]
    },
    verify: {
      requiredChecks: ["renderer-isolation"],
      executedChecks: [],
      failedChecks: []
    }
  });

  assert.equal(result.ok, false);
  assert.ok(result.violations.length > 0);
});

test("system invariants expose aggregate status", () => {
  const result = evaluateSystemInvariants({
    mutation: {
      actor: "agent",
      mode: "patch",
      requestedWrites: ["packages/shared/src/rpc/schema.ts"],
      forbiddenWrites: []
    },
    transaction: {
      id: "tx-002",
      state: "completed",
      sequence: 2,
      createdAt: "2026-03-28T15:31:00.000Z"
    },
    ledger: {
      transactions: [],
      artifacts: [],
      edges: []
    },
    ordering: {
      transitions: [{ name: "verify.completed", sequence: 1 }]
    },
    governance: {
      action: "patch.apply",
      requiresApproval: false,
      approved: true,
      governedTargets: ["packages/shared/src/rpc/schema.ts"]
    },
    verify: {
      requiredChecks: [],
      executedChecks: [],
      failedChecks: []
    }
  });

  assert.equal(typeof result.ok, "boolean");
  assert.ok(Array.isArray(result.violations));
});
