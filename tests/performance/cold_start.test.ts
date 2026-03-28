import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

type RpcEnvelope = {
  readonly result?: {
    readonly status?: string;
    readonly logs?: ReadonlyArray<{
      readonly seq?: number;
      readonly message?: string;
    }>;
  };
};

function readRpcGolden(name: string): RpcEnvelope {
  return JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "tests/golden/rpc", name), "utf8")
  ) as RpcEnvelope;
}

test("cold start status golden shows runnable in-flight job state", () => {
  const status = readRpcGolden("job.status.running.json");

  assert.equal(status.result?.status, "running");
});

test("cold start log golden preserves ordered bootstrap activity", () => {
  const logs = readRpcGolden("job.logs.sequence.json").result?.logs ?? [];
  const sequences = logs.map((entry) => entry.seq ?? -1);

  assert.ok(logs.length > 0);
  assert.deepEqual(
    sequences,
    [...sequences].sort((left, right) => left - right)
  );
  assert.ok(
    logs.some((entry) =>
      String(entry.message ?? "").toLowerCase().includes("job")
    )
  );
});
