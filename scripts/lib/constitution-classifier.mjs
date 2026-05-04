#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globToRegex(glob) {
  let out = "^";

  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    const next = glob[i + 1];

    if (ch === "*" && next === "*") {
      const after = glob[i + 2];
      if (after === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
      continue;
    }

    if (ch === "*") {
      out += "[^/]*";
      continue;
    }

    if (ch === "?") {
      out += "[^/]";
      continue;
    }

    out += escapeRegex(ch);
  }

  out += "$";
  return new RegExp(out);
}

export function loadConstitution(rootDir) {
  const constitutionPath = path.join(rootDir, "configs", "adjutorix", "constitution.json");
  return JSON.parse(fs.readFileSync(constitutionPath, "utf8"));
}

export function classifyPath(rootDir, inputPath) {
  const input = String(inputPath || "").replace(/\\/g, "/").replace(/^\.\//, "");
  const constitution = loadConstitution(rootDir);

  for (const stratum of constitution.strata || []) {
    for (const pattern of stratum.patterns || []) {
      if (globToRegex(String(pattern)).test(input)) {
        return String(stratum.id);
      }
    }
  }

  return "unclassified";
}

function main(argv) {
  const rootDir = argv[2] ? path.resolve(argv[2]) : process.cwd();
  const relPath = argv[3] || "";
  process.stdout.write(classifyPath(rootDir, relPath));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = path.resolve(fileURLToPath(import.meta.url));

if (invokedPath === modulePath) {
  main(process.argv);
}
