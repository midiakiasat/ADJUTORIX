import type { DiffFile, DiffHunk, DiffLine } from "./diff_review_model";

export type ActiveBufferDiffReviewInput = {
  path: string;
  baseline: string;
  working: string;
  hasBuffer: boolean;
  operational: boolean;
  contextRadius?: number;
  maxHunks?: number;
  maxUnchangedPreviewLines?: number;
};

const DEFAULT_CONTEXT_RADIUS = 3;
const DEFAULT_MAX_HUNKS = 32;
const DEFAULT_MAX_UNCHANGED_PREVIEW_LINES = 80;

type LineRange = {
  start: number;
  end: number;
};

const splitLines = (value: string): string[] => value.split(/\r?\n/);

const changedIndexesFor = (baselineLines: string[], workingLines: string[]): number[] => {
  const maxLines = Math.max(baselineLines.length, workingLines.length, 1);
  return Array.from({ length: maxLines }, (_, index) => index).filter(
    (index) => baselineLines[index] !== workingLines[index],
  );
};

const countLineChanges = (
  baselineLines: string[],
  workingLines: string[],
  changedIndexes: number[],
): { addedLines: number; removedLines: number } => {
  let addedLines = 0;
  let removedLines = 0;

  for (const index of changedIndexes) {
    const oldLine = baselineLines[index];
    const newLine = workingLines[index];

    if (oldLine === undefined && newLine !== undefined) {
      addedLines += 1;
    } else if (oldLine !== undefined && newLine === undefined) {
      removedLines += 1;
    } else {
      addedLines += 1;
      removedLines += 1;
    }
  }

  return { addedLines, removedLines };
};

const makeSyntheticLines = (
  path: string,
  baselineLines: string[],
  workingLines: string[],
  startIndex: number,
  endIndex: number,
): DiffLine[] => {
  const lines: DiffLine[] = [];

  for (let index = startIndex; index <= endIndex; index += 1) {
    const oldLine = baselineLines[index];
    const newLine = workingLines[index];

    if (oldLine === newLine) {
      lines.push({
        id: `${path}:line:${index + 1}:context`,
        kind: "context",
        content: newLine ?? oldLine ?? "",
        oldLineNumber: oldLine === undefined ? undefined : index + 1,
        newLineNumber: newLine === undefined ? undefined : index + 1,
      });
      continue;
    }

    if (oldLine !== undefined) {
      lines.push({
        id: `${path}:line:${index + 1}:removed`,
        kind: "removed",
        content: oldLine,
        oldLineNumber: index + 1,
      });
    }

    if (newLine !== undefined) {
      lines.push({
        id: `${path}:line:${index + 1}:added`,
        kind: "added",
        content: newLine,
        newLineNumber: index + 1,
      });
    }
  }

  return lines;
};

const buildChangedRanges = (
  changedIndexes: number[],
  maxLines: number,
  contextRadius: number,
): LineRange[] => {
  const ranges: LineRange[] = [];

  for (const changedIndex of changedIndexes) {
    const start = Math.max(0, changedIndex - contextRadius);
    const end = Math.min(maxLines - 1, changedIndex + contextRadius);
    const previous = ranges[ranges.length - 1];

    if (previous && start <= previous.end + 1) {
      previous.end = Math.max(previous.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  return ranges;
};

const buildSyntheticHunks = (input: {
  path: string;
  baselineLines: string[];
  workingLines: string[];
  hasBuffer: boolean;
  changedIndexes: number[];
  contextRadius: number;
  maxHunks: number;
  maxUnchangedPreviewLines: number;
}): DiffHunk[] => {
  const maxLines = Math.max(input.baselineLines.length, input.workingLines.length, 1);

  if (!input.hasBuffer) {
    return [
      {
        id: `${input.path}:synthetic-hunk:empty`,
        header: `@@ active-buffer ${input.path} @@`,
        summary: "Select a workspace file to hydrate diff review.",
        decision: "needs-attention",
        diagnosticsCount: 0,
        diagnosticsSeverity: "none",
        lines: makeSyntheticLines(
          input.path,
          input.baselineLines,
          input.workingLines,
          0,
          Math.min(maxLines - 1, input.maxUnchangedPreviewLines - 1),
        ),
      },
    ];
  }

  if (input.changedIndexes.length === 0) {
    return [
      {
        id: `${input.path}:synthetic-hunk:unchanged`,
        header: `@@ active-buffer ${input.path} @@`,
        summary: "No working-copy changes detected for the active editor buffer.",
        decision: "accepted",
        diagnosticsCount: 0,
        diagnosticsSeverity: "none",
        lines: makeSyntheticLines(
          input.path,
          input.baselineLines,
          input.workingLines,
          0,
          Math.min(maxLines - 1, input.maxUnchangedPreviewLines - 1),
        ),
      },
    ];
  }

  return buildChangedRanges(input.changedIndexes, maxLines, input.contextRadius)
    .slice(0, input.maxHunks)
    .map((range, hunkIndex) => {
      const lineCount = range.end - range.start + 1;

      return {
        id: `${input.path}:synthetic-hunk:${hunkIndex + 1}`,
        header: `@@ -${range.start + 1},${lineCount} +${range.start + 1},${lineCount} @@`,
        summary: `Changed line window ${range.start + 1}-${range.end + 1}.`,
        decision: "needs-attention",
        diagnosticsCount: 0,
        diagnosticsSeverity: "none",
        lines: makeSyntheticLines(input.path, input.baselineLines, input.workingLines, range.start, range.end),
      };
    });
};

export const buildActiveBufferDiffReviewFile = (input: ActiveBufferDiffReviewInput): DiffFile => {
  const baselineLines = splitLines(input.baseline);
  const workingLines = splitLines(input.working);
  const changedIndexes = changedIndexesFor(baselineLines, workingLines);
  const { addedLines, removedLines } = input.hasBuffer
    ? countLineChanges(baselineLines, workingLines, changedIndexes)
    : { addedLines: 0, removedLines: 0 };

  const hunks = buildSyntheticHunks({
    path: input.path,
    baselineLines,
    workingLines,
    hasBuffer: input.hasBuffer,
    changedIndexes,
    contextRadius: input.contextRadius ?? DEFAULT_CONTEXT_RADIUS,
    maxHunks: input.maxHunks ?? DEFAULT_MAX_HUNKS,
    maxUnchangedPreviewLines: input.maxUnchangedPreviewLines ?? DEFAULT_MAX_UNCHANGED_PREVIEW_LINES,
  });

  return {
    id: input.path,
    path: input.path,
    status: input.hasBuffer ? (input.working === input.baseline ? "unchanged" : "preview") : "empty",
    original: input.baseline,
    modified: input.working,
    addedLines,
    removedLines,
    diagnosticsCount: 0,
    diagnosticsSeverity: "none",
    reviewStatus: input.hasBuffer ? "reviewable" : "no-buffer",
    verifyStatus: input.operational ? "ready" : "blocked",
    applyStatus: input.operational ? "guarded" : "blocked",
    healthStatus: input.operational ? "operational" : "not-operational",
    hunks,
  };
};
