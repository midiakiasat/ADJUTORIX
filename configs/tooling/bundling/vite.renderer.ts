import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin, type UserConfig } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");
const appRoot = path.resolve(repoRoot, "packages/adjutorix-app");
const rendererRoot = path.resolve(appRoot, "src/renderer");
const sharedRoot = path.resolve(appRoot, "src/shared");
const typesRoot = path.resolve(appRoot, "src/types");
const outDir = path.resolve(appRoot, "dist/renderer");

function governedRendererBoundaryPlugin(): Plugin {
  const forbiddenFragments = [
    "node:",
    "electron",
    "child_process",
    "fs",
    "fs/promises",
    "net",
    "tls",
    "dgram",
    "worker_threads",
  ];

  return {
    name: "adjutorix-governed-renderer-boundary",
    enforce: "pre",
    resolveId(source, importer) {
      const normalized = source.trim();
      const matched = forbiddenFragments.find(
        (fragment) => normalized === fragment || normalized.startsWith(`${fragment}/`),
      );

      if (matched) {
        const from = importer ? path.relative(repoRoot, importer) : "<entry>";
        throw new Error(
          [
            `Renderer attempted to import forbidden authority module ${JSON.stringify(source)}.`,
            `Importer: ${from}`,
            "Renderer code must depend on governed preload/runtime surfaces, not raw Node/Electron authority.",
          ].join(" "),
        );
      }

      return null;
    },
  };
}

function governedEnvironmentPlugin(allowedEnvKeys: readonly string[]): Plugin {
  return {
    name: "adjutorix-governed-renderer-env",
    configResolved(config) {
      const exposed = Object.keys(config.env).filter((key) => key.startsWith("VITE_"));
      const unexpected = exposed.filter((key) => !allowedEnvKeys.includes(key));
      if (unexpected.length > 0) {
        throw new Error(
          `Unexpected renderer environment exposure detected: ${unexpected.join(", ")}. ` +
            `Allowed keys: ${allowedEnvKeys.join(", ")}`,
        );
      }
    },
  };
}

function stableChunkingPlugin(): Plugin {
  return {
    name: "adjutorix-stable-renderer-chunking",
    generateBundle(_, bundle) {
      const fileNames = Object.keys(bundle).sort();
      const htmlEntries = fileNames.filter((name) => name.endsWith(".html"));
      if (htmlEntries.length !== 1) {
        throw new Error(
          `Renderer build must emit exactly one HTML entry. Found ${htmlEntries.length}: ${htmlEntries.join(", ")}`,
        );
      }

      const jsAssets = fileNames.filter((name) => name.endsWith(".js"));
      if (jsAssets.length === 0) {
        throw new Error("Renderer build emitted no JavaScript assets.");
      }
    },
  };
}

function manualChunks(id: string): string | undefined {
  const normalized = id.split(path.sep).join("/");

  if (normalized.includes("node_modules/react") || normalized.includes("node_modules/react-dom")) {
    return "react-vendor";
  }

  if (normalized.includes("node_modules") && normalized.includes("/@radix-ui/")) {
    return "ui-vendor";
  }

  if (normalized.includes("node_modules") && normalized.includes("/monaco-editor/")) {
    return "monaco-vendor";
  }

  if (normalized.includes("node_modules") && normalized.includes("/zod/")) {
    return "schema-vendor";
  }

  if (normalized.includes("node_modules")) {
    return "vendor";
  }

  if (normalized.includes("/src/renderer/routes/")) {
    return "routes";
  }

  if (normalized.includes("/src/renderer/components/")) {
    return "components";
  }

  if (normalized.includes("/src/shared/")) {
    return "shared";
  }

  return undefined;
}

export default defineConfig(({ mode }): UserConfig => {
  const env = loadEnv(mode, repoRoot, "VITE_");

  const allowedEnvKeys = [
    "VITE_APP_CHANNEL",
    "VITE_APP_VERSION",
    "VITE_ENABLE_DEVTOOLS",
    "VITE_ENABLE_MOCK_RUNTIME",
  ] as const;

  const defineEnv = Object.fromEntries(
    allowedEnvKeys.map((key) => [
      `import.meta.env.${key}`,
      JSON.stringify(env[key] ?? ""),
    ]),
  );

  return {
    root: appRoot,
    envDir: repoRoot,
    publicDir: path.resolve(appRoot, "public"),
    appType: "spa",
    clearScreen: false,
    define: {
      __ADJUTORIX_RENDERER_BUILD__: JSON.stringify(true),
      __ADJUTORIX_RENDERER_MODE__: JSON.stringify(mode),
      ...defineEnv,
    },
    resolve: {
      alias: {
        "@": repoRoot,
        "@app-renderer": rendererRoot,
        "@app-shared": sharedRoot,
        "@app-types": typesRoot,
      },
      conditions: ["browser", "import", "module", "default"],
      dedupe: ["react", "react-dom"],
      extensions: [".tsx", ".ts", ".jsx", ".js", ".mjs", ".json"],
    },
    plugins: [
      governedRendererBoundaryPlugin(),
      governedEnvironmentPlugin(allowedEnvKeys),
      react({
        jsxRuntime: "automatic",
        include: /\.[jt]sx?$/,
        babel: {
          parserOpts: {
            plugins: ["jsx", "typescript"],
          },
        },
      }),
      stableChunkingPlugin(),
    ],
    css: {
      devSourcemap: true,
    },
    esbuild: {
      legalComments: "none",
      jsx: "automatic",
      target: "es2022",
    },
    server: {
      host: "127.0.0.1",
      port: 4173,
      strictPort: true,
      open: false,
      cors: false,
      fs: {
        strict: true,
        allow: [repoRoot],
      },
    },
    preview: {
      host: "127.0.0.1",
      port: 4174,
      strictPort: true,
      open: false,
    },
    build: {
      target: "es2022",
      outDir,
      assetsDir: "assets",
      sourcemap: true,
      manifest: true,
      emptyOutDir: true,
      modulePreload: {
        polyfill: false,
      },
      cssCodeSplit: true,
      reportCompressedSize: false,
      chunkSizeWarningLimit: 800,
      rollupOptions: {
        input: path.resolve(rendererRoot, "index.html"),
        output: {
          entryFileNames: "assets/[name]-[hash].js",
          chunkFileNames: "assets/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
          manualChunks,
        },
        treeshake: {
          moduleSideEffects: "no-external",
          propertyReadSideEffects: false,
          tryCatchDeoptimization: false,
        },
      },
    },
    optimizeDeps: {
      include: ["react", "react-dom"],
      exclude: ["electron"],
      esbuildOptions: {
        target: "es2022",
      },
    },
  };
});
