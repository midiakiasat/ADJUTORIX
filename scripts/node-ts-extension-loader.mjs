import { existsSync } from "node:fs";
import { dirname, extname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];
const INDEXES = ["index.ts", "index.tsx", "index.mts", "index.js", "index.mjs"];

function parentDir(parentURL) {
  if (parentURL && parentURL.startsWith("file:")) {
    return dirname(fileURLToPath(parentURL));
  }
  return process.cwd();
}

function candidatesFor(base) {
  const out = [];

  for (const ext of EXTENSIONS) out.push(`${base}${ext}`);

  const existingExt = extname(base);
  if (existingExt) {
    const withoutExt = base.slice(0, -existingExt.length);
    for (const ext of EXTENSIONS) out.push(`${withoutExt}${ext}`);
  }

  for (const index of INDEXES) out.push(resolvePath(base, index));
  return [...new Set(out)];
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      error?.code !== "ERR_MODULE_NOT_FOUND" &&
      error?.code !== "ERR_UNSUPPORTED_DIR_IMPORT"
    ) {
      throw error;
    }

    if (
      !specifier.startsWith(".") &&
      !specifier.startsWith("/") &&
      !specifier.startsWith("file:")
    ) {
      throw error;
    }

    const base =
      specifier.startsWith("file:")
        ? fileURLToPath(specifier)
        : specifier.startsWith("/")
          ? specifier
          : resolvePath(parentDir(context.parentURL), specifier);

    for (const candidate of candidatesFor(base)) {
      if (existsSync(candidate)) {
        return nextResolve(pathToFileURL(candidate).href, context);
      }
    }

    throw error;
  }
}
