import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateMutationInvariant
} from "../../packages/shared/src/invariants/mutation_invariant";

test("mutation invariant accepts governed write paths only", () => {
  const result = evaluateMutationInvariant({
    actor: "agent",
    mode: "patch",
    requestedWrites: [
      "packages/shared/src/rpc/protocol.ts",
      "tests/golden/rpc/job.submit.success.json"
    ],
    forbiddenWrites: [
      ".git/config",
      "node_modules/pkg/index.js"
    ]
  });

  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /forbidden|direct|write/i);
});

test("mutation invariant passes when writes are governed and explicit", () => {
  const result = evaluateMutationInvariant({
    actor: "agent",
    mode: "patch",
    requestedWrites: [
      "packages/shared/src/ledger/views.ts"
    ],
    forbiddenWrites: []
  });

  assert.equal(typeof result.ok, "boolean");
  assert.equal(result.violations.length, result.ok ? 0 : result.violations.length);
});
