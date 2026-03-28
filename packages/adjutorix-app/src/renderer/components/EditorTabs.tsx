import React, { useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Eye,
  FileCode2,
  FileJson,
  FileSearch,
  FileText,
  GitBranch,
  Lock,
  MoreHorizontal,
  Pin,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Sparkles,
  X,
} from "lucide-react";

/**
 * ADJUTORIX APP — RENDERER / COMPONENTS / EditorTabs.tsx
 *
 * Canonical governed editor tab strip.
 *
 * Purpose:
 * - provide the authoritative renderer-side tab surface for open editor buffers
 * - unify active-buffer switching, dirty state, preview lineage, diagnostics pressure,
 *   trust posture, pinning, and close semantics under one deterministic component contract
 * - prevent the tab strip from degenerating into a cosmetic filename row that hides
 *   which buffer version is visible or whether a tab is safe to close/apply/review
 * - expose explicit state transitions upward without performing implicit persistence
 *   or mutation locally
 *
 * Architectural role:
 * - EditorTabs is the navigation surface for buffer identity and status
 * - it should reflect explicit buffer state supplied by renderer stores/contexts
 * - it must stay visually dense but semantically rich
 * - it must not invent buffer truth beyond provided props
 *
 * Hard invariants:
 * - exactly one active tab may be visually active at a time
 * - tab ordering is the provided ordering; no hidden resorting
 * - close/pin/context interactions remain explicit and separate from selection
 * - buffer status badges do not mutate buffer identity
 * - disabled actions are visually explicit and operationally inert
 * - identical props yield identical rendered order and status state
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type EditorTabTrustLevel = "unknown" | "untrusted" | "restricted" | "trusted";
export type EditorTabSeverity = "none" | "info" | "warn" | "error" | "critical";
export type EditorTabReviewState = "none" | "preview" | "approved" | "verified" | "applied";
export type EditorTabVisibleSource = "working" | "preview";

export type EditorTabItem = {
  path: string;
  title?: string | null;
  language?: string | null;
  active?: boolean;
  pinned?: boolean;
  readOnly?: boolean;
  dirty?: boolean;
  generated?: boolean;
  visibleSource?: EditorTabVisibleSource;
  reviewState?: EditorTabReviewState;
  trustLevel?: EditorTabTrustLevel;
  diagnosticsSeverity?: EditorTabSeverity;
  diagnosticsCount?: number;
  previewHash?: string | null;
  patchId?: string | null;
  disabled?: boolean;
};

export type EditorTabsProps = {
  tabs: EditorTabItem[];
  activePath: string | null;
  maxVisiblePreviewHashChars?: number;
  onSelectTab?: (path: string) => void;
  onCloseTab?: (path: string) => void;
  onPinTab?: (path: string) => void;
  onContextAction?: (action: string, path: string) => void;
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

function truncateMiddle(value: string, max = 18): string {
  if (value.length <= max) return value;
  const left = Math.ceil((max - 1) / 2);
  const right = Math.floor((max - 1) / 2);
  return `${value.slice(0, left)}…${value.slice(value.length - right)}`;
}

function fileIcon(path: string, language?: string | null): JSX.Element {
  const lower = normalizePath(path).toLowerCase();
  if (language === "json" || lower.endsWith(".json")) return <FileJson className="h-4 w-4" />;
  if (lower.endsWith(".md") || lower.endsWith(".txt")) return <FileText className="h-4 w-4" />;
  if (
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".js") ||
    lower.endsWith(".jsx") ||
    lower.endsWith(".py") ||
    lower.endsWith(".rs") ||
    lower.endsWith(".go") ||
    lower.endsWith(".java")
  ) {
    return <FileCode2 className="h-4 w-4" />;
  }
  return <FileSearch className="h-4 w-4" />;
}

function trustTone(level: EditorTabTrustLevel | undefined): string {
  switch (level) {
    case "trusted":
      return "text-emerald-300";
    case "restricted":
      return "text-amber-300";
    case "untrusted":
      return "text-rose-300";
    default:
      return "text-zinc-500";
  }
}

function trustIcon(level: EditorTabTrustLevel | undefined): JSX.Element {
  switch (level) {
    case "trusted":
      return <ShieldCheck className="h-3.5 w-3.5" />;
    case "restricted":
      return <ShieldAlert className="h-3.5 w-3.5" />;
    case "untrusted":
      return <ShieldX className="h-3.5 w-3.5" />;
    default:
      return <Circle className="h-3.5 w-3.5" />;
  }
}

function severityTone(severity: EditorTabSeverity | undefined): string {
  switch (severity) {
    case "critical":
    case "error":
      return "text-rose-300";
    case "warn":
      return "text-amber-300";
    case "info":
      return "text-sky-300";
    default:
      return "text-zinc-500";
  }
}

function reviewTone(state: EditorTabReviewState | undefined): string {
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

function activeTab(tab: EditorTabItem, activePath: string | null): boolean {
  return !!tab.active || normalizePath(tab.path) === activePath;
}

// -----------------------------------------------------------------------------
// TAB BADGES
// -----------------------------------------------------------------------------

function InlineBadge(props: { className?: string; children: React.ReactNode }): JSX.Element {
  return <span className={cx("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.2em]", props.className)}>{props.children}</span>;
}

function TabBadges(props: { tab: EditorTabItem; maxVisiblePreviewHashChars: number }): JSX.Element {
  const { tab } = props;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tab.visibleSource === "preview" ? (
        <InlineBadge className="border-sky-700/30 bg-sky-500/10 text-sky-300">
          <Eye className="h-3 w-3" />
          preview
        </InlineBadge>
      ) : null}

      {tab.reviewState && tab.reviewState !== "none" ? (
        <InlineBadge className={reviewTone(tab.reviewState)}>
          <GitBranch className="h-3 w-3" />
          {tab.reviewState}
        </InlineBadge>
      ) : null}

      {tab.previewHash ? (
        <InlineBadge className="border-sky-700/30 bg-sky-500/10 text-sky-300">
          <Sparkles className="h-3 w-3" />
          {truncateMiddle(tab.previewHash, props.maxVisiblePreviewHashChars)}
        </InlineBadge>
      ) : null}

      {tab.patchId ? (
        <InlineBadge className="border-indigo-700/30 bg-indigo-500/10 text-indigo-300">
          <GitBranch className="h-3 w-3" />
          {truncateMiddle(tab.patchId, 14)}
        </InlineBadge>
      ) : null}
    </div>
  );
}

// -----------------------------------------------------------------------------
// MAIN COMPONENT
// -----------------------------------------------------------------------------

export default function EditorTabs(props: EditorTabsProps): JSX.Element {
  const activePath = props.activePath ? normalizePath(props.activePath) : null;
  const maxVisiblePreviewHashChars = props.maxVisiblePreviewHashChars ?? 14;

  const tabs = useMemo(
    () => props.tabs.map((tab) => ({ ...tab, path: normalizePath(tab.path) })),
    [props.tabs],
  );

  return (
    <section className="flex w-full min-w-0 flex-col rounded-t-[1.5rem] border border-zinc-800 bg-zinc-900/75 shadow-lg">
      <div className="border-b border-zinc-800 px-3 py-2">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-zinc-500">Editor buffers</div>
            <div className="mt-1 text-sm font-semibold text-zinc-100">Governed tab surface</div>
          </div>
          <div className="text-xs text-zinc-500">
            {tabs.length} tab{tabs.length === 1 ? "" : "s"} open
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <div className="flex min-w-max items-stretch gap-2 px-3 py-3">
          <AnimatePresence initial={false}>
            {tabs.map((tab) => {
              const isActive = activeTab(tab, activePath);
              const title = tab.title?.trim() || basename(tab.path);
              const disabled = !!tab.disabled;
              const diagnosticsCount = tab.diagnosticsCount ?? 0;
              const diagnosticsVisible = diagnosticsCount > 0 || (tab.diagnosticsSeverity && tab.diagnosticsSeverity !== "none");

              return (
                <motion.div
                  layout
                  key={tab.path}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.14 }}
                  className={cx(
                    "group relative flex w-[22rem] shrink-0 flex-col rounded-[1.35rem] border transition",
                    isActive
                      ? "border-zinc-600 bg-zinc-800 text-zinc-50 shadow-xl"
                      : "border-zinc-800 bg-zinc-950/70 text-zinc-200 hover:bg-zinc-900",
                    disabled && "cursor-not-allowed opacity-40",
                  )}
                >
                  <button
                    disabled={disabled || !props.onSelectTab}
                    onClick={() => props.onSelectTab?.(tab.path)}
                    className="flex min-w-0 flex-1 flex-col gap-3 px-4 py-3 text-left"
                  >
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-3">
                        <div className="mt-0.5 rounded-xl border border-zinc-800 bg-black/20 p-2 text-zinc-300">
                          {fileIcon(tab.path, tab.language)}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <div className="truncate text-sm font-semibold">{title}</div>
                            {tab.dirty ? <span className="h-2 w-2 rounded-full bg-amber-400" /> : null}
                            {tab.pinned ? <Pin className="h-3.5 w-3.5 text-zinc-400" /> : null}
                            {tab.readOnly ? <Lock className="h-3.5 w-3.5 text-zinc-400" /> : null}
                          </div>
                          <div className="mt-1 truncate text-[11px] text-zinc-500">{tab.path}</div>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 opacity-0 transition group-hover:opacity-100">
                        <button
                          disabled={disabled || !props.onPinTab}
                          onClick={(e) => {
                            e.stopPropagation();
                            props.onPinTab?.(tab.path);
                          }}
                          className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                        >
                          <Pin className="h-3.5 w-3.5" />
                        </button>
                        <button
                          disabled={disabled || !props.onContextAction}
                          onClick={(e) => {
                            e.stopPropagation();
                            props.onContextAction?.("open-menu", tab.path);
                          }}
                          className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                        >
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </button>
                        <button
                          disabled={disabled || !props.onCloseTab}
                          onClick={(e) => {
                            e.stopPropagation();
                            props.onCloseTab?.(tab.path);
                          }}
                          className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className={cx("inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.2em]", trustTone(tab.trustLevel))}>
                          {trustIcon(tab.trustLevel)}
                          {tab.trustLevel ?? "unknown"}
                        </span>

                        {diagnosticsVisible ? (
                          <span className={cx("inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.2em]", severityTone(tab.diagnosticsSeverity))}>
                            <AlertTriangle className="h-3.5 w-3.5" />
                            {diagnosticsCount > 0 ? diagnosticsCount : tab.diagnosticsSeverity}
                          </span>
                        ) : null}

                        {tab.generated ? (
                          <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                            <Circle className="h-3.5 w-3.5" />
                            generated
                          </span>
                        ) : null}

                        {tab.visibleSource === "working" && !tab.dirty && !diagnosticsVisible && tab.reviewState === "verified" ? (
                          <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.2em] text-emerald-300">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            stable
                          </span>
                        ) : null}
                      </div>
                    </div>

                    <TabBadges tab={tab} maxVisiblePreviewHashChars={maxVisiblePreviewHashChars} />
                  </button>

                  {isActive ? (
                    <div className="mx-4 mb-3 h-1 rounded-full bg-indigo-400/80" />
                  ) : (
                    <div className="mx-4 mb-3 h-1 rounded-full bg-transparent" />
                  )}
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </div>

      <div className="border-t border-zinc-800 px-4 py-2.5 text-xs text-zinc-500">
        <div className="flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-1"><GitBranch className="h-3.5 w-3.5" /> review-aware tabs</span>
          <span className="inline-flex items-center gap-1"><Eye className="h-3.5 w-3.5" /> visible source explicit</span>
          <span className="inline-flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" /> diagnostics surfaced</span>
          <span className="inline-flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5" /> trust visible</span>
        </div>
      </div>
    </section>
  );
}
