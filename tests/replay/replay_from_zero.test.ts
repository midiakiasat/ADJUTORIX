import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

type LedgerEvent = {
  readonly seq: number;
  readonly event_id: string;
  readonly transaction_id: string;
  readonly type: string;
};

function readNdjson(filePath: string): LedgerEvent[] {
  return fs
    .readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerEvent);
}

test("corrupted ledger fixture is not replayable from zero", () => {
  const fixturePath = path.join(
    process.cwd(),
    "tests/fixtures/corrupted_ledger/events.ndjson"
  );

  const events = readNdjson(fixturePath);
  const sequences = events.map((event) => event.seq);

  assert.notDeepEqual(sequences, [...sequences].sort((left, right) => left - right));
  assert.ok(new Set(sequences).size < sequences.length);
});

test("sample replay golden artifacts start from an explicit first sequence", () => {
  const timelinePath = path.join(
    process.cwd(),
    "tests/golden/ledger/transaction_timeline.ndjson"
  );

  const entries = readNdjson(timelinePath);
  assert.ok(entries.length > 0);
  assert.equal(entries[0]?.seq, 1);
});
