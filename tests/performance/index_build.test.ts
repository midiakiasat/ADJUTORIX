import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function countFiles(root: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      total += countFiles(absolute);
    } else if (entry.isFile()) {
      total += 1;
    }
  }
  return total;
}

test("typescript sample fixture stays small enough for fast index build", () => {
  const root = path.join(process.cwd(), "tests/fixtures/sample_repo_typescript");
  const fileCount = countFiles(root);

  assert.ok(fs.existsSync(path.join(root, "package.json")));
  assert.ok(fs.existsSync(path.join(root, "tsconfig.json")));
  assert.ok(fs.existsSync(path.join(root, "src/index.ts")));
  assert.ok(fileCount >= 4);
  assert.ok(fileCount <= 20);
});

test("python sample fixture stays small enough for deterministic indexing", () => {
  const root = path.join(process.cwd(), "tests/fixtures/sample_repo_python");
  const fileCount = countFiles(root);

  assert.ok(fs.existsSync(path.join(root, "pyproject.toml")));
  assert.ok(
    fs.existsSync(
      path.join(root, "src/sample_repo_python/core.py")
    )
  );
  assert.ok(fileCount >= 4);
  assert.ok(fileCount <= 20);
});
