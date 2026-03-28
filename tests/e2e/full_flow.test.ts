import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function readJson(relativePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), relativePath), "utf8"));
}

test("golden rpc artifacts form a coherent submit to status flow", () => {
  const submit = readJson("tests/golden/rpc/job.submit.success.json") as {
    readonly result?: { readonly job_id?: string };
  };
  const status = readJson("tests/golden/rpc/job.status.running.json") as {
    readonly result?: { readonly job_id?: string; readonly status?: string };
  };
  const logs = readJson("tests/golden/rpc/job.logs.sequence.json") as {
    readonly result?: { readonly job_id?: string; readonly logs?: readonly unknown[] };
  };

  const submitJobId = submit.result?.job_id;
  const statusJobId = status.result?.job_id;
  const logsJobId = logs.result?.job_id;

  assert.equal(typeof submitJobId, "string");
  assert.equal(statusJobId, submitJobId);
  assert.equal(logsJobId, submitJobId);
  assert.equal(typeof status.result?.status, "string");
  assert.ok(Array.isArray(logs.result?.logs));
});
