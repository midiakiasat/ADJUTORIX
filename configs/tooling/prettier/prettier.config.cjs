const path = require("node:path");

/**
 * ADJUTORIX Prettier configuration
 *
 * Purpose:
 * - provide one authoritative formatting contract across app, CLI, CI, hooks, and tooling surfaces
 * - keep diffs structurally stable so semantic changes remain visible
 * - minimize review noise in contract-bearing files, tests, and policy scripts
 * - align Markdown, JSON, YAML, and code formatting under one deterministic baseline
 *
 * Design principles:
 * - prefer explicit structure over dense packing
 * - keep line wrapping conservative enough for code review, but not so narrow that nested objects thrash
 * - preserve prose readability in docs and commit/policy artifacts
 * - avoid style-local exceptions unless a file class materially benefits from them
 */

/** @type {import("prettier").Config} */
module.exports = {
  $schema: "https://json.schemastore.org/prettierrc",

  /**
   * Core formatting
   */
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: false,
  quoteProps: "as-needed",
  jsxSingleQuote: false,
  trailingComma: "all",
  bracketSpacing: true,
  bracketSameLine: false,
  arrowParens: "always",
  objectWrap: "preserve",
  endOfLine: "lf",

  /**
   * These keep multiline structures stable and review-friendly.
   */
  proseWrap: "preserve",
  htmlWhitespaceSensitivity: "css",
  embeddedLanguageFormatting: "auto",
  singleAttributePerLine: false,

  /**
   * Repository-wide file handling
   */
  plugins: [],

  /**
   * File-class specialization.
   * The limiting case is policy/config/test files where default wrapping often creates diff churn.
   */
  overrides: [
    {
      files: ["*.md", "**/*.md"],
      options: {
        proseWrap: "always",
        printWidth: 88,
      },
    },
    {
      files: ["*.json", "**/*.json", "*.jsonc", "**/*.jsonc"],
      options: {
        printWidth: 100,
        trailingComma: "none",
      },
    },
    {
      files: ["*.yml", "**/*.yml", "*.yaml", "**/*.yaml"],
      options: {
        singleQuote: false,
        proseWrap: "preserve",
        printWidth: 100,
      },
    },
    {
      files: ["*.cjs", "**/*.cjs", "*.mjs", "**/*.mjs", "*.js", "**/*.js"],
      options: {
        printWidth: 100,
        trailingComma: "all",
      },
    },
    {
      files: ["*.ts", "**/*.ts", "*.tsx", "**/*.tsx"],
      options: {
        printWidth: 100,
        trailingComma: "all",
      },
    },
    {
      files: ["*.css", "**/*.css"],
      options: {
        singleQuote: false,
      },
    },
    {
      files: ["*.html", "**/*.html"],
      options: {
        printWidth: 100,
      },
    },
    {
      files: ["*.sh", "**/*.sh"],
      options: {
        printWidth: 100,
      },
    },
    {
      files: [
        "configs/ci/**/*.yml",
        "configs/ci/**/*.yaml",
        "configs/ci/**/*.json",
        "configs/ci/**/*.jsonc",
      ],
      options: {
        printWidth: 96,
      },
    },
    {
      files: [
        "configs/hooks/**/*",
        "configs/tooling/**/*",
      ],
      options: {
        printWidth: 100,
      },
    },
    {
      files: [
        "packages/adjutorix-app/tests/**/*.{ts,tsx,js,jsx}",
        "packages/adjutorix-cli/tests/**/*.{py,ts,tsx,js,jsx}",
        "tests/**/*.{ts,tsx,js,jsx,py}",
      ],
      options: {
        printWidth: 100,
      },
    },
    {
      files: [
        "README.md",
        "docs/**/*.md",
      ],
      options: {
        proseWrap: "always",
        printWidth: 88,