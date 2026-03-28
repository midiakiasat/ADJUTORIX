import test from "node:test";
import assert from "node:assert/strict";

import {
  assertLedgerEdge,
  buildEdgeAdjacencyMap,
  filterEdgesByType
} from "../../packages/shared/src/ledger/edges";
import {
  summarizeReplaySnapshot
} from "../../packages/shared/src/ledger/views";

test("ledger edge contract validates typed relationships", () => {
  const edges = [
    {
      from: "tx-002",
      to: "tx-001",
      type: "basis"
    },
    {
      from: "artifact-001",
      to: "tx-002",
      type: "produced_by"
    }
  ];

  for (const edge of edges) {
    assertLedgerEdge(edge);
  }

  const adjacency = buildEdgeAdjacencyMap(edges);
  assert.deepEqual(adjacency.get("tx-002"), [edges[0]]);
  assert.equal(filterEdgesByType(edges, "basis").length, 1);
  assert.equal(filterEdgesByType(edges, "produced_by").length, 1);
});

test("ledger views summarize replay state consistently", () => {
  const summary = summarizeReplaySnapshot({
    transactions: [
      { id: "tx-001", state: "planned", sequence: 1, createdAt: "2026-03-28T15:00:00.000Z" },
      { id: "tx-002", state: "completed", sequence: 2, createdAt: "2026-03-28T15:00:02.000Z" }
    ],
    artifacts: [
      { id: "artifact-001", kind: "verify-summary", transactionId: "tx-002" }
    ],
    edges: [
      { from: "tx-002", to: "tx-001", type: "basis" },
      { from: "artifact-001", to: "tx-002", type: "produced_by" }
    ]
  });

  assert.equal(summary.transactionCount, 2);
  assert.equal(summary.artifactCount, 1);
  assert.equal(summary.edgeCount, 2);
  assert.deepEqual(
    summary.stateCounts,
    [
      { state: "completed", count: 1 },
      { state: "planned", count: 1 }
    ]
  );
});

test("ledger edge contract rejects empty endpoints", () => {
  assert.throws(
    () =>
      assertLedgerEdge({
        from: "",
        to: "tx-001",
        type: "basis"
      }),
    /from|to/i
  );
});
