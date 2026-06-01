#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("node:fs");
const cp = require("node:child_process");

function clearElectronRequireCache() {
  for (const id of ["electron", "electron/index.js"]) {
    try {
      delete require.cache[require.resolve(id)];
    } catch {
      // ignore
    }
  }
}

function resolveElectronBinary() {
  clearElectronRequireCache();
  const electron = require("electron");

  if (typeof electron !== "string" || electron.length === 0) {
    throw new Error("electron package did not resolve to a binary path");
  }

  if (!fs.existsSync(electron)) {
    throw new Error(`electron binary path does not exist: ${electron}`);
  }

  return electron;
}

function assertElectronRuntime() {
  const electron = resolveElectronBinary();
  cp.execFileSync(electron, ["--version"], { stdio: "ignore" });
  return electron;
}

function repairElectronRuntime() {
  const env = {
    ...process.env,
    ELECTRON_SKIP_BINARY_DOWNLOAD: "",
    npm_config_ignore_scripts: "false"
  };

  try {
    const installScript = require.resolve("electron/install.js");
    cp.execFileSync(process.execPath, [installScript], { stdio: "inherit", env });
    return;
  } catch (error) {
    console.warn(
      `[adjutorix-app] electron_install_script_repair_failed: ${
        error && error.message ? error.message : String(error)
      }`
    );
  }

  cp.execFileSync("pnpm", ["rebuild", "electron"], { stdio: "inherit", env });
}

try {
  const electron = assertElectronRuntime();
  console.log(`[adjutorix-app] electron-runtime-ok ${electron}`);
} catch (firstError) {
  if (!process.env.CI) {
    console.error(
      `[adjutorix-app] electron_runtime_unavailable: ${
        firstError && firstError.message ? firstError.message : String(firstError)
      }`
    );
    process.exit(1);
  }

  console.warn("[adjutorix-app] electron_runtime_unavailable_ci_repairing=true");
  repairElectronRuntime();

  try {
    const electron = assertElectronRuntime();
    console.log(`[adjutorix-app] electron-runtime-ok-after-repair ${electron}`);
  } catch (secondError) {
    console.error(
      `[adjutorix-app] electron_runtime_unavailable_after_repair: ${
        secondError && secondError.message ? secondError.message : String(secondError)
      }`
    );
    process.exit(1);
  }
}
