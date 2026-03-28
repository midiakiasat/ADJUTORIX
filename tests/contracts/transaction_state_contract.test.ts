import test from "node:test";
import assert from "node:assert/strict";

import {
  assertTransactionRecord,
  compareTransactionSequence,
  isTerminalTransactionState
} from "../../packages/shared/src/ledger/transaction";
import {
  nextSequenceValue
} from "../../packages/shared/src/ledger/sequence";

test("transaction contract preserves ordering and terminal state semantics", () => {
  const planned = {
    id: "tx-001",
    state: "planned",
    sequence: 1,
    createdAt: "2026-03-28T15:00:00.000Z"
  };

  const completed = {
    id: "tx-002",
    state: "completed",
    sequence: 2,
    createdAt: "2026-03-28T15:00:01.000Z"
  };

  assertTransactionRecord(planned);
  assertTransactionRecord(completed);

  assert.equal(compareTransactionSequence(planned, completed), -1);
  assert.equal(nextSequenceValue(planned.sequence), 2);
  assert.equal(isTerminalTransactionState("completed"), true);
  assert.equal(isTerminalTransactionState("running"), false);
});

test("transaction contract rejects malformed records", () => {
  assert.throws(
    () =>
      assertTransactionRecord({
        id: "",
        state: "planned",
        sequence: 0,
        createdAt: ""
      }),
    /id|sequence|created/i
  );
});
