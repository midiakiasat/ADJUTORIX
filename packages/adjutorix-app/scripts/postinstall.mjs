import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname);
const candidateScripts = [
  resolve(root, "prepare-renderer-assets.js"),
  resolve(root, "prepare-renderer-assets.mjs")
];

const target = candidateScripts.find((file) => existsSync(file));

if (!target) {
  console.log("[adjutorix-app] postinstall: no renderer asset preparation script found; skipping.");
  process.exit(0);
}

const result = spawnSync(process.execPath, [target], {
  cwd: root,
  stdio: "inherit",
  env: process.env
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 0);
