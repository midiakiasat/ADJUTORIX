import React, { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Eye,
  Filter,
  GitBranch,
  Link2,
  Loader2,
  Network,
  PlayCircle,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Sparkles,
  Target,
  Wrench,
  XCircle,
} from "lucide-react";

/**
 * ADJUTORIX APP — RENDERER / COMPONENTS / TransactionGraphPanel.tsx
 *
 * Canonical transaction / lineage graph cockpit.
 *
 * Purpose:
 * - provide the authoritative renderer-side graph surface for transactional lineage
 * - unify requests, previews, verification runs, approvals, applies, replays, rollbacks,
 *   diagnostics nodes, and their causal edges under one deterministic component contract
 * - prevent users from seeing only a flat timeline when the governing truth is graph-shaped
 * - expose explicit node selection, edge inspection, filtering, and focus/replay intent upward
 *   without mutating transaction state locally
 *
 * Architectural role:
 * - TransactionGraphPanel is the topology-and-causality layer above raw ledger rows
 * - it does not compute authoritative state transitions; it renders declared graph state
 * - it should remain useful in sparse, partial, degraded, and high-complexity sessions
 * - it must surface branch structure, head nodes, blocked branches, and bindable lineage clearly
 *
 * Hard invariants:
 * - node and edge ordering are the provided ordering after explicit filters only
 * - selected node/edge identity is explicit and stable
 * - heads, blocked paths, and causal references annotate graph state without mutating identity
 * - filters change visibility only, never graph truth
 * - all actions map to explicit callbacks or explicit disabled state
 * - identical props yield identical topology rendering and summaries
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type GraphHealth = "healthy" | "degraded" | "unhealthy" | "unknown";
export type GraphAttention = "none" | "low" | "medium" | "high" | "critical";
export type GraphNodeKind =
  | "request"
  | "preview"
  | "verify"
  | "approval"
  | "apply"
  | "replay"
  | "rollback"
  | "diagnostic"
  | "checkpoint"
  | "unknown";
export type GraphEdgeKind =
  | "causal"
  | "derived-from"
  | "verified-by"
  | "approved-by"
  | "applied-from"
  | "replayed-from"
  | "blocked-by"
  | "diagnostic-link"
  | "unknown";
export type GraphTrustLevel = "unknown" | "untrusted" | "restricted" | "trusted";

export type TransactionGraphNode = {
  id: string;
  label: string;
  subtitle?: string | null;
  kind: GraphNodeKind;
  seq?: number | null;
  tsMs?: number | null;
  x: number;
  y: number;
  isHead?: boolean;
  blocked?: boolean;
  attention?: GraphAttention;
  trustLevel?: GraphTrustLevel;
  patchId?: string | null;
  previewHash?: string | null;
  verifyId?: string | null;
  requestHash?: string | null;
  detail?: Record<string, unknown> | null;
};

export type TransactionGraphEdge = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  kind: GraphEdgeKind;
  label?: string | null;
  blocked?: boolean;
  attention?: GraphAttention;
  detail?: Record<string, unknown> | null;
};

export type TransactionGraphMetric = {
  id: string;
  label: string;
  value: string;
  tone?: "neutral" | "good" | "warn" | "bad";
};

export type TransactionGraphPanelProps = {
  title?: string;
  subtitle?: string;
  health?: GraphHealth;
  loading?: boolean;
  nodes: TransactionGraphNode[];
  edges: TransactionGraphEdge[];
  selectedNodeId?: string | null;
  selectedEdgeId?: string | null;
  filterQuery?: string;
  kindFilters?: string[];
  attentionOnly?: boolean;
  showBlockedOnly?: boolean;
  metrics?: TransactionGraphMetric[];
  onRefreshRequested?: () => void;
  onSelectNode?: (node: TransactionGraphNode) => void;
  onSelectEdge?: (edge: TransactionGraphEdge) => void;
  onFilterQueryChange?: (query: string) => void;
  onKindFiltersChange?: (kinds: string[]) => void;
  onToggleAttentionOnly?: (value: boolean) => void;
  onToggleBlockedOnly?: (value: boolean) => void;
  onFocusReplayRequested?: (node: TransactionGraphNode) => void;
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function formatDateTime(ts?: number | null): string {
  if (!ts) return "Unknown";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}

function attentionRank(level: GraphAttention | undefined): number {
  switch (level) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

function healthTone(level: GraphHealth | undefined): string {
  switch (level) {
    case "healthy":
      return "border-emerald-700/30 bg-emerald-500/10 text-emerald-300";
    case "degraded":
      return "border-amber-700/30 bg-amber-500/10 text-amber-300";
    case "unhealthy":
      return "border-rose-700/30 bg-rose-500/10 text-rose-300";
    default:
      return "border-zinc-700/30 bg-zinc-500/10 text-zinc-300";
  }
}

function attentionTone(level: GraphAttention | undefined): string {
  switch (level) {
    case "critical":
    case "high":
      return "border-rose-700/30 bg-rose-500/10 text-rose-300";
    case "medium":
      return "border-amber-700/30 bg-amber-500/10 text-amber-300";
    case "low":
      return "border-sky-700/30 bg-sky-500/10 text-sky-300";
    default:
      return "border-zinc-700/30 bg-zinc-500/10 text-zinc-400";
  }
}

function trustTone(level: GraphTrustLevel | undefined): string {
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

function trustIcon(level: GraphTrustLevel | undefined): JSX.Element {
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

function metricTone(tone?: TransactionGraphMetric["tone"]): string {
  switch (tone) {
    case "good":
      return "border-emerald-700/30 bg-emerald-500/10 text-emerald-300";
    case "warn":
      return "border-amber-700/30 bg-amber-500/10 text-amber-300";
    case "bad":
      return "border-rose-700/30 bg-rose-500/10 text-rose-300";
    default:
      return "border-zinc-800 bg-zinc-950/60 text-zinc-200";
  }
}

function kindColor(kind: GraphNodeKind): string {
  switch (kind) {
    case "request":
      return "fill-zinc-700 stroke-zinc-500";
    case "preview":
      return "fill-sky-500/30 stroke-sky-400";
    case "verify":
      return "fill-emerald-500/30 stroke-emerald-400";
    case "approval":
      return "fill-indigo-500/30 stroke-indigo-400";
    case "apply":
      return "fill-violet-500/30 stroke-violet-400";
    case "replay":
      return "fill-amber-500/30 stroke-amber-400";
    case "rollback":
      return "fill-rose-500/30 stroke-rose-400";
    case "diagnostic":
      return "fill-orange-500/30 stroke-orange-400";
    case "checkpoint":
      return "fill-cyan-500/30 stroke-cyan-400";
    default:
      return "fill-zinc-700 stroke-zinc-400";
  }
}

function edgeStroke(edge: TransactionGraphEdge): string {
  if (edge.blocked) return "#fb7185";
  if (attentionRank(edge.attention) >= 3) return "#f59e0b";
  switch (edge.kind) {
    case "verified-by":
      return "#34d399";
    case "approved-by":
      return "#818cf8";
    case "applied-from":
      return "#a78bfa";
    case "replayed-from":
      return "#fbbf24";
    default:
      return "#52525b";
  }
}

// -----------------------------------------------------------------------------
// SUBCOMPONENTS
// -----------------------------------------------------------------------------

function Badge(props: { className?: string; children: React.ReactNode }): JSX.Element {
  return <span className={cx("inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.2em]", props.className)}>{props.children}</span>;
}

function MetricCard(props: { label: string; value: string; tone?: "neutral" | "good" | "warn" | "bad"; icon?: React.ReactNode }): JSX.Element {
  return (
    <div className={cx("rounded-[1.5rem] border p-4 shadow-sm", metricTone(props.tone))}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] opacity-70">{props.label}</div>
          <div className="mt-2 text-lg font-semibold tracking-tight">{props.value}</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-black/20 p-2.5 text-zinc-300">{props.icon ?? <Network className="h-4 w-4" />}</div>
      </div>
    </div>
  );
}

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

// -----------------------------------------------------------------------------
// MAIN COMPONENT
// -----------------------------------------------------------------------------

export default function TransactionGraphPanel(props: TransactionGraphPanelProps): JSX.Element {
  const title = props.title ?? "Transaction graph cockpit";
  const subtitle =
    props.subtitle ??
    "Topology view over requests, previews, verifies, approvals, applies, replays, rollbacks, and blocked causal edges.";

  const health = props.health ?? "unknown";
  const loading = props.loading ?? false;
  const [localFilter, setLocalFilter] = useState(props.filterQuery ?? "");
  const [localKinds, setLocalKinds] = useState<string[]>(props.kindFilters ?? []);
  const attentionOnly = props.attentionOnly ?? false;
  const showBlockedOnly = props.showBlockedOnly ?? false;
  const [localSelectedNodeId, setLocalSelectedNodeId] = useState<string | null>(props.selectedNodeId ?? null);
  const [localSelectedEdgeId, setLocalSelectedEdgeId] = useState<string | null>(props.selectedEdgeId ?? null);

  const visibleNodes = useMemo(() => {
    const q = localFilter.trim().toLowerCase();
    return props.nodes.filter((node) => {
      if (attentionOnly && attentionRank(node.attention) === 0 && !node.blocked) return false;
      if (showBlockedOnly && !node.blocked) return false;
      if (localKinds.length > 0 && !localKinds.includes(node.kind)) return false;
      if (!q) return true;
      return (
        node.label.toLowerCase().includes(q) ||
        (node.subtitle ?? "").toLowerCase().includes(q) ||
        (node.patchId ?? "").toLowerCase().includes(q) ||
        (node.previewHash ?? "").toLowerCase().includes(q) ||
        (node.verifyId ?? "").toLowerCase().includes(q) ||
        (node.requestHash ?? "").toLowerCase().includes(q)
      );
    });
  }, [attentionOnly, localFilter, localKinds, props.nodes, showBlockedOnly]);

  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);

  const visibleEdges = useMemo(() => {
    const q = localFilter.trim().toLowerCase();
    return props.edges.filter((edge) => {
      if (!visibleNodeIds.has(edge.fromNodeId) || !visibleNodeIds.has(edge.toNodeId)) return false;
      if (attentionOnly && attentionRank(edge.attention) === 0 && !edge.blocked) return false;
      if (showBlockedOnly && !edge.blocked) return false;
      if (!q) return true;
      return edge.kind.toLowerCase().includes(q) || (edge.label ?? "").toLowerCase().includes(q);
    });
  }, [attentionOnly, localFilter, props.edges, showBlockedOnly, visibleNodeIds]);

  const selectedNodeId = props.selectedNodeId ?? localSelectedNodeId ?? visibleNodes[0]?.id ?? null;
  const selectedEdgeId = props.selectedEdgeId ?? localSelectedEdgeId ?? null;
  const selectedNode = visibleNodes.find((n) => n.id === selectedNodeId) ?? visibleNodes[0] ?? null;
  const selectedEdge = visibleEdges.find((e) => e.id === selectedEdgeId) ?? null;

  const metrics = props.metrics ?? [
    { id: "nodes", label: "Visible nodes", value: String(visibleNodes.length) },
    { id: "edges", label: "Visible edges", value: String(visibleEdges.length) },
    { id: "heads", label: "Heads", value: String(visibleNodes.filter((n) => n.isHead).length), tone: visibleNodes.some((n) => n.isHead) ? "good" : "neutral" },
    { id: "blocked", label: "Blocked", value: String(visibleNodes.filter((n) => n.blocked).length + visibleEdges.filter((e) => e.blocked).length), tone: visibleNodes.some((n) => n.blocked) || visibleEdges.some((e) => e.blocked) ? "warn" : "neutral" },
  ];

  const kindUniverse = useMemo(() => [...new Set(props.nodes.map((n) => n.kind))].sort((a, b) => a.localeCompare(b)), [props.nodes]);
  const nodeById = useMemo(() => Object.fromEntries(props.nodes.map((n) => [n.id, n])), [props.nodes]);

  return (
    <section className="flex h-full min-h-0 flex-col rounded-[2rem] border border-zinc-800 bg-zinc-900/70 shadow-xl">
      <div className="border-b border-zinc-800 px-5 py-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Transaction topology</div>
            <h2 className="mt-1 text-lg font-semibold text-zinc-50">{title}</h2>
            <p className="mt-2 text-sm leading-7 text-zinc-400">{subtitle}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={healthTone(health)}>
              <ShieldCheck className="h-3.5 w-3.5" />
              {health}
            </Badge>
            <button
              onClick={props.onRefreshRequested}
              disabled={!props.onRefreshRequested}
              className={cx(
                "rounded-2xl border border-zinc-800 bg-zinc-950/70 p-2.5 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100",
                !props.onRefreshRequested && "cursor-not-allowed opacity-40",
              )}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {metrics.map((metric) => (
            <MetricCard
              key={metric.id}
              label={metric.label}
              value={metric.value}
              tone={metric.tone}
              icon={metric.id === "heads" ? <Target className="h-4 w-4" /> : metric.id === "blocked" ? <AlertTriangle className="h-4 w-4" /> : <Network className="h-4 w-4" />}
            />
          ))}
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_auto]">
          <div className="flex items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-2.5">
            <Search className="h-4 w-4 text-zinc-500" />
            <input
              value={localFilter}
              onChange={(e) => {
                setLocalFilter(e.target.value);
                props.onFilterQueryChange?.(e.target.value);
              }}
              placeholder="Filter graph nodes and edges"
              className="w-full bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <ToggleChip label="Attention only" active={attentionOnly} icon={<AlertTriangle className="h-3.5 w-3.5" />} onClick={props.onToggleAttentionOnly ? () => props.onToggleAttentionOnly?.(!attentionOnly) : undefined} />
            <ToggleChip label="Blocked only" active={showBlockedOnly} icon={<Wrench className="h-3.5 w-3.5" />} onClick={props.onToggleBlockedOnly ? () => props.onToggleBlockedOnly?.(!showBlockedOnly) : undefined} />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {kindUniverse.map((kind) => {
            const active = localKinds.includes(kind);
            return (
              <ToggleChip
                key={kind}
                label={kind}
                active={active}
                icon={<GitBranch className="h-3.5 w-3.5" />}
                onClick={
                  props.onKindFiltersChange
                    ? () => {
                        const next = active ? localKinds.filter((k) => k !== kind) : [...localKinds, kind].sort((a, b) => a.localeCompare(b));
                        setLocalKinds(next);
                        props.onKindFiltersChange?.(next);
                      }
                    : undefined
                }
              />
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
        <AnimatePresence mode="wait">
          {loading ? (
            <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="grid min-h-[18rem] place-items-center rounded-[2rem] border border-zinc-800 bg-zinc-950/30">
              <div className="flex items-center gap-3 text-sm text-zinc-300">
                <Loader2 className="h-4 w-4 animate-spin" />
                Hydrating transaction topology…
              </div>
            </motion.div>
          ) : visibleNodes.length > 0 ? (
            <motion.div key="graph" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.16 }} className="grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
              <div className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-4 shadow-lg">
                <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Topology view</div>
                <div className="mt-4 overflow-auto rounded-[1.5rem] border border-zinc-800 bg-black/20">
                  <svg viewBox="0 0 1200 720" className="h-[42rem] w-full min-w-[56rem]">
                    <defs>
                      <marker id="tx-arrow" markerWidth="10" markerHeight="10" refX="7" refY="3" orient="auto">
                        <path d="M0,0 L0,6 L8,3 z" fill="#71717a" />
                      </marker>
                    </defs>

                    {visibleEdges.map((edge) => {
                      const from = nodeById[edge.fromNodeId];
                      const to = nodeById[edge.toNodeId];
                      if (!from || !to) return null;
                      const selected = selectedEdge?.id === edge.id;
                      return (
                        <g key={edge.id} onClick={() => { setLocalSelectedEdgeId(edge.id); props.onSelectEdge?.(edge); }} className="cursor-pointer">
                          <line
                            x1={from.x + 84}
                            y1={from.y + 36}
                            x2={to.x}
                            y2={to.y + 36}
                            stroke={edgeStroke(edge)}
                            strokeWidth={selected ? 4 : 2.5}
                            strokeDasharray={edge.blocked ? "8 6" : undefined}
                            markerEnd="url(#tx-arrow)"
                          />
                          {edge.label ? (
                            <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 6} fill="#a1a1aa" fontSize="12" textAnchor="middle">
                              {edge.label}
                            </text>
                          ) : null}
                        </g>
                      );
                    })}

                    {visibleNodes.map((node) => {
                      const selected = selectedNode?.id === node.id;
                      return (
                        <g key={node.id} transform={`translate(${node.x}, ${node.y})`} onClick={() => { setLocalSelectedNodeId(node.id); props.onSelectNode?.(node); }} className="cursor-pointer">
                          <rect
                            x={0}
                            y={0}
                            rx={18}
                            ry={18}
                            width={168}
                            height={72}
                            className={kindColor(node.kind)}
                            strokeWidth={selected ? 3.5 : 2}
                            opacity={node.blocked ? 0.85 : 1}
                          />
                          {node.isHead ? <circle cx={152} cy={16} r={7} fill="#34d399" /> : null}
                          {node.blocked ? <circle cx={136} cy={16} r={7} fill="#fb7185" /> : null}
                          <text x={16} y={28} fill="#fafafa" fontSize="13" fontWeight="600">{node.label}</text>
                          <text x={16} y={47} fill="#a1a1aa" fontSize="11">{node.kind}</text>
                          {node.seq != null ? <text x={16} y={63} fill="#71717a" fontSize="10">seq {node.seq}</text> : null}
                        </g>
                      );
                    })}
                  </svg>
                </div>
              </div>

              <div className="space-y-5">
                <section className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-5 shadow-lg">
                  <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Selected node</div>
                  {selectedNode ? (
                    <div className="mt-4 space-y-4">
                      <div>
                        <div className="text-lg font-semibold text-zinc-50">{selectedNode.label}</div>
                        {selectedNode.subtitle ? <div className="mt-2 text-sm leading-7 text-zinc-400">{selectedNode.subtitle}</div> : null}
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Badge className={trustTone(selectedNode.trustLevel)}>
                          {trustIcon(selectedNode.trustLevel)}
                          {selectedNode.trustLevel ?? "unknown"}
                        </Badge>
                        <Badge className={attentionTone(selectedNode.attention)}>
                          <AlertTriangle className="h-3.5 w-3.5" />
                          {selectedNode.attention ?? "none"}
                        </Badge>
                        {selectedNode.isHead ? <Badge className="border-emerald-700/30 bg-emerald-500/10 text-emerald-300">head</Badge> : null}
                        {selectedNode.blocked ? <Badge className="border-rose-700/30 bg-rose-500/10 text-rose-300">blocked</Badge> : null}
                      </div>

                      <div className="grid gap-3 sm:grid-cols-2">
                        <MetricCard label="Kind" value={selectedNode.kind} icon={<GitBranch className="h-4 w-4" />} />
                        <MetricCard label="Seq" value={selectedNode.seq != null ? String(selectedNode.seq) : "None"} icon={<Target className="h-4 w-4" />} />
                        <MetricCard label="Patch" value={selectedNode.patchId ?? "None"} icon={<GitBranch className="h-4 w-4" />} />
                        <MetricCard label="Verify" value={selectedNode.verifyId ?? "None"} icon={<ShieldCheck className="h-4 w-4" />} />
                        <MetricCard label="Preview" value={selectedNode.previewHash ?? "None"} icon={<Sparkles className="h-4 w-4" />} />
                        <MetricCard label="At" value={formatDateTime(selectedNode.tsMs)} icon={<Activity className="h-4 w-4" />} />
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => props.onFocusReplayRequested?.(selectedNode)}
                          disabled={!props.onFocusReplayRequested}
                          className={cx(
                            "inline-flex items-center gap-2 rounded-2xl border px-4 py-2 text-sm font-medium transition",
                            props.onFocusReplayRequested
                              ? "border-indigo-700/40 bg-indigo-500/15 text-indigo-200 hover:bg-indigo-500/20"
                              : "cursor-not-allowed border-zinc-800 bg-zinc-950/60 text-zinc-500",
                          )}
                        >
                          <PlayCircle className="h-4 w-4" />
                          Focus replay
                        </button>
                      </div>

                      <div className="rounded-[1.5rem] border border-zinc-800 bg-zinc-950/50 p-4 shadow-sm">
                        <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Node detail</div>
                        <pre className="mt-3 overflow-auto whitespace-pre-wrap break-words rounded-2xl border border-zinc-800 bg-black/20 p-4 font-mono text-xs leading-6 text-zinc-300">
{prettyJson(selectedNode.detail)}
                        </pre>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-4 rounded-[1.5rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-5 text-sm text-zinc-500">
                      Select a visible node to inspect its causal references and structured detail.
                    </div>
                  )}
                </section>

                <section className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-5 shadow-lg">
                  <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Selected edge</div>
                  {selectedEdge ? (
                    <div className="mt-4 space-y-4">
                      <div className="text-lg font-semibold text-zinc-50">{selectedEdge.kind}</div>
                      {selectedEdge.label ? <div className="text-sm text-zinc-400">{selectedEdge.label}</div> : null}

                      <div className="flex flex-wrap items-center gap-2">
                        <Badge className={attentionTone(selectedEdge.attention)}>
                          <AlertTriangle className="h-3.5 w-3.5" />
                          {selectedEdge.attention ?? "none"}
                        </Badge>
                        {selectedEdge.blocked ? <Badge className="border-rose-700/30 bg-rose-500/10 text-rose-300">blocked</Badge> : null}
                        <Badge className="border-zinc-700/30 bg-zinc-500/10 text-zinc-300">
                          <Link2 className="h-3.5 w-3.5" />
                          {selectedEdge.fromNodeId} → {selectedEdge.toNodeId}
                        </Badge>
                      </div>

                      <div className="grid gap-3 sm:grid-cols-2">
                        <MetricCard label="From" value={nodeById[selectedEdge.fromNodeId]?.label ?? selectedEdge.fromNodeId} icon={<ChevronRight className="h-4 w-4" />} />
                        <MetricCard label="To" value={nodeById[selectedEdge.toNodeId]?.label ?? selectedEdge.toNodeId} icon={<ChevronRight className="h-4 w-4" />} />
                      </div>

                      <div className="rounded-[1.5rem] border border-zinc-800 bg-zinc-950/50 p-4 shadow-sm">
                        <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Edge detail</div>
                        <pre className="mt-3 overflow-auto whitespace-pre-wrap break-words rounded-2xl border border-zinc-800 bg-black/20 p-4 font-mono text-xs leading-6 text-zinc-300">
{prettyJson(selectedEdge.detail)}
                        </pre>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-4 rounded-[1.5rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-5 text-sm text-zinc-500">
                      Select a visible edge to inspect its causal meaning and any blocking context.
                    </div>
                  )}
                </section>
              </div>
            </motion.div>
          ) : (
            <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="grid min-h-[18rem] place-items-center rounded-[2rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-8 text-center">
              <div className="max-w-xl">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-[1.5rem] border border-zinc-800 bg-zinc-950/60 text-zinc-400">
                  <Network className="h-6 w-6" />
                </div>
                <h3 className="mt-6 text-xl font-semibold text-zinc-100">No visible transaction nodes</h3>
                <p className="mt-3 text-sm leading-7 text-zinc-500">The current topology filters produced no visible graph nodes. Relax query, kind, attention, or blocked-path filters to continue analysis.</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="border-t border-zinc-800 px-4 py-3 text-xs text-zinc-500">
        <div className="flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-1"><Network className="h-3.5 w-3.5" /> causality explicit</span>
          <span className="inline-flex items-center gap-1"><Target className="h-3.5 w-3.5" /> heads visible</span>
          <span className="inline-flex items-center gap-1"><Wrench className="h-3.5 w-3.5" /> blocked paths surfaced</span>
          <span className="inline-flex items-center gap-1"><PlayCircle className="h-3.5 w-3.5" /> replay focus explicit</span>
        </div>
      </div>
    </section>
  );
}
