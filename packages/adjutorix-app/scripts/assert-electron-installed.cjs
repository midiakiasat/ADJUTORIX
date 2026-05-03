const fs = require("node:fs");

function fail(message) {
  console.error(`[adjutorix-app] ${message}`);
  process.exit(1);
}

let electronPath;
try {
  electronPath = require("electron");
} catch (error) {
  fail(`electron_runtime_unavailable: ${error.message}`);
}

if (typeof electronPath !== "string" || electronPath.length === 0) {
  fail("electron_runtime_unavailable: require('electron') did not return an executable path");
}

if (!fs.existsSync(electronPath)) {
  fail(`electron_runtime_missing_binary: ${electronPath}`);
}

console.log(`[adjutorix-app] electron runtime ready: ${electronPath}`);
