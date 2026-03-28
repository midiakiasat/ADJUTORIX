import test from "node:test";
import assert from "node:assert/strict";

import {
  RPC_METHOD_SCHEMAS,
  validateRequestParams,
  validateResponseResult
} from "../../packages/shared/src/rpc/validation";
import {
  RPC_CHANNELS,
  getRpcChannel
} from "../../packages/shared/src/rpc/channels";
import {
  assertRpcEnvelope,
  createRpcRequestEnvelope,
  createRpcSuccessEnvelope
} from "../../packages/shared/src/rpc/protocol";

test("rpc contract validates request and response payloads for known methods", () => {
  const request = createRpcRequestEnvelope("job.submit", {
    intent: "verify.run",
    workspaceRoot: "/workspace/sample_repo_small",
    arguments: {
      target: "all"
    }
  }, "rpc-contract-001");

  assert.equal(request.jsonrpc, "2.0");
  assert.equal(request.method, "job.submit");

  validateRequestParams("job.submit", request.params);

  const response = createRpcSuccessEnvelope("rpc-contract-001", {
    jobId: "job-001",
    transactionId: "tx-001",
    acceptedAt: "2026-03-28T15:00:00.000Z",
    queuePosition: 0,
    capabilities: ["verify.run", "patch.preview"]
  });

  assert.equal(response.jsonrpc, "2.0");
  validateResponseResult("job.submit", response.result);
});

test("rpc contract rejects invalid envelopes", () => {
  assert.throws(
    () =>
      assertRpcEnvelope({
        jsonrpc: "1.0",
        id: "bad-envelope"
      }),
    /jsonrpc/i
  );

  assert.throws(
    () =>
      validateRequestParams("job.submit", {
        workspaceRoot: "",
        intent: ""
      }),
    /workspace|intent/i
  );
});

test("rpc channels are stable and method-bound", () => {
  assert.ok(RPC_CHANNELS.length > 0);
  assert.equal(getRpcChannel("job.submit"), "adjutorix:job.submit");
  assert.match(getRpcChannel("verify.status"), /^adjutorix:/);
  assert.ok(RPC_METHOD_SCHEMAS["job.submit"]);
  assert.ok(RPC_METHOD_SCHEMAS["verify.status"]);
});
