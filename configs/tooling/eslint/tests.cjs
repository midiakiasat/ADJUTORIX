const base = require("./base.cjs");

/**
 * ADJUTORIX test ESLint configuration
 *
 * Specialization goals:
 * - make tests expressive enough to mock, simulate, and stress governed boundaries without turning into an untyped free-for-all
 * - preserve trust-boundary realism: tests may model privileged surfaces, but should not normalize bypass patterns as ordinary practice
 * - tighten async expectations, assertion hygiene, and fixture clarity so replay/verify/smoke failures remain authoritative rather than flaky
 * - centralize test-specific relaxations here instead of scattering ad hoc disables across the repository
 */

module.exports = {
  ...base,
  env: {
    ...(base.env ?? {}),
    node: true,
    browser: true,
  },
  parserOptions: {
    ...(base.parserOptions ?? {}),
    tsconfigRootDir: process.cwd(),
    project: true,
  },
  ignorePatterns: [
    ...(base.ignorePatterns ?? []),
    "**/dist/**",
    "**/build/**",
    "**/out/**",
    "**/coverage/**",
    "**/.nyc_output/**",
    "**/fixtures/**/generated/**",
  ],
  rules: {
    ...(base.rules ?? {}),

    /**
     * Tests need controlled flexibility, but still should not degrade into ambient chaos.
     */
    "no-console": "off",
    "no-alert": "off",
    "max-lines": "off",
    "max-lines-per-function": "off",
    "max-params": "off",

    /**
     * Relax selected strict-typing rules for mocks/fixtures while keeping async and import discipline.
     */
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-non-null-assertion": "off",
    "@typescript-eslint/no-unsafe-assignment": "off",
    "@typescript-eslint/no-unsafe-argument": "off",
    "@typescript-eslint/no-unsafe-call": "off",
    "@typescript-eslint/no-unsafe-member-access": "off",
    "@typescript-eslint/no-unsafe-return": "off",
    "@typescript-eslint/unbound-method": "off",
    "@typescript-eslint/explicit-function-return-type": [
      "error",
      {
        allowExpressions: true,
        allowTypedFunctionExpressions: true,
        allowHigherOrderFunctions: true,
      },
    ],
    "@typescript-eslint/no-floating-promises": [
      "error",
      {
        ignoreIIFE: false,
        ignoreVoid: false,
      },
    ],
    "@typescript-eslint/no-misused-promises": [
      "error",
      {
        checksConditionals: true,
        checksSpreads: true,
        checksVoidReturn: {
          arguments: true,
          attributes: false,
          inheritedMethods: true,
          properties: true,
          returns: true,
          variables: true,
        },
      },
    ],
    "@typescript-eslint/promise-function-async": [
      "error",
      {
        allowAny: false,
        checkArrowFunctions: true,
        checkFunctionDeclarations: true,
        checkFunctionExpressions: true,
        checkMethodDeclarations: true,
      },
    ],
    "@typescript-eslint/return-await": ["error", "in-try-catch"],

    /**
     * Tests should still preserve import and layering clarity.
     */
    "import/no-default-export": "off",
    "import/no-extraneous-dependencies": [
      "error",
      {
        devDependencies: true,
        optionalDependencies: false,
        peerDependencies: true,
      },
    ],
    "import/no-cycle": ["warn", { ignoreExternal: true, maxDepth: 20 }],

    /**
     * Async/promise realism matters more than terseness in authoritative tests.
     */
    "promise/prefer-await-to-then": "error",
    "promise/no-promise-in-callback": "error",
    "promise/no-nesting": "warn",
    "promise/catch-or-return": [
      "error",
      {
        allowFinally: true,
        terminationMethod: ["catch", "finally"],
      },
    ],

    /**
     * Guard against normalized bypass patterns even in tests.
     */
    "no-restricted-globals": [
      "error",
      {
        name: "require",
        message: "Tests should prefer explicit imports unless exercising a CommonJS boundary intentionally in a dedicated fixture.",
      },
    ],
    "no-restricted-properties": [
      "error",
      {
        object: "window",
        property: "require",
        message: "Tests must not normalize window.require usage outside explicit boundary fixtures.",
      },
      {
        object: "window",
        property: "fetch",
        message: "Tests should mock governed runtime/preload request surfaces rather than rely on raw window.fetch.",
      },
      {
        object: "globalThis",
        property: "fetch",
        message: "Tests should mock governed runtime/preload request surfaces rather than rely on raw fetch.",
      },
      {
        object: "localStorage",
        property: "setItem",
        message: "Tests should prefer governed settings/workspace APIs over raw localStorage mutation unless persistence behavior itself is the subject under test.",
      },
      {
        object: "sessionStorage",
        property: "setItem",
        message: "Tests should prefer governed settings/workspace APIs over raw sessionStorage mutation unless persistence behavior itself is the subject under test.",
      },
    ],
    "no-restricted-syntax": [
      "error",
      {
        selector: "CallExpression[callee.name='fetch']",
        message: "Tests should mock governed transport/runtime boundaries instead of calling raw fetch directly.",
      },
      {
        selector: "NewExpression[callee.name='WebSocket']",
        message: "Tests should mock governed transport/runtime boundaries instead of constructing raw WebSocket connections.",
      },
      {
        selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
        message: "Tests must not normalize dangerouslySetInnerHTML in UI fixtures.",
      },
      {
        selector: "CallExpression[callee.object.name='ipcMain'][callee.property.name='on']",
        message: "Tests should prefer request/response IPC surfaces unless explicitly validating event-stream behavior.",
      },
    ],
  },
  overrides: [
    ...(base.overrides ?? []),

    /**
     * Renderer tests: browser-like, but still governed.
     */
    {
      files: [
        "packages/adjutorix-app/tests/renderer/**/*.{ts,tsx}",
        "packages/adjutorix-app/src/renderer/**/*.test.{ts,tsx}",
        "**/tests/renderer/**/*.{ts,tsx}",
        "**/renderer/**/*.test.{ts,tsx}",
      ],
      env: {
        browser: true,
        node: true,
      },
      rules: {
        "react/no-array-index-key": "off",
        "react/no-unstable-nested-components": [
          "error",
          {
            allowAsProps: true,
          },
        ],
        "no-restricted-imports": [
          "error",
          {
            paths: [
              {
                name: "electron",
                message: "Renderer tests should mock the preload/runtime bridge, not import electron directly.",
              },
            ],
            patterns: [
              {
                group: ["node:*"],
                message: "Renderer tests should not normalize raw Node authority imports.",
              },
            ],
          },
        ],
      },
    },

    /**
     * Main/preload tests: may inspect authority boundaries, but should not legitimize unsafe production shortcuts.
     */
    {
      files: [
        "packages/adjutorix-app/tests/main/**/*.{ts,tsx}",
        "packages/adjutorix-app/tests/preload/**/*.{ts,tsx}",
        "**/tests/main/**/*.{ts,tsx}",
        "**/tests/preload/**/*.{ts,tsx}",
      ],
      env: {
        node: true,
        browser: false,
      },
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: [
              {
                name: "react",
                message: "Main/preload tests should not rely on renderer runtime imports unless explicitly integration-scoped.",
              },
            ],
          },
        ],
        "no-restricted-syntax": [
          "error",
          {
            selector: "CallExpression[callee.object.name='child_process'][callee.property.name=/^(exec|execSync|spawnSync)$/]",
            message: "Main/preload tests should prefer explicit command-runner/service seams over raw child_process shortcuts.",
          },
        ],
      },
    },

    /**
     * Smoke tests: highest integration value, so keep async/state discipline tight even if mocking rules are looser.
     */
    {
      files: [
        "packages/adjutorix-app/tests/smoke/**/*.{ts,tsx}",
        "**/tests/smoke/**/*.{ts,tsx}",
      ],
      env: {
        node: true,
        browser: true,
      },
      rules: {
        "@typescript-eslint/no-floating-promises": [
          "error",
          {
            ignoreIIFE: false,
            ignoreVoid: false,
          },
        ],
        "promise/prefer-await-to-then": "error",
        "no-restricted-syntax": [
          "error",
          {
            selector: "CallExpression[callee.name='setTimeout']",
            message: "Smoke tests should avoid timing hacks; prefer explicit waits tied to authoritative state.",
          },
          {
            selector: "CallExpression[callee.name='setInterval']",
            message: "Smoke tests should avoid polling loops unless encapsulated in a dedicated wait helper.",
          },
        ],
      },
    },

    /**
     * CLI Python-adjacent contract tests and repository contract suites.
     */
    {
      files: [
        "packages/adjutorix-cli/tests/**/*.{js,ts,tsx}",
        "tests/contracts/**/*.{ts,tsx,js}",
        "tests/invariants/**/*.{ts,tsx,js}",
        "tests/replay/**/*.{ts,tsx,js}",
        "tests/recovery/**/*.{ts,tsx,js}",
      ],
      env: {
        node: true,
        browser: false,
      },
      rules: {
        "no-restricted-syntax": [
          "error",
          {
            selector: "CallExpression[callee.name='fetch']",
            message: "Contract/invariant tests should prefer explicit client seams over ambient fetch.",
          },
        ],
      },
    },

    /**
     * JSON/fixture helpers and config-bearing tests.
     */
    {
      files: [
        "**/tests/**/*.{js,cjs,mjs}",
      ],
      parser: "espree",
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
      rules: {
        "@typescript-eslint/explicit-function-return-type": "off",
        "@typescript-eslint/no-var-requires": "off",
        "@typescript-eslint/no-require-imports": "off",
      },
    },
  ],
};
