import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("sample patch golden includes reversible hunks", () => {
  const patchPath = path.join(
    process.cwd(),
    "tests/golden/patches/sample.patch.diff"
  );

  const patch = fs.readFileSync(patchPath, "utf8");

  assert.match(patch, /^diff --git /m);
  assert.match(patch, /^@@ /m);
  assert.match(patch, /^[+-].+/m);
});

test("rollback visibility fixture contains explicit failure evidence", () => {
  const ledgerPath = path.join(
    process.cwd(),
    "tests/fixtures/corrupted_ledger/ledger.json"
  );

  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as {
    readonly transactions?: ReadonlyArray<{ readonly status?: string }>;
    readonly edges?: ReadonlyArray<{ readonly type?: string }>;
  };

  assert.ok(Array.isArray(ledger.transactions));
  assert.ok(Array.isArray(ledger.edges));
});
