import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function stableDigest(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

test("golden replay snapshot is deterministic across repeated loads", () => {
  const snapshotPath = path.join(
    process.cwd(),
    "tests/golden/ledger/replay_snapshot.json"
  );

  const first = readJson(snapshotPath);
  const second = readJson(snapshotPath);

  assert.deepEqual(second, first);
  assert.equal(stableDigest(first), stableDigest(second));
});

test("golden transaction timeline sequence is monotonic", () => {
  const timelinePath = path.join(
    process.cwd(),
    "tests/golden/ledger/transaction_timeline.ndjson"
  );

  const entries = fs
    .readFileSync(timelinePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { readonly seq: number; readonly transaction_id: string });

  assert.ok(entries.length > 0);

  const sequences = entries.map((entry) => entry.seq);
  const sorted = [...sequences].sort((left, right) => left - right);

  assert.deepEqual(sequences, sorted);
  assert.equal(new Set(entries.map((entry) => entry.transaction_id)).size, entries.length);
});
