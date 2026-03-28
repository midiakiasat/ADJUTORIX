import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / MAIN / workspace_paths.test.ts
 *
 * Canonical workspace-path semantics contract suite.
 *
 * Purpose:
 * - verify that main-process workspace path utilities preserve one authoritative path surface
 *   for root containment, normalization, relative projection, traversal rejection, and canonical comparison
 * - verify that separator normalization, dot-segment collapse, sibling-prefix rejection,
 *   root identity, hidden path handling, and Windows/Unix cross-shape behavior remain deterministic
 * - verify that no subsystem can reinterpret the same target as both in-root and out-of-root
 *   depending on formatting accidents or traversal artifacts
 *
 * Test philosophy:
 * - no snapshots
 * - assert primitive path semantics, edge cases, and monotonicity directly
 * - prefer counterexamples and limiting cases over happy-path only coverage
 *
 * Notes:
 * - this suite assumes src/main/governance/workspace_paths exports the functions and types referenced below
 * - if the production module exports differ slightly, update adapters first rather than weakening intent
 */

import {
  normalizeWorkspacePath,
  normalizeWorkspaceRoot,
  isPathInsideWorkspace,
  assertPathInsideWorkspace,
  relativizeWorkspacePath,
  commonWorkspacePrefix,
  compareWorkspacePaths,
  resolveWorkspaceChildPath,
  type WorkspacePathComparison,
} from "../../../src/main/governance/workspace_paths";

describe("workspace_paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("normalizeWorkspacePath", () => {
    it("normalizes Windows separators into stable slash-based canonical paths", () => {
      expect(normalizeWorkspacePath("C:\\repo\\adjutorix-app\\src\\renderer\\App.tsx")).toBe(
        "C:/repo/adjutorix-app/src/renderer/App.tsx",
      );
    });

    it("collapses repeated separators and dot segments without changing semantic identity", () => {
      expect(normalizeWorkspacePath("/repo//adjutorix-app/./src/renderer/App.tsx")).toBe(
        "/repo/adjutorix-app/src/renderer/App.tsx",
      );
      expect(normalizeWorkspacePath("/repo/adjutorix-app/src/renderer/../renderer/App.tsx")).toBe(
        "/repo/adjutorix-app/src/renderer/App.tsx",
      );
    });

    it("preserves root-like paths instead of collapsing them into empty strings", () => {
      expect(normalizeWorkspacePath("/")).toBe("/");
      expect(normalizeWorkspacePath("C:/")).toBe("C:/");
    });

    it("trims trailing slashes for non-root paths", () => {
      expect(normalizeWorkspacePath("/repo/adjutorix-app/src/renderer/")).toBe(
        "/repo/adjutorix-app/src/renderer",
      );
    });
  });

  describe("normalizeWorkspaceRoot", () => {
    it("normalizes workspace roots identically to ordinary canonical paths", () => {
      expect(normalizeWorkspaceRoot("/repo/adjutorix-app/")).toBe("/repo/adjutorix-app");
      expect(normalizeWorkspaceRoot("C:\\repo\\adjutorix-app\\")).toBe("C:/repo/adjutorix-app");
    });
  });

  describe("isPathInsideWorkspace", () => {
    it("returns true for the workspace root itself", () => {
      expect(isPathInsideWorkspace("/repo/adjutorix-app", "/repo/adjutorix-app")).toBe(true);
    });

    it("returns true for nested child paths under the workspace root", () => {
      expect(
        isPathInsideWorkspace(
          "/repo/adjutorix-app/src/renderer/App.tsx",
          "/repo/adjutorix-app",
        ),
      ).toBe(true);
    });

    it("rejects sibling-prefix tricks that only share a string prefix with the workspace root", () => {
      expect(
        isPathInsideWorkspace(
          "/repo/adjutorix-app-malicious/src/index.ts",
          "/repo/adjutorix-app",
        ),
      ).toBe(false);
    });

    it("rejects parent paths and unrelated paths outside the workspace root", () => {
      expect(isPathInsideWorkspace("/repo", "/repo/adjutorix-app")).toBe(false);
      expect(isPathInsideWorkspace("/etc/passwd", "/repo/adjutorix-app")).toBe(false);
    });

    it("handles normalized traversal inputs by semantic containment rather than raw string shape", () => {
      expect(
        isPathInsideWorkspace(
          "/repo/adjutorix-app/src/renderer/../App.tsx",
          "/repo/adjutorix-app",
        ),
      ).toBe(true);
    });

    it("rejects escaped traversal that normalizes outside the workspace root", () => {
      expect(
        isPathInsideWorkspace(
          "/repo/adjutorix-app/../../etc/passwd",
          "/repo/adjutorix-app",
        ),
      ).toBe(false);
    });

    it("works for Windows-style roots and children after normalization", () => {
      expect(
        isPathInsideWorkspace(
          "C:\\repo\\adjutorix-app\\src\\renderer\\App.tsx",
          "C:\\repo\\adjutorix-app",
        ),
      ).toBe(true);
    });
  });

  describe("assertPathInsideWorkspace", () => {
    it("does not throw for valid in-root paths", () => {
      expect(() =>
        assertPathInsideWorkspace(
          "/repo/adjutorix-app/src/renderer/App.tsx",
          "/repo/adjutorix-app",
        ),
      ).not.toThrow();
    });

    it("throws for out-of-root paths with explicit failure semantics", () => {
      expect(() =>
        assertPathInsideWorkspace(
          "/etc/passwd",
          "/repo/adjutorix-app",
        ),
      ).toThrow();
    });
  });

  describe("relativizeWorkspacePath", () => {
    it("projects child paths relative to the workspace root", () => {
      expect(
        relativizeWorkspacePath(
          "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
          "/repo/adjutorix-app",
        ),
      ).toBe("src/renderer/components/AppShell.tsx");
    });

    it("returns '.' or equivalent explicit root projection for the root itself", () => {
      const rel = relativizeWorkspacePath("/repo/adjutorix-app", "/repo/adjutorix-app");
      expect([".", ""]).toContain(rel);
    });

    it("throws or fails safely when asked to relativize a path outside the workspace", () => {
      expect(() =>
        relativizeWorkspacePath(
          "/repo/other-project/src/index.ts",
          "/repo/adjutorix-app",
        ),
      ).toThrow();
    });

    it("normalizes Windows-style input before computing the relative path", () => {
      expect(
        relativizeWorkspacePath(
          "C:\\repo\\adjutorix-app\\src\\renderer\\App.tsx",
          "C:\\repo\\adjutorix-app",
        ),
      ).toBe("src/renderer/App.tsx");
    });
  });

  describe("commonWorkspacePrefix", () => {
    it("returns the longest shared canonical prefix across related workspace paths", () => {
      expect(
        commonWorkspacePrefix([
          "/repo/adjutorix-app/src/renderer/App.tsx",
          "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
          "/repo/adjutorix-app/src/renderer/components/ProviderStatus.tsx",
        ]),
      ).toBe("/repo/adjutorix-app/src/renderer");
    });

    it("returns a root-safe prefix when only top-level root identity is shared", () => {
      const prefix = commonWorkspacePrefix([
        "/repo/a/App.tsx",
        "/other/b/App.tsx",
      ]);
      expect(["/", ""]).toContain(prefix);
    });

    it("returns empty or root-safe value for empty input without inventing structure", () => {
      const prefix = commonWorkspacePrefix([]);
      expect(["", "/"]).toContain(prefix);
    });
  });

  describe("compareWorkspacePaths", () => {
    it("treats semantically identical differently formatted paths as equal", () => {
      const result = compareWorkspacePaths(
        "/repo/adjutorix-app/src/renderer/App.tsx",
        "/repo//adjutorix-app/src/renderer/./App.tsx",
      );

      expect(result).toBe("equal");
    });

    it("orders unequal canonical paths deterministically for stable maps and sorting", () => {
      const a = compareWorkspacePaths(
        "/repo/adjutorix-app/src/renderer/A.tsx",
        "/repo/adjutorix-app/src/renderer/B.tsx",
      );
      const b = compareWorkspacePaths(
        "/repo/adjutorix-app/src/renderer/B.tsx",
        "/repo/adjutorix-app/src/renderer/A.tsx",
      );

      expect(a).not.toBe("equal");
      expect(b).not.toBe("equal");
      expect(a).not.toBe(b);
    });
  });

  describe("resolveWorkspaceChildPath", () => {
    it("resolves a relative child path under the workspace root canonically", () => {
      expect(
        resolveWorkspaceChildPath(
          "/repo/adjutorix-app",
          "src/renderer/App.tsx",
        ),
      ).toBe("/repo/adjutorix-app/src/renderer/App.tsx");
    });

    it("normalizes dot segments in child resolution without changing in-root meaning", () => {
      expect(
        resolveWorkspaceChildPath(
          "/repo/adjutorix-app",
          "src/renderer/../renderer/App.tsx",
        ),
      ).toBe("/repo/adjutorix-app/src/renderer/App.tsx");
    });

    it("rejects child traversal that escapes the workspace root", () => {
      expect(() =>
        resolveWorkspaceChildPath(
          "/repo/adjutorix-app",
          "../../etc/passwd",
        ),
      ).toThrow();
    });

    it("rejects absolute child inputs that point outside the workspace root", () => {
      expect(() =>
        resolveWorkspaceChildPath(
          "/repo/adjutorix-app",
          "/etc/passwd",
        ),
      ).toThrow();
    });
  });

  describe("cross-function invariants", () => {
    it("keeps containment and relativization coherent for the same in-root path", () => {
      const path = "/repo/adjutorix-app/src/renderer/components/AppShell.tsx";
      const root = "/repo/adjutorix-app";

      expect(isPathInsideWorkspace(path, root)).toBe(true);
      expect(relativizeWorkspacePath(path, root)).toBe("src/renderer/components/AppShell.tsx");
    });

    it("does not let normalization convert an out-of-root path into an in-root path by formatting accident", () => {
      const escaped = "/repo/adjutorix-app/../../other-project/src/index.ts";
      expect(isPathInsideWorkspace(escaped, "/repo/adjutorix-app")).toBe(false);
    });

    it("preserves hidden and dotfile paths as in-root when they are genuinely under the workspace root", () => {
      const path = "/repo/adjutorix-app/.gitignore";
      expect(isPathInsideWorkspace(path, "/repo/adjutorix-app")).toBe(true);
      expect(relativizeWorkspacePath(path, "/repo/adjutorix-app")).toBe(".gitignore");
    });

    it("returns deterministic identical outputs for identical inputs", () => {
      const a = normalizeWorkspacePath("/repo/adjutorix-app/src/renderer/App.tsx");
      const b = normalizeWorkspacePath("/repo/adjutorix-app/src/renderer/App.tsx");
      expect(a).toBe(b);

      const insideA = isPathInsideWorkspace(
        "/repo/adjutorix-app/src/renderer/App.tsx",
        "/repo/adjutorix-app",
      );
      const insideB = isPathInsideWorkspace(
        "/repo/adjutorix-app/src/renderer/App.tsx",
        "/repo/adjutorix-app",
      );
      expect(insideA).toBe(insideB);
    });
  });
});
