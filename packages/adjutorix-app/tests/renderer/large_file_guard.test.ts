import { describe, expect, it } from "vitest";

/**
 * ADJUTORIX APP — TESTS / RENDERER / large_file_guard.test.ts
 *
 * Canonical large-file guard contract suite.
 *
 * Purpose:
 * - verify that renderer/lib/large_file_guard preserves one authoritative policy surface for
 *   allow/degrade/deny decisions across editor, diff, preview, and review panes
 * - verify that byte thresholds, binary-like detection, preview sizing, mime/path hints,
 *   and policy overrides remain deterministic and do not drift between surfaces
 * - verify that malformed or partial metadata fails safely instead of widening edit authority
 *
 * Test philosophy:
 * - no snapshots
 * - assert decision semantics, threshold boundaries, and policy invariants directly
 * - prefer edge cases and limiting cases over happy-path-only coverage
 *
 * Notes:
 * - this suite assumes renderer/lib/large_file_guard exports the functions and types referenced below
 * - if the real module exports differ slightly, update the imports and helper builders first
 */

import {
  DEFAULT_LARGE_FILE_POLICY,
  classifyLargeFileDecision,
  buildLargeFileDecision,
  isBinaryLikePath,
  isBinaryLikeMime,
  shouldAllowFullEditor,
  shouldAllowDiffEditor,
  type LargeFileDecision,
  type LargeFilePolicy,
  type LargeFileProbe,
} from "../../../src/renderer/lib/large_file_guard";

function policy(overrides: Partial<LargeFilePolicy> = {}): LargeFilePolicy {
  return {
    editorAllowBytes: 256 * 1024,
    editorDegradeBytes: 1024 * 1024,
    diffAllowBytes: 128 * 1024,
    diffDegradeBytes: 512 * 1024,
    previewBytes: 64 * 1024,
    denyBinaryLike: true,
    binaryExtensions: [
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".webp",
      ".pdf",
      ".zip",
      ".gz",
      ".tar",
      ".jar",
      ".woff",
      ".woff2",
      ".ttf",
      ".exe",
      ".dll",
      ".so",
      ".bin",
      ".ico",
    ],
    binaryMimePrefixes: ["image/", "audio/", "video/", "font/"],
    binaryMimeExact: [
      "application/pdf",
      "application/zip",
      "application/gzip",
      "application/octet-stream",
    ],
    ...overrides,
  };
}

function probe(overrides: Partial<LargeFileProbe> = {}): LargeFileProbe {
  return {
    path: "/repo/adjutorix-app/src/renderer/App.tsx",
    sizeBytes: 4096,
    mimeType: "text/typescript",
    purpose: "editor",
    ...overrides,
  } as LargeFileProbe;
}

function expectDecision(
  decision: LargeFileDecision,
  expected: Pick<LargeFileDecision, "enabled" | "decision">,
): void {
  expect(decision.enabled).toBe(expected.enabled);
  expect(decision.decision).toBe(expected.decision);
}

describe("renderer/lib/large_file_guard", () => {
  describe("DEFAULT_LARGE_FILE_POLICY", () => {
    it("exposes a deterministic baseline policy with monotonic thresholds", () => {
      expect(DEFAULT_LARGE_FILE_POLICY.editorAllowBytes).toBeGreaterThan(0);
      expect(DEFAULT_LARGE_FILE_POLICY.editorDegradeBytes).toBeGreaterThan(
        DEFAULT_LARGE_FILE_POLICY.editorAllowBytes,
      );
      expect(DEFAULT_LARGE_FILE_POLICY.diffAllowBytes).toBeGreaterThan(0);
      expect(DEFAULT_LARGE_FILE_POLICY.diffDegradeBytes).toBeGreaterThan(
        DEFAULT_LARGE_FILE_POLICY.diffAllowBytes,
      );
      expect(DEFAULT_LARGE_FILE_POLICY.previewBytes).toBeGreaterThan(0);
    });
  });

  describe("isBinaryLikePath", () => {
    it("detects binary-like file extensions case-insensitively", () => {
      const p = policy();

      expect(isBinaryLikePath("/repo/image.PNG", p)).toBe(true);
      expect(isBinaryLikePath("/repo/archive.Zip", p)).toBe(true);
      expect(isBinaryLikePath("/repo/font.WOFF2", p)).toBe(true);
      expect(isBinaryLikePath("/repo/program.bin", p)).toBe(true);
    });

    it("does not classify ordinary text-like extensions as binary-like", () => {
      const p = policy();

      expect(isBinaryLikePath("/repo/src/App.tsx", p)).toBe(false);
      expect(isBinaryLikePath("/repo/docs/README.md", p)).toBe(false);
      expect(isBinaryLikePath("/repo/config/settings.json", p)).toBe(false);
      expect(isBinaryLikePath("/repo/script.sh", p)).toBe(false);
    });

    it("returns false when no path is available instead of inventing binary certainty", () => {
      expect(isBinaryLikePath(undefined, policy())).toBe(false);
      expect(isBinaryLikePath(null as unknown as string, policy())).toBe(false);
      expect(isBinaryLikePath("", policy())).toBe(false);
    });
  });

  describe("isBinaryLikeMime", () => {
    it("detects binary-like mime prefixes and exact mime matches", () => {
      const p = policy();

      expect(isBinaryLikeMime("image/png", p)).toBe(true);
      expect(isBinaryLikeMime("video/mp4", p)).toBe(true);
      expect(isBinaryLikeMime("font/woff2", p)).toBe(true);
      expect(isBinaryLikeMime("application/pdf", p)).toBe(true);
      expect(isBinaryLikeMime("application/octet-stream", p)).toBe(true);
    });

    it("does not classify ordinary text-like mime types as binary-like", () => {
      const p = policy();

      expect(isBinaryLikeMime("text/plain", p)).toBe(false);
      expect(isBinaryLikeMime("text/typescript", p)).toBe(false);
      expect(isBinaryLikeMime("application/json", p)).toBe(false);
      expect(isBinaryLikeMime("application/xml", p)).toBe(false);
    });

    it("returns false when no mime type is available", () => {
      expect(isBinaryLikeMime(undefined, policy())).toBe(false);
      expect(isBinaryLikeMime(null as unknown as string, policy())).toBe(false);
      expect(isBinaryLikeMime("", policy())).toBe(false);
    });
  });

  describe("classifyLargeFileDecision", () => {
    it("allows full editor access strictly below the editor allow threshold", () => {
      const result = classifyLargeFileDecision(
        probe({ purpose: "editor", sizeBytes: 32 * 1024 }),
        policy(),
      );

      expectDecision(result, { enabled: false, decision: "allow" });
      expect(result.reason).toBeNull();
    });

    it("degrades editor access at or above the editor allow threshold but below deny threshold", () => {
      const p = policy({ editorAllowBytes: 1000, editorDegradeBytes: 5000, previewBytes: 300 });

      const atBoundary = classifyLargeFileDecision(
        probe({ purpose: "editor", sizeBytes: 1000 }),
        p,
      );
      const aboveBoundary = classifyLargeFileDecision(
        probe({ purpose: "editor", sizeBytes: 3200 }),
        p,
      );

      expectDecision(atBoundary, { enabled: true, decision: "degrade" });
      expectDecision(aboveBoundary, { enabled: true, decision: "degrade" });
      expect(atBoundary.previewBytes).toBe(300);
      expect(aboveBoundary.previewBytes).toBe(300);
      expect(atBoundary.reason?.toLowerCase()).toContain("large");
    });

    it("denies editor access at or above the editor degrade threshold", () => {
      const p = policy({ editorAllowBytes: 1000, editorDegradeBytes: 5000, previewBytes: 512 });

      const atBoundary = classifyLargeFileDecision(
        probe({ purpose: "editor", sizeBytes: 5000 }),
        p,
      );
      const aboveBoundary = classifyLargeFileDecision(
        probe({ purpose: "editor", sizeBytes: 9000 }),
        p,
      );

      expectDecision(atBoundary, { enabled: true, decision: "deny" });
      expectDecision(aboveBoundary, { enabled: true, decision: "deny" });
      expect(atBoundary.previewBytes).toBe(512);
      expect(aboveBoundary.reason?.toLowerCase()).toContain("exceeds");
    });

    it("uses stricter diff thresholds for diff purpose than editor purpose", () => {
      const p = policy({
        editorAllowBytes: 10_000,
        editorDegradeBytes: 20_000,
        diffAllowBytes: 4_000,
        diffDegradeBytes: 8_000,
      });

      const editorDecision = classifyLargeFileDecision(
        probe({ purpose: "editor", sizeBytes: 7_000 }),
        p,
      );
      const diffDecision = classifyLargeFileDecision(
        probe({ purpose: "diff", sizeBytes: 7_000 }),
        p,
      );

      expectDecision(editorDecision, { enabled: false, decision: "allow" });
      expectDecision(diffDecision, { enabled: true, decision: "degrade" });
    });

    it("denies binary-like content when binary denial is enabled even if byte size is small", () => {
      const p = policy({ denyBinaryLike: true });

      const fromPath = classifyLargeFileDecision(
        probe({ path: "/repo/assets/logo.png", mimeType: "text/plain", sizeBytes: 12 }),
        p,
      );
      const fromMime = classifyLargeFileDecision(
        probe({ path: "/repo/unknown/blob", mimeType: "application/pdf", sizeBytes: 12 }),
        p,
      );

      expectDecision(fromPath, { enabled: true, decision: "deny" });
      expectDecision(fromMime, { enabled: true, decision: "deny" });
      expect(fromPath.reason?.toLowerCase()).toContain("binary");
      expect(fromMime.reason?.toLowerCase()).toContain("binary");
    });

    it("does not deny binary-like hints when binary denial is disabled, falling back to thresholds only", () => {
      const p = policy({ denyBinaryLike: false, editorAllowBytes: 1000, editorDegradeBytes: 5000 });

      const result = classifyLargeFileDecision(
        probe({ path: "/repo/assets/logo.png", mimeType: "image/png", sizeBytes: 200 }),
        p,
      );

      expectDecision(result, { enabled: false, decision: "allow" });
    });

    it("treats missing or negative sizes as deny-safe instead of granting full edit authority", () => {
      const negative = classifyLargeFileDecision(
        probe({ sizeBytes: -1 }),
        policy(),
      );
      const missing = classifyLargeFileDecision(
        probe({ sizeBytes: undefined as unknown as number }),
        policy(),
      );

      expectDecision(negative, { enabled: true, decision: "deny" });
      expectDecision(missing, { enabled: true, decision: "deny" });
    });

    it("preserves previewBytes in degrade and deny outcomes but not in full allow outcome", () => {
      const p = policy({ editorAllowBytes: 100, editorDegradeBytes: 200, previewBytes: 77 });

      const allow = classifyLargeFileDecision(probe({ sizeBytes: 99 }), p);
      const degrade = classifyLargeFileDecision(probe({ sizeBytes: 100 }), p);
      const deny = classifyLargeFileDecision(probe({ sizeBytes: 200 }), p);

      expect(allow.previewBytes).toBeNull();
      expect(degrade.previewBytes).toBe(77);
      expect(deny.previewBytes).toBe(77);
    });
  });

  describe("buildLargeFileDecision", () => {
    it("builds an explicit decision object from probe and policy without mutating inputs", () => {
      const p = policy({ editorAllowBytes: 1000, editorDegradeBytes: 2000 });
      const pr = probe({ sizeBytes: 1500, purpose: "editor" });

      const result = buildLargeFileDecision(pr, p);

      expectDecision(result, { enabled: true, decision: "degrade" });
      expect(pr.sizeBytes).toBe(1500);
      expect(p.editorAllowBytes).toBe(1000);
    });

    it("returns the same semantic decision as classifyLargeFileDecision", () => {
      const p = policy({ diffAllowBytes: 1000, diffDegradeBytes: 2000 });
      const pr = probe({ purpose: "diff", sizeBytes: 2100 });

      expect(buildLargeFileDecision(pr, p)).toEqual(classifyLargeFileDecision(pr, p));
    });
  });

  describe("shouldAllowFullEditor", () => {
    it("returns true only for explicit allow decisions", () => {
      expect(
        shouldAllowFullEditor({ enabled: false, decision: "allow", reason: null, previewBytes: null }),
      ).toBe(true);

      expect(
        shouldAllowFullEditor({ enabled: true, decision: "degrade", reason: "x", previewBytes: 10 }),
      ).toBe(false);

      expect(
        shouldAllowFullEditor({ enabled: true, decision: "deny", reason: "x", previewBytes: 10 }),
      ).toBe(false);
    });
  });

  describe("shouldAllowDiffEditor", () => {
    it("returns true only for explicit allow decisions in diff context", () => {
      expect(
        shouldAllowDiffEditor({ enabled: false, decision: "allow", reason: null, previewBytes: null }),
      ).toBe(true);

      expect(
        shouldAllowDiffEditor({ enabled: true, decision: "degrade", reason: "x", previewBytes: 10 }),
      ).toBe(false);
    });
  });

  describe("cross-surface monotonicity guarantees", () => {
    it("never widens from deny to degrade or allow as file size increases under fixed policy", () => {
      const p = policy({ editorAllowBytes: 1000, editorDegradeBytes: 2000 });

      const small = classifyLargeFileDecision(probe({ purpose: "editor", sizeBytes: 900 }), p);
      const medium = classifyLargeFileDecision(probe({ purpose: "editor", sizeBytes: 1500 }), p);
      const large = classifyLargeFileDecision(probe({ purpose: "editor", sizeBytes: 2500 }), p);

      expect(small.decision).toBe("allow");
      expect(medium.decision).toBe("degrade");
      expect(large.decision).toBe("deny");
    });

    it("never grants diff authority where editor authority is already denied under same size and policy", () => {
      const p = policy({
        editorAllowBytes: 1000,
        editorDegradeBytes: 2000,
        diffAllowBytes: 500,
        diffDegradeBytes: 1500,
      });

      const editor = classifyLargeFileDecision(probe({ purpose: "editor", sizeBytes: 2500 }), p);
      const diff = classifyLargeFileDecision(probe({ purpose: "diff", sizeBytes: 2500 }), p);

      expect(editor.decision).toBe("deny");
      expect(diff.decision).toBe("deny");
    });

    it("keeps preview sizing independent of exact byte size once degradation or denial is chosen", () => {
      const p = policy({ editorAllowBytes: 1000, editorDegradeBytes: 5000, previewBytes: 321 });

      const a = classifyLargeFileDecision(probe({ purpose: "editor", sizeBytes: 1001 }), p);
      const b = classifyLargeFileDecision(probe({ purpose: "editor", sizeBytes: 4900 }), p);
      const c = classifyLargeFileDecision(probe({ purpose: "editor", sizeBytes: 5000 }), p);

      expect(a.previewBytes).toBe(321);
      expect(b.previewBytes).toBe(321);
      expect(c.previewBytes).toBe(321);
    });
  });
});
