import React, { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Eye,
  FileCode2,
  Filter,
  GitBranch,
  History,
  Layers3,
  Link2,
  Loader2,
  PlayCircle,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Sparkles,
  Target,
  Wrench,
} from "lucide-react";

/**
 * ADJUTORIX APP — RENDERER / COMPONENTS / LedgerPanel.tsx
 *
 * Canonical renderer-side ledger/history cockpit.
 *
 * Purpose:
 * - provide the authoritative renderer surface for ledger history, heads, timeline context,
 *   selected entry detail, and replay/recovery anchoring
 * - unify current heads, filtered timeline slices, patch/verify/apply references,
 *   diagnostics pressure, and replay intent under one deterministic component contract
 * - prevent ledger viewing from collapsing into a flat event list detached from
 *   lineage semantics and operational state
 * - expose explicit selection/filter/replay intent upward without performing replay locally
 *
 * Architectural role:
 * - LedgerPanel is the navigation-and-context layer over ledger state
 * - it does not persist entries or execute replay; it renders declared ledger state
 * - it should remain useful in empty, partial, degraded, and fully populated history states
 *
 * Hard invariants:
 * - visible ordering is the provided ordering after explicit user filters only
 * - selected entry identity is explicit and stable
 * - heads and replay anchors are surfaced independently of timeline selection
 * - filters change visibility only, never mutate ledger identity
 * - action affordances are explicit callbacks or explicit disabled state
 * - identical props yield identical ordering, tallies, and visible posture
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type LedgerHealth = "healthy" | "degraded" | "unhealthy" | "unknown";
export type LedgerAttention = "none" | "low" | "medium" | "high" | "critical";
export type LedgerDirection = "forward" | "reverse";
export type LedgerEntryKind =
  | "workspace-open"
  | "workspace-close"
  | "patch-preview"
  | "patch-approve"
  | "verify-run"
  | "verify-bind"
  | "patch-apply"
  | "diagnostic"
  | "agent"
  | "replay"
  | "unknown";

export type LedgerEntryReference = {
  patchId?: string | null;
  previewHash?: string | null;
  verifyId?: string | null;
  requestHash?: string | null;
};

export type LedgerEntryItem = {
  id: string;
  seq: number;
  kind: LedgerEntryKind;
  tsMs: number;
  title: string;
  summary: string;
  attention?: LedgerAttention;
  references?: LedgerEntryReference;
  detail?: Record<string, unknown> | null;
};

export type LedgerHeads = {
  currentSeq?: number | null;
  appliedSeq?: number | null;
  verifiedSeq?: number | null;
  previewSeq?: number | null;
  replaySeq?: number | null;
};

export type LedgerReplayState = {
  fromSeq?: number | null;
  toSeq?: number | null;
  lastReplayTargetSeq?: number | null;
  lastReplayAtMs?: number | null;
};

export type LedgerMetric = {
  id: string;
  label: string;
  value: string;
  tone?: "neutral" | "good" | "warn" | "bad";
};

export type LedgerPanelProps = {
  title?: string;
  subtitle?: string;
  health?: LedgerHealth;
  direction?: LedgerDirection;
  loading?: boolean;
  heads?: LedgerHeads;
  replay?: LedgerReplayState;
  metrics?: LedgerMetric[];
  entries: LedgerEntryItem[];
  selectedEntryId?: string | null;
  filterQuery?: string;
  kindFilters?: string[];
  attentionOnly?: boolean;
  minSeq?: number | null;
  maxSeq?: number | null;
  onRefreshRequested?: () => void;
  onSelectEntry?: (entry: LedgerEntryItem) => void;
  onFilterQueryChange?: (query: string) => void;
  onKindFiltersChange?: (kinds: string[]) => void;
  onToggleAttentionOnly?: (value: boolean) => void;
  onReplayAnchorChange?: (fromSeq: number | null, toSeq: number | null) => void;
  onReplayRequested?: (targetSeq: number) => void;

  ledgerId?: string | null;
  ledger?: { id?: string | null } | null;
  identity?: { ledgerId?: string | null } | null;
  selectedLedgerId?: string | null;
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

function attentionRank(level: LedgerAttention | undefined): number {
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

function healthTone(level: LedgerHealth | undefined): string {
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

function attentionTone(level: LedgerAttention | undefined): string {
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

function metricTone(tone?: LedgerMetric["tone"]): string {
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

function kindIcon(kind: LedgerEntryKind): JSX.Element {
  switch (kind) {
    case "patch-preview":
    case "patch-approve":
    case "patch-apply":
      return <GitBranch className="h-4 w-4" />;
    case "verify-run":
    case "verify-bind":
      return <ShieldCheck className="h-4 w-4" />;
    case "diagnostic":
      return <Wrench className="h-4 w-4" />;
    case "replay":
      return <PlayCircle className="h-4 w-4" />;
    case "agent":
      return <Sparkles className="h-4 w-4" />;
    default:
      return <History className="h-4 w-4" />;
  }
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
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
        <div className="rounded-xl border border-zinc-800 bg-black/20 p-2.5 text-zinc-300">{props.icon ?? <Layers3 className="h-4 w-4" />}</div>
      </div>
    </div>
  );
}

function ToggleChip(props: { label: string; active: boolean; icon?: React.ReactNode; onClick?: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={!props.onClick}
      className={cx(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition",
        props.active
          ? "border-zinc-600 bg-zinc-800 text-zinc-50"
          : "border-zinc-800 bg-zinc-950/60 text-zinc-300 hover:bg-zinc-900",
        !props.onClick && "cursor-not-allowed opacity-40",
      )}
    >
      {props.icon ? <span className="shrink-0">{props.icon}</span> : null}
      <span>{props.label}</span>
    </button>
  );
}

export default function LedgerPanel(props: LedgerPanelProps): JSX.Element {
  const compatLedgerId =
    props.ledgerId ??
    props.ledger?.id ??
    props.identity?.ledgerId ??
    props.selectedLedgerId ??
    null;
  const title = props.title ?? "Ledger cockpit";
  const subtitle =
    props.subtitle ??
    "Unified history surface for ledger heads, timeline entries, selected lineage detail, and replay anchoring.";

  const health = props.health ?? "unknown";
  const direction = props.direction ?? "reverse";
  const loading = props.loading ?? false;
  const [localFilter, setLocalFilter] = useState(props.filterQuery ?? "");
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(props.selectedEntryId ?? null);
  const [localKinds, setLocalKinds] = useState<string[]>(props.kindFilters ?? []);
  const attentionOnly = props.attentionOnly ?? false;

  const visibleEntries = useMemo(() => {
    const q = localFilter.trim().toLowerCase();
    const list = props.entries.filter((entry) => {
      if (attentionOnly && attentionRank(entry.attention) === 0) return false;
      if (localKinds.length > 0 && !localKinds.includes(entry.kind)) return false;
      if (props.minSeq !== null && props.minSeq !== undefined && entry.seq < props.minSeq) return false;
      if (props.maxSeq !== null && props.maxSeq !== undefined && entry.seq > props.maxSeq) return false;
      if (!q) return true;
      return (
        entry.title.toLowerCase().includes(q) ||
        entry.summary.toLowerCase().includes(q) ||
        entry.kind.toLowerCase().includes(q) ||
        (entry.references?.patchId ?? "").toLowerCase().includes(q) ||
        (entry.references?.verifyId ?? "").toLowerCase().includes(q) ||
        (entry.references?.previewHash ?? "").toLowerCase().includes(q)
      );
    });
    return direction === "forward" ? list : [...list].reverse();
  }, [attentionOnly, direction, localFilter, localKinds, props.entries, props.maxSeq, props.minSeq]);

  const selectedEntryId = props.selectedEntryId ?? localSelectedId ?? visibleEntries[0]?.id ?? null;
  const selectedEntry = visibleEntries.find((entry) => entry.id === selectedEntryId) ?? visibleEntries[0] ?? null;

  const metrics: LedgerMetric[] = Array.isArray(props.metrics)
    ? props.metrics
    : props.metrics && typeof props.metrics === "object"
      ? Object.entries(props.metrics).map(([id, value]) => ({
          id,
          label: String(id)
            .replace(/([A-Z])/g, " $1")
            .replace(/^./, (ch) => ch.toUpperCase()),
          value: String(value ?? 0),
        }))
      : [
    { id: "entries", label: "Visible entries", value: String(visibleEntries.length) },
    { id: "current", label: "Current head", value: props.heads?.currentSeq != null ? String(props.heads.currentSeq) : "None", tone: props.heads?.currentSeq != null ? "good" : "neutral" },
    { id: "verified", label: "Verified head", value: props.heads?.verifiedSeq != null ? String(props.heads.verifiedSeq) : "None", tone: props.heads?.verifiedSeq != null ? "good" : "neutral" },
    { id: "replay", label: "Replay anchor", value: props.replay?.lastReplayTargetSeq != null ? String(props.replay.lastReplayTargetSeq) : "None", tone: props.replay?.lastReplayTargetSeq != null ? "warn" : "neutral" },
  ];

  const kindUniverse = useMemo(
  () =>
    [...new Set(
      props.entries
        .map((entry) => entry.kind)
        .filter((kind): kind is LedgerEntryKind => typeof kind === "string" && kind.trim().length > 0),
    )].sort((a, b) => a.localeCompare(b)),
  [props.entries],
);

  return (
    <section className="flex h-full min-h-0 flex-col rounded-[2rem] border border-zinc-800 bg-zinc-900/70 shadow-xl">
      <div className="border-b border-zinc-800 px-5 py-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Transactions</div>
            <h2 className="mt-1 text-lg font-semibold text-zinc-50">{title}</h2>
            <p className="mt-2 text-sm leading-7 text-zinc-400">{subtitle}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={healthTone(health)}>
              <ShieldCheck className="h-3.5 w-3.5" />
              {health}
            </Badge>
            <Badge className="border-zinc-700/30 bg-zinc-500/10 text-zinc-300">
              <History className="h-3.5 w-3.5" />
              {direction}
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

        {compatLedgerId ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
              <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Record id</div>
              <div className="mt-1 text-sm font-medium text-zinc-100">{String(compatLedgerId)}</div>
            </div>
          </div>
        ) : null}

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {metrics.map((metric) => (
            <MetricCard
              key={metric.id}
              label={metric.label}
              value={metric.value}
              tone={metric.tone}
              icon={metric.id.includes("current") ? <Target className="h-4 w-4" /> : metric.id.includes("verified") ? <ShieldCheck className="h-4 w-4" /> : metric.id.includes("replay") ? <PlayCircle className="h-4 w-4" /> : <History className="h-4 w-4" />}
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
              placeholder="Filter ledger timeline"
              className="w-full bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <ToggleChip label="Attention only" active={attentionOnly} icon={<AlertTriangle className="h-3.5 w-3.5" />} onClick={props.onToggleAttentionOnly ? () => props.onToggleAttentionOnly?.(!attentionOnly) : undefined} />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {kindUniverse.map((kind) => {
            const active = localKinds.includes(kind);
            return (
              <ToggleChip
                key={`kind:${kind}`}
                label={kind}
                active={active}
                icon={kindIcon(kind as LedgerEntryKind)}
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
                Hydrating ledger cockpit…
              </div>
            </motion.div>
          ) : visibleEntries.length > 0 ? (
            <motion.div key="ledger" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.16 }} className="grid gap-5 xl:grid-cols-[0.95fr_1.05fr]">
              <div className="space-y-2">
                {visibleEntries.map((entry) => {
                  const selected = selectedEntry?.id === entry.id;
                  return (
                    <button
                      key={`${entry.id}:${entry.seq}:${entry.kind}:${entry.tsMs ?? "na"}`}
                      onClick={() => {
                        setLocalSelectedId(entry.id);
                        props.onSelectEntry?.(entry);
                      }}
                      className={cx(
                        "flex w-full items-start gap-3 rounded-[1.5rem] border px-4 py-4 text-left shadow-sm transition",
                        selected ? "border-zinc-600 bg-zinc-800 text-zinc-50" : "border-zinc-800 bg-zinc-950/50 text-zinc-200 hover:bg-zinc-900",
                      )}
                    >
                      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-2 text-zinc-300">{kindIcon(entry.kind)}</div>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-semibold">{entry.title}</span>
                          <span className="rounded-full border border-zinc-700/30 bg-zinc-500/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] text-zinc-300">seq {entry.seq}</span>
                          <span className={cx("rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.2em]", attentionTone(entry.attention))}>{entry.attention ?? "none"}</span>
                        </div>
                        <div className="mt-2 text-sm text-zinc-400">{entry.summary}</div>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                          <span>{entry.kind}</span>
                          <span>{formatDateTime(entry.tsMs)}</span>
                          {entry.references?.patchId ? <span>patch {entry.references.patchId}</span> : null}
                          {entry.references?.verifyId ? <span>verify {entry.references.verifyId}</span> : null}
                          {entry.references?.previewHash ? <span>preview {entry.references.previewHash}</span> : null}
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 text-zinc-600" />
                    </button>
                  );
                })}
              </div>

              <div className="space-y-5">
                <section className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-5 shadow-lg">
                  <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Heads</div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <MetricCard label="Current" value={props.heads?.currentSeq != null ? String(props.heads.currentSeq) : "None"} tone={props.heads?.currentSeq != null ? "good" : "neutral"} icon={<Target className="h-4 w-4" />} />
                    <MetricCard label="Applied" value={props.heads?.appliedSeq != null ? String(props.heads.appliedSeq) : "None"} tone={props.heads?.appliedSeq != null ? "good" : "neutral"} icon={<GitBranch className="h-4 w-4" />} />
                    <MetricCard label="Verified" value={props.heads?.verifiedSeq != null ? String(props.heads.verifiedSeq) : "None"} tone={props.heads?.verifiedSeq != null ? "good" : "neutral"} icon={<ShieldCheck className="h-4 w-4" />} />
                    <MetricCard label="Replay" value={props.heads?.replaySeq != null ? String(props.heads.replaySeq) : "None"} tone={props.heads?.replaySeq != null ? "warn" : "neutral"} icon={<PlayCircle className="h-4 w-4" />} />
                  </div>
                </section>

                <section className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-5 shadow-lg">
                  <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Replay anchors</div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <MetricCard label="From" value={props.replay?.fromSeq != null ? String(props.replay.fromSeq) : "None"} icon={<Link2 className="h-4 w-4" />} />
                    <MetricCard label="To" value={props.replay?.toSeq != null ? String(props.replay.toSeq) : "None"} icon={<Link2 className="h-4 w-4" />} />
                    <MetricCard label="Last replay" value={props.replay?.lastReplayTargetSeq != null ? String(props.replay.lastReplayTargetSeq) : "None"} tone={props.replay?.lastReplayTargetSeq != null ? "warn" : "neutral"} icon={<PlayCircle className="h-4 w-4" />} />
                    <MetricCard label="At" value={formatDateTime(props.replay?.lastReplayAtMs)} icon={<Clock3 className="h-4 w-4" />} />
                  </div>
                  {selectedEntry ? (
                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        onClick={() => props.onReplayAnchorChange?.(selectedEntry.seq, props.replay?.toSeq ?? null)}
                        className={cx(
                          "inline-flex items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-900",
                          !props.onReplayAnchorChange && "cursor-not-allowed opacity-40",
                        )}
                        disabled={!props.onReplayAnchorChange}
                      >
                        <Link2 className="h-4 w-4" />
                        Set from
                      </button>
                      <button
                        onClick={() => props.onReplayAnchorChange?.(props.replay?.fromSeq ?? null, selectedEntry.seq)}
                        className={cx(
                          "inline-flex items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-900",
                          !props.onReplayAnchorChange && "cursor-not-allowed opacity-40",
                        )}
                        disabled={!props.onReplayAnchorChange}
                      >
                        <Link2 className="h-4 w-4" />
                        Set to
                      </button>
                      <button
                        onClick={() => props.onReplayRequested?.(selectedEntry.seq)}
                        className={cx(
                          "inline-flex items-center gap-2 rounded-2xl border border-indigo-700/40 bg-indigo-500/15 px-4 py-2 text-sm font-medium text-indigo-200 hover:bg-indigo-500/20",
                          !props.onReplayRequested && "cursor-not-allowed opacity-40",
                        )}
                        disabled={!props.onReplayRequested}
                      >
                        <PlayCircle className="h-4 w-4" />
                        Replay to selected
                      </button>
                    </div>
                  ) : null}
                </section>

                <section className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-5 shadow-lg">
                  <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Selected entry</div>
                  {selectedEntry ? (
                    <div className="mt-4 space-y-4">
                      <div>
                        <div className="text-lg font-semibold text-zinc-50">{selectedEntry.title}</div>
                        <div className="mt-2 text-sm leading-7 text-zinc-400">{selectedEntry.summary}</div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Badge className={attentionTone(selectedEntry.attention)}>
                          <AlertTriangle className="h-3.5 w-3.5" />
                          {selectedEntry.attention ?? "none"}
                        </Badge>
                        <Badge className="border-zinc-700/30 bg-zinc-500/10 text-zinc-300">
                          <History className="h-3.5 w-3.5" />
                          seq {selectedEntry.seq}
                        </Badge>
                        <Badge className="border-zinc-700/30 bg-zinc-500/10 text-zinc-300">
                          <Clock3 className="h-3.5 w-3.5" />
                          {formatDateTime(selectedEntry.tsMs)}
                        </Badge>
                      </div>

                      <div className="grid gap-3 sm:grid-cols-2">
                        <MetricCard label="Patch" value={selectedEntry.references?.patchId ?? "None"} icon={<GitBranch className="h-4 w-4" />} />
                        <MetricCard label="Verify" value={selectedEntry.references?.verifyId ?? "None"} icon={<ShieldCheck className="h-4 w-4" />} />
                        <MetricCard label="Preview" value={selectedEntry.references?.previewHash ?? "None"} icon={<Sparkles className="h-4 w-4" />} />
                        <MetricCard label="Request" value={selectedEntry.references?.requestHash ?? "None"} icon={<Activity className="h-4 w-4" />} />
                      </div>

                      <div className="rounded-[1.5rem] border border-zinc-800 bg-zinc-950/50 p-4 shadow-sm">
                        <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Detail payload</div>
                        <pre className="mt-3 overflow-auto whitespace-pre-wrap break-words rounded-2xl border border-zinc-800 bg-black/20 p-4 font-mono text-xs leading-6 text-zinc-300">
{prettyJson(selectedEntry.detail)}
                        </pre>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-4 rounded-[1.5rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-5 text-sm text-zinc-500">
                      Select a visible ledger entry to inspect its lineage references and structured detail.
                    </div>
                  )}
                </section>
              </div>
            </motion.div>
          ) : (
            <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="grid min-h-[18rem] place-items-center rounded-[2rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-8 text-center">
              <div className="max-w-xl">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-[1.5rem] border border-zinc-800 bg-zinc-950/60 text-zinc-400">
                  <History className="h-6 w-6" />
                </div>
                <h3 className="mt-6 text-xl font-semibold text-zinc-100">No visible ledger entries</h3>
                <p className="mt-3 text-sm leading-7 text-zinc-500">The current timeline filters produced no visible history entries. Relax query or kind filters to continue navigation.</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="border-t border-zinc-800 px-4 py-3 text-xs text-zinc-500">
        <div className="flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-1"><History className="h-3.5 w-3.5" /> timeline explicit</span>
          <span className="inline-flex items-center gap-1"><Target className="h-3.5 w-3.5" /> heads independent</span>
          <span className="inline-flex items-center gap-1"><Link2 className="h-3.5 w-3.5" /> replay anchors explicit</span>
          <span className="inline-flex items-center gap-1"><GitBranch className="h-3.5 w-3.5" /> lineage references visible</span>
        </div>
      </div>
    </section>
  );
}
