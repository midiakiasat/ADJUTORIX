const path = require("node:path");

/**
 * ADJUTORIX ESLint base configuration
 *
 * Goals:
 * - one authoritative lint baseline for JS/TS/React/Electron surfaces
 * - bias toward correctness, explicitness, and governed-boundary clarity over stylistic minimalism
 * - keep renderer/main/CLI/tests aligned on import discipline, unused state, async handling, and authority separation
 * - provide a strong default that package-specific configs can extend rather than weaken ad hoc
 */

const tsconfigRootDir = process.cwd();

module.exports = {
  root: false,
  env: {
    es2023: true,
    node: true,
  },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    ecmaFeatures: {
      jsx: true,
    },
    tsconfigRootDir,
    project: true,
  },
  plugins: [
    "@typescript-eslint",
    "import",
    "promise",
    "unused-imports",
    "react",
    "react-hooks",
    "jsx-a11y",
  ],
  settings: {
    react: {
      version: "detect",
    },
    "import/parsers": {
      "@typescript-eslint/parser": [".ts", ".tsx", ".mts", ".cts"],
    },
    "import/resolver": {
      typescript: {
        alwaysTryTypes: true,
        project: true,
      },
      node: {
        extensions: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".d.ts", ".json"],
      },
    },
  },
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended-type-checked",
    "plugin:@typescript-eslint/stylistic-type-checked",
    "plugin:import/recommended",
    "plugin:import/typescript",
    "plugin:promise/recommended",
    "plugin:react/recommended",
    "plugin:react-hooks/recommended",
    "plugin:jsx-a11y/recommended",
  ],
  ignorePatterns: [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/out/**",
    "**/coverage/**",
    "**/.turbo/**",
    "**/.next/**",
    "**/.vite/**",
    "**/*.d.ts",
    "**/*.generated.*",
    "**/*.snap",
  ],
  reportUnusedDisableDirectives: true,
  rules: {
    /**
     * Core correctness / safety
     */
    "no-alert": "error",
    "no-console": [
      "warn",
      {
        allow: ["warn", "error"],
      },
    ],
    "no-debugger": "error",
    "no-implicit-coercion": "error",
    "no-return-await": "off",
    "no-void": [
      "error",
      {
        allowAsStatement: true,
      },
    ],
    eqeqeq: ["error", "always", { null: "never" }],
    curly: ["error", "all"],

    /**
     * Imports / module hygiene
     */
    "import/no-absolute-path": "error",
    "import/no-cycle": ["error", { ignoreExternal: true, maxDepth: 10 }],
    "import/no-default-export": "off",
    "import/no-duplicates": "error",
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
          "**/vite.config.*",
          "**/playwright.config.*",
          "**/eslint.config.*",
          "**/*.config.*",
        ],
        optionalDependencies: false,
        peerDependencies: true,
      },
    ],
    "import/order": [
      "error",
      {
        groups: [
          "builtin",
          "external",
          "internal",
          ["parent", "sibling", "index"],
          "object",
          "type",
        ],
        pathGroups: [
          {
            pattern: "@/**",
            group: "internal",
            position: "before",
          },
        ],
        pathGroupsExcludedImportTypes: ["builtin"],
        alphabetize: {
          order: "asc",
          caseInsensitive: true,
        },
        "newlines-between": "always",
      },
    ],

    /**
     * TypeScript discipline
     */
    "@typescript-eslint/array-type": ["error", { default: "array-simple" }],
    "@typescript-eslint/await-thenable": "error",
    "@typescript-eslint/ban-ts-comment": [
      "error",
      {
        "ts-expect-error": "allow-with-description",
        "ts-ignore": true,
        "ts-nocheck": true,
        "ts-check": false,
        minimumDescriptionLength: 8,
      },
    ],
    "@typescript-eslint/consistent-type-definitions": ["error", "type"],
    "@typescript-eslint/consistent-type-imports": [
      "error",
      {
        prefer: "type-imports",
        disallowTypeAnnotations: false,
        fixStyle: "separate-type-imports",
      },
    ],
    "@typescript-eslint/explicit-function-return-type": [
      "error",
      {
        allowExpressions: true,
        allowTypedFunctionExpressions: true,
        allowHigherOrderFunctions: true,
      },
    ],
    "@typescript-eslint/no-confusing-void-expression": [
      "error",
      {
        ignoreArrowShorthand: false,
        ignoreVoidOperator: true,
      },
    ],
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-floating-promises": [
      "error",
      {
        ignoreIIFE: false,
        ignoreVoid: true,
      },
    ],
    "@typescript-eslint/no-for-in-array": "error",
    "@typescript-eslint/no-inferrable-types": "error",
    "@typescript-eslint/no-misused-promises": [
      "error",
      {
        checksConditionals: true,
        checksVoidReturn: {
          arguments: true,
          attributes: false,
          inheritedMethods: true,
          properties: true,
          returns: true,
          variables: true,
        },
        checksSpreads: true,
      },
    ],
    "@typescript-eslint/no-non-null-assertion": "error",
    "@typescript-eslint/no-redundant-type-constituents": "error",
    "@typescript-eslint/no-unnecessary-boolean-literal-compare": "error",
    "@typescript-eslint/no-unnecessary-condition": [
      "error",
      {
        allowConstantLoopConditions: false,
      },
    ],
    "@typescript-eslint/no-unnecessary-type-assertion": "error",
    "@typescript-eslint/no-unnecessary-type-constraint": "error",
    "@typescript-eslint/no-unsafe-argument": "error",
    "@typescript-eslint/no-unsafe-assignment": "error",
    "@typescript-eslint/no-unsafe-call": "error",
    "@typescript-eslint/no-unsafe-enum-comparison": "error",
    "@typescript-eslint/no-unsafe-member-access": "error",
    "@typescript-eslint/no-unsafe-return": "error",
    "@typescript-eslint/no-unused-vars": "off",
    "@typescript-eslint/non-nullable-type-assertion-style": "error",
    "@typescript-eslint/only-throw-error": "error",
    "@typescript-eslint/prefer-nullish-coalescing": [
      "error",
      {
        ignoreConditionalTests: false,
        ignoreMixedLogicalExpressions: false,
      },
    ],
    "@typescript-eslint/prefer-optional-chain": "error",
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
    "@typescript-eslint/require-array-sort-compare": [
      "error",
      {
        ignoreStringArrays: false,
      },
    ],
    "@typescript-eslint/restrict-plus-operands": [
      "error",
      {
        allowAny: false,
        allowBoolean: false,
        allowNullish: false,
        allowNumberAndString: false,
        allowRegExp: false,
      },
    ],
    "@typescript-eslint/restrict-template-expressions": [
      "error",
      {
        allowAny: false,
        allowBoolean: false,
        allowNever: false,
        allowNullish: false,
        allowNumber: true,
        allowRegExp: false,
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
    "@typescript-eslint/unbound-method": [
      "error",
      {
        ignoreStatic: true,
      },
    ],

    /**
     * Unused-state discipline
     */
    "unused-imports/no-unused-imports": "error",
    "unused-imports/no-unused-vars": [
      "error",
      {
        args: "after-used",
        argsIgnorePattern: "^_",
        caughtErrors: "all",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
        ignoreRestSiblings: true,
        vars: "all",
        varsIgnorePattern: "^_",
      },
    ],

    /**
     * Promise / async consistency
     */
    "promise/always-return": "off",
    "promise/catch-or-return": [
      "error",
      {
        allowFinally: true,
        terminationMethod: ["catch", "finally"],
      },
    ],
    "promise/no-multiple-resolved": "error",
    "promise/no-nesting": "warn",
    "promise/no-new-statics": "error",
    "promise/no-promise-in-callback": "warn",
    "promise/no-return-in-finally": "error",
    "promise/no-return-wrap": "error",
    "promise/param-names": "error",
    "promise/prefer-await-to-callbacks": "warn",
    "promise/prefer-await-to-then": "warn",
    "promise/valid-params": "error",

    /**
     * React / UI correctness
     */
    "react/function-component-definition": [
      "error",
      {
        namedComponents: "function-declaration",
        unnamedComponents: "arrow-function",
      },
    ],
    "react/jsx-boolean-value": ["error", "never"],
    "react/jsx-curly-brace-presence": [
      "error",
      {
        props: "never",
        children: "never",
        propElementValues: "always",
      },
    ],
    "react/jsx-no-bind": [
      "warn",
      {
        allowArrowFunctions: true,
        allowBind: false,
        ignoreDOMComponents: true,
        ignoreRefs: true,
      },
    ],
    "react/jsx-no-leaked-render": [
      "error",
      {
        validStrategies: ["coerce", "ternary"],
      },
    ],
    "react/no-array-index-key": "warn",
    "react/no-danger": "error",
    "react/no-unstable-nested-components": [
      "error",
      {
        allowAsProps: true,
      },
    ],
    "react/prop-types": "off",
    "react/react-in-jsx-scope": "off",
    "react/require-default-props": "off",
    "react/self-closing-comp": "error",
    "react-hooks/exhaustive-deps": "error",
    "react-hooks/rules-of-hooks": "error",

    /**
     * Accessibility
     */
    "jsx-a11y/anchor-is-valid": "error",
    "jsx-a11y/click-events-have-key-events": "warn",
    "jsx-a11y/no-autofocus": ["warn", { ignoreNonDOM: true }],
    "jsx-a11y/no-static-element-interactions": "warn",

    /**
     * General maintainability
     */
    "max-depth": ["warn", 4],
    "max-lines": [
      "warn",
      {
        max: 600,
        skipBlankLines: true,
        skipComments: true,
      },
    ],
    "max-lines-per-function": [
      "warn",
      {
        max: 120,
        skipBlankLines: true,
        skipComments: true,
        IIFEs: true,
      },
    ],
    "max-params": ["warn", 5],
  },
  overrides: [
    {
      files: ["**/*.js", "**/*.cjs", "**/*.mjs"],
      parser: "espree",
      extends: [
        "eslint:recommended",
        "plugin:import/recommended",
        "plugin:promise/recommended",
      ],
      rules: {
        "@typescript-eslint/explicit-function-return-type": "off",
        "@typescript-eslint/no-var-requires": "off",
        "@typescript-eslint/no-require-imports": "off",
      },
    },
    {
      files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx", "**/tests/**/*.ts", "**/tests/**/*.tsx"],
      env: {
        node: true,
      },
      rules: {
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
        "react/no-array-index-key": "off",
      },
    },
    {
      files: [
        "**/src/renderer/**/*.{ts,tsx,js,jsx}",
      ],
      env: {
        browser: true,
        node: false,
      },
      rules: {
        /**
         * Renderer must not gain hidden authority.
         */
        "no-restricted-imports": [
          "error",
          {
            paths: [
              {
                name: "electron",
                message: "Renderer must not import electron directly. Use the governed preload surface.",
              },
              {
                name: "node:fs",
                message: "Renderer must not access filesystem authority directly.",
              },
              {
                name: "node:fs/promises",
                message: "Renderer must not access filesystem authority directly.",
              },
              {
                name: "fs",
                message: "Renderer must not access filesystem authority directly.",
              },
              {
                name: "fs/promises",
                message: "Renderer must not access filesystem authority directly.",
              },
              {
                name: "child_process",
                message: "Renderer must not spawn processes directly.",
              },
              {
                name: "node:child_process",
                message: "Renderer must not spawn processes directly.",
              },
            ],
            patterns: [
              {
                group: ["node:*"],
                message: "Renderer must not import Node authority surfaces directly unless explicitly exempted in a package-level override.",
              },
            ],
          },
        ],
      },
    },
    {
      files: [
        "**/src/main/**/*.{ts,tsx,js,jsx}",
        "**/src/preload/**/*.{ts,tsx,js,jsx}",
      ],
      env: {
        node: true,
        browser: false,
      },
      rules: {
        "no-console": "off",
      },
    },
    {
      files: ["**/*.config.{ts,js,cjs,mjs}", "**/configs/**/*.{js,cjs,mjs}", "**/scripts/**/*.{js,cjs,mjs,ts}"],
      rules: {
        "no-console": "off",
        "import/no-default-export": "off",
      },
    },
    {
      files: ["**/*.d.ts"],
      rules: {
        "import/no-duplicates": "off",
      },
    },
  ],
};
