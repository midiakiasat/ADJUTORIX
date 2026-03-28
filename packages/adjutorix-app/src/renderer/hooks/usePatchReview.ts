import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * ADJUTORIX APP — SRC / HOOKS / usePatchReview.ts
 *
 * Canonical governed patch-review hook.
 *
 * Purpose:
 * - provide one renderer-side, typed, memoized, event-driven surface for patch-review truth
 * - unify patch identity, file-level diffs, hunks, review decisions, comments, verify evidence,
 *   selection state, apply readiness, and refresh/update lifecycles behind one hook
 * - prevent patch panels, diff viewers, apply gates, verify panels, and ledger surfaces from each
 *   inventing their own review state shape or async loading path
 *
 * Architectural role:
 * - pure React hook over caller-supplied provider functions
 * - no Electron/window/global assumptions
 * - no hidden singleton store, no implicit polling, no background mutation
 * - all async transitions are explicit, cancellable, and sequence-guarded
 *
 * Hard invariants:
 * - identical provider results produce identical derived state
 * - stale async completions never overwrite newer state
 * - file/hunk/comment ordering is stable unless explicitly replaced by provider snapshot
 * - apply readiness is derived from explicit review and verify facts only
 * - provider subscription cleanup is deterministic
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type PatchReviewLoadState = "idle" | "loading" | "ready" | "refreshing" | "error";
export type PatchReviewStatus = "unknown" | "draft" | "in-review" | "approved" | "rejected" | "applied" | "stale";
export type PatchFileStatus = "pending" | "accepted" | "rejected" | "commented" | "unchanged";
export type PatchCommentStatus = "open" | "resolved";
export type PatchApplyReadiness = "unknown" | "blocked" | "ready" | "warning";
export type PatchChangeKind = "add" | "delete" | "modify" | "rename" | "copy" | "unknown";

export interface PatchRange {
  startLine: number;
  endLine: number;
}

export interface PatchLine {
  type: "context" | "add" | "delete";
  oldLineNumber?: number | null;
  newLineNumber?: number | null;
  content: string;
}

export interface PatchHunk {
  id: string;
  header: string;
  oldRange: PatchRange;
  newRange: PatchRange;
  lines: PatchLine[];
}

export interface PatchComment {
  id: string;
  author: string;
  body: string;
  createdAtMs: number;
  status: PatchCommentStatus;
  filePath?: string | null;
  hunkId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface PatchVerifyEvidence {
  verifyId: string;
  status: "unknown" | "passed" | "failed" | "partial";
  summary?: string | null;
  updatedAtMs?: number | null;
}

export interface PatchFileReview {
  id: string;
  path: string;
  oldPath?: string | null;
  kind: PatchChangeKind;
  status: PatchFileStatus;
  addedLineCount?: number | null;
  deletedLineCount?: number | null;
  hunks: PatchHunk[];
  comments?: PatchComment[];
  metadata?: Record<string, unknown>;
}

export interface PatchReviewSnapshot {
  patchId: string;
  title: string;
  status: PatchReviewStatus;
  createdAtMs?: number | null;
  updatedAtMs?: number | null;
  selectedFileId?: string | null;
  selectedHunkId?: string | null;
  files: PatchFileReview[];
  comments?: PatchComment[];
  verifyEvidence?: PatchVerifyEvidence[];
  applyReadiness?: PatchApplyReadiness;
  metadata?: Record<string, unknown>;
}

export interface PatchReviewDerivedState {
  totalFiles: number;
  totalHunks: number;
  totalComments: number;
  acceptedFiles: number;
  rejectedFiles: number;
  commentedFiles: number;
  selectedFile: PatchFileReview | null;
  selectedHunk: PatchHunk | null;
  filesById: Map<string, PatchFileReview>;
  hunksById: Map<string, PatchHunk>;
  commentsById: Map<string, PatchComment>;
  isApplyBlocked: boolean;
  isVerifyPassing: boolean;
}

export interface PatchReviewEvent {
  type:
    | "patch-review-snapshot"
    | "patch-review-status"
    | "patch-review-selection"
    | "patch-review-file"
    | "patch-review-comment"
    | "patch-review-verify"
    | "patch-review-readiness";
  snapshot?: PatchReviewSnapshot;
  status?: PatchReviewStatus;
  selectedFileId?: string | null;
  selectedHunkId?: string | null;
  file?: PatchFileReview;
  comment?: PatchComment;
  verifyEvidence?: PatchVerifyEvidence;
  applyReadiness?: PatchApplyReadiness;
}

export interface PatchReviewProvider {
  loadPatchReview: () => Promise<PatchReviewSnapshot>;
  refreshPatchReview?: () => Promise<PatchReviewSnapshot>;
  subscribe?: (listener: (event: PatchReviewEvent) => void) => () => void;
  selectFile?: (fileId: string | null) => Promise<void> | void;
  selectHunk?: (hunkId: string | null) => Promise<void> | void;
}

export interface UsePatchReviewOptions {
  autoLoad?: boolean;
  provider: PatchReviewProvider;
}

export interface UsePatchReviewResult {
  state: PatchReviewLoadState;
  snapshot: PatchReviewSnapshot | null;
  derived: PatchReviewDerivedState;
  error: Error | null;
  isReady: boolean;
  isBusy: boolean;
  reload: () => Promise<void>;
  refresh: () => Promise<void>;
  selectFile: (fileId: string | null) => Promise<void>;
  selectHunk: (hunkId: string | null) => Promise<void>;
  setSnapshot: (snapshot: PatchReviewSnapshot | null) => void;
}

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function normalizeLine(line: PatchLine): PatchLine {
  return {
    ...line,
    content: line.content ?? "",
    oldLineNumber: line.oldLineNumber ?? null,
    newLineNumber: line.newLineNumber ?? null,
  };
}

function normalizeHunk(hunk: PatchHunk): PatchHunk {
  return {
    ...hunk,
    lines: (hunk.lines ?? []).map(normalizeLine),
    oldRange: {
      startLine: Math.max(1, hunk.oldRange?.startLine ?? 1),
      endLine: Math.max(1, hunk.oldRange?.endLine ?? hunk.oldRange?.startLine ?? 1),
    },
    newRange: {
      startLine: Math.max(1, hunk.newRange?.startLine ?? 1),
      endLine: Math.max(1, hunk.newRange?.endLine ?? hunk.newRange?.startLine ?? 1),
    },
  };
}

function normalizeComment(comment: PatchComment): PatchComment {
  return {
    ...comment,
    createdAtMs: Number.isFinite(comment.createdAtMs) ? comment.createdAtMs : Date.now(),
    status: comment.status ?? "open",
    filePath: comment.filePath ? normalizePath(comment.filePath) : null,
    hunkId: comment.hunkId ?? null,
    metadata: { ...(comment.metadata ?? {}) },
  };
}

function normalizeVerifyEvidence(evidence: PatchVerifyEvidence): PatchVerifyEvidence {
  return {
    ...evidence,
    status: evidence.status ?? "unknown",
    summary: evidence.summary ?? null,
    updatedAtMs: evidence.updatedAtMs ?? null,
  };
}

function normalizeFile(file: PatchFileReview): PatchFileReview {
  return {
    ...file,
    path: normalizePath(file.path),
    oldPath: file.oldPath ? normalizePath(file.oldPath) : null,
    kind: file.kind ?? "unknown",
    status: file.status ?? "pending",
    addedLineCount: file.addedLineCount ?? 0,
    deletedLineCount: file.deletedLineCount ?? 0,
    hunks: (file.hunks ?? []).map(normalizeHunk),
    comments: (file.comments ?? []).map(normalizeComment).sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id)),
    metadata: { ...(file.metadata ?? {}) },
  };
}

function normalizeSnapshot(snapshot: PatchReviewSnapshot): PatchReviewSnapshot {
  return {
    ...snapshot,
    status: snapshot.status ?? "unknown",
    createdAtMs: snapshot.createdAtMs ?? null,
    updatedAtMs: snapshot.updatedAtMs ?? null,
    selectedFileId: snapshot.selectedFileId ?? null,
    selectedHunkId: snapshot.selectedHunkId ?? null,
    files: (snapshot.files ?? []).map(normalizeFile).sort((a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id)),
    comments: (snapshot.comments ?? []).map(normalizeComment).sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id)),
    verifyEvidence: (snapshot.verifyEvidence ?? []).map(normalizeVerifyEvidence).sort((a, b) => a.verifyId.localeCompare(b.verifyId)),
    applyReadiness: snapshot.applyReadiness ?? "unknown",
    metadata: { ...(snapshot.metadata ?? {}) },
  };
}

function buildDerived(snapshot: PatchReviewSnapshot | null): PatchReviewDerivedState {
  if (!snapshot) {
    return {
      totalFiles: 0,
      totalHunks: 0,
      totalComments: 0,
      acceptedFiles: 0,
      rejectedFiles: 0,
      commentedFiles: 0,
      selectedFile: null,
      selectedHunk: null,
      filesById: new Map<string, PatchFileReview>(),
      hunksById: new Map<string, PatchHunk>(),
      commentsById: new Map<string, PatchComment>(),
      isApplyBlocked: true,
      isVerifyPassing: false,
    };
  }

  const filesById = new Map<string, PatchFileReview>();
  const hunksById = new Map<string, PatchHunk>();
  const commentsById = new Map<string, PatchComment>();

  for (const file of snapshot.files) {
    filesById.set(file.id, file);
    for (const hunk of file.hunks) hunksById.set(hunk.id, hunk);
    for (const comment of file.comments ?? []) commentsById.set(comment.id, comment);
  }

  for (const comment of snapshot.comments ?? []) commentsById.set(comment.id, comment);

  const selectedFile = snapshot.selectedFileId ? filesById.get(snapshot.selectedFileId) ?? null : null;
  const selectedHunk = snapshot.selectedHunkId ? hunksById.get(snapshot.selectedHunkId) ?? null : null;
  const totalHunks = snapshot.files.reduce((sum, file) => sum + file.hunks.length, 0);
  const totalComments = commentsById.size;
  const acceptedFiles = snapshot.files.filter((file) => file.status === "accepted").length;
  const rejectedFiles = snapshot.files.filter((file) => file.status === "rejected").length;
  const commentedFiles = snapshot.files.filter((file) => file.status === "commented").length;
  const isApplyBlocked = snapshot.applyReadiness === "blocked" || rejectedFiles > 0;
  const isVerifyPassing = (snapshot.verifyEvidence ?? []).length > 0 && (snapshot.verifyEvidence ?? []).every((item) => item.status === "passed");

  return {
    totalFiles: snapshot.files.length,
    totalHunks,
    totalComments,
    acceptedFiles,
    rejectedFiles,
    commentedFiles,
    selectedFile,
    selectedHunk,
    filesById,
    hunksById,
    commentsById,
    isApplyBlocked,
    isVerifyPassing,
  };
}

function upsertById<T extends { id: string }>(items: T[], next: T, sortFn?: (a: T, b: T) => number): T[] {
  const idx = items.findIndex((item) => item.id === next.id);
  const merged = idx >= 0
    ? [...items.slice(0, idx), next, ...items.slice(idx + 1)]
    : [...items, next];
  return sortFn ? [...merged].sort(sortFn) : merged;
}

function applyPatchReviewEvent(previous: PatchReviewSnapshot | null, event: PatchReviewEvent): PatchReviewSnapshot | null {
  if (event.snapshot) {
    return normalizeSnapshot(event.snapshot);
  }

  if (!previous) return previous;

  switch (event.type) {
    case "patch-review-status":
      return {
        ...previous,
        status: event.status ?? previous.status,
      };
    case "patch-review-selection":
      return {
        ...previous,
        selectedFileId: event.selectedFileId ?? previous.selectedFileId,
        selectedHunkId: event.selectedHunkId ?? previous.selectedHunkId,
      };
    case "patch-review-file": {
      if (!event.file) return previous;
      const nextFile = normalizeFile(event.file);
      return {
        ...previous,
        files: upsertById(previous.files, nextFile, (a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id)),
      };
    }
    case "patch-review-comment": {
      if (!event.comment) return previous;
      const nextComment = normalizeComment(event.comment);
      return {
        ...previous,
        comments: upsertById(previous.comments ?? [], nextComment, (a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id)),
      };
    }
    case "patch-review-verify": {
      if (!event.verifyEvidence) return previous;
      const nextEvidence = normalizeVerifyEvidence(event.verifyEvidence);
      const idx = (previous.verifyEvidence ?? []).findIndex((item) => item.verifyId === nextEvidence.verifyId);
      const next = idx >= 0
        ? [...(previous.verifyEvidence ?? []).slice(0, idx), nextEvidence, ...(previous.verifyEvidence ?? []).slice(idx + 1)]
        : [...(previous.verifyEvidence ?? []), nextEvidence];
      return {
        ...previous,
        verifyEvidence: next.sort((a, b) => a.verifyId.localeCompare(b.verifyId)),
      };
    }
    case "patch-review-readiness":
      return {
        ...previous,
        applyReadiness: event.applyReadiness ?? previous.applyReadiness,
      };
    default:
      return previous;
  }
}

// -----------------------------------------------------------------------------
// HOOK
// -----------------------------------------------------------------------------

export function usePatchReview(options: UsePatchReviewOptions): UsePatchReviewResult {
  const { provider, autoLoad = true } = options;

  const [state, setState] = useState<PatchReviewLoadState>(autoLoad ? "loading" : "idle");
  const [snapshot, setSnapshotState] = useState<PatchReviewSnapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const requestSeqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const setSnapshot = useCallback((next: PatchReviewSnapshot | null) => {
    if (!mountedRef.current) return;
    setSnapshotState(next ? normalizeSnapshot(next) : null);
  }, []);

  const runLoad = useCallback(
    async (mode: "load" | "refresh") => {
      const requestId = ++requestSeqRef.current;
      setError(null);
      setState((current) => {
        if (mode === "refresh" && (current === "ready" || current === "refreshing")) return "refreshing";
        return "loading";
      });

      try {
        const next = mode === "refresh" && provider.refreshPatchReview
          ? await provider.refreshPatchReview()
          : await provider.loadPatchReview();

        if (!mountedRef.current || requestId !== requestSeqRef.current) return;
        setSnapshotState(normalizeSnapshot(next));
        setState("ready");
      } catch (cause) {
        if (!mountedRef.current || requestId !== requestSeqRef.current) return;
        setError(cause instanceof Error ? cause : new Error(String(cause)));
        setState("error");
      }
    },
    [provider],
  );

  const reload = useCallback(async () => {
    await runLoad("load");
  }, [runLoad]);

  const refresh = useCallback(async () => {
    await runLoad("refresh");
  }, [runLoad]);

  const selectFile = useCallback(
    async (fileId: string | null) => {
      if (provider.selectFile) {
        await provider.selectFile(fileId);
      }
      setSnapshotState((current) => current ? { ...current, selectedFileId: fileId } : current);
    },
    [provider],
  );

  const selectHunk = useCallback(
    async (hunkId: string | null) => {
      if (provider.selectHunk) {
        await provider.selectHunk(hunkId);
      }
      setSnapshotState((current) => current ? { ...current, selectedHunkId: hunkId } : current);
    },
    [provider],
  );

  useEffect(() => {
    if (!autoLoad) return;
    void reload();
  }, [autoLoad, reload]);

  useEffect(() => {
    if (!provider.subscribe) return;

    const unsubscribe = provider.subscribe((event) => {
      if (!mountedRef.current) return;
      setSnapshotState((current) => applyPatchReviewEvent(current, event));
    });

    return () => {
      unsubscribe?.();
    };
  }, [provider]);

  const derived = useMemo(() => buildDerived(snapshot), [snapshot]);

  return {
    state,
    snapshot,
    derived,
    error,
    isReady: state === "ready",
    isBusy: state === "loading" || state === "refreshing",
    reload,
    refresh,
    selectFile,
    selectHunk,
    setSnapshot,
  };
}

export default usePatchReview;
