import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

type VerifySummary = {
  readonly status?: string;
  readonly checks?: ReadonlyArray<{
    readonly name?: string;
    readonly status?: string;
    readonly duration_ms?: number;
  }>;
};

function readVerifySummary(name: string): VerifySummary {
  return JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "tests/golden/verify", name),
      "utf8"
    )
  ) as VerifySummary;
}

test("verify success summary stays within a tight synthetic latency envelope", () => {
  const summary = readVerifySummary("summary.success.json");
  const durations = (summary.checks ?? []).map((check) => check.duration_ms ?? 0);
  const totalDurationMs = durations.reduce((left, right) => left + right, 0);

  assert.equal(summary.status, "completed");
  assert.ok(durations.length > 0);
  assert.ok(durations.every((value) => value >= 0));
  assert.ok(totalDurationMs > 0);
  assert.ok(totalDurationMs <= 5_000);
});

test("verify failure summary exposes bounded failed-check latency", () => {
  const summary = readVerifySummary("summary.failure.json");
  const failedChecks = (summary.checks ?? []).filter(
    (check) => check.status === "failed"
  );
  const maxFailedDuration = Math.max(
    ...failedChecks.map((check) => check.duration_ms ?? 0)
  );

  assert.equal(summary.status, "failed");
  assert.ok(failedChecks.length > 0);
  assert.ok(maxFailedDuration >= 0);
  assert.ok(maxFailedDuration <= 1_000);
});
