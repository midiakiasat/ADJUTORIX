import test from "node:test";
import assert from "node:assert/strict";

import {
  assertPatchArtifact,
  normalizePatchArtifact
} from "../../packages/shared/src/patch/patch_artifact";
import {
  summarizePatch
} from "../../packages/shared/src/patch/patch_summary";
import {
  assertPatchRollbackPlan
} from "../../packages/shared/src/patch/patch_rollback";

test("patch schema accepts a normalized patch artifact", () => {
  const patch = normalizePatchArtifact({
    patchId: "patch-001",
    transactionId: "tx-001",
    basisTransactionId: "tx-000",
    targets: [
      {
        path: "src/index.ts",
        kind: "modify",
        language: "typescript"
      }
    ],
    hunks: [
      {
        path: "src/index.ts",
        additions: 4,
        deletions: 1,
        header: "@@ -1,3 +1,6 @@"
      }
    ],
    metadata: {
      generator: "unit-test",
      normalized: "true"
    },
    rollback: {
      strategy: "reverse-apply",
      expectedCleanRevert: true
    }
  });

  assertPatchArtifact(patch);

  const summary = summarizePatch(patch);
  assert.equal(summary.fileCount, 1);
  assert.equal(summary.insertions, 4);
  assert.equal(summary.deletions, 1);
});

test("patch schema rejects empty identifiers and invalid rollback plans", () => {
  assert.throws(
    () =>
      assertPatchArtifact({
        patchId: "",
        transactionId: "tx-001",
        basisTransactionId: "tx-000",
        targets: [],
        hunks: [],
        metadata: {}
      }),
    /patch/i
  );

  assert.throws(
    () =>
      assertPatchRollbackPlan({
        strategy: "",
        expectedCleanRevert: true
      }),
    /strategy/i
  );
});
