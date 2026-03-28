import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("failure recovery evidence exists across fixture and verify summary", () => {
  const stateHead = fs.readFileSync(
    path.join(process.cwd(), "tests/fixtures/corrupted_ledger/state-head.txt"),
    "utf8"
  );
  const summary = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "tests/golden/verify/summary.failure.json"),
      "utf8"
    )
  ) as {
    readonly status?: string;
    readonly violations?: readonly string[];
  };

  assert.match(stateHead, /tx-head=/);
  assert.match(stateHead, /artifact-head=/);
  assert.match(stateHead, /replay-head=/);
  assert.equal(summary.status, "failed");
  assert.ok(Array.isArray(summary.violations));
  assert.ok((summary.violations?.length ?? 0) > 0);
});
