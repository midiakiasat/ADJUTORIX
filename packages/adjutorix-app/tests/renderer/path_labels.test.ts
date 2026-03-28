import { describe, expect, it } from "vitest";

/**
 * ADJUTORIX APP — TESTS / RENDERER / path_labels.test.ts
 *
 * Canonical path-label utility contract suite.
 *
 * Purpose:
 * - verify that renderer/lib/path_labels preserves one authoritative path-labeling surface for
 *   file tree, tabs, search, diagnostics, outline, diff, and review panes
 * - verify that basename extraction, workspace-relative projection, breadcrumb rendering,
 *   duplicate disambiguation, root elision, separator normalization, and empty/edge cases remain deterministic
 * - verify that path-label derivation never collapses distinct files into ambiguous labels across surfaces
 *
 * Test philosophy:
 * - no snapshots
 * - assert primitive labeling semantics directly because every renderer surface depends on them
 * - prefer boundary cases and duplicate-name disambiguation over happy-path-only coverage
 *
 * Notes:
 * - this suite assumes renderer/lib/path_labels exports the functions referenced below
 * - if the real module exports differ slightly, update the imports and adapters first rather than weakening the contract
 */

import {
  basenameLabel,
  dirnameLabel,
  relativePathLabel,
  breadcrumbLabel,
  shortPathLabel,
  disambiguatePathLabels,
  commonPathPrefix,
  normalizePathForLabeling,
} from "../../../src/renderer/lib/path_labels";

describe("renderer/lib/path_labels", () => {
  describe("normalizePathForLabeling", () => {
    it("normalizes Windows separators into stable slash-separated labels", () => {
      expect(normalizePathForLabeling("C:\\repo\\adjutorix-app\\src\\App.tsx")).toBe(
        "C:/repo/adjutorix-app/src/App.tsx",
      );
    });

    it("collapses repeated separators and trims trailing slashes except for roots", () => {
      expect(normalizePathForLabeling("/repo//adjutorix-app///src/App.tsx")).toBe(
        "/repo/adjutorix-app/src/App.tsx",
      );
      expect(normalizePathForLabeling("/repo/adjutorix-app/src/renderer/")).toBe(
        "/repo/adjutorix-app/src/renderer",
      );
    });

    it("preserves root-like paths without collapsing them into empty strings", () => {
      expect(normalizePathForLabeling("/")).toBe("/");
      expect(normalizePathForLabeling("C:/")).toBe("C:/");
    });
  });

  describe("basenameLabel", () => {
    it("returns the final path segment for ordinary file paths", () => {
      expect(basenameLabel("/repo/adjutorix-app/src/renderer/App.tsx")).toBe("App.tsx");
      expect(basenameLabel("/repo/adjutorix-app/README.md")).toBe("README.md");
    });

    it("returns the directory name for normalized directory paths", () => {
      expect(basenameLabel("/repo/adjutorix-app/src/renderer/components")).toBe("components");
    });

    it("returns root-safe labels for root-like inputs instead of empty strings", () => {
      expect(basenameLabel("/")).toBe("/");
      expect(basenameLabel("C:/")).toBe("C:/");
    });
  });

  describe("dirnameLabel", () => {
    it("returns the parent path label for nested file paths", () => {
      expect(dirnameLabel("/repo/adjutorix-app/src/renderer/App.tsx")).toBe(
        "/repo/adjutorix-app/src/renderer",
      );
    });

    it("returns root or drive roots safely without inventing deeper parents", () => {
      expect(dirnameLabel("/repo")).toBe("/");
      expect(dirnameLabel("/")).toBe("/");
      expect(dirnameLabel("C:/repo")).toBe("C:/");
    });
  });

  describe("relativePathLabel", () => {
    it("renders workspace-relative paths when the file sits under the workspace root", () => {
      expect(
        relativePathLabel(
          "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
          "/repo/adjutorix-app",
        ),
      ).toBe("src/renderer/components/AppShell.tsx");
    });

    it("returns '.' or an equivalent explicit root label when path equals workspace root", () => {
      const label = relativePathLabel("/repo/adjutorix-app", "/repo/adjutorix-app");
      expect([".", "", "adjutorix-app"]).toContain(label);
    });

    it("does not incorrectly relativize paths outside the workspace root", () => {
      expect(
        relativePathLabel(
          "/repo/other-project/src/index.ts",
          "/repo/adjutorix-app",
        ),
      ).toBe("/repo/other-project/src/index.ts");
    });

    it("normalizes separators before relativizing Windows-style paths", () => {
      expect(
        relativePathLabel(
          "C:\\repo\\adjutorix-app\\src\\renderer\\App.tsx",
          "C:\\repo\\adjutorix-app",
        ),
      ).toBe("src/renderer/App.tsx");
    });
  });

  describe("breadcrumbLabel", () => {
    it("renders a stable breadcrumb label for a path under a workspace root", () => {
      expect(
        breadcrumbLabel(
          "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
          "/repo/adjutorix-app",
        ),
      ).toBe("src / renderer / components / AppShell.tsx");
    });

    it("omits the workspace root from breadcrumbs instead of repeating it in every surface", () => {
      const label = breadcrumbLabel(
        "/repo/adjutorix-app/src/renderer/App.tsx",
        "/repo/adjutorix-app",
      );
      expect(label).not.toContain("adjutorix-app / src");
    });

    it("falls back to a normalized absolute breadcrumb when no workspace root is provided", () => {
      expect(breadcrumbLabel("/repo/adjutorix-app/src/renderer/App.tsx")).toBe(
        "repo / adjutorix-app / src / renderer / App.tsx",
      );
    });
  });

  describe("shortPathLabel", () => {
    it("returns basename-only label for unique paths when no disambiguation context is required", () => {
      expect(
        shortPathLabel(
          "/repo/adjutorix-app/src/renderer/ProviderStatus.tsx",
          {
            workspaceRoot: "/repo/adjutorix-app",
            allPaths: [
              "/repo/adjutorix-app/src/renderer/ProviderStatus.tsx",
              "/repo/adjutorix-app/src/renderer/App.tsx",
            ],
          },
        ),
      ).toBe("ProviderStatus.tsx");
    });

    it("adds minimal parent context for duplicate basenames instead of collapsing them", () => {
      const allPaths = [
        "/repo/adjutorix-app/src/renderer/App.tsx",
        "/repo/adjutorix-app/tests/renderer/App.tsx",
      ];

      const a = shortPathLabel(allPaths[0], { workspaceRoot: "/repo/adjutorix-app", allPaths });
      const b = shortPathLabel(allPaths[1], { workspaceRoot: "/repo/adjutorix-app", allPaths });

      expect(a).not.toBe(b);
      expect(a).toContain("App.tsx");
      expect(b).toContain("App.tsx");
      expect(a).toMatch(/renderer/);
      expect(b).toMatch(/renderer/);
    });

    it("keeps labels deterministic across repeated calls with identical inputs", () => {
      const allPaths = [
        "/repo/adjutorix-app/src/state/index.ts",
        "/repo/adjutorix-app/tests/state/index.ts",
      ];

      const first = shortPathLabel(allPaths[0], { workspaceRoot: "/repo/adjutorix-app", allPaths });
      const second = shortPathLabel(allPaths[0], { workspaceRoot: "/repo/adjutorix-app", allPaths });

      expect(first).toBe(second);
    });
  });

  describe("disambiguatePathLabels", () => {
    it("returns one stable unique label per path while minimizing extra path context", () => {
      const paths = [
        "/repo/adjutorix-app/src/renderer/App.tsx",
        "/repo/adjutorix-app/tests/renderer/App.tsx",
        "/repo/adjutorix-app/src/renderer/ProviderStatus.tsx",
      ];

      const labels = disambiguatePathLabels(paths, { workspaceRoot: "/repo/adjutorix-app" });

      expect(Object.keys(labels)).toHaveLength(3);
      expect(new Set(Object.values(labels)).size).toBe(3);
      expect(labels[paths[2]]).toBe("ProviderStatus.tsx");
      expect(labels[paths[0]]).toContain("App.tsx");
      expect(labels[paths[1]]).toContain("App.tsx");
      expect(labels[paths[0]]).not.toBe(labels[paths[1]]);
    });

    it("disambiguates three-way duplicate basenames without collapsing any pair", () => {
      const paths = [
        "/repo/a/src/index.ts",
        "/repo/a/tests/index.ts",
        "/repo/a/packages/core/index.ts",
      ];

      const labels = disambiguatePathLabels(paths, { workspaceRoot: "/repo/a" });
      const values = Object.values(labels);

      expect(values).toHaveLength(3);
      expect(new Set(values).size).toBe(3);
      values.forEach((label) => expect(label).toContain("index.ts"));
    });

    it("preserves input-path identity even when two paths differ only by deeper parent structure", () => {
      const paths = [
        "/repo/adjutorix-app/src/state/editor/index.ts",
        "/repo/adjutorix-app/src/state/workspace/index.ts",
      ];

      const labels = disambiguatePathLabels(paths, { workspaceRoot: "/repo/adjutorix-app" });

      expect(labels[paths[0]]).not.toBe(labels[paths[1]]);
      expect(labels[paths[0]]).toMatch(/editor/);
      expect(labels[paths[1]]).toMatch(/workspace/);
    });
  });

  describe("commonPathPrefix", () => {
    it("computes the longest shared path prefix across sibling files", () => {
      expect(
        commonPathPrefix([
          "/repo/adjutorix-app/src/renderer/App.tsx",
          "/repo/adjutorix-app/src/renderer/ProviderStatus.tsx",
          "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
        ]),
      ).toBe("/repo/adjutorix-app/src/renderer");
    });

    it("returns the root-safe prefix when only root segments are shared", () => {
      const prefix = commonPathPrefix([
        "/repo/a/App.tsx",
        "/other/b/App.tsx",
      ]);
      expect(["/", ""]).toContain(prefix);
    });

    it("returns empty or root-safe prefix for empty input without inventing structure", () => {
      const prefix = commonPathPrefix([]);
      expect(["", "/"]).toContain(prefix);
    });
  });

  describe("cross-surface labeling guarantees", () => {
    it("keeps tree, tab, and search-friendly labels semantically aligned for the same path", () => {
      const path = "/repo/adjutorix-app/src/renderer/components/AppShell.tsx";
      const allPaths = [
        path,
        "/repo/adjutorix-app/src/renderer/App.tsx",
      ];

      const base = basenameLabel(path);
      const rel = relativePathLabel(path, "/repo/adjutorix-app");
      const crumb = breadcrumbLabel(path, "/repo/adjutorix-app");
      const short = shortPathLabel(path, { workspaceRoot: "/repo/adjutorix-app", allPaths });

      expect(base).toBe("AppShell.tsx");
      expect(rel.endsWith("AppShell.tsx")).toBe(true);
      expect(crumb.endsWith("AppShell.tsx")).toBe(true);
      expect(short).toContain("AppShell.tsx");
    });

    it("does not let workspace-root names leak into short duplicate labels unless necessary for uniqueness", () => {
      const paths = [
        "/repo/adjutorix-app/src/editor/index.ts",
        "/repo/adjutorix-app/src/workspace/index.ts",
      ];

      const labels = disambiguatePathLabels(paths, { workspaceRoot: "/repo/adjutorix-app" });

      expect(labels[paths[0]]).not.toContain("adjutorix-app/");
      expect(labels[paths[1]]).not.toContain("adjutorix-app/");
    });

    it("never collapses hidden or dotfile basenames into empty labels", () => {
      expect(basenameLabel("/repo/adjutorix-app/.env.local")).toBe(".env.local");
      expect(relativePathLabel("/repo/adjutorix-app/.gitignore", "/repo/adjutorix-app")).toBe(
        ".gitignore",
      );
    });

    it("handles unicode and spaced path segments without lossy normalization", () => {
      const path = "/repo/adjutorix-app/docs/Design Notes/Γraph Panel.md";

      expect(basenameLabel(path)).toBe("Γraph Panel.md");
      expect(relativePathLabel(path, "/repo/adjutorix-app")).toBe(
        "docs/Design Notes/Γraph Panel.md",
      );
      expect(breadcrumbLabel(path, "/repo/adjutorix-app")).toBe(
        "docs / Design Notes / Γraph Panel.md",
      );
    });
  });
});
