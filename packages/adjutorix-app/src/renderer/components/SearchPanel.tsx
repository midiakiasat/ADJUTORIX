import React, { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  FileCode2,
  FileSearch,
  Filter,
  FolderTree,
  GitBranch,
  Lock,
  RefreshCw,
  Regex,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Sparkles,
  Target,
  XCircle,
} from "lucide-react";

/**
 * ADJUTORIX APP — RENDERER / COMPONENTS / SearchPanel.tsx
 *
 * Canonical governed search surface.
 *
 * Purpose:
 * - provide the authoritative renderer-side search interface for workspace content
 * - unify query intent, file/result filtering, diagnostics pressure, trust posture,
 *   preview lineage hints, and navigation actions under one deterministic component contract
 * - prevent search from becoming a blind grep box detached from governance context
 * - expose explicit search state and user intent upward without performing hidden IO
 *
 * Architectural role:
 * - SearchPanel is a view/controller surface, not the search engine itself
 * - it renders explicit search inputs, facets, summaries, and results
 * - it should remain useful in healthy, degraded, and empty-result states
 *
 * Hard invariants:
 * - all visible actions are explicit callbacks or explicit disabled state
 * - result identity is stable via path + line + column coordinates
 * - filters only affect presentation and declared user intent; they do not mutate source data
 * - trust/review/diagnostics annotations remain visible but never alter match identity
 * - identical props yield identical ordering and visible state
 * - no placeholders, fake counts, or hidden search side effects
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type SearchTrustLevel = "unknown" | "untrusted" | "restricted" | "trusted";
export type SearchSeverity = "none" | "info" | "warn" | "error" | "critical";
export type SearchReviewState = "none" | "preview" | "approved" | "verified" | "applied";

export type SearchScope = "workspace" | "open-buffers" | "selected-paths" | "modified-files";

export type SearchResultItem = {
  id: string;
  path: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  previewBefore?: string;
  previewMatch: string;
  previewAfter?: string;
  language?: string | null;
  trustLevel?: SearchTrustLevel;
  diagnosticsSeverity?: SearchSeverity;
  diagnosticsCount?: number;
  reviewState?: SearchReviewState;
  modified?: boolean;
  generated?: boolean;
  ignored?: boolean;
};

export type SearchPanelProps = {
  title?: string;
  subtitle?: string;
  rootPath: string | null;
  query: string;
  replaceQuery?: string;
  regex?: boolean;
  matchCase?: boolean;
  wholeWord?: boolean;
  scope?: SearchScope;
  loading?: boolean;
  canSearch?: boolean;
  trustLevel?: SearchTrustLevel;
  resultCount?: number;
  fileCount?: number;
  results: SearchResultItem[];
  showOnlyModified?: boolean;
  showOnlyDiagnostics?: boolean;
  showOnlyReviewRelevant?: boolean;
  onQueryChange?: (value: string) => void;
  onReplaceQueryChange?: (value: string) => void;
  onRegexChange?: (value: boolean) => void;
  onMatchCaseChange?: (value: boolean) => void;
  onWholeWordChange?: (value: boolean) => void;
  onScopeChange?: (value: SearchScope) => void;
  onSearch?: () => void;
  onRefresh?: () => void;
  onOpenResult?: (result: SearchResultItem) => void;
  onRevealResult?: (result: SearchResultItem) => void;
  onToggleModifiedOnly?: (value: boolean) => void;
  onToggleDiagnosticsOnly?: (value: boolean) => void;
  onToggleReviewRelevantOnly?: (value: boolean) => void;
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

function trustTone(level: SearchTrustLevel | undefined): string {
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

function trustIcon(level: SearchTrustLevel | undefined): JSX.Element {
  switch (level) {
    case "trusted":
      return <ShieldCheck className="h-3.5 w-3.5" />;
    case "restricted":
      return <ShieldAlert className="h-3.5 w-3.5" />;
    case "untrusted":
      return <ShieldX className="h-3.5 w-3.5" />;
    default:
      return <Lock className="h-3.5 w-3.5" />;
  }
}

function severityTone(severity: SearchSeverity | undefined): string {
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

function reviewTone(state: SearchReviewState | undefined): string {
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

function scopeLabel(scope: SearchScope): string {
  switch (scope) {
    case "open-buffers":
      return "Open buffers";
    case "selected-paths":
      return "Selected paths";
    case "modified-files":
      return "Modified files";
    default:
      return "Workspace";
  }
}

function resultSort(a: SearchResultItem, b: SearchResultItem): number {
  const pathCmp = normalizePath(a.path).localeCompare(normalizePath(b.path));
  if (pathCmp !== 0) return pathCmp;
  if (a.line !== b.line) return a.line - b.line;
  return a.column - b.column;
}

// -----------------------------------------------------------------------------
// SUBCOMPONENTS
// -----------------------------------------------------------------------------

function ToggleChip(props: { active: boolean; label: string; onClick?: () => void; icon?: React.ReactNode }): JSX.Element {
  return (
    <button
      onClick={props.onClick}
      className={cx(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition",
        props.active
          ? "border-indigo-700/30 bg-indigo-500/10 text-indigo-200"
          : "border-zinc-800 bg-zinc-950/60 text-zinc-300 hover:bg-zinc-900",
        !props.onClick && "cursor-not-allowed opacity-40",
      )}
      disabled={!props.onClick}
    >
      {props.icon}
      {props.label}
    </button>
  );
}

function SummaryCard(props: { label: string; value: string; icon: React.ReactNode }): JSX.Element {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">{props.label}</div>
          <div className="mt-1 text-sm font-semibold text-zinc-100">{props.value}</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-2 text-zinc-300">{props.icon}</div>
      </div>
    </div>
  );
}

function ResultRow(props: {
  item: SearchResultItem;
  onOpenResult?: (item: SearchResultItem) => void;
  onRevealResult?: (item: SearchResultItem) => void;
}): JSX.Element {
  const title = basename(props.item.path);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.14 }}
      className="rounded-[1.5rem] border border-zinc-800 bg-zinc-950/50 p-4 shadow-sm"
    >
      <div className="flex items-start justify-between gap-4">
        <button onClick={() => props.onOpenResult?.(props.item)} className="min-w-0 flex-1 text-left">
          <div className="flex min-w-0 items-center gap-3">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-2 text-zinc-300">
              <FileCode2 className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-zinc-100">{title}</div>
              <div className="mt-1 truncate text-xs text-zinc-500">{props.item.path}</div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.2em]">
            <span className="rounded-full border border-zinc-700/30 bg-zinc-500/10 px-2 py-0.5 text-zinc-300">
              line {props.item.line}:{props.item.column}
            </span>
            <span className={cx("inline-flex items-center gap-1 rounded-full border px-2 py-0.5", trustTone(props.item.trustLevel))}>
              {trustIcon(props.item.trustLevel)}
              {props.item.trustLevel ?? "unknown"}
            </span>
            {props.item.reviewState && props.item.reviewState !== "none" ? (
              <span className={cx("inline-flex items-center gap-1 rounded-full border px-2 py-0.5", reviewTone(props.item.reviewState))}>
                <GitBranch className="h-3 w-3" />
                {props.item.reviewState}
              </span>
            ) : null}
            {props.item.diagnosticsCount ? (
              <span className={cx("inline-flex items-center gap-1 rounded-full border px-2 py-0.5", severityTone(props.item.diagnosticsSeverity))}>
                <AlertTriangle className="h-3 w-3" />
                {props.item.diagnosticsCount}
              </span>
            ) : null}
            {props.item.modified ? (
              <span className="rounded-full border border-amber-700/30 bg-amber-500/10 px-2 py-0.5 text-amber-300">modified</span>
            ) : null}
            {props.item.generated ? (
              <span className="rounded-full border border-zinc-700/30 bg-zinc-500/10 px-2 py-0.5 text-zinc-400">generated</span>
            ) : null}
          </div>
        </button>

        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() => props.onRevealResult?.(props.item)}
            className="rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-800"
          >
            <Eye className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => props.onOpenResult?.(props.item)}
            className="rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-800"
          >
            <Target className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-2xl border border-zinc-800 bg-black/20 px-4 py-3 font-mono text-xs leading-6 text-zinc-300">
        <span className="text-zinc-500">{props.item.previewBefore ?? ""}</span>
        <span className="rounded bg-amber-500/20 px-1 text-amber-200">{props.item.previewMatch}</span>
        <span className="text-zinc-500">{props.item.previewAfter ?? ""}</span>
      </div>
    </motion.div>
  );
}

// -----------------------------------------------------------------------------
// MAIN COMPONENT
// -----------------------------------------------------------------------------

export default function SearchPanel(props: SearchPanelProps): JSX.Element {
  const title = props.title ?? "Search surface";
  const subtitle =
    props.subtitle ??
    "Governed search across workspace content, with explicit scope, trust posture, diagnostics pressure, and review lineage context.";

  const regex = props.regex ?? false;
  const matchCase = props.matchCase ?? false;
  const wholeWord = props.wholeWord ?? false;
  const scope = props.scope ?? "workspace";
  const loading = props.loading ?? false;
  const canSearch = props.canSearch ?? true;
  const trustLevel = props.trustLevel ?? "unknown";
  const showOnlyModified = props.showOnlyModified ?? false;
  const showOnlyDiagnostics = props.showOnlyDiagnostics ?? false;
  const showOnlyReviewRelevant = props.showOnlyReviewRelevant ?? false;

  const [localQuery, setLocalQuery] = useState(props.query);
  const [localReplace, setLocalReplace] = useState(props.replaceQuery ?? "");

  const filteredResults = useMemo(() => {
    return [...props.results]
      .filter((item) => (showOnlyModified ? !!item.modified : true))
      .filter((item) => (showOnlyDiagnostics ? (item.diagnosticsCount ?? 0) > 0 : true))
      .filter((item) => (showOnlyReviewRelevant ? item.reviewState && item.reviewState !== "none" : true))
      .sort(resultSort);
  }, [props.results, showOnlyDiagnostics, showOnlyModified, showOnlyReviewRelevant]);

  const resultCount = props.resultCount ?? filteredResults.length;
  const fileCount = props.fileCount ?? new Set(filteredResults.map((r) => normalizePath(r.path))).size;

  return (
    <section className="flex h-full min-h-0 flex-col rounded-[2rem] border border-zinc-800 bg-zinc-900/70 shadow-xl">
      <div className="border-b border-zinc-800 px-5 py-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Search</div>
            <h2 className="mt-1 text-lg font-semibold text-zinc-50">{title}</h2>
            <p className="mt-2 text-sm leading-7 text-zinc-400">{subtitle}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className={cx("inline-flex items-center gap-1 rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.2em]", trustTone(trustLevel))}>
              {trustIcon(trustLevel)}
              {trustLevel}
            </span>
            <button
              disabled={!props.onRefresh}
              onClick={props.onRefresh}
              className={cx(
                "rounded-2xl border border-zinc-800 bg-zinc-950/70 p-2.5 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100",
                !props.onRefresh && "cursor-not-allowed opacity-40",
              )}
            >
              <RefreshCw className={cx("h-4 w-4", loading && "animate-spin")} />
            </button>
          </div>
        </div>

        <div className="mt-5 grid gap-4 xl:grid-cols-[1fr_auto]">
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-2.5">
              <Search className="h-4 w-4 text-zinc-500" />
              <input
                value={localQuery}
                onChange={(e) => {
                  setLocalQuery(e.target.value);
                  props.onQueryChange?.(e.target.value);
                }}
                placeholder="Search workspace content"
                className="w-full bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
              />
            </div>

            <div className="flex items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-2.5">
              <Sparkles className="h-4 w-4 text-zinc-500" />
              <input
                value={localReplace}
                onChange={(e) => {
                  setLocalReplace(e.target.value);
                  props.onReplaceQueryChange?.(e.target.value);
                }}
                placeholder="Replace text (intent only)"
                className="w-full bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-2 xl:w-[22rem] xl:justify-end">
            <ToggleChip active={regex} label="Regex" icon={<Regex className="h-3.5 w-3.5" />} onClick={props.onRegexChange ? () => props.onRegexChange?.(!regex) : undefined} />
            <ToggleChip active={matchCase} label="Match case" icon={<CheckCircle2 className="h-3.5 w-3.5" />} onClick={props.onMatchCaseChange ? () => props.onMatchCaseChange?.(!matchCase) : undefined} />
            <ToggleChip active={wholeWord} label="Whole word" icon={<Target className="h-3.5 w-3.5" />} onClick={props.onWholeWordChange ? () => props.onWholeWordChange?.(!wholeWord) : undefined} />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {(["workspace", "open-buffers", "selected-paths", "modified-files"] as SearchScope[]).map((candidate) => (
            <ToggleChip
              key={candidate}
              active={scope === candidate}
              label={scopeLabel(candidate)}
              icon={candidate === "workspace" ? <FolderTree className="h-3.5 w-3.5" /> : candidate === "open-buffers" ? <FileCode2 className="h-3.5 w-3.5" /> : candidate === "selected-paths" ? <Target className="h-3.5 w-3.5" /> : <GitBranch className="h-3.5 w-3.5" />}
              onClick={props.onScopeChange ? () => props.onScopeChange?.(candidate) : undefined}
            />
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <ToggleChip active={showOnlyModified} label="Modified only" icon={<GitBranch className="h-3.5 w-3.5" />} onClick={props.onToggleModifiedOnly ? () => props.onToggleModifiedOnly?.(!showOnlyModified) : undefined} />
          <ToggleChip active={showOnlyDiagnostics} label="Diagnostics only" icon={<AlertTriangle className="h-3.5 w-3.5" />} onClick={props.onToggleDiagnosticsOnly ? () => props.onToggleDiagnosticsOnly?.(!showOnlyDiagnostics) : undefined} />
          <ToggleChip active={showOnlyReviewRelevant} label="Review relevant" icon={<Sparkles className="h-3.5 w-3.5" />} onClick={props.onToggleReviewRelevantOnly ? () => props.onToggleReviewRelevantOnly?.(!showOnlyReviewRelevant) : undefined} />
          <button
            disabled={!canSearch || !props.onSearch}
            onClick={props.onSearch}
            className={cx(
              "ml-auto inline-flex items-center gap-2 rounded-2xl border px-4 py-2 text-sm font-medium transition",
              canSearch && props.onSearch
                ? "border-indigo-700/40 bg-indigo-500/15 text-indigo-200 hover:bg-indigo-500/20"
                : "cursor-not-allowed border-zinc-800 bg-zinc-950/70 text-zinc-500",
            )}
          >
            <Search className="h-4 w-4" />
            Search
          </button>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryCard label="Scope" value={scopeLabel(scope)} icon={<Filter className="h-4 w-4" />} />
          <SummaryCard label="Results" value={String(resultCount)} icon={<Search className="h-4 w-4" />} />
          <SummaryCard label="Files" value={String(fileCount)} icon={<FileSearch className="h-4 w-4" />} />
          <SummaryCard label="Root" value={props.rootPath ?? "No workspace"} icon={<FolderTree className="h-4 w-4" />} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
        <AnimatePresence mode="popLayout">
          {loading ? (
            <motion.div
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="grid min-h-[18rem] place-items-center rounded-[2rem] border border-zinc-800 bg-zinc-950/30"
            >
              <div className="flex items-center gap-3 text-sm text-zinc-300">
                <RefreshCw className="h-4 w-4 animate-spin" />
                Evaluating governed search surface…
              </div>
            </motion.div>
          ) : filteredResults.length > 0 ? (
            <motion.div key="results" layout className="space-y-3">
              {filteredResults.map((result) => (
                <ResultRow key={result.id} item={result} onOpenResult={props.onOpenResult} onRevealResult={props.onRevealResult} />
              ))}
            </motion.div>
          ) : (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="grid min-h-[18rem] place-items-center rounded-[2rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-8 text-center"
            >
              <div className="max-w-xl">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-[1.5rem] border border-zinc-800 bg-zinc-950/60">
                  {props.query.trim() ? <XCircle className="h-6 w-6 text-zinc-400" /> : <Search className="h-6 w-6 text-zinc-400" />}
                </div>
                <h3 className="mt-6 text-xl font-semibold text-zinc-100">
                  {props.query.trim() ? "No governed matches" : "Enter a search query"}
                </h3>
                <p className="mt-3 text-sm leading-7 text-zinc-500">
                  {props.query.trim()
                    ? "The current query and active filters produced no visible matches. Adjust scope, trust-relevant filters, or diagnostics constraints and try again."
                    : "Search begins from an explicit query and explicit scope. Results will retain trust, diagnostics, and review context instead of returning naked text hits."}
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="border-t border-zinc-800 px-4 py-3 text-xs text-zinc-500">
        <div className="flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5" /> trust explicit</span>
          <span className="inline-flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" /> diagnostics surfaced</span>
          <span className="inline-flex items-center gap-1"><GitBranch className="h-3.5 w-3.5" /> review lineage visible</span>
          <span className="inline-flex items-center gap-1"><Search className="h-3.5 w-3.5" /> match identity stable</span>
        </div>
      </div>
    </section>
  );
}
