export type PatchLineKind = "context" | "add" | "delete";

export interface PatchLine {
  readonly kind: PatchLineKind;
  readonly content: string;
}

export interface PatchHunkRange {
  readonly start: number;
  readonly count: number;
}

export interface PatchHunk {
  readonly oldRange: PatchHunkRange;
  readonly newRange: PatchHunkRange;
  readonly header: string;
  readonly lines: readonly PatchLine[];
}

function assertRange(range: PatchHunkRange, field: string): void {
  if (!Number.isInteger(range.start) || range.start < 0) {
    throw new Error(`${field}.start must be an integer >= 0`);
  }
  if (!Number.isInteger(range.count) || range.count < 0) {
    throw new Error(`${field}.count must be an integer >= 0`);
  }
}

export function assertPatchLine(line: PatchLine, field = "patchLine"): void {
  if (!["context", "add", "delete"].includes(line.kind)) {
    throw new Error(`${field}.kind is invalid`);
  }
  if (typeof line.content !== "string") {
    throw new Error(`${field}.content must be a string`);
  }
}

export function assertPatchHunk(hunk: PatchHunk, field = "patchHunk"): void {
  assertRange(hunk.oldRange, `${field}.oldRange`);
  assertRange(hunk.newRange, `${field}.newRange`);
  if (typeof hunk.header !== "string") {
    throw new Error(`${field}.header must be a string`);
  }
  hunk.lines.forEach((line, index) => assertPatchLine(line, `${field}.lines[${index}]`));
}

export function patchHunkLineDelta(hunk: PatchHunk): number {
  let delta = 0;
  for (const line of hunk.lines) {
    if (line.kind === "add") {
      delta += 1;
    } else if (line.kind === "delete") {
      delta -= 1;
    }
  }
  return delta;
}
