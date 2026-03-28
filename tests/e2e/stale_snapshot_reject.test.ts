import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

type LedgerEvent = {
  readonly seq: number;
};

test("corrupted ledger fixture carries a stale replay head beyond observed events", () => {
  const events = fs
    .readFileSync(
      path.join(process.cwd(), "tests/fixtures/corrupted_ledger/events.ndjson"),
      "utf8"
    )
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerEvent);

  const rawStateHead = fs.readFileSync(
    path.join(process.cwd(), "tests/fixtures/corrupted_ledger/state-head.txt"),
    "utf8"
  );

  const replayHeadLine = rawStateHead
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("replay-head="));

  assert.ok(replayHeadLine);

  const replayHead = Number(String(replayHeadLine).replace("replay-head=seq-", ""));
  const maxSeq = Math.max(...events.map((event) => event.seq));

  assert.ok(replayHead > maxSeq);
});
