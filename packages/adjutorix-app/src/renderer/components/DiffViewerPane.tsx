import React, { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  FileCode2,
  Filter,
  GitBranch,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Sparkles,
  SplitSquareVertical,
  Target,
  Wand2,
} from "lucide-react";

/**
 * ADJUTORIX APP — RENDERER / COMPONENTS / DiffViewerPane.tsx
 *
 * Canonical governed diff/review surface.
 *
 * Purpose:
 * - provide the authoritative renderer-side diff viewer for patch review
 * - unify baseline vs preview/working comparison, file and hunk structure,
 *   review decisions, diagnostics pressure, lineage identifiers, and navigation intent
 *   under one deterministic component contract
 * - prevent diff viewing from degenerating into raw added/removed lines detached from
 *   preview lineage, verification posture, or review state
 * - expose explicit selection/review/navigation actions upward without applying patches
 *
 * Architectural role:
 * - DiffViewerPane is the visual inspection surface for governed patch review
 * - it renders explicit diff data supplied by renderer stores/contexts
 * - it must remain informative in empty, partial, degraded, and fully reviewed states
 *
 * Hard invariants:
 * - visible comparison mode is explicit and does not silently change text identity
 * - file and hunk ordering are the provided ordering
 * - review/diagnostics/trust badges annotate but never alter diff identity
 * - all visible actions map to explicit callbacks or explicit disabled state
 * - identical props yield identical visual ordering and status semantics
 * - no placeholders, fake diff generation, or hidden mutation side effects
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type DiffTrustLevel = "unknown" | "untrusted" | "restricted" | "trusted";
export type DiffSeverity = "none" | "info" | "warn" | "error" | "critical";
export type DiffReviewState = "none" | "preview" | "approved" | "verified" | "applied";
export type DiffDecision = "unreviewed" | "accepted" | "rejected" | "needs-attention";
export type DiffComparisonMode = "baseline-vs-preview" | "baseline-vs-working" | "working-vs-preview";
export type DiffLineKind = "context" | "added" | "removed" | "meta";

export type DiffLine = {
  id: string;
  kind: DiffLineKind;
  oldLineNumber?: number | null;
  newLineNumber?: number | null;
  content: string;
  highlighted?: boolean;
};

export type DiffHunk = {
  id: string;
  header: string;
  summary?: string | null;
  lines: DiffLine[];
  diagnosticsSeverity?: DiffSeverity;
  diagnosticsCount?: number;
  decision?: DiffDecision;
};

export type DiffFile = {
  id: string;
  path: string;
  previousPath?: string | null;
  language?: string | null;
  addedLines?: number;
  removedLines?: number;
  diagnosticsSeverity?: DiffSeverity;
  diagnosticsCount?: number;
  reviewState?: DiffReviewState;
  decision?: DiffDecision;
  trustLevel?: DiffTrustLevel;
  modified?: boolean;
  generated?: boolean;
  hunks: DiffHunk[];
};

export type DiffViewerPaneProps = {
  title?: string;
  subtitle?: string;
  comparisonMode?: DiffComparisonMode;
  patchId?: string | null;
  previewHash?: string | null;
  verifyPassed?: boolean;
  applyReady?: boolean;
  trustLevel?: DiffTrustLevel;
  loading?: boolean;
  files: DiffFile[];
  selectedFileId?: string | null;
  selectedHunkId?: string | null;
  expandedFileIds?: string[];
  showOnlyAttention?: boolean;
  showOnlyDiagnostics?: boolean;
  showWhitespace?: boolean;
  splitView?: boolean;
  onSetComparisonMode?: (mode: DiffComparisonMode) => void;
  onSelectFile?: (file: DiffFile) => void;
  onSelectHunk?: (file: DiffFile, hunk: DiffHunk) => void;
  onToggleFileExpanded?: (fileId: string) => void;
  onToggleAttentionOnly?: (value: boolean) => void;
  onToggleDiagnosticsOnly?: (value: boolean) => void;
  onToggleWhitespace?: (value: boolean) => void;
  onToggleSplitView?: (value: boolean) => void;
  onSetDecision?: (file: DiffFile, decision: DiffDecision) => void;
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function normalizePath(path: string): string {
  const p = path.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  return p.endsWith("/") && p !== "/" ? p.slice(0, -1) : p;
}

function basename(path: string): string {
  const normalized = normalizePath(path);
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

function trustTone(level: DiffTrustLevel | undefined): string {
  switch (level) {
    case "trusted":
      return "border-emerald-700/30 bg-emerald-500/10 text-emerald-300";
    case "restricted":
      return "border-amber-700/30 bg-amber-500/10 text-amber-300";
    case "untrusted":
      return "border-rose-700/30 bg-rose-500/10 text-rose-300";
    default:
      return "border-zinc-700/30 bg-zinc-500/10 text-zinc-300";
  }
}

function trustIcon(level: DiffTrustLevel | undefined): JSX.Element {
  switch (level) {
    case "trusted":
      return <ShieldCheck className="h-3.5 w-3.5" />;
    case "restricted":
      return <ShieldAlert className="h-3.5 w-3.5" />;
    case "untrusted":
      return <ShieldX className="h-3.5 w-3.5" />;
    default:
      return <ShieldCheck className="h-3.5 w-3.5" />;
  }
}

function severityTone(severity: DiffSeverity | undefined): string {
  switch (severity) {
    case "critical":
    case "error":
      return "border-rose-700/30 bg-rose-500/10 text-rose-300";
    case "warn":
      return "border-amber-700/30 bg-amber-500/10 text-amber-300";
    case "info":
      return "border-sky-700/30 bg-sky-500/10 text-sky-300";
    default:
      return "border-zinc-700/30 bg-zinc-500/10 text-zinc-400";
  }
}

function reviewTone(state: DiffReviewState | undefined): string {
  switch (state) {
    case "preview":
      return "border-sky-700/30 bg-sky-500/10 text-sky-300";
    case "approved":
      return "border-indigo-700/30 bg-indigo-500/10 text-indigo-300";
    case "verified":
      return "border-emerald-700/30 bg-emerald-500/10 text-emerald-300";
    case "applied":
      return "border-violet-700/30 bg-violet-500/10 text-violet-300";
    default:
      return "border-zinc-700/30 bg-zinc-500/10 text-zinc-400";
  }
}

function decisionTone(decision: DiffDecision | undefined): string {
  switch (decision) {
    case "accepted":
      return "border-emerald-700/30 bg-emerald-500/10 text-emerald-300";
    case "rejected":
      return "border-rose-700/30 bg-rose-500/10 text-rose-300";
    case "needs-attention":
      return "border-amber-700/30 bg-amber-500/10 text-amber-300";
    default:
      return "border-zinc-700/30 bg-zinc-500/10 text-zinc-400";
  }
}

function lineTone(kind: DiffLineKind): string {
  switch (kind) {
    case "added":
      return "bg-emerald-500/10 text-emerald-100";
    case "removed":
      return "bg-rose-500/10 text-rose-100";
    case "meta":
      return "bg-zinc-800/80 text-zinc-400";
    default:
      return "bg-transparent text-zinc-300";
  }
}

function lineMarker(kind: DiffLineKind): string {
  switch (kind) {
    case "added":
      return "+";
    case "removed":
      return "-";
    case "meta":
      return "@";
    default:
      return " ";
  }
}

function attentionFile(file: DiffFile): boolean {
  return file.decision === "needs-attention" || (file.diagnosticsCount ?? 0) > 0 || file.reviewState === "preview";
}

function diagnosticsFile(file: DiffFile): boolean {
  return (file.diagnosticsCount ?? 0) > 0 || file.hunks.some((h) => (h.diagnosticsCount ?? 0) > 0);
}

// -----------------------------------------------------------------------------
// SUBCOMPONENTS
// -----------------------------------------------------------------------------

function ToggleChip(props: { label: string; active: boolean; icon?: React.ReactNode; onClick?: () => void }): JSX.Element {
  return (
    <button
      onClick={props.onClick}
      disabled={!props.onClick}
      className={cx(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition",
        props.active
          ? "border-indigo-700/30 bg-indigo-500/10 text-indigo-200"
          : "border-zinc-800 bg-zinc-950/60 text-zinc-300 hover:bg-zinc-900",
        !props.onClick && "cursor-not-allowed opacity-40",
      )}
    >
      {props.icon}
      {props.label}
    </button>
  );
}

function SummaryCard(props: { label: string; value: string; icon?: React.ReactNode; tone?: "neutral" | "good" | "warn" | "bad" }): JSX.Element {
  const tone =
    props.tone === "good"
      ? "border-emerald-700/30 bg-emerald-500/10 text-emerald-300"
      : props.tone === "warn"
        ? "border-amber-700/30 bg-amber-500/10 text-amber-300"
        : props.tone === "bad"
          ? "border-rose-700/30 bg-rose-500/10 text-rose-300"
          : "border-zinc-800 bg-zinc-950/60 text-zinc-200";

  return (
    <div className={cx("rounded-[1.5rem] border p-4 shadow-sm", tone)}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] opacity-70">{props.label}</div>
          <div className="mt-2 text-lg font-semibold tracking-tight">{props.value}</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-black/20 p-2.5 text-zinc-300">{props.icon ?? <FileCode2 className="h-4 w-4" />}</div>
      </div>
    </div>
  );
}

function FileHeader(props: {
  file: DiffFile;
  selected: boolean;
  expanded: boolean;
  onSelect?: (file: DiffFile) => void;
  onToggleExpand?: (fileId: string) => void;
  onSetDecision?: (file: DiffFile, decision: DiffDecision) => void;
}): JSX.Element {
  return (
    <div
      className={cx(
        "rounded-[1.5rem] border px-4 py-4 transition",
        props.selected ? "border-zinc-600 bg-zinc-800 text-zinc-50" : "border-zinc-800 bg-zinc-950/50 text-zinc-200",
      )}
    >
      <div className="flex items-start gap-3">
        <button
          onClick={() => props.onToggleExpand?.(props.file.id)}
          className="mt-0.5 rounded-xl border border-zinc-800 bg-zinc-900/60 p-2 text-zinc-300 hover:bg-zinc-800"
        >
          {props.expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>

        <button onClick={() => props.onSelect?.(props.file)} className="min-w-0 flex-1 text-left">
          <div className="flex min-w-0 items-center gap-3">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-2 text-zinc-300">
              <FileCode2 className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{basename(props.file.path)}</div>
              <div className="mt-1 truncate text-xs text-zinc-500">{props.file.path}</div>
              {props.file.previousPath ? <div className="mt-1 truncate text-xs text-zinc-600">from {props.file.previousPath}</div> : null}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.2em]">
            <span className={cx("inline-flex items-center gap-1 rounded-full border px-2 py-0.5", trustTone(props.file.trustLevel))}>
              {trustIcon(props.file.trustLevel)}
              {props.file.trustLevel ?? "unknown"}
            </span>
            {props.file.reviewState && props.file.reviewState !== "none" ? (
              <span className={cx("inline-flex items-center gap-1 rounded-full border px-2 py-0.5", reviewTone(props.file.reviewState))}>
                <GitBranch className="h-3 w-3" />
                {props.file.reviewState}
              </span>
            ) : null}
            {props.file.decision ? (
              <span className={cx("inline-flex items-center gap-1 rounded-full border px-2 py-0.5", decisionTone(props.file.decision))}>
                <Target className="h-3 w-3" />
                {props.file.decision}
              </span>
            ) : null}
            {props.file.diagnosticsCount ? (
              <span className={cx("inline-flex items-center gap-1 rounded-full border px-2 py-0.5", severityTone(props.file.diagnosticsSeverity))}>
                <AlertTriangle className="h-3 w-3" />
                {props.file.diagnosticsCount}
              </span>
            ) : null}
            {typeof props.file.addedLines === "number" ? <span className="rounded-full border border-emerald-700/30 bg-emerald-500/10 px-2 py-0.5 text-emerald-300">+{props.file.addedLines}</span> : null}
            {typeof props.file.removedLines === "number" ? <span className="rounded-full border border-rose-700/30 bg-rose-500/10 px-2 py-0.5 text-rose-300">-{props.file.removedLines}</span> : null}
          </div>
        </button>

        <div className="flex shrink-0 flex-wrap gap-2">
          {(["accepted", "needs-attention", "rejected"] as DiffDecision[]).map((decision) => (
            <button
              key={decision}
              onClick={() => props.onSetDecision?.(props.file, decision)}
              className={cx(
                "rounded-xl border px-3 py-2 text-[10px] font-medium uppercase tracking-[0.18em] transition",
                props.file.decision === decision
                  ? decisionTone(decision)
                  : "border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:bg-zinc-800",
              )}
            >
              {decision}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function HunkView(props: {
  file: DiffFile;
  hunk: DiffHunk;
  selected: boolean;
  splitView: boolean;
  showWhitespace: boolean;
  onSelect?: (file: DiffFile, hunk: DiffHunk) => void;
}): JSX.Element {
  const leftLines = props.hunk.lines.filter((line) => line.kind !== "added");
  const rightLines = props.hunk.lines.filter((line) => line.kind !== "removed");

  return (
    <div className={cx("rounded-[1.25rem] border shadow-sm", props.selected ? "border-zinc-600 bg-zinc-900 text-zinc-50" : "border-zinc-800 bg-zinc-950/40 text-zinc-200")}>
      <button onClick={() => props.onSelect?.(props.file, props.hunk)} className="w-full border-b border-zinc-800 px-4 py-3 text-left">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-zinc-700/30 bg-zinc-500/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] text-zinc-300">{props.hunk.header}</span>
          {props.hunk.summary ? <span className="text-sm text-zinc-400">{props.hunk.summary}</span> : null}
          {props.hunk.decision ? <span className={cx("rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.2em]", decisionTone(props.hunk.decision))}>{props.hunk.decision}</span> : null}
          {props.hunk.diagnosticsCount ? <span className={cx("rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.2em]", severityTone(props.hunk.diagnosticsSeverity))}>{props.hunk.diagnosticsCount} diagnostics</span> : null}
        </div>
      </button>

      {props.splitView ? (
        <div className="grid grid-cols-2 gap-px bg-zinc-800">
          <div className="bg-zinc-950/40">
            {leftLines.map((line) => (
              <div key={`${line.id}:left`} className={cx("grid grid-cols-[4rem_1.5rem_1fr] gap-3 px-3 py-1.5 font-mono text-xs leading-6", lineTone(line.kind), line.highlighted && "ring-1 ring-inset ring-amber-400/40")}>
                <div className="text-right text-zinc-500">{line.oldLineNumber ?? ""}</div>
                <div className="text-center text-zinc-500">{lineMarker(line.kind)}</div>
                <pre className="overflow-auto whitespace-pre-wrap break-words">{props.showWhitespace ? line.content.replace(/ /g, "·") : line.content}</pre>
              </div>
            ))}
          </div>
          <div className="bg-zinc-950/40">
            {rightLines.map((line) => (
              <div key={`${line.id}:right`} className={cx("grid grid-cols-[4rem_1.5rem_1fr] gap-3 px-3 py-1.5 font-mono text-xs leading-6", lineTone(line.kind), line.highlighted && "ring-1 ring-inset ring-amber-400/40")}>
                <div className="text-right text-zinc-500">{line.newLineNumber ?? ""}</div>
                <div className="text-center text-zinc-500">{lineMarker(line.kind)}</div>
                <pre className="overflow-auto whitespace-pre-wrap break-words">{props.showWhitespace ? line.content.replace(/ /g, "·") : line.content}</pre>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="bg-zinc-950/40">
          {props.hunk.lines.map((line) => (
            <div key={line.id} className={cx("grid grid-cols-[4rem_4rem_1.5rem_1fr] gap-3 px-3 py-1.5 font-mono text-xs leading-6", lineTone(line.kind), line.highlighted && "ring-1 ring-inset ring-amber-400/40")}>
              <div className="text-right text-zinc-500">{line.oldLineNumber ?? ""}</div>
              <div className="text-right text-zinc-500">{line.newLineNumber ?? ""}</div>
              <div className="text-center text-zinc-500">{lineMarker(line.kind)}</div>
              <pre className="overflow-auto whitespace-pre-wrap break-words">{props.showWhitespace ? line.content.replace(/ /g, "·") : line.content}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// MAIN COMPONENT
// -----------------------------------------------------------------------------

export default function DiffViewerPane(props: DiffViewerPaneProps): JSX.Element {
  const title = props.title ?? "Governed diff review";
  const subtitle =
    props.subtitle ??
    "Explicit patch comparison surface with lineage, review posture, diagnostics pressure, and file/hunk-level navigation.";

  const comparisonMode = props.comparisonMode ?? "baseline-vs-preview";
  const trustLevel = props.trustLevel ?? "unknown";
  const loading = props.loading ?? false;
  const showOnlyAttention = props.showOnlyAttention ?? false;
  const showOnlyDiagnostics = props.showOnlyDiagnostics ?? false;
  const showWhitespace = props.showWhitespace ?? false;
  const splitView = props.splitView ?? true;
  const expandedFileIds = useMemo(() => new Set(props.expandedFileIds ?? props.files.map((file) => file.id)), [props.expandedFileIds, props.files]);
  const [localFileId, setLocalFileId] = useState<string | null>(props.selectedFileId ?? null);
  const [localHunkId, setLocalHunkId] = useState<string | null>(props.selectedHunkId ?? null);

  const visibleFiles = useMemo(() => {
    return props.files.filter((file) => {
      if (showOnlyAttention && !attentionFile(file)) return false;
      if (showOnlyDiagnostics && !diagnosticsFile(file)) return false;
      return true;
    });
  }, [props.files, showOnlyAttention, showOnlyDiagnostics]);

  const selectedFileId = props.selectedFileId ?? localFileId ?? visibleFiles[0]?.id ?? null;
  const selectedFile = visibleFiles.find((file) => file.id === selectedFileId) ?? visibleFiles[0] ?? null;
  const selectedHunkId = props.selectedHunkId ?? localHunkId ?? selectedFile?.hunks[0]?.id ?? null;

  const summary = useMemo(() => {
    const added = visibleFiles.reduce((n, file) => n + (file.addedLines ?? 0), 0);
    const removed = visibleFiles.reduce((n, file) => n + (file.removedLines ?? 0), 0);
    const hunks = visibleFiles.reduce((n, file) => n + file.hunks.length, 0);
    return { added, removed, hunks, files: visibleFiles.length };
  }, [visibleFiles]);

  return (
    <section className="flex h-full min-h-0 flex-col rounded-[2rem] border border-zinc-800 bg-zinc-900/70 shadow-xl">
      <div className="border-b border-zinc-800 px-5 py-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Patch review</div>
            <h2 className="mt-1 text-lg font-semibold text-zinc-50">{title}</h2>
            <p className="mt-2 text-sm leading-7 text-zinc-400">{subtitle}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={cx("inline-flex items-center gap-1 rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.2em]", trustTone(trustLevel))}>
              {trustIcon(trustLevel)}
              {trustLevel}
            </span>
            {props.previewHash ? <span className="inline-flex items-center gap-1 rounded-full border border-sky-700/30 bg-sky-500/10 px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-sky-300"><Sparkles className="h-3.5 w-3.5" />{props.previewHash}</span> : null}
            {props.patchId ? <span className="inline-flex items-center gap-1 rounded-full border border-indigo-700/30 bg-indigo-500/10 px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-indigo-300"><GitBranch className="h-3.5 w-3.5" />{props.patchId}</span> : null}
            {props.verifyPassed ? <span className="inline-flex items-center gap-1 rounded-full border border-emerald-700/30 bg-emerald-500/10 px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-emerald-300"><ShieldCheck className="h-3.5 w-3.5" />verified</span> : null}
            {props.applyReady ? <span className="inline-flex items-center gap-1 rounded-full border border-violet-700/30 bg-violet-500/10 px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-violet-300"><Wand2 className="h-3.5 w-3.5" />apply-ready</span> : null}
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryCard label="Files" value={String(summary.files)} icon={<FileCode2 className="h-4 w-4" />} />
          <SummaryCard label="Added" value={`+${summary.added}`} tone={summary.added > 0 ? "good" : "neutral"} icon={<CheckCircle2 className="h-4 w-4" />} />
          <SummaryCard label="Removed" value={`-${summary.removed}`} tone={summary.removed > 0 ? "bad" : "neutral"} icon={<AlertTriangle className="h-4 w-4" />} />
          <SummaryCard label="Hunks" value={String(summary.hunks)} icon={<Target className="h-4 w-4" />} />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {(["baseline-vs-preview", "baseline-vs-working", "working-vs-preview"] as DiffComparisonMode[]).map((mode) => (
            <ToggleChip key={mode} label={mode} active={comparisonMode === mode} icon={<SplitSquareVertical className="h-3.5 w-3.5" />} onClick={props.onSetComparisonMode ? () => props.onSetComparisonMode?.(mode) : undefined} />
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <ToggleChip label="Attention only" active={showOnlyAttention} icon={<AlertTriangle className="h-3.5 w-3.5" />} onClick={props.onToggleAttentionOnly ? () => props.onToggleAttentionOnly?.(!showOnlyAttention) : undefined} />
          <ToggleChip label="Diagnostics only" active={showOnlyDiagnostics} icon={<Filter className="h-3.5 w-3.5" />} onClick={props.onToggleDiagnosticsOnly ? () => props.onToggleDiagnosticsOnly?.(!showOnlyDiagnostics) : undefined} />
          <ToggleChip label="Whitespace" active={showWhitespace} icon={<Eye className="h-3.5 w-3.5" />} onClick={props.onToggleWhitespace ? () => props.onToggleWhitespace?.(!showWhitespace) : undefined} />
          <ToggleChip label="Split view" active={splitView} icon={splitView ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />} onClick={props.onToggleSplitView ? () => props.onToggleSplitView?.(!splitView) : undefined} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
        <AnimatePresence mode="wait">
          {loading ? (
            <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="grid min-h-[18rem] place-items-center rounded-[2rem] border border-zinc-800 bg-zinc-950/30">
              <div className="text-sm text-zinc-300">Hydrating governed diff surface…</div>
            </motion.div>
          ) : visibleFiles.length > 0 ? (
            <motion.div key="diff" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.16 }} className="grid gap-5 xl:grid-cols-[0.95fr_1.05fr]">
              <div className="space-y-3">
                {visibleFiles.map((file) => {
                  const selected = selectedFile?.id === file.id;
                  const expanded = expandedFileIds.has(file.id);
                  return (
                    <div key={file.id} className="space-y-2">
                      <FileHeader
                        file={file}
                        selected={selected}
                        expanded={expanded}
                        onSelect={(next) => {
                          setLocalFileId(next.id);
                          setLocalHunkId(next.hunks[0]?.id ?? null);
                          props.onSelectFile?.(next);
                        }}
                        onToggleExpand={props.onToggleFileExpanded}
                        onSetDecision={props.onSetDecision}
                      />

                      <AnimatePresence initial={false}>
                        {expanded && selected ? (
                          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                            <div className="space-y-3 pl-3">
                              {file.hunks.map((hunk) => (
                                <HunkView
                                  key={hunk.id}
                                  file={file}
                                  hunk={hunk}
                                  selected={selectedHunkId === hunk.id}
                                  splitView={splitView}
                                  showWhitespace={showWhitespace}
                                  onSelect={(selectedFile, selectedHunk) => {
                                    setLocalFileId(selectedFile.id);
                                    setLocalHunkId(selectedHunk.id);
                                    props.onSelectHunk?.(selectedFile, selectedHunk);
                                  }}
                                />
                              ))}
                            </div>
                          </motion.div>
                        ) : null}
                      </AnimatePresence>
                    </div>
                  );
                })}
              </div>

              <div className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-4 shadow-lg">
                {selectedFile ? (
                  <div className="space-y-4">
                    <div>
                      <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Selected file</div>
                      <div className="mt-2 text-lg font-semibold text-zinc-50">{basename(selectedFile.path)}</div>
                      <div className="mt-1 text-sm text-zinc-500">{selectedFile.path}</div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cx("rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.2em]", trustTone(selectedFile.trustLevel))}>{selectedFile.trustLevel ?? "unknown"}</span>
                      {selectedFile.reviewState && selectedFile.reviewState !== "none" ? <span className={cx("rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.2em]", reviewTone(selectedFile.reviewState))}>{selectedFile.reviewState}</span> : null}
                      {selectedFile.decision ? <span className={cx("rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.2em]", decisionTone(selectedFile.decision))}>{selectedFile.decision}</span> : null}
                    </div>

                    {selectedFile.hunks.length > 0 ? (
                      <div className="space-y-3">
                        {selectedFile.hunks.map((hunk) => (
                          <HunkView
                            key={`detail:${hunk.id}`}
                            file={selectedFile}
                            hunk={hunk}
                            selected={selectedHunkId === hunk.id}
                            splitView={splitView}
                            showWhitespace={showWhitespace}
                            onSelect={(selectedFile, selectedHunk) => {
                              setLocalFileId(selectedFile.id);
                              setLocalHunkId(selectedHunk.id);
                              props.onSelectHunk?.(selectedFile, selectedHunk);
                            }}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-[1.5rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-5 text-sm text-zinc-500">The selected file exposes no hunk data.</div>
                    )}
                  </div>
                ) : (
                  <div className="grid min-h-[20rem] place-items-center text-center">
                    <div className="max-w-lg">
                      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-[1.5rem] border border-zinc-800 bg-zinc-950/60 text-zinc-400">
                        <FileCode2 className="h-6 w-6" />
                      </div>
                      <h3 className="mt-6 text-xl font-semibold text-zinc-100">No selected diff file</h3>
                      <p className="mt-3 text-sm leading-7 text-zinc-500">Choose a visible file from the left review column to inspect its governed hunk structure and review state.</p>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          ) : (
            <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="grid min-h-[18rem] place-items-center rounded-[2rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-8 text-center">
              <div className="max-w-xl">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-[1.5rem] border border-zinc-800 bg-zinc-950/60 text-zinc-400">
                  <GitBranch className="h-6 w-6" />
                </div>
                <h3 className="mt-6 text-xl font-semibold text-zinc-100">No visible diff files</h3>
                <p className="mt-3 text-sm leading-7 text-zinc-500">The current diff surface has no visible files under the active review and diagnostics filters.</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="border-t border-zinc-800 px-4 py-3 text-xs text-zinc-500">
        <div className="flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-1"><GitBranch className="h-3.5 w-3.5" /> lineage explicit</span>
          <span className="inline-flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5" /> trust visible</span>
          <span className="inline-flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" /> diagnostics surfaced</span>
          <span className="inline-flex items-center gap-1"><Target className="h-3.5 w-3.5" /> review decisions explicit</span>
        </div>
      </div>
    </section>
  );
}
