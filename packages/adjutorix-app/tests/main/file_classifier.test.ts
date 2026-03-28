import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / MAIN / file_ignore.test.ts
 *
 * Canonical file-ignore contract suite.
 *
 * Purpose:
 * - verify that main-process file ignore evaluation preserves one authoritative boundary for
 *   ignored, hidden, generated, vendor, cache, build-artifact, and policy-denied paths
 * - verify that path normalization, workspace-relative matching, basename rules, directory inheritance,
 *   explicit allow overrides, and mutability restrictions remain deterministic
 * - verify that ignored or hidden paths cannot silently leak into indexing, diagnostics, review,
 *   or mutation surfaces as trusted first-class workspace entries
 *
 * Test philosophy:
 * - no snapshots
 * - assert ignore semantics, boundary conditions, and monotonicity directly
 * - prefer counterexamples and limiting cases over happy-path only coverage
 *
 * Notes:
 * - this suite assumes src/main/governance/file_ignore exports the functions and types referenced below
 * - if the production module exports differ slightly, update adapters first rather than weakening intent
 */

import {
  DEFAULT_FILE_IGNORE_POLICY,
  normalizeIgnorePath,
  classifyIgnoredPath,
  shouldIgnorePath,
  shouldHidePath,
  assertPathAllowedByIgnorePolicy,
  type FileIgnorePolicy,
  type FileIgnoreContext,
  type FileIgnoreEvaluation,
} from "../../../src/main/governance/file_ignore";

function policy(overrides: Partial<FileIgnorePolicy> = {}): FileIgnorePolicy {
  return {
    ignoreHiddenByDefault: false,
    hideHiddenByDefault: true,
    ignoreDirectories: [
      "node_modules",
      ".git",
      ".svn",
      ".hg",
      "dist",
      "build",
      ".next",
      ".turbo",
      ".cache",
      ".adjutorix",
      "coverage",
      "tmp",
      "temp",
      "vendor",
    ],
    ignoreBasenames: [
      ".DS_Store",
      "Thumbs.db",
      "package-lock.json.bak",
    ],
    ignoreExtensions: [
      ".log",
      ".tmp",
      ".cache",
      ".map",
      ".pyc",
      ".tsbuildinfo",
    ],
    generatedPathFragments: [
      "/generated/",
      "/__generated__/",
      "/gen/",
    ],
    allowExplicitPaths: [],
    denyMutationForIgnored: true,
    denyIndexingForIgnored: true,
    denyDiagnosticsForIgnored: true,
    denyReviewForIgnored: true,
    ...overrides,
  };
}

function ctx(overrides: Partial<FileIgnoreContext> = {}): FileIgnoreContext {
  return {
    workspaceRoot: "/repo/adjutorix-app",
    path: "/repo/adjutorix-app/src/renderer/App.tsx",
    purpose: "index",
    policy: policy(),
    ...overrides,
  } as FileIgnoreContext;
}

function codes(result: FileIgnoreEvaluation): string[] {
  return result.reasons.map((r) => r.code);
}

describe("file_ignore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("DEFAULT_FILE_IGNORE_POLICY", () => {
    it("exposes deterministic baseline ignore policy with non-empty structural rules", () => {
      expect(DEFAULT_FILE_IGNORE_POLICY.ignoreDirectories.length).toBeGreaterThan(0);
      expect(DEFAULT_FILE_IGNORE_POLICY.ignoreExtensions.length).toBeGreaterThan(0);
      expect(typeof DEFAULT_FILE_IGNORE_POLICY.hideHiddenByDefault).toBe("boolean");
    });
  });

  describe("normalizeIgnorePath", () => {
    it("normalizes Windows separators and trailing slashes into stable canonical paths", () => {
      expect(normalizeIgnorePath("C:\\repo\\adjutorix-app\\src\\renderer\\App.tsx")).toBe(
        "C:/repo/adjutorix-app/src/renderer/App.tsx",
      );
      expect(normalizeIgnorePath("/repo/adjutorix-app/src/renderer/")).toBe(
        "/repo/adjutorix-app/src/renderer",
      );
    });

    it("collapses repeated separators without changing semantic path identity", () => {
      expect(normalizeIgnorePath("/repo//adjutorix-app///src/App.tsx")).toBe(
        "/repo/adjutorix-app/src/App.tsx",
      );
    });
  });

  describe("shouldIgnorePath / shouldHidePath", () => {
    it("does not ignore ordinary workspace source paths by default", () => {
      expect(shouldIgnorePath(ctx())).toBe(false);
      expect(shouldHidePath(ctx())).toBe(false);
    });

    it("hides dotfiles by default without necessarily ignoring them for all purposes", () => {
      expect(
        shouldHidePath(
          ctx({ path: "/repo/adjutorix-app/.env.local" }),
        ),
      ).toBe(true);
    });

    it("ignores canonical vendor and build directories recursively", () => {
      expect(
        shouldIgnorePath(
          ctx({ path: "/repo/adjutorix-app/node_modules/react/index.js" }),
        ),
      ).toBe(true);
      expect(
        shouldIgnorePath(
          ctx({ path: "/repo/adjutorix-app/dist/main.js" }),
        ),
      ).toBe(true);
      expect(
        shouldIgnorePath(
          ctx({ path: "/repo/adjutorix-app/.adjutorix/cache/state.json" }),
        ),
      ).toBe(true);
    });

    it("ignores common generated and cache-like outputs by path fragment or extension", () => {
      expect(
        shouldIgnorePath(
          ctx({ path: "/repo/adjutorix-app/src/__generated__/types.ts" }),
        ),
      ).toBe(true);
      expect(
        shouldIgnorePath(
          ctx({ path: "/repo/adjutorix-app/logs/runtime.log" }),
        ),
      ).toBe(true);
      expect(
        shouldIgnorePath(
          ctx({ path: "/repo/adjutorix-app/.cache/graph.bin" }),
        ),
      ).toBe(true);
    });

    it("ignores specific junk basenames regardless of directory location", () => {
      expect(
        shouldIgnorePath(
          ctx({ path: "/repo/adjutorix-app/src/renderer/.DS_Store" }),
        ),
      ).toBe(true);
      expect(
        shouldIgnorePath(
          ctx({ path: "/repo/adjutorix-app/assets/Thumbs.db" }),
        ),
      ).toBe(true);
    });

    it("does not ignore similar-looking safe source paths by prefix accident", () => {
      expect(
        shouldIgnorePath(
          ctx({ path: "/repo/adjutorix-app/src/generatedTypes.ts" }),
        ),
      ).toBe(false);
      expect(
        shouldIgnorePath(
          ctx({ path: "/repo/adjutorix-app/node_modules_like/index.ts" }),
        ),
      ).toBe(false);
      expect(
        shouldIgnorePath(
          ctx({ path: "/repo/adjutorix-app/distinguished/logic.ts" }),
        ),
      ).toBe(false);
    });

    it("supports explicit allow overrides that carve back trusted paths from broad ignore classes", () => {
      const p = policy({
        allowExplicitPaths: ["/repo/adjutorix-app/.adjutorix/ledger/export.json"],
      });

      expect(
        shouldIgnorePath(
          ctx({
            path: "/repo/adjutorix-app/.adjutorix/ledger/export.json",
            policy: p,
          }),
        ),
      ).toBe(false);
    });
  });

  describe("classifyIgnoredPath", () => {
    it("returns allowed for ordinary in-root source paths", () => {
      const result = classifyIgnoredPath(ctx());

      expect(result.allowed).toBe(true);
      expect(result.ignored).toBe(false);
      expect(result.hidden).toBe(false);
      expect(result.reasons).toEqual([]);
    });

    it("classifies hidden dotfiles as hidden even when not fully ignored", () => {
      const result = classifyIgnoredPath(
        ctx({ path: "/repo/adjutorix-app/.env.local", purpose: "tree" }),
      );

      expect(result.allowed).toBe(true);
      expect(result.hidden).toBe(true);
      expect(codes(result)).toContain("HIDDEN_PATH");
    });

    it("classifies vendor directories as ignored for indexing and diagnostics", () => {
      const indexResult = classifyIgnoredPath(
        ctx({ path: "/repo/adjutorix-app/node_modules/react/index.js", purpose: "index" }),
      );
      const diagnosticsResult = classifyIgnoredPath(
        ctx({ path: "/repo/adjutorix-app/node_modules/react/index.js", purpose: "diagnostics" }),
      );

      expect(indexResult.allowed).toBe(false);
      expect(indexResult.ignored).toBe(true);
      expect(codes(indexResult)).toContain("IGNORED_DIRECTORY");

      expect(diagnosticsResult.allowed).toBe(false);
      expect(diagnosticsResult.ignored).toBe(true);
    });

    it("classifies generated paths as ignored for review and indexing", () => {
      const result = classifyIgnoredPath(
        ctx({ path: "/repo/adjutorix-app/src/__generated__/schema.ts", purpose: "review" }),
      );

      expect(result.allowed).toBe(false);
      expect(result.ignored).toBe(true);
      expect(codes(result)).toContain("GENERATED_PATH");
    });

    it("denies mutation for ignored paths even if read/tree listing would otherwise surface them", () => {
      const result = classifyIgnoredPath(
        ctx({ path: "/repo/adjutorix-app/.adjutorix/cache/state.json", purpose: "mutation" }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("IGNORED_MUTATION_DENIED");
    });

    it("denies diagnostics for ignored paths when diagnostics denial is enabled", () => {
      const result = classifyIgnoredPath(
        ctx({ path: "/repo/adjutorix-app/dist/main.js.map", purpose: "diagnostics" }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("IGNORED_DIAGNOSTICS_DENIED");
    });

    it("denies review for ignored/generated paths when review denial is enabled", () => {
      const result = classifyIgnoredPath(
        ctx({ path: "/repo/adjutorix-app/src/generated/types.ts", purpose: "review" }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("IGNORED_REVIEW_DENIED");
    });

    it("treats hidden tree exposure as a narrower limiting case than indexing or mutation denial", () => {
      const treeResult = classifyIgnoredPath(
        ctx({ path: "/repo/adjutorix-app/.env.local", purpose: "tree" }),
      );
      const mutationResult = classifyIgnoredPath(
        ctx({ path: "/repo/adjutorix-app/.env.local", purpose: "mutation" }),
      );

      expect(treeResult.allowed).toBe(true);
      expect(treeResult.hidden).toBe(true);
      expect(mutationResult.allowed).toBe(false);
    });

    it("does not silently trust paths outside the workspace root even if their basename looks allowed", () => {
      const result = classifyIgnoredPath(
        ctx({ path: "/etc/hosts", purpose: "read" }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("PATH_OUTSIDE_WORKSPACE");
    });

    it("does not confuse sibling-root prefix tricks with in-root paths", () => {
      const result = classifyIgnoredPath(
        ctx({ path: "/repo/adjutorix-app-malicious/src/App.tsx", purpose: "read" }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("PATH_OUTSIDE_WORKSPACE");
    });

    it("returns deterministic identical classifications for identical inputs", () => {
      const a = classifyIgnoredPath(ctx({ path: "/repo/adjutorix-app/src/renderer/App.tsx", purpose: "index" }));
      const b = classifyIgnoredPath(ctx({ path: "/repo/adjutorix-app/src/renderer/App.tsx", purpose: "index" }));
      expect(b).toEqual(a);
    });

    it("preserves all relevant reasons instead of stopping at the first ignore signal", () => {
      const result = classifyIgnoredPath(
        ctx({
          path: "/repo/adjutorix-app/.adjutorix/__generated__/runtime.log",
          purpose: "mutation",
        }),
      );

      expect(result.allowed).toBe(false);
      expect(result.reasons.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("assertPathAllowedByIgnorePolicy", () => {
    it("does not throw for an ordinary source path allowed by policy", () => {
      expect(() => assertPathAllowedByIgnorePolicy(ctx())).not.toThrow();
    });

    it("throws for ignored mutation paths with explicit ignore failure semantics", () => {
      expect(() =>
        assertPathAllowedByIgnorePolicy(
          ctx({
            path: "/repo/adjutorix-app/node_modules/react/index.js",
            purpose: "mutation",
          }),
        ),
      ).toThrow();
    });
  });
});
