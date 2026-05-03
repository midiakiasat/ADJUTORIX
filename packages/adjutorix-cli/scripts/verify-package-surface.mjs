import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const pkgPath = path.join(root, "package.json");

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!fs.existsSync(pkgPath)) fail("package.json missing");

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

if (!pkg.name || !String(pkg.name).includes("adjutorix")) {
  fail("package identity must include adjutorix");
}

if (!pkg.version) fail("package version missing");

if (!pkg.scripts || !pkg.scripts.test || /no test specified/i.test(String(pkg.scripts.test))) {
  fail("package test script is missing or placeholder");
}

for (const field of ["main", "module", "types", "bin"]) {
  const value = pkg[field];
  if (!value) continue;

  const entries =
    typeof value === "string"
      ? [value]
      : typeof value === "object"
        ? Object.values(value)
        : [];

  for (const entry of entries) {
    const rel = String(entry);
    const target = path.join(root, rel);
    const sourceFallback = target
      .replace(/\/dist\//g, "/src/")
      .replace(/\.d\.ts$/, ".ts")
      .replace(/\.js$/, ".ts");

    if (!fs.existsSync(target) && !fs.existsSync(sourceFallback)) {
      fail(`declared ${field} target is missing: ${rel}`);
    }
  }
}

console.log(`${pkg.name}-surface-ok`);
