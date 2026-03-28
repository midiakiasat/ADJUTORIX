import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("recovery fixture exposes persisted state heads required for resume", () => {
  const stateHeadPath = path.join(
    process.cwd(),
    "tests/fixtures/corrupted_ledger/state-head.txt"
  );

  const raw = fs.readFileSync(stateHeadPath, "utf8");
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  assert.ok(lines.some((line) => line.startsWith("tx-head=")));
  assert.ok(lines.some((line) => line.startsWith("artifact-head=")));
  assert.ok(lines.some((line) => line.startsWith("replay-head=")));
});

test("resume metadata preserves explicit recovery targets", () => {
  const stateHeadPath = path.join(
    process.cwd(),
    "tests/fixtures/corrupted_ledger/state-head.txt"
  );

  const values = Object.fromEntries(
    fs
      .readFileSync(stateHeadPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [key, value] = line.split("=", 2);
        return [key, value];
      })
  );

  assert.match(String(values["tx-head"]), /^tx-/);
  assert.match(String(values["artifact-head"]), /^artifact-/);
  assert.match(String(values["replay-head"]), /^seq-/);
});
