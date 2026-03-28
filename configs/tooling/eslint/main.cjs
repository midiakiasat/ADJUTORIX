const base = require("./base.cjs");

/**
 * ADJUTORIX main-process ESLint configuration
 *
 * Specialization goals:
 * - treat the Electron main process as an authority-bearing boundary with stricter rules than generic Node code
 * - keep IPC, workspace mutation, shell/process launch, and agent connectivity explicit, typed, and reviewable
 * - prevent convenience shortcuts that hide consequential side effects behind weak typing or ambient globals
 * - preserve deterministic, governable orchestration across app lifecycle, services, and IPC handlers
 */

module.exports = {
  ...base,
  env: {
    ...base.env,
    browser: false,
    node: true,
  },
  parserOptions: {
    ...base.parserOptions,
    tsconfigRootDir: process.cwd(),
    project: true,
  },
  ignorePatterns: [
    ...(base.ignorePatterns ?? []),
    "**/src/renderer/**",
  ],
  rules: {
    ...(base.rules ?? {}),

    /**
     * Main process is authoritative: logging is allowed, but weak shortcuts are not.
     */
    "no-console": "off",
    "no-restricted-globals": [
      "error",
      {
        name: "fetch",
        message: "Main process must use an explicit HTTP client/runtime wrapper for network authority, not ambient fetch.",
      },
    ],
    "no-restricted-properties": [
      "error",
      {
        object: "process",
        property: "exit",
        message: "Do not terminate the main process directly. Return explicit failure state through lifecycle control.",
      },
      {
        object: "app",
        property: "quit",
        message: "Do not quit the app from arbitrary locations. Route shutdown through explicit lifecycle control.",
      },
      {
        object: "BrowserWindow",
        property: "getAllWindows",
        message: "Avoid global BrowserWindow reach-through; use window registries/services instead.",
      },
    ],
    "no-restricted-syntax": [
      "error",
      {
        selector: "CallExpression[callee.object.name='ipcMain'][callee.property.name='on']",
        message: "Use ipcMain.handle for request/response authority surfaces unless streaming/event semantics are explicitly justified.",
      },
      {
        selector: "CallExpression[callee.object.name='ipcRenderer']",
        message: "Main-process code must not depend on renderer IPC objects.",
      },
      {
        selector: "CallExpression[callee.object.name='shell'][callee.property.name='openExternal'] Literal[value=/^http:/]",
        message: "Do not open insecure external URLs from main process authority surfaces.",
      },
      {
        selector: "NewExpression[callee.name='BrowserWindow'] ObjectExpression > Property[key.name='webPreferences'] ObjectExpression > Property[key.name='nodeIntegration'][value.value=true]",
        message: "BrowserWindow nodeIntegration must never be enabled.",
      },
      {
        selector: "NewExpression[callee.name='BrowserWindow'] ObjectExpression > Property[key.name='webPreferences'] ObjectExpression > Property[key.name='contextIsolation'][value.value=false]",
        message: "BrowserWindow contextIsolation must not be disabled.",
      },
      {
        selector: "CallExpression[callee.object.name='fs'][callee.property.name=/^(writeFileSync|appendFileSync|rmSync|unlinkSync|renameSync|mkdirSync)$/]",
        message: "Prefer async, service-wrapped filesystem mutation with explicit error and policy handling.",
      },
      {
        selector: "CallExpression[callee.object.name='child_process'][callee.property.name=/^(exec|execSync|spawnSync)$/]",
        message: "Avoid direct shell/process shortcuts. Use explicit command-runner services with governed boundaries.",
      },
      {
        selector: "CallExpression[callee.name='setInterval']",
        message: "Prefer scheduler/service-based recurring work instead of raw setInterval in main-process authority code.",
      },
      {
        selector: "CallExpression[callee.name='setTimeout'] Literal[value>1000]",
        message: "Long-lived delayed work should go through scheduler/lifecycle services, not raw timers.",
      },
    ],

    /**
     * Strong typing and explicit authority boundaries matter more in main process than almost anywhere else.
     */
    "@typescript-eslint/explicit-function-return-type": [
      "error",
      {
        allowExpressions: false,
        allowTypedFunctionExpressions: true,
        allowHigherOrderFunctions: true,
      },
    ],
    "@typescript-eslint/no-explicit-any": "error",
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
    "@typescript-eslint/no-unnecessary-condition": [
      "error",
      {
        allowConstantLoopConditions: false,
      },
    ],
    "@typescript-eslint/no-unsafe-assignment": "error",
    "@typescript-eslint/no-unsafe-argument": "error",
    "@typescript-eslint/no-unsafe-call": "error",
    "@typescript-eslint/no-unsafe-member-access": "error",
    "@typescript-eslint/no-unsafe-return": "error",
    "@typescript-eslint/only-throw-error": "error",
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
    "@typescript-eslint/strict-boolean-expressions": [
      "error",
      {
        allowAny: false,
        allowNullableBoolean: false,
        allowNullableEnum: false,
        allowNullableNumber: false,
        allowNullableObject: false,
        allowNullableString: false,
        allowNumber: false,
        allowRuleToRunWithoutStrictNullChecksIKnowWhatIAmDoing: false,
        allowString: false,
      },
    ],
    "@typescript-eslint/switch-exhaustiveness-check": "error",

    /**
     * Import discipline for privileged process code.
     */
    "import/no-default-export": "off",
    "import/no-cycle": ["error", { ignoreExternal: true, maxDepth: 15 }],
    "import/no-restricted-paths": [
      "error",
      {
        zones: [
          {
            target: "./packages/adjutorix-app/src/main",
            from: "./packages/adjutorix-app/src/renderer",
            message: "Main process must not depend on renderer code.",
          },
        ],
      },
    ],

    /**
     * Complexity limits: main-process files tend to become dangerous blobs if left unchecked.
     */
    "max-lines": [
      "warn",
      {
        max: 700,
        skipBlankLines: true,
        skipComments: true,
      },
    ],
    "max-lines-per-function": [
      "warn",
      {
        max: 140,
        skipBlankLines: true,
        skipComments: true,
        IIFEs: true,
      },
    ],
    "max-params": ["warn", 6],
  },
  overrides: [
    ...(base.overrides ?? []),
    {
      files: [
        "packages/adjutorix-app/src/main/**/*.{ts,tsx,js,jsx}",
        "src/main/**/*.{ts,tsx,js,jsx}",
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
                message: "Main-process code must not depend on React/UI runtime.",
              },
              {
                name: "react-dom",
                message: "Main-process code must not depend on React/UI runtime.",
              },
            ],
            patterns: [
              {
                group: ["**/src/renderer/**", "@/renderer/**"],
                message: "Main process must not import renderer modules directly.",
              },
            ],
          },
        ],
      },
    },
    {
      files: [
        "packages/adjutorix-app/src/main/ipc/**/*.{ts,tsx,js,jsx}",
        "packages/adjutorix-app/src/main/**/ipc*.{ts,tsx,js,jsx}",
        "**/src/main/ipc/**/*.{ts,tsx,js,jsx}",
      ],
      rules: {
        /**
         * IPC surfaces are especially sensitive: keep handlers explicit and reject event-style shortcuts.
         */
        "no-restricted-syntax": [
          "error",
          {
            selector: "CallExpression[callee.object.name='ipcMain'][callee.property.name='on']",
            message: "IPC authority surfaces must use ipcMain.handle, not event-style ipcMain.on.",
          },
          {
            selector: "ArrowFunctionExpression[async=false]",
            message: "IPC handlers should generally be async and explicit about awaited side effects.",
          },
        ],
      },
    },
    {
      files: [
        "packages/adjutorix-app/tests/main/**/*.{ts,tsx}",
        "**/tests/main/**/*.{ts,tsx}",
      ],
      env: {
        node: true,
        browser: false,
      },
      rules: {
        /**
         * Main-process tests may mock aggressive authority surfaces, but should still avoid normalizing unsafe patterns.
         */
        "@typescript-eslint/no-explicit-any": "off",
        "@typescript-eslint/no-unsafe-assignment": "off",
        "@typescript-eslint/no-unsafe-argument": "off",
        "@typescript-eslint/no-unsafe-call": "off",
        "@typescript-eslint/no-unsafe-member-access": "off",
        "@typescript-eslint/no-unsafe-return": "off",
        "max-lines": "off",
        "max-lines-per-function": "off",
        "no-restricted-globals": [
          "error",
          {
            name: "fetch",
            message: "Main-process tests should mock explicit clients/servic