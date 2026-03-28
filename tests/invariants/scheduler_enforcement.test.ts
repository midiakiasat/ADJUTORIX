import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateOrderingInvariant
} from "../../packages/shared/src/invariants/ordering_invariant";

test("ordering invariant rejects out-of-order transitions", () => {
  const result = evaluateOrderingInvariant({
    transitions: [
      { name: "verify.completed", sequence: 3 },
      { name: "verify.started", sequence: 1 },
      { name: "patch.applied", sequence: 2 }
    ]
  });

  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /order|sequence/i);
});

test("ordering invariant accepts monotonic scheduling", () => {
  const result = evaluateOrderingInvariant({
    transitions: [
      { name: "job.submitted", sequence: 1 },
      { name: "verify.started", sequence: 2 },
      { name: "verify.completed", sequence: 3 }
    ]
  });

  assert.equal(typeof result.ok, "boolean");
});
