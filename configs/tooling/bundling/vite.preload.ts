import path from "node:path";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin, type UserConfig } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");
const appRoot = path.resolve(repoRoot, "packages/adjutorix-app");
const preloadRoot = path.resolve(appRoot, "src/preload");
const mainRoot = path.resolve(appRoot, "src/main");
const rendererRoot = path.resolve(appRoot, "src/renderer");
const sharedRoot = path.resolve(appRoot, "src/shared");
const outDir = path.resolve(appRoot, "dist/preload");

const electronBuiltins = ["electron"] as const;
const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);
const explicitExternal = new Set<string>([
  ...electronBuiltins,
  ...nodeBuiltins,
]);

function assertPreloadBoundaryPlugin(): Plugin {
  return {
    name: "adjutorix-preload-boundary",
    enforce: "pre",
    resolveId(source, importer) {
      const normalized = source.trim();
      const importerRel = importer ? path.relative(repoRoot, importer) : "<entry>";

      if (
        normalized.includes("/src/renderer/") ||
        normalized.startsWith("@app-renderer/") ||
        normalized === "react" ||
        normalized === "react-dom"
      ) {
        throw new Error(
          [
            `Preload attempted to import renderer/UI dependency ${JSON.stringify(source)}.`,
            `Importer: ${importerRel}`,
            "Preload must remain a membrane between main authority and renderer requests, not a UI runtime.",
          ].join(" "),
        );
      }

      if (
        normalized.includes("/tests/") ||
        normalized.endsWith(".test.ts") ||
        normalized.endsWith(".test.tsx") ||
        normalized.endsWith(".spec.ts") ||
        normalized.endsWith(".spec.tsx")
      ) {
        throw new Error(
          [
            `Preload attempted to import test-only module ${JSON.stringify(source)}.`,
            `Importer: ${importerRel}`,
            "Production preload bundle must never depend on test surfaces.",
          ].join(" "),
        );
      }

      return null;
    },
  };
}

function assertSingleGovernedSurfacePlugin(): Plugin {
  return {
    name: "adjutorix-preload-governed-surface",
    generateBundle(_, bundle) {
      const jsEntries = Object.values(bundle).filter(
        (item) => item.type === "chunk" && item.isEntry,
      );

      if (jsEntries.length !== 1) {
        throw new Error(
          `Preload bundle must emit exactly one entry chunk, found ${jsEntries.length}.`,
        );
      }

      const [entry] = jsEntries;
      if (!entry.fileName.endsWith("preload.js")) {
        throw new Error(
          `Preload entry filename must be preload.js for deterministic Electron wiring, found ${entry.fileName}.`,
        );
      }
    },
  };
}

function assertExternalizationPolicyPlugin(): Plugin {
  return {
    name: "adjutorix-preload-externalization-policy",
    resolveId(source) {
      const normalized = source.trim();
      if (explicitExternal.has(normalized)) {
        return { id: normalized, external: true };
      }
      return null;
    },
  };
}

function stablePreloadChunkNamesPlugin(): Plugin {
  return {
    name: "adjutorix-preload-stable-chunks",
    renderChunk(code, chunk) {
      if (chunk.isEntry && !chunk.name.startsWith("preload")) {
        chunk.name = "preload";
      }
      return { code, map: null };
    },
  };
}

export default defineConfig(({ mode }): UserConfig => {
  const isProduction = mode === "production";

  return {
    root: appRoot,
    clearScreen: false,
    resolve: {
      alias: {
        "@": repoRoot,
        "@app-main": mainRoot,
        "@app-preload": preloadRoot,
        "@app-shared": sharedRoot,
      },
      conditions: ["electron", "main", "node", "import", "module", "default"],
      extensions: [".ts", ".tsx", ".mjs", ".js", ".json"],
    },
    define: {
      __ADJUTORIX_PRELOAD_BUILD__: JSON.stringify(true),
      __ADJUTORIX_PRELOAD_MODE__: JSON.stringify(mode),
      __ADJUTORIX_RENDERER_ROOT__: JSON.stringify(rendererRoot),
    },
    plugins: [
      assertPreloadBoundaryPlugin(),
      assertExternalizationPolicyPlugin(),
      assertSingleGovernedSurfacePlugin(),
      stablePreloadChunkNamesPlugin(),
    ],
    build: {
      target: "node18",
      outDir,
      emptyOutDir: true,
      sourcemap: true,
      minify: isProduction,
      reportCompressedSize: false,
      lib: {
        entry: path.resolve(preloadRoot, "index.ts"),
        formats: ["cjs"],
        fileName: () => "preload.js",
      },
      rollupOptions: {
        external(source) {
          if (explicitExternal.has(source)) {
            return true;
          }

          if (source.startsWith("node:")) {
            return true;
          }

          return false;
        },
        output: {
          format: "cjs",
          entryFileNames: "preload.js",
          chunkFileNames: "chunks/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
          exports: "named",
          interop: "auto",
          generatedCode: {
            constBindings: true,
            objectShorthand: true,
          },
        },
        treeshake: {
          moduleSideEffects: "no-external",
          propertyReadSideEffects: false,
          tryCatchDeoptimization: false,
        },
      },
      commonjsOptions: {
        include: [],
      },
    },
    esbuild: {
      target: "node18",
      platform: "node",
      format: "cjs",
      legalComments: "none",
    },
    optimizeDeps: {
      disabled: true,
    },
  };
});
