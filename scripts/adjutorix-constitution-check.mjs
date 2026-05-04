#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const reportFlag = args.indexOf("--report");
const reportPath = reportFlag >= 0 ? args[reportFlag + 1] : ".tmp/adjutorix-constitution-report.json";
const constitutionPath = "configs/adjutorix/constitution.json";

const requiredFields = [
  "id",
  "purpose",
  "patterns",
  "allowedReaders",
  "allowedWriters",
  "repairEligibility",
  "promotionSource",
  "verificationProfile",
  "rollbackProfile",
  "retentionRule",
  "indexingRule",
  "reviewVisibilityRule",
  "mutationDenialRule"
];

function fail(message, detail = {}) {
  console.error(`[constitution] ${message}`);
  if (Object.keys(detail).length) console.error(JSON.stringify(detail, null, 2));
  process.exit(1);
}

function escapeRegex(ch) {
  return ch.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(glob) {
  let out = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    const next = glob[i + 1];

    if (ch === "*") {
      if (next === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
      continue;
    }

    out += escapeRegex(ch);
  }
  out += "$";
  return new RegExp(out);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`cannot parse ${file}`, { error: String(error) });
  }
}

const constitution = readJson(constitutionPath);

if (constitution.schemaVersion !== 1) {
  fail("unsupported or missing schemaVersion", { schemaVersion: constitution.schemaVersion });
}

if (!Array.isArray(constitution.classificationPriority) || constitution.classificationPriority.length === 0) {
  fail("classificationPriority must be a non-empty array");
}

if (!Array.isArray(constitution.strata) || constitution.strata.length === 0) {
  fail("strata must be a non-empty array");
}

const strataById = new Map();
for (const stratum of constitution.strata) {
  for (const field of requiredFields) {
    if (!(field in stratum)) fail(`stratum missing required field: ${field}`, { stratum: stratum.id ?? null });
  }
  if (!Array.isArray(stratum.patterns) || stratum.patterns.length === 0) {
    fail("stratum patterns must be non-empty", { stratum: stratum.id });
  }
  if (strataById.has(stratum.id)) fail("duplicate stratum id", { id: stratum.id });
  strataById.set(stratum.id, {
    ...stratum,
    regexes: stratum.patterns.map((pattern) => ({ pattern, regex: globToRegExp(pattern) }))
  });
}

for (const id of constitution.classificationPriority) {
  if (!strataById.has(id)) fail("classificationPriority references unknown stratum", { id });
}

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean)
  .sort();

function classify(file) {
  for (const id of constitution.classificationPriority) {
    const stratum = strataById.get(id);
    const hit = stratum.regexes.find(({ regex }) => regex.test(file));
    if (hit) return { stratum: id, pattern: hit.pattern };
  }
  return { stratum: "unclassified", pattern: null };
}

const classified = tracked.map((file) => ({ file, ...classify(file) }));
const unclassified = classified.filter((entry) => entry.stratum === "unclassified");
const trackedNonAuthority = classified.filter((entry) => !entry.stratum.startsWith("authority/") && entry.stratum !== "unclassified");

const counts = {};
for (const entry of classified) counts[entry.stratum] = (counts[entry.stratum] ?? 0) + 1;

const report = {
  ok: unclassified.length === 0,
  constitutionPath,
  trackedFileCount: tracked.length,
  counts,
  unclassified,
  trackedNonAuthority,
  generatedAt: new Date().toISOString()
};

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(JSON.stringify({
  ok: report.ok,
  trackedFileCount: report.trackedFileCount,
  counts: report.counts,
  unclassifiedCount: report.unclassified.length,
  trackedNonAuthorityCount: report.trackedNonAuthority.length,
  reportPath
}, null, 2));

if (unclassified.length > 0) {
  console.error("[constitution] unclassified tracked paths exist; refine constitution before proceeding");
  process.exit(2);
}
