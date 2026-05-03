import { describe, expect, it } from "vitest";

/**
 * ADJUTORIX APP — TESTS / RENDERER / diagnostic_parser.test.ts
 *
 * Canonical diagnostic-parser contract suite.
 *
 * Purpose:
 * - verify that renderer/lib/diagnostic_parser preserves one authoritative normalization surface
 *   across heterogeneous raw diagnostic producers
 * - verify that severity, category, location, provenance, codes, fingerprints, and summary counts
 *   remain deterministic and producer-independent after normalization
 * - verify that malformed or partial payloads fail safely instead of silently widening, dropping,
 *   or inventing semantic meaning
 *
 * Test philosophy:
 * - no snapshots
 * - assert normalization semantics, boundary conditions, and aggregation guarantees directly
 * - prefer cross-producer equivalence and malformed-input resistance over happy-path-only coverage
 *
 * Notes:
 * - this suite assumes renderer/lib/diagnostic_parser exports the functions referenced below
 * - if the real module exports differ slightly, update the imports and helper adapters first
 */

import {
  parseDiagnostic,
  parseDiagnostics,
  summarizeDiagnostics,
  fingerprintDiagnostic,
  diagnosticSortKey,
  type NormalizedDiagnostic,
} from "../../src/renderer/lib/diagnostic_parser";

function diag(partial: Partial<NormalizedDiagnostic> & Pick<NormalizedDiagnostic, "id" | "severity" | "message">): NormalizedDiagnostic {
  return {
    category: "unknown",
    producer: "unknown",
    sourceLabel: "unknown",
    code: null,
    filePath: null,
    range: null,
    relatedPaths: [],
    tags: [],
    fingerprint: partial.id,
    jobId: null,
    verifyId: null,
    patchId: null,
    createdAtMs: 1711000000000,
    ...partial,
  } as NormalizedDiagnostic;
}

describe("renderer/lib/diagnostic_parser", () => {
  describe("parseDiagnostic", () => {
    it("normalizes a TypeScript-style diagnostic into canonical severity, provenance, and location fields", () => {
      const raw = {
        producer: "typescript",
        source: "tsc",
        code: 2322,
        severity: "error",
        messageText: "Type 'number' is not assignable to type 'string'.",
        file: "/repo/adjutorix-app/src/renderer/App.tsx",
        start: { line: 12, column: 8 },
        end: { line: 12, column: 18 },
        createdAtMs: 1711000001000,
      };

      const parsed = parseDiagnostic(raw);

      expect(parsed.severity).toBe("error");
      expect(parsed.producer).toBe("typescript");
      expect(parsed.sourceLabel).toBe("tsc");
      expect(parsed.code).toBe("TS2322");
      expect(parsed.filePath).toBe("/repo/adjutorix-app/src/renderer/App.tsx");
      expect(parsed.range).toEqual({
        start: { line: 12, column: 8 },
        end: { line: 12, column: 18 },
      });
      expect(parsed.message).toContain("Type 'number'");
    });

    it("normalizes an ESLint-style diagnostic into canonical lint provenance", () => {
      const raw = {
        producer: "eslint",
        source: "eslint",
        ruleId: "@typescript-eslint/no-explicit-any",
        severity: 1,
        message: "Unexpected any. Specify a different type.",
        filePath: "/repo/adjutorix-app/src/renderer/App.tsx",
        line: 20,
        column: 14,
        endLine: 20,
        endColumn: 17,
      };

      const parsed = parseDiagnostic(raw);

      expect(parsed.severity).toBe("warning");
      expect(parsed.category).toBe("lint");
      expect(parsed.producer).toBe("eslint");
      expect(parsed.code).toBe("@typescript-eslint/no-explicit-any");
      expect(parsed.range).toEqual({
        start: { line: 20, column: 14 },
        end: { line: 20, column: 17 },
      });
    });

    it("normalizes verify/replay diagnostics into canonical verification severity and lineage references", () => {
      const raw = {
        producer: "verify",
        source: "verify-run",
        severity: "fatal",
        category: "verification",
        code: "VERIFY_REPLAY_MISMATCH",
        message: "Replay mismatch detected at transaction edge 18 -> 19.",
        filePath: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
        startLine: 88,
        startColumn: 1,
        endLine: 88,
        endColumn: 32,
        verifyId: "verify-42",
        patchId: "patch-42",
        jobId: "job-verify-42",
      };

      const parsed = parseDiagnostic(raw);

      expect(parsed.severity).toBe("fatal");
      expect(parsed.category).toBe("verification");
      expect(parsed.code).toBe("VERIFY_REPLAY_MISMATCH");
      expect(parsed.verifyId).toBe("verify-42");
      expect(parsed.patchId).toBe("patch-42");
      expect(parsed.jobId).toBe("job-verify-42");
      expect(parsed.range?.start.line).toBe(88);
    });

    it("preserves fileless or rangeless diagnostics without inventing location data", () => {
      const raw = {
        producer: "eslint",
        source: "eslint",
        severity: "info",
        message: "File ignored by default ignore pattern.",
        code: "ignored-file",
      };

      const parsed = parseDiagnostic(raw);

      expect(parsed.filePath).toBeNull();
      expect(parsed.range).toBeNull();
      expect(parsed.message).toBe("File ignored by default ignore pattern.");
    });

    it("maps mixed producer-specific severities into one canonical severity lattice", () => {
      expect(parseDiagnostic({ producer: "a", severity: 0, message: "x" }).severity).toBe("info");
      expect(parseDiagnostic({ producer: "a", severity: 1, message: "x" }).severity).toBe("warning");
      expect(parseDiagnostic({ producer: "a", severity: 2, message: "x" }).severity).toBe("error");
      expect(parseDiagnostic({ producer: "a", severity: "fatal", message: "x" }).severity).toBe("fatal");
      expect(parseDiagnostic({ producer: "a", severity: "warn", message: "x" }).severity).toBe("warning");
    });

    it("derives stable textual codes from numeric TypeScript codes", () => {
      expect(parseDiagnostic({ producer: "typescript", code: 2339, message: "x" }).code).toBe("TS2339");
      expect(parseDiagnostic({ producer: "typescript", code: "2339", message: "x" }).code).toBe("TS2339");
    });

    it("normalizes related paths and tags into arrays without dropping explicit provenance", () => {
      const raw = {
        producer: "verify",
        severity: "error",
        message: "Ledger mismatch",
        relatedPaths: [
          "/repo/adjutorix-app/docs/LEDGER_AND_REPLAY.md",
          "/repo/adjutorix-app/packages/shared/src/ledger.ts",
        ],
        tags: ["ledger", "replay"],
      };

      const parsed = parseDiagnostic(raw);

      expect(parsed.relatedPaths).toEqual([
        "/repo/adjutorix-app/docs/LEDGER_AND_REPLAY.md",
        "/repo/adjutorix-app/packages/shared/src/ledger.ts",
      ]);
      expect(parsed.tags).toEqual(["ledger", "replay"]);
    });

    it("fails safely on missing message payloads instead of inventing meaningless diagnostics", () => {
      expect(() => parseDiagnostic({ producer: "typescript" })).toThrow();
      expect(() => parseDiagnostic({ producer: "eslint", severity: "error" })).toThrow();
    });
  });

  describe("fingerprintDiagnostic", () => {
    it("produces identical fingerprints for semantically identical diagnostics from different raw forms", () => {
      const a = parseDiagnostic({
        producer: "typescript",
        source: "tsc",
        code: 2322,
        severity: "error",
        messageText: "Type 'number' is not assignable to type 'string'.",
        file: "/repo/adjutorix-app/src/renderer/App.tsx",
        start: { line: 12, column: 8 },
        end: { line: 12, column: 18 },
      });

      const b = parseDiagnostic({
        producer: "typescript",
        source: "tsserver",
        code: "2322",
        severity: 2,
        message: "Type 'number' is not assignable to type 'string'.",
        filePath: "/repo/adjutorix-app/src/renderer/App.tsx",
        line: 12,
        column: 8,
        endLine: 12,
        endColumn: 18,
      });

      expect(fingerprintDiagnostic(a)).toBe(fingerprintDiagnostic(b));
    });

    it("changes fingerprint when semantic location changes even if message stays identical", () => {
      const a = parseDiagnostic({ producer: "eslint", severity: "warning", message: "Unused variable 'x'.", filePath: "/repo/a.ts", line: 3, column: 1 });
      const b = parseDiagnostic({ producer: "eslint", severity: "warning", message: "Unused variable 'x'.", filePath: "/repo/a.ts", line: 8, column: 1 });

      expect(fingerprintDiagnostic(a)).not.toBe(fingerprintDiagnostic(b));
    });
  });

  describe("parseDiagnostics", () => {
    it("normalizes heterogeneous diagnostic arrays into canonical diagnostics preserving input cardinality", () => {
      const parsed = parseDiagnostics([
        {
          producer: "typescript",
          source: "tsc",
          code: 2322,
          severity: "error",
          messageText: "Type 'number' is not assignable to type 'string'.",
          file: "/repo/adjutorix-app/src/renderer/App.tsx",
          start: { line: 12, column: 8 },
          end: { line: 12, column: 18 },
        },
        {
          producer: "eslint",
          source: "eslint",
          ruleId: "no-unused-vars",
          severity: 1,
          message: "Unused variable 'x'.",
          filePath: "/repo/adjutorix-app/src/renderer/App.tsx",
          line: 20,
          column: 4,
        },
        {
          producer: "verify",
          severity: "fatal",
          code: "VERIFY_REPLAY_MISMATCH",
          message: "Replay mismatch detected at transaction edge 18 -> 19.",
        },
      ]);

      expect(parsed).toHaveLength(3);
      expect(parsed.map((d) => d.severity)).toEqual(["error", "warning", "fatal"]);
    });

    it("preserves deterministic output ordering when input diagnostics are already ordered", () => {
      const parsed = parseDiagnostics([
        { producer: "a", severity: "warning", message: "first" },
        { producer: "a", severity: "error", message: "second" },
      ]);

      expect(parsed.map((d) => d.message)).toEqual(["first", "second"]);
    });
  });

  describe("diagnosticSortKey", () => {
    it("orders diagnostics by severity then file then position then message deterministically", () => {
      const diagnostics = [
        diag({ id: "d3", severity: "warning", message: "m3", filePath: "/repo/b.ts", range: { start: { line: 5, column: 1 }, end: { line: 5, column: 2 } } }),
        diag({ id: "d1", severity: "fatal", message: "m1", filePath: "/repo/a.ts", range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } }),
        diag({ id: "d2", severity: "error", message: "m2", filePath: "/repo/a.ts", range: { start: { line: 2, column: 1 }, end: { line: 2, column: 2 } } }),
        diag({ id: "d4", severity: "info", message: "m4", filePath: null, range: null }),
      ];

      const ordered = [...diagnostics].sort((a, b) => diagnosticSortKey(a).localeCompare(diagnosticSortKey(b)));
      expect(ordered.map((d) => d.id)).toEqual(["d1", "d2", "d3", "d4"]);
    });
  });

  describe("summarizeDiagnostics", () => {
    it("aggregates total and per-severity counts canonically", () => {
      const diagnostics = [
        diag({ id: "1", severity: "fatal", message: "fatal" }),
        diag({ id: "2", severity: "error", message: "error-1" }),
        diag({ id: "3", severity: "error", message: "error-2" }),
        diag({ id: "4", severity: "warning", message: "warn" }),
        diag({ id: "5", severity: "info", message: "info" }),
      ];

      const summary = summarizeDiagnostics(diagnostics);

      expect(summary.total).toBe(5);
      expect(summary.fatalCount).toBe(1);
      expect(summary.errorCount).toBe(2);
      expect(summary.warningCount).toBe(1);
      expect(summary.infoCount).toBe(1);
    });

    it("aggregates producer, category, and file distributions without dropping null-file diagnostics", () => {
      const diagnostics = [
        diag({ id: "1", severity: "error", message: "a", producer: "typescript", category: "type", filePath: "/repo/a.ts" }),
        diag({ id: "2", severity: "warning", message: "b", producer: "eslint", category: "lint", filePath: "/repo/a.ts" }),
        diag({ id: "3", severity: "fatal", message: "c", producer: "verify", category: "verification", filePath: null }),
      ];

      const summary = summarizeDiagnostics(diagnostics);

      expect(summary.byProducer).toEqual({
        typescript: 1,
        eslint: 1,
        verify: 1,
      });
      expect(summary.byCategory).toEqual({
        type: 1,
        lint: 1,
        verification: 1,
      });
      expect(summary.byFile).toEqual({
        "/repo/a.ts": 2,
      });
    });

    it("returns a zero summary for an empty diagnostic set", () => {
      const summary = summarizeDiagnostics([]);

      expect(summary.total).toBe(0);
      expect(summary.fatalCount).toBe(0);
      expect(summary.errorCount).toBe(0);
      expect(summary.warningCount).toBe(0);
      expect(summary.infoCount).toBe(0);
      expect(summary.byProducer).toEqual({});
      expect(summary.byCategory).toEqual({});
      expect(summary.byFile).toEqual({});
    });
  });

  describe("cross-producer semantic guarantees", () => {
    it("maps equivalent severity concepts from multiple producers into the same canonical warning class", () => {
      const ts = parseDiagnostic({ producer: "typescript", severity: "warning", message: "w" });
      const eslint = parseDiagnostic({ producer: "eslint", severity: 1, message: "w" });
      const verify = parseDiagnostic({ producer: "verify", severity: "warn", message: "w" });

      expect(ts.severity).toBe("warning");
      expect(eslint.severity).toBe("warning");
      expect(verify.severity).toBe("warning");
    });

    it("does not let source label override canonical producer identity", () => {
      const parsed = parseDiagnostic({
        producer: "typescript",
        source: "tsserver",
        severity: "error",
        message: "x",
      });

      expect(parsed.producer).toBe("typescript");
      expect(parsed.sourceLabel).toBe("tsserver");
    });

    it("keeps duplicate messages from different files or lines semantically distinct after normalization", () => {
      const a = parseDiagnostic({ producer: "eslint", severity: "warning", message: "Unused variable 'x'.", filePath: "/repo/a.ts", line: 3, column: 1 });
      const b = parseDiagnostic({ producer: "eslint", severity: "warning", message: "Unused variable 'x'.", filePath: "/repo/b.ts", line: 3, column: 1 });
      const c = parseDiagnostic({ producer: "eslint", severity: "warning", message: "Unused variable 'x'.", filePath: "/repo/a.ts", line: 4, column: 1 });

      expect(a.filePath).not.toBe(b.filePath);
      expect(fingerprintDiagnostic(a)).not.toBe(fingerprintDiagnostic(b));
      expect(fingerprintDiagnostic(a)).not.toBe(fingerprintDiagnostic(c));
    });
  });
});
