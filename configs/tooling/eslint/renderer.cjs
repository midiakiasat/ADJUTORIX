const path = require("node:path");

const base = require("./base.cjs");

/**
 * ADJUTORIX renderer ESLint configuration
 *
 * Specialization goals:
 * - tighten renderer-only trust boundaries beyond the repository-wide base rules
 * - prevent hidden authority, ambient persistence, direct RPC/process access, and unsafe side effects in React UI code
 * - enforce predictable component structure, explicit async boundaries, and state/effect discipline for governed surfaces
 * - keep the renderer a pure presentation/request layer that depends on preload/runtime abstractions rather than raw capability
 */

module.exports = {
  ...base,
  env: {
    ...base.env,
    browser: true,
    node: false,
  },
  parserOptions: {
    ...base.parserOptions,
    tsconfigRootDir: process.cwd(),
    project: true,
  },
  ignorePatterns: [
    ...(base.ignorePatterns ?? []),
    "**/src/main/**",
    "**/src/preload/**",
    "**/electron/**",
  ],
  rules: {
    ...(base.rules ?? {}),

    /**
     * Renderer is a request/presentation surface, not an authority holder.
     */
    "no-restricted-globals": [
      "error",
      {
        name: "require",
        message: "Renderer must not use CommonJS require. Import governed abstractions instead.",
      },
    ],
    "no-restricted-properties": [
      "error",
      {
        object: "window",
        property: "require",
        message: "Renderer must not access window.require. Use the governed preload bridge.",
      },
      {
        object: "window",
        property: "open",
        message: "Renderer must not create uncontrolled external windows without a governed wrapper.",
      },
      {
        object: "document",
        property: "write",
        message: "Renderer must not mutate DOM through document.write.",
      },
      {
        object: "document",
        property: "cookie",
        message: "Renderer must not rely on ambient cookie mutation for app state.",
      },
      {
        object: "localStorage",
        property: "setItem",
        message: "Renderer persistence must flow through governed settings/workspace surfaces, not raw localStorage.",
      },
      {
        object: "localStorage",
        property: "removeItem",
        message: "Renderer persistence must flow through governed settings/workspace surfaces, not raw localStorage.",
      },
      {
        object: "sessionStorage",
        property: "setItem",
        message: "Renderer persistence must flow through governed settings/workspace surfaces, not raw sessionStorage.",
      },
      {
        object: "sessionStorage",
        property: "removeItem",
        message: "Renderer persistence must flow through governed settings/workspace surfaces, not raw sessionStorage.",
      },
      {
        object: "window",
        property: "fetch",
        message: "Renderer must not call remote/local authority surfaces directly. Route requests through governed runtime/preload services.",
      },
      {
        object: "globalThis",
        property: "fetch",
        message: "Renderer must not call remote/local authority surfaces directly. Route requests through governed runtime/preload services.",
      },
      {
        object: "window",
        property: "WebSocket",
        message: "Renderer must not open raw WebSocket authority channels directly.",
      },
      {
        object: "window",
        property: "indexedDB",
        message: "Renderer must not own authoritative persistence directly through indexedDB.",
      },
    ],
    "no-restricted-syntax": [
      "error",
      {
        selector: "CallExpression[callee.name='fetch']",
        message: "Renderer must not call fetch directly. Use a governed runtime or preload service.",
      },
      {
        selector: "NewExpression[callee.name='WebSocket']",
        message: "Renderer must not open raw WebSocket connections directly.",
      },
      {
        selector: "CallExpression[callee.object.name='axios']",
        message: "Renderer must not call axios directly. Use a governed runtime or preload service.",
      },
      {
        selector: "CallExpression[callee.object.name='window'][callee.property.name='fetch']",
        message: "Renderer must not call window.fetch directly.",
      },
      {
        selector: "CallExpression[callee.object.name='document'][callee.property.name='querySelector']",
        message: "Prefer refs and declarative React structure over ad hoc DOM authority via querySelector.",
      },
      {
        selector: "CallExpression[callee.object.name='document'][callee.property.name='getElementById']",
        message: "Prefer refs and declarative React structure over ad hoc DOM authority via getElementById.",
      },
      {
        selector: "CallExpression[callee.object.name='window'][callee.property.name='addEventListener'] Literal[value='message']",
        message: "Cross-context message authority should be wrapped in governed runtime utilities.",
      },
      {
        selector: "CallExpression[callee.object.name='history'][callee.property.name='pushState']",
        message: "Use the app router/navigation abstraction instead of raw history mutation.",
      },
      {
        selector: "CallExpression[callee.object.name='history'][callee.property.name='replaceState']",
        message: "Use the app router/navigation abstraction instead of raw history mutation.",
      },
      {
        selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
        message: "dangerouslySetInnerHTML is forbidden in renderer surfaces.",
      },
    ],

    /**
     * Async / effect discipline
     */
    "react-hooks/exhaustive-deps": "error",
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
    "promise/prefer-await-to-then": "error",
    "promise/no-promise-in-callback": "error",

    /**
     * UI predictability / component boundaries
     */
    "react/function-component-definition": [
      "error",
      {
        namedComponents: "function-declaration",
        unnamedComponents: "arrow-function",
      },
    ],
    "react/jsx-no-bind": [
      "warn",
      {
        allowArrowFunctions: true,
        allowBind: false,
        ignoreDOMComponents: true,
        ignoreRefs: false,
      },
    ],
    "react/no-array-index-key": "error",
    "react/no-unstable-nested-components": [
      "error",
      {
        allowAsProps: false,
      },
    ],
    "react/self-closing-comp": "error",
    "react/jsx-boolean-value": ["error", "never"],
    "react/jsx-curly-brace-presence": [
      "error",
      {
        props: "never",
        children: "never",
        propElementValues: "always",
      },
    ],

    /**
     * Renderer should not quietly degrade into a script blob.
     */
    "max-lines": [
      "warn",
      {
        max: 450,
        skipBlankLines: true,
        skipComments: true,
      },
    ],
    "max-lines-per-function": [
      "warn",
      {
        max: 90,
        skipBlankLines: true,
        skipComments: true,
        IIFEs: false,
      },
    ],
    "max-params": ["warn", 4],

    /**
     * Stronger import discipline in renderer.
     */
    "import/no-default-export": "off",
    "import/no-extraneous-dependencies": [
      "error",
      {
        devDependencies: [
          "**/*.test.ts",
          "**/*.test.tsx",
          "**/*.spec.ts",
          "**/*.spec.tsx",
          "**/tests/**",
          "**/vitest.config.*",
          "**/*.stories.tsx",
        ],
        optionalDependencies: false,
        peerDependencies: true,
      },
    ],
    "import/no-restricted-paths": [
      "error",
      {
        zones: [
          {
            target: "./packages/adjutorix-app/src/renderer",
            from: "./packages/adjutorix-app/src/main",
            message: "Renderer must not import directly from main-process code.",
          },
          {
            target: "./packages/adjutorix-app/src/renderer",
            from: "./packages/adjutorix-app/src/preload",
            message: "Renderer must consume preload only through exposed runtime surfaces, not direct imports.",
          },
        ],
      },
    ],
  },
  overrides: [
    ...(base.overrides ?? []),
    {
      files: [
        "packages/adjutorix-app/src/renderer/**/*.{ts,tsx,js,jsx}",
        "src/renderer/**/*.{ts,tsx,js,jsx}",
      ],
      env: {
        browser: true,
        node: false,
      },
      rules: {
        "no-console": [
          "error",
          {
            allow: ["warn", "error"],
          },
        ],
      },
    },
    {
      files: [
        "packages/adjutorix-app/src/renderer/**/*.test.{ts,tsx}",
        "packages/adjutorix-app/tests/renderer/**/*.{ts,tsx}",
        "**/renderer/**/*.test.{ts,tsx}",
        "**/tests/renderer/**/*.{ts,tsx}",
      ],
      env: {
        browser: true,
        node: true,
      },
      rules: {
        /**
         * Tests may mock renderer/runtime boundaries more aggressively, but still must not import raw authority APIs.
         */
        "@typescript-eslint/no-explicit-any": "off",
        "@typescript-eslint/no-unsafe-assignment": "off",
        "@typescript-eslint/no-unsafe-argument": "off",
        "@typescript-eslint/no-unsafe-call": "off",
        "@typescript-eslint/no-unsafe-member-access": "off",
        "@typescript-eslint/no-unsafe-return": "off",
        "max-lines": "off",
        "max-lines-per-function": "off",
        "react/no-array-index-key": "off",
        "no-restricted-properties": [
          "error",
          {
            object: "window",
            property: "require",
            message: "Renderer tests must not normalize window.require usage.",
          },
        ],
        "no-restricted-syntax": [
          "error",
          {
            selector: "CallExpression[callee.name='fetch']",
            message: "Renderer tests must mock governed runtime services instead of using raw fetch.",
          },
          {
            selector: "NewExpression[callee.name='WebSocket']",
            message: "Renderer tests must mock governed runtime services instead of raw WebSocket.",
          },
        ],
      },
    },
  ],
};
