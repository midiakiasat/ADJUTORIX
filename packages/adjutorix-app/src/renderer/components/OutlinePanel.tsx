import React, { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  AlertTriangle,
  Box,
  Braces,
  ChevronDown,
  ChevronRight,
  Circle,
  Eye,
  FileCode2,
  FileText,
  Filter,
  FolderTree,
  FunctionSquare,
  GitBranch,
  Hash,
  Layers3,
  Link2,
  ListTree,
  Search,
  ShieldCheck,
  Sparkles,
  Target,
} from "lucide-react";

/**
 * ADJUTORIX APP — RENDERER / COMPONENTS / OutlinePanel.tsx
 *
 * Canonical structural outline surface for the active artifact/buffer.
 *
 * Purpose:
 * - provide the authoritative renderer-side outline panel for structural navigation
 * - unify symbols, regions, sections, diagnostics hotspots, review relevance,
 *   and navigation intent under one deterministic component contract
 * - prevent the outline from degrading into a shallow symbol dump detached from
 *   governed editing, diagnostics pressure, and patch/verify context
 * - expose explicit jump/reveal/select interactions upward without performing
 *   hidden editor mutation locally
 *
 * Architectural role:
 * - OutlinePanel is a structural navigation surface for the currently active artifact
 * - it renders explicit outline state supplied by renderer stores/contexts/parsers
 * - it should remain useful for code, configs, markdown, and structured text
 * - it must make structural significance visible, not just lexical order
 *
 * Hard invariants:
 * - node ordering is the provided ordering; no hidden resorting beyond visible filtering
 * - expanded, selected, and revealed nodes are explicit state, not inferred from scroll
 * - diagnostics/review badges annotate nodes without altering their identity
 * - identical props yield identical visible structure and ordering
 * - all visible actions map to explicit callbacks or explicit disabled state
 * - no placeholders, fake symbols, or hidden reparsing side effects
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type OutlineNodeKind =
  | "file"
  | "module"
  | "namespace"
  | "class"
  | "interface"
  | "enum"
  | "function"
  | "method"
  | "property"
  | "variable"
  | "type"
  | "heading"
  | "region"
  | "section"
  | "object"
  | "array"
  | "key"
  | "unknown";

export type OutlineSeverity = "none" | "info" | "warn" | "error" | "critical";
export type OutlineReviewState = "none" | "preview" | "approved" | "verified" | "applied";
export type OutlineTrustLevel = "unknown" | "untrusted" | "restricted" | "trusted";

export type OutlineRange = {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
};

export type OutlineNode = {
  id: string;
  label: string;
  detail?: string | null;
  path?: string | null;
  kind: OutlineNodeKind;
  range: OutlineRange;
  children?: OutlineNode[];
  diagnosticsSeverity?: OutlineSeverity;
  diagnosticsCount?: number;
  reviewState?: OutlineReviewState;
  trustLevel?: OutlineTrustLevel;
  referenced?: boolean;
  modified?: boolean;
  generated?: boolean;
  hidden?: boolean;
};

export type OutlinePanelProps = {
  title?: string;
  subtitle?: string;
  artifactPath: string | null;
  nodes: OutlineNode[];
  expandedNodeIds: string[];
  selectedNodeId?: string | null;
  revealedNodeId?: string | null;
  searchQuery?: string;
  showOnlyDiagnostics?: boolean;
  showOnlyReviewRelevant?: boolean;
  showOnlyReferenced?: boolean;
  loading?: boolean;
  trustLevel?: OutlineTrustLevel;
  onSearchQueryChange?: (query: string) => void;
  onToggleExpand?: (id: string) => void;
  onSelectNode?: (node: OutlineNode) => void;
  onRevealNode?: (node: OutlineNode) => void;
  onToggleDiagnosticsOnly?: (value: boolean) => void;
  onToggleReviewRelevantOnly?: (value: boolean) => void;
  onToggleReferencedOnly?: (value: boolean) => void;
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function normalizePath(path: string | null | undefined): string | null {
  if (!path) return null;
  const p = path.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  return p.endsWith("/") && p !== "/" ? p.slice(0, -1) : p;
}

function basename(path: string | null | undefined): string {
  const p = normalizePath(path);
  if (!p) return "No artifact";
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function kindIcon(kind: OutlineNodeKind): JSX.Element {
  switch (kind) {
    case "module":
    case "namespace":
      return <Layers3 className="h-4 w-4" />;
    case "class":
    case "interface":
    case "enum":
      return <Box className="h-4 w-4" />;
    case "function":
    case "method":
      return <FunctionSquare className="h-4 w-4" />;
    case "property":
    case "variable":
    case "key":
      return <Hash className="h-4 w-4" />;
    case "heading":
    case "section":
    case "region":
      return <ListTree className="h-4 w-4" />;
    case "object":
    case "array":
    case "type":
      return <Braces className="h-4 w-4" />;
    case "file":
      return <FileText className="h-4 w-4" />;
    default:
      return <FileCode2 className="h-4 w-4" />;
  }
}

function trustTone(level: OutlineTrustLevel | undefined): string {
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

function severityTone(severity: OutlineSeverity | undefined): string {
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

function reviewTone(state: OutlineReviewState | undefined): string {
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

function matchesQuery(node: OutlineNode, query: string): boolean {
  if (!query.trim()) return true;
  const q = query.trim().toLowerCase();
  return (
    node.label.toLowerCase().includes(q) ||
    (node.detail ?? "").toLowerCase().includes(q) ||
    (node.path ?? "").toLowerCase().includes(q) ||
    node.kind.toLowerCase().includes(q)
  );
}

function anyChildMatches(node: OutlineNode, query: string): boolean {
  if (!node.children || node.children.length === 0) return false;
  return node.children.some((child) => matchesQuery(child, query) || anyChildMatches(child, query));
}

function passesFilters(node: OutlineNode, query: string, diagnosticsOnly: boolean, reviewOnly: boolean, referencedOnly: boolean): boolean {
  const selfMatch = matchesQuery(node, query);
  const childMatch = anyChildMatches(node, query);
  if (!selfMatch && !childMatch) return false;
  if (diagnosticsOnly && !(node.diagnosticsCount && node.diagnosticsCount > 0) && !childMatch) return false;
  if (reviewOnly && (!node.reviewState || node.reviewState === "none") && !childMatch) return false;
  if (referencedOnly && !node.referenced && !childMatch) return false;
  return !node.hidden;
}

function countNodes(nodes: OutlineNode[]): number {
  return nodes.reduce((n, node) => n + 1 + countNodes(node.children ?? []), 0);
}

// -----------------------------------------------------------------------------
// NODE ROW
// -----------------------------------------------------------------------------

type OutlineNodeRowProps = {
  node: OutlineNode;
  depth: number;
  expandedNodeIds: Set<string>;
  selectedNodeId: string | null;
  revealedNodeId: string | null;
  query: string;
  showOnlyDiagnostics: boolean;
  showOnlyReviewRelevant: boolean;
  showOnlyReferenced: boolean;
  onToggleExpand?: (id: string) => void;
  onSelectNode?: (node: OutlineNode) => void;
  onRevealNode?: (node: OutlineNode) => void;
};

function OutlineNodeRow(props: OutlineNodeRowProps): JSX.Element | null {
  const visible = passesFilters(
    props.node,
    props.query,
    props.showOnlyDiagnostics,
    props.showOnlyReviewRelevant,
    props.showOnlyReferenced,
  );

  if (!visible) return null;

  const isExpanded = props.expandedNodeIds.has(props.node.id);
  const isSelected = props.selectedNodeId === props.node.id;
  const isRevealed = props.revealedNodeId === props.node.id;
  const hasChildren = !!props.node.children && props.node.children.length > 0;
  const paddingLeft = 12 + props.depth * 18;

  return (
    <div>
      <div
        className={cx(
          "group flex items-start gap-2 rounded-2xl border px-3 py-2 transition",
          isSelected
            ? "border-zinc-600 bg-zinc-800 text-zinc-50"
            : isRevealed
              ? "border-sky-700/30 bg-sky-500/10 text-zinc-100"
              : "border-transparent text-zinc-300 hover:border-zinc-800 hover:bg-zinc-900/80",
        )}
        style={{ paddingLeft }}
      >
        {hasChildren ? (
          <button
            onClick={() => props.onToggleExpand?.(props.node.id)}
            className="mt-0.5 rounded-lg p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          >
            {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        ) : (
          <span className="w-6 shrink-0" />
        )}

        <button onClick={() => props.onSelectNode?.(props.node)} className="flex min-w-0 flex-1 items-start gap-3 text-left">
          <div className="mt-0.5 rounded-xl border border-zinc-800 bg-zinc-950/70 p-2 text-zinc-300">{kindIcon(props.node.kind)}</div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="truncate text-sm font-medium">{props.node.label}</span>
              <span className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">{props.node.kind}</span>
              {props.node.modified ? <span className="rounded-full border border-amber-700/30 bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] text-amber-300">modified</span> : null}
              {props.node.generated ? <span className="rounded-full border border-zinc-700/30 bg-zinc-500/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] text-zinc-400">generated</span> : null}
              {props.node.referenced ? <span className="rounded-full border border-sky-700/30 bg-sky-500/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] text-sky-300">referenced</span> : null}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
              {props.node.detail ? <span className="truncate">{props.node.detail}</span> : null}
              <span>
                {props.node.range.startLine}:{props.node.range.startColumn} → {props.node.range.endLine}:{props.node.range.endColumn}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className={cx("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.2em]", trustTone(props.node.trustLevel))}>
                <ShieldCheck className="h-3 w-3" />
                {props.node.trustLevel ?? "unknown"}
              </span>
              {props.node.reviewState && props.node.reviewState !== "none" ? (
                <span className={cx("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.2em]", reviewTone(props.node.reviewState))}>
                  <GitBranch className="h-3 w-3" />
                  {props.node.reviewState}
                </span>
              ) : null}
              {props.node.diagnosticsCount ? (
                <span className={cx("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.2em]", severityTone(props.node.diagnosticsSeverity))}>
                  <AlertTriangle className="h-3 w-3" />
                  {props.node.diagnosticsCount}
                </span>
              ) : null}
            </div>
          </div>
        </button>

        <button
          onClick={() => props.onRevealNode?.(props.node)}
          className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-1.5 text-zinc-400 opacity-0 transition group-hover:opacity-100 hover:bg-zinc-800 hover:text-zinc-100"
        >
          <Eye className="h-3.5 w-3.5" />
        </button>
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
                {props.node.children!.map((child) => (
                  <OutlineNodeRow
                    key={child.id}
                    node={child}
                    depth={props.depth + 1}
                    expandedNodeIds={props.expandedNodeIds}
                    selectedNodeId={props.selectedNodeId}
                    revealedNodeId={props.revealedNodeId}
                    query={props.query}
                    showOnlyDiagnostics={props.showOnlyDiagnostics}
                    showOnlyReviewRelevant={props.showOnlyReviewRelevant}
                    showOnlyReferenced={props.showOnlyReferenced}
                    onToggleExpand={props.onToggleExpand}
                    onSelectNode={props.onSelectNode}
                    onRevealNode={props.onRevealNode}
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

export default function OutlinePanel(props: OutlinePanelProps): JSX.Element {
  const title = props.title ?? "Outline";
  const subtitle =
    props.subtitle ??
    "Structural navigation across the active artifact, with diagnostics hotspots, review relevance, and trust-aware outline intent.";

  const trustLevel = props.trustLevel ?? "unknown";
  const query = props.searchQuery ?? "";
  const loading = props.loading ?? false;
  const showOnlyDiagnostics = props.showOnlyDiagnostics ?? false;
  const showOnlyReviewRelevant = props.showOnlyReviewRelevant ?? false;
  const showOnlyReferenced = props.showOnlyReferenced ?? false;

  const expandedNodeIds = useMemo(() => new Set(props.expandedNodeIds), [props.expandedNodeIds]);
  const selectedNodeId = props.selectedNodeId ?? null;
  const revealedNodeId = props.revealedNodeId ?? null;

  const [localQuery, setLocalQuery] = useState(query);

  const visibleRoots = useMemo(
    () =>
      props.nodes.filter((node) =>
        passesFilters(node, localQuery, showOnlyDiagnostics, showOnlyReviewRelevant, showOnlyReferenced),
      ),
    [localQuery, props.nodes, showOnlyDiagnostics, showOnlyReferenced, showOnlyReviewRelevant],
  );

  const totalNodes = useMemo(() => countNodes(props.nodes), [props.nodes]);
  const visibleNodeCount = useMemo(() => countNodes(visibleRoots), [visibleRoots]);

  return (
    <section className="flex h-full min-h-0 flex-col rounded-[2rem] border border-zinc-800 bg-zinc-900/70 shadow-xl">
      <div className="border-b border-zinc-800 px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Structure</div>
            <h2 className="mt-1 text-lg font-semibold text-zinc-50">{title}</h2>
            <p className="mt-2 text-sm leading-7 text-zinc-400">{subtitle}</p>
          </div>
          <span className={cx("inline-flex items-center gap-1 rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.2em]", trustTone(trustLevel))}>
            <ShieldCheck className="h-3.5 w-3.5" />
            {trustLevel}
          </span>
        </div>

        <div className="mt-4 space-y-3">
          <div className="flex items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-2.5">
            <Search className="h-4 w-4 text-zinc-500" />
            <input
              value={localQuery}
              onChange={(e) => {
                setLocalQuery(e.target.value);
                props.onSearchQueryChange?.(e.target.value);
              }}
              placeholder="Search structural outline"
              className="w-full bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={props.onToggleDiagnosticsOnly ? () => props.onToggleDiagnosticsOnly?.(!showOnlyDiagnostics) : undefined}
              className={cx(
                "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition",
                showOnlyDiagnostics
                  ? "border-indigo-700/30 bg-indigo-500/10 text-indigo-200"
                  : "border-zinc-800 bg-zinc-950/60 text-zinc-300 hover:bg-zinc-900",
                !props.onToggleDiagnosticsOnly && "cursor-not-allowed opacity-40",
              )}
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              Diagnostics only
            </button>
            <button
              onClick={props.onToggleReviewRelevantOnly ? () => props.onToggleReviewRelevantOnly?.(!showOnlyReviewRelevant) : undefined}
              className={cx(
                "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition",
                showOnlyReviewRelevant
                  ? "border-indigo-700/30 bg-indigo-500/10 text-indigo-200"
                  : "border-zinc-800 bg-zinc-950/60 text-zinc-300 hover:bg-zinc-900",
                !props.onToggleReviewRelevantOnly && "cursor-not-allowed opacity-40",
              )}
            >
              <Sparkles className="h-3.5 w-3.5" />
              Review relevant
            </button>
            <button
              onClick={props.onToggleReferencedOnly ? () => props.onToggleReferencedOnly?.(!showOnlyReferenced) : undefined}
              className={cx(
                "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition",
                showOnlyReferenced
                  ? "border-indigo-700/30 bg-indigo-500/10 text-indigo-200"
                  : "border-zinc-800 bg-zinc-950/60 text-zinc-300 hover:bg-zinc-900",
                !props.onToggleReferencedOnly && "cursor-not-allowed opacity-40",
              )}
            >
              <Link2 className="h-3.5 w-3.5" />
              Referenced only
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
              <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Artifact</div>
              <div className="mt-1 truncate text-sm font-medium text-zinc-100">{basename(props.artifactPath)}</div>
            </div>
            <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
              <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Visible nodes</div>
              <div className="mt-1 text-sm font-medium text-zinc-100">{visibleNodeCount}</div>
            </div>
            <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
              <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Total nodes</div>
              <div className="mt-1 text-sm font-medium text-zinc-100">{totalNodes}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
        <AnimatePresence mode="wait">
          {loading ? (
            <motion.div
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="grid min-h-[18rem] place-items-center rounded-[2rem] border border-zinc-800 bg-zinc-950/30"
            >
              <div className="text-sm text-zinc-300">Hydrating structural outline…</div>
            </motion.div>
          ) : visibleRoots.length > 0 ? (
            <motion.div key="tree" layout className="space-y-1">
              {visibleRoots.map((node) => (
                <OutlineNodeRow
                  key={node.id}
                  node={node}
                  depth={0}
                  expandedNodeIds={expandedNodeIds}
                  selectedNodeId={selectedNodeId}
                  revealedNodeId={revealedNodeId}
                  query={localQuery}
                  showOnlyDiagnostics={showOnlyDiagnostics}
                  showOnlyReviewRelevant={showOnlyReviewRelevant}
                  showOnlyReferenced={showOnlyReferenced}
                  onToggleExpand={props.onToggleExpand}
                  onSelectNode={props.onSelectNode}
                  onRevealNode={props.onRevealNode}
                />
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
                  {props.artifactPath ? <ListTree className="h-6 w-6 text-zinc-400" /> : <FolderTree className="h-6 w-6 text-zinc-400" />}
                </div>
                <h3 className="mt-6 text-xl font-semibold text-zinc-100">
                  {props.artifactPath ? "No visible outline nodes" : "No active artifact"}
                </h3>
                <p className="mt-3 text-sm leading-7 text-zinc-500">
                  {props.artifactPath
                    ? "The current structural filters produced no visible nodes. Clear filters or search by symbol, section, or diagnostics-bearing region."
                    : "Select an active artifact to expose its structural index, diagnostics hotspots, and review-relevant regions."}
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="border-t border-zinc-800 px-4 py-3 text-xs text-zinc-500">
        <div className="flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-1"><ListTree className="h-3.5 w-3.5" /> structural order explicit</span>
          <span className="inline-flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" /> diagnostics hotspots surfaced</span>
          <span className="inline-flex items-center gap-1"><GitBranch className="h-3.5 w-3.5" /> review relevance visible</span>
          <span className="inline-flex items-center gap-1"><Target className="h-3.5 w-3.5" /> navigation intent explicit</span>
        </div>
      </div>
    </section>
  );
}
