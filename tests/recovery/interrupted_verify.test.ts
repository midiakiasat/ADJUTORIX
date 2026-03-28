import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

type VerifySummary = {
  readonly transaction_id: string;
  readonly status: string;
  readonly checks: ReadonlyArray<{
    readonly name: string;
    readonly status: string;
    readonly duration_ms: number;
    readonly details?: string;
  }>;
  readonly violations: readonly string[];
};

function readSummary(name: string): VerifySummary {
  return JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "tests/golden/verify", name),
      "utf8"
    )
  ) as VerifySummary;
}

test("failure verify summary captures interrupted verification evidence", () => {
  const summary = readSummary("summary.failure.json");

  assert.equal(summary.status, "failed");
  assert.ok(summary.checks.some((check) => check.status === "failed"));
  assert.ok(summary.violations.length > 0);
});

test("success verify summary contains no violations", () => {
  const summary = readSummary("summary.success.json");

  assert.equal(summary.status, "completed");
  assert.deepEqual(summary.violations, []);
  assert.ok(summary.checks.every((check) => check.duration_ms >= 0));
});
