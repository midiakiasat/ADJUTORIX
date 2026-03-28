const path = require("node:path");

const base = require("./base.cjs");
const renderer = require("./renderer.cjs");
const main = require("./main.cjs");

/**
 * ADJUTORIX ESLint orchestrator configuration
 *
 * Purpose:
 * - act as the single entrypoint that routes every file in the repository to the correct lint authority profile
 * - prevent silent drift where renderer, main, preload, CLI, tests, configs, and CI scripts are linted under the wrong assumptions
 * - keep package-level invocation simple while preserving high-fidelity per-surface policy
 * - provide one compositional config that can be consumed by flat package configs or legacy .eslintrc extension points
 *
 * Design:
 * - start from the base repository contract
 * - selectively override with renderer/main specializations in their exact authority zones
 * - add orchestration-specific zones for preload, CLI, tests, configs, and CI/hooks scripts
 * - reject ambiguous overlaps by ordering overrides from most general to most specific only where that improves policy fidelity
 */

function mergeRules(...ruleSets) {
  return Object.assign({}, ...ruleSets.filter(Boolean));
}

function mergeArrays(...arrays) {
  return arrays.filter(Array.isArray).flat();
}

function makeOverride({
  files,
  excludedFiles,
  env,
  extendsList,
  rules,
  parser,
  parserOptions,
  plugins,
  settings,
}) {
  const override = {
    files,
  };

  if (excludedFiles) {
    override.excludedFiles = excludedFiles;
  }
  if (env) {
    override.env = env;
  }
  if (extendsList) {
    override.extends = extendsList;
  }
  if (rules) {
    override.rules = rules;
  }
  if (parser) {
    override.parser = parser;
  }
  if (parserOptions) {
    override.parserOptions = parserOptions;
  }
  if (plugins) {
    override.plugins = plugins;
  }
  if (settings) {
    override.settings = settings;
  }

  return override;
}

const commonTsParserOptions = {
  ...(base.parserOptions ?? {}),
  tsconfigRootDir: process.cwd(),
  project: true,
};

const repositoryIgnorePatterns = mergeArrays(base.ignorePatterns, [
  "**/.git/**",
  "**/.cache/**",
  "**/.tmp/**",
  "**/tmp/**",
  "**/artifacts/**",
  "**/*.min.js",
]);

const sharedSettings = {
  ...(base.settings ?? {}),
};

module.exports = {
  root: true,
  env: {
    ...(base.env ?? {}),
    es2023: true,
  },
  parser: base.parser,
  parserOptions: commonTsParserOptions,
  plugins: mergeArrays(base.plugins, ["n"]),
  settings: sharedSettings,
  extends: mergeArrays(base.extends),
  ignorePatterns: repositoryIgnorePatterns,
  reportUnusedDisableDirectives: true,
  rules: mergeRules(base.rules, {
    /**
     * Repository-wide orchestration sanity.
     * These rules are intentionally mild here; authority-specific tightening lives in the targeted overrides below.
     */
    "no-restricted-imports": "off",
    "no-restricted-properties": "off",
    "no-restricted-syntax": "off",
  }),
  overrides: [
    /**
     * 1) Renderer authority surface.
     * Use the stricter renderer config as the primary trust boundary for all UI/request-layer files.
     */
    makeOverride({
      files: [
        "packages/adjutorix-app/src/renderer/**/*.{ts,tsx,js,jsx}",
        "src/renderer/**/*.{ts,tsx,js,jsx}",
      ],
      env: {
        ...(renderer.env ?? {}),
        browser: true,
        node: false,
      },
      parser: renderer.parser,
      parserOptions: renderer.parserOptions,
      plugins: renderer.plugins,
      settings: renderer.settings,
      extendsList: renderer.extends,
      rules: renderer.rules,
    }),

    /**
     * 2) Main-process authority surface.
     * Stronger process/IPC/file/shell/network discipline than generic Node code.
     */
    makeOverride({
      files: [
        "packages/adjutorix-app/src/main/**/*.{ts,tsx,js,jsx}",
        "src/main/**/*.{ts,tsx,js,jsx}",
      ],
      env: {
        ...(main.env ?? {}),
        node: true,
        browser: false,
      },
      parser: main.parser,
      parserOptions: main.parserOptions,
      plugins: main.plugins,
      settings: main.settings,
      extendsList: main.extends,
      rules: main.rules,
    }),

    /**
     * 3) Preload bridge.
     * This is neither ordinary renderer nor ordinary main. It is a membrane and must remain very small and explicit.
     */
    makeOverride({
      files: [
        "packages/adjutorix-app/src/preload/**/*.{ts,tsx,js,jsx}",
        "src/preload/**/*.{ts,tsx,js,jsx}",
      ],
      env: {
        node: true,
        browser: false,
      },
      rules: mergeRules(base.rules, main.rules, {
        "no-console": "off",
        "@typescript-eslint/no-explicit-any": "error",
        "@typescript-eslint/explicit-function-return-type": [
          "error",
          {
            allowExpressions: false,
            allowTypedFunctionExpressions: true,
            allowHigherOrderFunctions: true,
          },
        ],
        "max-lines": [
          "warn",
          {
            max: 220,
            skipBlankLines: true,
            skipComments: true,
          },
        ],
        "max-lines-per-function": [
          "warn",
          {
            max: 70,
            skipBlankLines: true,
            skipComments: true,
            IIFEs: false,
          },
        ],
        "no-restricted-imports": [
          "error",
          {
            paths: [
              {
                name: "react",
                message: "Preload must not depend on React or renderer runtime.",
              },
              {
                name: "react-dom",
                message: "Preload must not depend on React or renderer runtime.",
              },
            ],
            patterns: [
              {
                group: ["**/src/renderer/**", "@/renderer/**"],
                message: "Preload must not import renderer modules directly.",
              },
            ],
          },
        ],
        "no-restricted-syntax": [
          "error",
          {
            selector: "CallExpression[callee.object.name='contextBridge'][callee.property.name='exposeInMainWorld'] ObjectExpression > Property[key.name!='adjutorix']",
            message: "Preload should expose a single governed API root rather than multiple ambient globals.",
          },
          {
            selector: "CallExpression[callee.object.name='ipcRenderer'][callee.property.name='send']",
            message: "Preload should prefer invoke/handle request-response surfaces over fire-and-forget send for governed actions.",
          },
        ],
      }),
    }),

    /**
     * 4) CLI Python-adjacent JS/TS glue, scripts, and toolchain files.
     * These are Node-oriented, but should not silently import app runtime surfaces.
     */
    makeOverride({
      files: [
        "configs/**/*.{js,cjs,mjs,ts}",
        "scripts/**/*.{js,cjs,mjs,ts}",
        "tools/**/*.{js,cjs,mjs,ts}",
        "packages/**/eslint.config.{js,cjs,mjs,ts}",
        "packages/**/vitest.config.{js,cjs,mjs,ts}",
        "packages/**/vite.config.{js,cjs,mjs,ts}",
        "packages/**/playwright.config.{js,cjs,mjs,ts}",
      ],
      env: {
        node: true,
        browser: false,
      },
      rules: mergeRules(base.rules, {
        "no-console": "off",
        "import/no-default-export": "off",
        "@typescript-eslint/no-var-requires": "off",
        "@typescript-eslint/no-require-imports": "off",
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: ["**/src/renderer/**"],
                message: "Tooling/config code must not depend on renderer runtime modules.",
              },
            ],
          },
        ],
      }),
    }),

    /**
     * 5) Repository contract tests and smoke tests.
     * Keep them permissive enough to mock aggressively, but still anchored to trust boundaries.
     */
    makeOverride({
      files: [
        "tests/**/*.{ts,tsx,js,jsx}",
        "packages/**/tests/**/*.{ts,tsx,js,jsx}",
        "**/*.test.{ts,tsx,js,jsx}",
        "**/*.spec.{ts,tsx,js,jsx}",
      ],
      env: {
        node: true,
        browser: true,
      },
      rules: mergeRules(base.rules, {
        "@typescript-eslint/no-explicit-any": "off",
        "@typescript-eslint/no-non-null-assertion": "off",
        "@typescript-eslint/no-unsafe-assignment": "off",
        "@typescript-eslint/no-unsafe-argument": "off",
        "@typescript-eslint/no-unsafe-call": "off",
        "@typescript-eslint/no-unsafe-member-access": "off",
        "@typescript-eslint/no-unsafe-return": "off",
        "@typescript-eslint/unbound-method": "off",
        "max-lines": "off",
        "max-lines-per-function": "off",
        "no-console": "off",
        "no-restricted-imports": [
          "error",
          {
            paths: [
              {
                name: "electron",
                message: "Tests should exercise governed entry surfaces rather than normalize direct electron imports in shared helpers.",
              },
            ],
          },
        ],
      }),
    }),

    /**
     * 6) CI and hook shell-adjacent JS glue.
     * These files may coordinate tooling, but must not accidentally look like product runtime code.
     */
    makeOverride({
      files: [
        "configs/ci/**/*.{js,cjs,mjs,ts}",
        "configs/hooks/**/*.{js,cjs,mjs,ts}",
      ],
      env: {
        node: true,
        browser: false,
      },
      rules: mergeRules(base.rules, {
        "no-console": "off",
        "@typescript-eslint/no-explicit-any": "off",
        "import/no-default-export": "off",
      }),
    }),

    /**
     * 7) Package manifests and JSON-bearing config companions.
     * Narrow parser/profile fallback for plain JS manifest helpers.
     */
    makeOverride({
      files: [
        "**/*.cjs",
        "**/*.mjs",
        "**/*.js",
      ],
      excludedFiles: [
        "packages/adjutorix-app/src/renderer/**/*",
        "packages/adjutorix-app/src/main/**/*",
        "packages/adjutorix-app/src/preload/**/*",
        "src/renderer/**/*",
        "src/main/**/*",
        "src/preload/**/*",
      ],
      parser: "espree",
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
      extendsList: [
        "eslint:recommended",
        "plugin:import/recommended",
        "plugin:promise/recommended",
      ],
      rules: {
        "no-console": "off",
        "import/no-default-export": "off",
      },
    }),

    /**
     * Append specialized overrides from base/renderer/main after the broad routing layers,
     * so file-local relaxations remain available where they were intentionally authored.
     */
    ...(base.overrides ?? []),
    ...(renderer.overrides ?? []),
    ...(main.overrides ?? []),
  ],
};
