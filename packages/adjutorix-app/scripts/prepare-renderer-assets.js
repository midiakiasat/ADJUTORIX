import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const assetsDir = path.join(root, "assets");

const requiredFiles = [
  { relativePath: "icon.png", kind: "asset" },
  { relativePath: "icon.icns", kind: "asset" },
  { relativePath: "splash.png", kind: "asset" },
  { relativePath: "fonts/Inter-Regular.woff2", kind: "font" },
  { relativePath: "fonts/Inter-Medium.woff2", kind: "font" },
  { relativePath: "fonts/Inter-SemiBold.woff2", kind: "font" }
];

function assertDirectory(dirPath, label) {
  if (!fs.existsSync(dirPath)) {
    throw new Error(`${label}_not_found:${dirPath}`);
  }
  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    throw new Error(`${label}_not_directory:${dirPath}`);
  }
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label}_not_found:${filePath}`);
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`${label}_not_file:${filePath}`);
  }
  if (stat.size <= 0) {
    throw new Error(`${label}_empty:${filePath}`);
  }
  return stat.size;
}

function toManifestEntry(relativePath, kind) {
  const filePath = path.join(assetsDir, relativePath);
  const size = assertFile(filePath, kind);
  return {
    kind,
    relativePath,
    size
  };
}

function main() {
  assertDirectory(assetsDir, "assets_directory");

  const manifest = requiredFiles.map((entry) =>
    toManifestEntry(entry.relativePath, entry.kind)
  );

  const manifestPath = path.join(assetsDir, "asset-manifest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        assetsDir: "assets",
        files: manifest
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  for (const entry of manifest) {
    console.log(
      `[adjutorix-app] prepare-renderer-assets: verified ${entry.relativePath} (${entry.size} bytes)`
    );
  }

  console.log(
    `[adjutorix-app] prepare-renderer-assets: manifest written to ${manifestPath}`
  );
}

main();
