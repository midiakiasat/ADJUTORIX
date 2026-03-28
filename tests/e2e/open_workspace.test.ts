import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("open workspace fixture exposes a minimal runnable repository shape", () => {
  const root = path.join(process.cwd(), "tests/fixtures/sample_repo_small");

  assert.ok(fs.existsSync(root));
  assert.ok(fs.existsSync(path.join(root, "README.md")));
  assert.ok(fs.existsSync(path.join(root, "package.json")));
  assert.ok(fs.existsSync(path.join(root, "src/index.js")));
  assert.ok(fs.existsSync(path.join(root, "tests/basic.test.js")));

  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8")
  ) as {
    readonly name?: string;
    readonly scripts?: Record<string, string>;
  };

  assert.equal(typeof pkg.name, "string");
  assert.ok(pkg.scripts);
});
