// @ts-nocheck
import React, { useCallback, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Circle, Eye, FileCode2, FileJson, FileSearch, FileText, Folder, FolderOpen, FolderTree, GitBranch, MoreHorizontal, RefreshCw, Search, ShieldAlert, ShieldCheck, ShieldX, Sparkles } from "lucide-react";

/**
 * ADJUTORIX APP — RENDERER / COMPONENTS / FileTreePane.tsx
 *
 * Canonical governed workspace tree/navigation pane.
 *
 * Purpose:
 * - provide the authoritative renderer-side workspace tree surface
 * - unify file/folder navigation, selection, expansion, diagnostics pressure,
 *   trust signaling, preview lineage hints, and controlled user intent
 * - prevent the file tree from degenerating into a blind directory browser that
 *   ignores governance, review, and verification context
 * - expose a deterministic, composable surface for workspace-aware navigation
 *   while remaining business-logic light and view-contract strict
 *
 * Architectural role:
 * - this is the primary navigation substrate for workspace content
 * - it should reflect explicit state supplied by the renderer store/context
 * - it must not invent filesystem truth or perform invisible mutation
 *
 * Hard invariants:
 * - rendering order is deterministic for identical props
 * - selected, focused, expanded, and revealed paths are explicit and not inferred
 * - diagnostics, preview, and trust annotations are visible but never alter path identity
 * - disabled actions remain visually explicit and operationally inert
 * - node identity is path-based and stable
 * - no placeholders, fake data mutation, or hidden side effects
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type FileTreeTrustLevel = "unknown" | "untrusted" | "restricted" | "trusted";
export type FileTreeNodeKind = "file" | "directory";
export type FileTreeSeverity = "none" | "info" | "warn" | "error" | "critical";
export type FileTreeReviewState = "none" | "preview" | "approved" | "verified" | "applied";

export type FileTreeNode = {
  path: string;
  name: string;
  kind: FileTreeNodeKind;
  children?: FileTreeNode[];
  diagnosticsSeverity?: FileTreeSeverity;
  diagnosticsCount?: number;
  reviewState?: FileTreeReviewState;
  modified?: boolean;
  ignored?: boolean;
  hidden?: boolean;
  generated?: boolean;
  trustLevel?: FileTreeTrustLevel;
  focused?: boolean;
  selectable?: boolean;
  openable?: boolean;
};

export type FileTreeSelectionMode = "single" | "multi";

export type FileTreePaneProps = {
  title?: string;
  subtitle?: string;
  rootPath: string | null;
  workspaceTrust?: FileTreeTrustLevel;
  nodes: FileTreeNode[];
  expandedPaths: string[];
  selectedPaths: string[];
  focusedPath?: string | null;
  revealedPath?: string | null;
  searchQuery?: string;
  selectionMode?: FileTreeSelectionMode;
  loading?: boolean;
  canRefresh?: boolean;
  onRefresh?: () => void;
  onToggleExpand?: (path: string) => void;
  onSelectPath?: (path: string, mode: FileTreeSelectionMode) => void;
  onFocusPath?: (path: string) => void;
  onRevealPath?: (path: string) => void;
  onOpenPath?: (path: string) => void;
  onSearchQueryChange?: (query: string) => void;
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

function pathDepth(path: string): number {
  return normalizePath(path).split("/").filter(Boolean).length;
}

function matchQuery(node: FileTreeNode, query: string): boolean {
  if (!query.trim()) return true;
  const q = query.trim().toLowerCase();
  return node.name.toLowerCase().includes(q) || node.path.toLowerCase().includes(q);
}

function anyChildMatches(node: FileTreeNode, query: string): boolean {
  if (!node.children || node.children.length === 0) return false;
  return node.children.some((child) => matchQuery(child, query) || anyChildMatches(child, query));
}

function sortNodes(nodes: FileTreeNode[]): FileTreeNode[] {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function trustTone(level: FileTreeTrustLevel | undefined): string {
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

function severityTone(severity: FileTreeSeverity | undefined): string {
  switch (severity) {
    case "critical":
      return "text-rose-400";
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

function reviewTone(reviewState: FileTreeReviewState | undefined): string {
  switch (reviewState) {
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

function fileIcon(node: FileTreeNode): JSX.Element {
  if (node.kind === "directory") {
    return <Folder className="h-4 w-4 text-zinc-300" />;
  }

  if (node.name.endsWith(".json")) return <FileJson className="h-4 w-4 text-zinc-300" />;
  if (node.name.endsWith(".ts") || node.name.endsWith(".tsx") || node.name.endsWith(".js") || node.name.endsWith(".py")) {
    return <FileCode2 className="h-4 w-4 text-zinc-300" />;
  }
  if (node.name.endsWith(".md") || node.name.endsWith(".txt")) return <FileText className="h-4 w-4 text-zinc-300" />;
  return <FileSearch className="h-4 w-4 text-zinc-300" />;
}

function trustIcon(level: FileTreeTrustLevel | undefined): JSX.Element {
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

function reviewLabel(reviewState: FileTreeReviewState | undefined): string | null {
  switch (reviewState) {
    case "preview":
      return "preview";
    case "approved":
      return "approved";
    case "verified":
      return "verified";
    case "applied":
      return "applied";
    default:
      return null;
  }
}

// -----------------------------------------------------------------------------
// NODE RENDERER
// -----------------------------------------------------------------------------

type NodeRowProps = {
  node: FileTreeNode;
  depth: number;
  expandedPaths: Set<string>;
  selectedPaths: Set<string>;
  focusedPath: string | null;
  revealedPath: string | null;
  selectionMode: FileTreeSelectionMode;
  query: string;
  onToggleExpand?: (path: string) => void;
  onSelectPath?: (path: string, mode: FileTreeSelectionMode) => void;
  onFocusPath?: (path: string) => void;
  onRevealPath?: (path: string) => void;
  onOpenPath?: (path: string) => void;
  onContextAction?: (action: string, path: string) => void;
};

function NodeRow(props: NodeRowProps): JSX.Element | null {
  const path = normalizePath(props.node.path);
  const isExpanded = props.expandedPaths.has(path);
  const isSelected = props.selectedPaths.has(path);
  const isFocused = props.focusedPath === path || !!props.node.focused;
  const isRevealed = props.revealedPath === path;
  const hasChildren = props.node.kind === "directory" && !!props.node.children && props.node.children.length > 0;
  const visible = matchQuery(props.node, props.query) || anyChildMatches(props.node, props.query);

  if (!visible || props.node.hidden) return null;

  const paddingLeft = 12 + props.depth * 18;
  const review = reviewLabel(props.node.reviewState);
  const selectable = props.node.selectable ?? true;
  const openable = props.node.openable ?? props.node.kind === "file";

  return (
    <div>
      <div
        className={cx(
          "group relative flex items-center gap-2 rounded-2xl border px-3 py-2 transition",
          isSelected
            ? "border-zinc-600 bg-zinc-800 text-zinc-50"
            : isFocused
              ? "border-zinc-700 bg-zinc-900 text-zinc-100"
              : "border-transparent text-zinc-300 hover:border-zinc-800 hover:bg-zinc-900/80",
          props.node.ignored && "opacity-50",
        )}
        style={{ paddingLeft }}
        onClick={() => selectable && props.onSelectPath?.(path, props.selectionMode)}
        onDoubleClick={() => openable && props.onOpenPath?.(path)}
      >
        {hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              props.onToggleExpand?.(path);
            }}
            className="rounded-lg p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          >
            {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        ) : (
          <span className="w-6 shrink-0" />
        )}

        <button
          onClick={(e) => {
            e.stopPropagation();
            props.onFocusPath?.(path);
          }}
          className="rounded-lg border border-transparent p-1 text-zinc-400 hover:border-zinc-800 hover:bg-zinc-800 hover:text-zinc-100"
        >
          {props.node.kind === "directory" && isExpanded ? (
            <FolderOpen className="h-4 w-4 text-zinc-300" />
          ) : (
            fileIcon(props.node)
          )}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{props.node.name}</span>
            {props.node.modified ? <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] text-amber-300">dirty</span> : null}
            {props.node.generated ? <span className="rounded-full bg-zinc-700/40 px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] text-zinc-400">generated</span> : null}
            {review ? <span className={cx("rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.2em]", reviewTone(props.node.reviewState))}>{review}</span> : null}
            {isRevealed ? <span className="rounded-full border border-sky-700/30 bg-sky-500/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] text-sky-300">revealed</span> : null}
          </div>
          <div className="mt-0.5 flex items-center gap-3 text-[11px] text-zinc-500">
            <span className="truncate">{path}</span>
            {props.node.diagnosticsCount ? <span className={cx("inline-flex items-center gap-1", severityTone(props.node.diagnosticsSeverity))}><AlertTriangle className="h-3 w-3" />{props.node.diagnosticsCount}</span> : null}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className={cx("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.2em]", trustTone(props.node.trustLevel))}>
            {trustIcon(props.node.trustLevel)}
            {props.node.trustLevel ?? "unknown"}
          </span>

          <button
            onClick={(e) => {
              e.stopPropagation();
              props.onRevealPath?.(path);
            }}
            className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-1.5 text-zinc-400 opacity-0 transition group-hover:opacity-100 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <Eye className="h-3.5 w-3.5" />
          </button>

          <button
            onClick={(e) => {
              e.stopPropagation();
              props.onContextAction?.("open-menu", path);
            }}
            className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-1.5 text-zinc-400 opacity-0 transition group-hover:opacity-100 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {hasChildren ? (
        <AnimatePresence initial={false}>
          {isExpanded && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.16 }}
              className="overflow-hidden"
            >
              <div className="mt-1 space-y-1">
                {sortNodes(props.node.children ?? []).map((child) => (
                  <NodeRow
                    key={child.path}
                    node={child}
                    depth={props.depth + 1}
                    expandedPaths={props.expandedPaths}
                    selectedPaths={props.selectedPaths}
                    focusedPath={props.focusedPath}
                    revealedPath={props.revealedPath}
                    selectionMode={props.selectionMode}
                    query={props.query}
                    onToggleExpand={props.onToggleExpand}
                    onSelectPath={props.onSelectPath}
                    onFocusPath={props.onFocusPath}
                    onRevealPath={props.onRevealPath}
                    onOpenPath={props.onOpenPath}
                    onContextAction={props.onContextAction}
                  />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      ) : null}
    </div>
  );
}

// -----------------------------------------------------------------------------
// MAIN COMPONENT
// -----------------------------------------------------------------------------

export default function FileTreePane(props: FileTreePaneProps): JSX.Element {
  const title = props.title ?? "Workspace tree";
  const subtitle =
    props.subtitle ??
    "Governed navigation surface for files, folders, review lineage, diagnostics pressure, and trust-aware workspace intent.";

  const expandedPaths = useMemo(() => new Set(props.expandedPaths.map(normalizePath)), [props.expandedPaths]);
  const selectedPaths = useMemo(() => new Set(props.selectedPaths.map(normalizePath)), [props.selectedPaths]);
  const focusedPath = props.focusedPath ? normalizePath(props.focusedPath) : null;
  const revealedPath = props.revealedPath ? normalizePath(props.revealedPath) : null;
  const selectionMode = props.selectionMode ?? "multi";
  const query = props.searchQuery ?? "";

  const [localQuery, setLocalQuery] = useState(query);

  const visibleNodes = useMemo(() => sortNodes(props.nodes), [props.nodes]);

  const handleSearch = useCallback(
    (next: string) => {
      setLocalQuery(next);
      props.onSearchQueryChange?.(next);
    },
    [props.onSearchQueryChange],
  );

  return (
    <section className="flex h-full min-h-0 flex-col rounded-[2rem] border border-zinc-800 bg-zinc-900/70 shadow-xl">
      <div className="border-b border-zinc-800 px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Navigation</div>
            <h2 className="mt-1 text-lg font-semibold text-zinc-50">{title}</h2>
            <p className="mt-2 text-sm leading-7 text-zinc-400">{subtitle}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className={cx("inline-flex items-center gap-1 rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.2em]", trustTone(props.workspaceTrust))}>
              {trustIcon(props.workspaceTrust)}
              {props.workspaceTrust ?? "unknown"}
            </span>
            <button
              disabled={!props.canRefresh || !props.onRefresh}
              onClick={props.onRefresh}
              className={cx(
                "rounded-2xl border border-zinc-800 bg-zinc-950/70 p-2.5 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100",
                (!props.canRefresh || !props.onRefresh) && "cursor-not-allowed opacity-40",
              )}
            >
              <RefreshCw className={cx("h-4 w-4", props.loading && "animate-spin")} />
            </button>
          </div>
        </div>

        <div className="mt-4 space-y-3">
          <div className="flex items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-2.5">
            <Search className="h-4 w-4 text-zinc-500" />
            <input
              value={localQuery}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder="Search file tree"
              className="w-full bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
              <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Root</div>
              <div className="mt-1 break-all text-sm font-medium text-zinc-100">{props.rootPath ?? "No workspace"}</div>
            </div>
            <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
              <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Selection</div>
              <div className="mt-1 text-sm font-medium text-zinc-100">{props.selectedPaths.length} path{props.selectedPaths.length === 1 ? "" : "s"} selected</div>
            </div>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
        {props.rootPath ? (
          visibleNodes.length > 0 ? (
            <div className="space-y-1">
              {visibleNodes.map((node) => (
                <NodeRow
                  key={node.path}
                  node={node}
                  depth={Math.max(0, pathDepth(node.path) - pathDepth(props.rootPath))}
                  expandedPaths={expandedPaths}
                  selectedPaths={selectedPaths}
                  focusedPath={focusedPath}
                  revealedPath={revealedPath}
                  selectionMode={selectionMode}
                  query={localQuery}
                  onToggleExpand={props.onToggleExpand}
                  onSelectPath={props.onSelectPath}
                  onFocusPath={props.onFocusPath}
                  onRevealPath={props.onRevealPath}
                  onOpenPath={props.onOpenPath}
                  onContextAction={props.onContextAction}
                />
              ))}
            </div>
          ) : (
            <div className="grid h-full min-h-[16rem] place-items-center rounded-[2rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-6 text-center">
              <div className="max-w-md">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-950/60">
                  <Search className="h-5 w-5 text-zinc-400" />
                </div>
                <h3 className="mt-5 text-lg font-semibold text-zinc-100">No visible nodes</h3>
                <p className="mt-3 text-sm leading-7 text-zinc-500">
                  The current query or tree state yields no visible files. Clear the filter, expand a parent, or refresh the workspace snapshot.
                </p>
              </div>
            </div>
          )
        ) : (
          <div className="grid h-full min-h-[16rem] place-items-center rounded-[2rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-6 text-center">
            <div className="max-w-lg">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-950/60">
                <FolderTree className="h-5 w-5 text-zinc-400" />
              </div>
              <h3 className="mt-5 text-lg font-semibold text-zinc-100">No workspace is open</h3>
              <p className="mt-3 text-sm leading-7 text-zinc-500">
                The file tree is a governed navigation surface, not a blind browser. Open a workspace first to establish trust, diagnostics posture, selection state, and review lineage.
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-zinc-800 px-4 py-3 text-xs text-zinc-500">
        <div className="flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-1"><GitBranch className="h-3.5 w-3.5" /> review-aware</span>
          <span className="inline-flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" /> diagnostics-visible</span>
          <span className="inline-flex items-center gap-1"><Sparkles className="h-3.5 w-3.5" /> preview lineage surfaced</span>
          <span className="inline-flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5" /> trust explicit</span>
        </div>
      </div>
    </section>
  );
}
