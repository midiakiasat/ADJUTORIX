import type { PatchConflict } from "./patch_conflicts.js";
import type { PatchHunk } from "./patch_hunks.js";
import type { PatchTarget } from "./patch_targets.js";

export interface PatchSummary {
  readonly patchId: string;
  readonly targetCount: number;
  readonly fileCount: number;
  readonly hunkCount: number;
  readonly addLineCount: number;
  readonly deleteLineCount: number;
  readonly conflictCount: number;
  readonly fatalConflictCount: number;
}

export function buildPatchSummary(
  patchId: string,
  targets: readonly PatchTarget[],
  hunks: readonly PatchHunk[],
  conflicts: readonly PatchConflict[]
): PatchSummary {
  let addLineCount = 0;
  let deleteLineCount = 0;

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") {
        addLineCount += 1;
      } else if (line.kind === "delete") {
        deleteLineCount += 1;
      }
    }
  }

  const fileCount = new Set(targets.map((target) => target.path)).size;
  const fatalConflictCount = conflicts.filter((conflict) => conflict.fatal).length;

  return {
    patchId,
    targetCount: targets.length,
    fileCount,
    hunkCount: hunks.length,
    addLineCount,
    deleteLineCount,
    conflictCount: conflicts.length,
    fatalConflictCount
  };
}
