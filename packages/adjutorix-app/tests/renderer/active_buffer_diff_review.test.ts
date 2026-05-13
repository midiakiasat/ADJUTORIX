import { describe, expect, it } from "vitest";
import { buildActiveBufferDiffReviewFile } from "../../src/renderer/lib/active_buffer_diff_review";

describe("active buffer diff review builder", () => {
  it("emits separate added and removed rows for a modified line", () => {
    const file = buildActiveBufferDiffReviewFile({
      path: "src/example.ts",
      baseline: "one\ntwo\nthree",
      working: "one\nTWO\nthree",
      hasBuffer: true,
      operational: true,
    });

    expect(file.status).toBe("preview");
    expect(file.addedLines).toBe(1);
    expect(file.removedLines).toBe(1);
    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0]?.lines.map((line) => line.kind)).toEqual([
      "context",
      "removed",
      "added",
      "context",
    ]);
  });

  it("splits distant changes into bounded hunk windows", () => {
    const file = buildActiveBufferDiffReviewFile({
      path: "src/example.ts",
      baseline: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"].join("\n"),
      working: ["a", "B", "c", "d", "e", "f", "g", "h", "i", "J", "k"].join("\n"),
      hasBuffer: true,
      operational: true,
    });

    expect(file.hunks).toHaveLength(2);
    expect(file.hunks[0]?.header).toBe("@@ -1,5 +1,5 @@");
    expect(file.hunks[1]?.header).toBe("@@ -7,5 +7,5 @@");
    expect(file.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind === "added")).toHaveLength(2);
    expect(file.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind === "removed")).toHaveLength(2);
  });

  it("preserves no-buffer posture", () => {
    const file = buildActiveBufferDiffReviewFile({
      path: "No active buffer",
      baseline: "",
      working: "",
      hasBuffer: false,
      operational: false,
    });

    expect(file.status).toBe("empty");
    expect(file.reviewStatus).toBe("no-buffer");
    expect(file.verifyStatus).toBe("blocked");
    expect(file.hunks[0]?.id).toContain("empty");
  });
});
