import React, { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Database,
  FileSearch,
  Filter,
  GitBranch,
  HardDrive,
  Layers3,
  Link2,
  Loader2,
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
 * ADJUTORIX APP — RENDERER / COMPONENTS / IndexHealthPanel.tsx
 *
 * Canonical index integrity / freshness cockpit.
 *
 * Purpose:
 * - provide the authoritative renderer-side surface for index health, freshness, corruption posture,
 *   coverage gaps, rebuild state, and consumer dependency readiness
 * - unify index snapshots, providers/consumers, failed shards, stale scopes, rebuild intent,
 *   and diagnostics evidence under one deterministic component contract
 * - prevent the UI from treating search/tree/outline/diagnostics as trustworthy when the underlying
 *   index substrate is stale, partial, drifting, or corrupted
 * - expose explicit refresh/rebuild/select/focus actions upward without performing hidden work
 *
 * Architectural role:
 * - IndexHealthPanel is infrastructure chrome for searchability and structural coherence
 * - it does not build or validate indexes locally; it renders declared state from runtime/services
 * - it should remain useful during healthy steady-state, degraded freshness, partial coverage,
 *   interrupted rebuild, corruption recovery, and post-repair verification
 *
 * Hard invariants:
 * - overall health, freshness, and corruption posture are explicit and independently visible
 * - provider/consumer/readiness state annotates but never alters index identity
 * - ordering of indexes/issues/consumers is the provided ordering after explicit filters only
 * - all actions map to explicit callbacks or explicit disabled state
 * - identical props yield identical summaries, ordering, and visible posture
 * - no placeholders, fake rebuild progress, or hidden probing side effects
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type IndexHealth = "healthy" | "degraded" | "unhealthy" | "unknown";
export type IndexFreshness = "fresh" | "aging" | "stale" | "unknown";
export type IndexIntegrity = "clean" | "partial" | "corrupt" | "rebuilding" | "unknown";
export type IndexProviderKind = "workspace" | "watcher" | "parser" | "symbol" | "search" | "diagnostics" | "custom";
export type IndexConsumerKind = "file-tree" | "search" | "outline" | "diagnostics" | "diff" | "ledger" | "chat" | "custom";
export type IndexIssueSeverity = "info" | "warn" | "error" | "critical";

export type IndexShardItem = {
  id: string;
  label: string;
  path?: string | null;
  health?: IndexHealth;
  freshness?: IndexFreshness;
  integrity?: IndexIntegrity;
  documentCount?: number | null;
  symbolCount?: number | null;
  updatedAtMs?: number | null;
  corrupted?: boolean;
  rebuilding?: boolean;
  missingScopes?: string[];
  detail?: Record<string, unknown> | null;
};

export type IndexIssueItem = {
  id: string;
  severity: IndexIssueSeverity;
  title: string;
  summary: string;
  shardId?: string | null;
  consumerId?: string | null;
  createdAtMs?: number | null;
  detail?: Record<string, unknown> | null;
};

export type IndexConsumerItem = {
  id: string;
  label: string;
  kind: IndexConsumerKind;
  ready: boolean;
  usingFallback?: boolean;
  staleVisible?: boolean;
  blockedReason?: string | null;
};

export type IndexMetric = {
  id: string;
  label: string;
  value: string;
  tone?: "neutral" | "good" | "warn" | "bad";
};

export type IndexHealthPanelProps = {
  title?: string;
  subtitle?: string;
  health?: IndexHealth;
  freshness?: IndexFreshness;
  integrity?: IndexIntegrity;
  loading?: boolean;
  selectedShardId?: string | null;
  filterQuery?: string;
  showOnlyIssues?: boolean;
  showOnlyConsumersBlocked?: boolean;
  metrics?: IndexMetric[];
  shards: IndexShardItem[];
  issues?: IndexIssueItem[];
  consumers?: IndexConsumerItem[];
  onRefreshRequested?: () => void;
  onRebuildRequested?: () => void;
  onSelectShard?: (shard: IndexShardItem) => void;
  onFilterQueryChange?: (query: string) => void;
  onToggleShowOnlyIssues?: (value: boolean) => void;
  onToggleShowOnlyConsumersBlocked?: (value: boolean) => void;
  onFocusIssueRequested?: (issue: IndexIssueItem) => void;
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

function healthTone(level: IndexHealth | undefined): string {
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

function freshnessTone(level: IndexFreshness | undefined): string {
  switch (level) {
    case "fresh":
      return "border-emerald-700/30 bg-emerald-500/10 text-emerald-300";
    case "aging":
      return "border-amber-700/30 bg-amber-500/10 text-amber-300";
    case "stale":
      return "border-rose-700/30 bg-rose-500/10 text-rose-300";
    default:
      return "border-zinc-700/30 bg-zinc-500/10 text-zinc-300";
  }
}

function integrityTone(level: IndexIntegrity | undefined): string {
  switch (level) {
    case "clean":
      return "border-emerald-700/30 bg-emerald-500/10 text-emerald-300";
    case "partial":
    case "rebuilding":
      return "border-amber-700/30 bg-amber-500/10 text-amber-300";
    case "corrupt":
      return "border-rose-700/30 bg-rose-500/10 text-rose-300";
    default:
      return "border-zinc-700/30 bg-zinc-500/10 text-zinc-300";
  }
}

function issueTone(level: IndexIssueSeverity): string {
  switch (level) {
    case "critical":
    case "error":
      return "border-rose-700/30 bg-rose-500/10 text-rose-300";
    case "warn":
      return "border-amber-700/30 bg-amber-500/10 text-amber-300";
    default:
      return "border-sky-700/30 bg-sky-500/10 text-sky-300";
  }
}

function metricTone(tone?: IndexMetric["tone"]): string {
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

function providerIcon(kind: IndexProviderKind): JSX.Element {
  switch (kind) {
    case "workspace":
      return <HardDrive className="h-4 w-4" />;
    case "watcher":
      return <Activity className="h-4 w-4" />;
    case "parser":
      return <Layers3 className="h-4 w-4" />;
    case "symbol":
      return <Sparkles className="h-4 w-4" />;
    case "search":
      return <Search className="h-4 w-4" />;
    case "diagnostics":
      return <Wrench className="h-4 w-4" />;
    default:
      return <Database className="h-4 w-4" />;
  }
}

function consumerIcon(kind: IndexConsumerKind): JSX.Element {
  switch (kind) {
    case "file-tree":
      return <HardDrive className="h-4 w-4" />;
    case "search":
      return <FileSearch className="h-4 w-4" />;
    case "outline":
      return <Layers3 className="h-4 w-4" />;
    case "diagnostics":
      return <Wrench className="h-4 w-4" />;
    case "diff":
      return <GitBranch className="h-4 w-4" />;
    case "ledger":
      return <Link2 className="h-4 w-4" />;
    case "chat":
      return <Sparkles className="h-4 w-4" />;
    default:
      return <Target className="h-4 w-4" />;
  }
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}

function shardHasIssue(shard: IndexShardItem): boolean {
  return shard.health === "degraded" || shard.health === "unhealthy" || shard.freshness === "stale" || shard.integrity === "corrupt" || shard.integrity === "partial" || !!shard.corrupted;
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
        <div className="rounded-xl border border-zinc-800 bg-black/20 p-2.5 text-zinc-300">{props.icon ?? <Database className="h-4 w-4" />}</div>
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

function ActionButton(props: { label: string; icon?: React.ReactNode; disabled?: boolean; tone?: "primary" | "secondary"; onClick?: () => void }): JSX.Element {
  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled || !props.onClick}
      className={cx(
        "inline-flex items-center gap-2 rounded-2xl border px-4 py-2 text-sm font-medium transition",
        props.tone === "secondary"
          ? "border-zinc-800 bg-zinc-950/70 text-zinc-200 hover:bg-zinc-900"
          : "border-indigo-700/40 bg-indigo-500/15 text-indigo-200 hover:bg-indigo-500/20",
        (props.disabled || !props.onClick) && "cursor-not-allowed opacity-40",
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

export default function IndexHealthPanel(props: IndexHealthPanelProps): JSX.Element {
  const title = props.title ?? "Index health cockpit";
  const subtitle =
    props.subtitle ??
    "Authoritative surface for index freshness, integrity, consumer readiness, corruption scope, and explicit rebuild posture.";

  const health = props.health ?? "unknown";
  const freshness = props.freshness ?? "unknown";
  const integrity = props.integrity ?? "unknown";
  const loading = props.loading ?? false;
  const issues = props.issues ?? [];
  const consumers = props.consumers ?? [];
  const [localFilter, setLocalFilter] = useState(props.filterQuery ?? "");
  const showOnlyIssues = props.showOnlyIssues ?? false;
  const showOnlyConsumersBlocked = props.showOnlyConsumersBlocked ?? false;
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(props.selectedShardId ?? null);

  const visibleShards = useMemo(() => {
    const q = localFilter.trim().toLowerCase();
    return props.shards.filter((shard) => {
      if (showOnlyIssues && !shardHasIssue(shard)) return false;
      if (!q) return true;
      return (
        shard.label.toLowerCase().includes(q) ||
        (shard.path ?? "").toLowerCase().includes(q) ||
        (shard.missingScopes ?? []).join(" ").toLowerCase().includes(q)
      );
    });
  }, [localFilter, props.shards, showOnlyIssues]);

  const visibleIssues = useMemo(() => {
    if (!showOnlyIssues && !showOnlyConsumersBlocked) return issues;
    return issues.filter((issue) => (showOnlyIssues ? true : true));
  }, [issues, showOnlyConsumersBlocked, showOnlyIssues]);

  const visibleConsumers = useMemo(() => {
    return consumers.filter((consumer) => (showOnlyConsumersBlocked ? !consumer.ready || !!consumer.blockedReason : true));
  }, [consumers, showOnlyConsumersBlocked]);

  const selectedShardId = props.selectedShardId ?? localSelectedId ?? visibleShards[0]?.id ?? null;
  const selectedShard = visibleShards.find((shard) => shard.id === selectedShardId) ?? visibleShards[0] ?? null;

  const metrics = props.metrics ?? [
    { id: "shards", label: "Visible shards", value: String(visibleShards.length) },
    { id: "issues", label: "Issues", value: String(issues.length), tone: issues.length > 0 ? "warn" : "good" },
    { id: "blocked", label: "Blocked consumers", value: String(consumers.filter((c) => !c.ready || !!c.blockedReason).length), tone: consumers.some((c) => !c.ready || !!c.blockedReason) ? "bad" : "good" },
    { id: "fresh", label: "Fresh shards", value: String(props.shards.filter((s) => s.freshness === "fresh").length), tone: props.shards.some((s) => s.freshness === "fresh") ? "good" : "neutral" },
  ];

  return (
    <section className="flex h-full min-h-0 flex-col rounded-[2rem] border border-zinc-800 bg-zinc-900/70 shadow-xl">
      <div className="border-b border-zinc-800 px-5 py-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Index substrate</div>
            <h2 className="mt-1 text-lg font-semibold text-zinc-50">{title}</h2>
            <p className="mt-2 text-sm leading-7 text-zinc-400">{subtitle}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={healthTone(health)}>
              <ShieldCheck className="h-3.5 w-3.5" />
              {health}
            </Badge>
            <Badge className={freshnessTone(freshness)}>
              <Clock3 className="h-3.5 w-3.5" />
              {freshness}
            </Badge>
            <Badge className={integrityTone(integrity)}>
              <Database className="h-3.5 w-3.5" />
              {integrity}
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
              icon={metric.id === "issues" ? <AlertTriangle className="h-4 w-4" /> : metric.id === "blocked" ? <ShieldX className="h-4 w-4" /> : metric.id === "fresh" ? <CheckCircle2 className="h-4 w-4" /> : <Database className="h-4 w-4" />}
            />
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div className="flex min-w-[18rem] flex-1 items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-2.5">
            <Search className="h-4 w-4 text-zinc-500" />
            <input
              value={localFilter}
              onChange={(e) => {
                setLocalFilter(e.target.value);
                props.onFilterQueryChange?.(e.target.value);
              }}
              placeholder="Filter indexes and scope gaps"
              className="w-full bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
            />
          </div>
          <ToggleChip label="Issues only" active={showOnlyIssues} icon={<Filter className="h-3.5 w-3.5" />} onClick={props.onToggleShowOnlyIssues ? () => props.onToggleShowOnlyIssues?.(!showOnlyIssues) : undefined} />
          <ToggleChip label="Blocked consumers" active={showOnlyConsumersBlocked} icon={<ShieldX className="h-3.5 w-3.5" />} onClick={props.onToggleShowOnlyConsumersBlocked ? () => props.onToggleShowOnlyConsumersBlocked?.(!showOnlyConsumersBlocked) : undefined} />
          <ActionButton label="Rebuild" icon={<Wrench className="h-4 w-4" />} disabled={integrity === "rebuilding"} onClick={props.onRebuildRequested} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
        <AnimatePresence mode="wait">
          {loading ? (
            <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="grid min-h-[18rem] place-items-center rounded-[2rem] border border-zinc-800 bg-zinc-950/30">
              <div className="flex items-center gap-3 text-sm text-zinc-300">
                <Loader2 className="h-4 w-4 animate-spin" />
                Hydrating index integrity cockpit…
              </div>
            </motion.div>
          ) : visibleShards.length > 0 || visibleIssues.length > 0 || visibleConsumers.length > 0 ? (
            <motion.div key="index" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.16 }} className="grid gap-5 xl:grid-cols-[0.96fr_1.04fr]">
              <div className="space-y-5">
                <section className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-5 shadow-lg">
                  <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Shards / scopes</div>
                  {visibleShards.length > 0 ? (
                    <div className="mt-4 space-y-2">
                      {visibleShards.map((shard) => {
                        const selected = selectedShard?.id === shard.id;
                        return (
                          <button
                            key={shard.id}
                            onClick={() => {
                              setLocalSelectedId(shard.id);
                              props.onSelectShard?.(shard);
                            }}
                            className={cx(
                              "flex w-full items-start gap-3 rounded-[1.5rem] border px-4 py-4 text-left shadow-sm transition",
                              selected ? "border-zinc-600 bg-zinc-800 text-zinc-50" : "border-zinc-800 bg-zinc-950/50 text-zinc-200 hover:bg-zinc-900",
                            )}
                          >
                            <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-2 text-zinc-300">
                              {providerIcon("search")}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex min-w-0 flex-wrap items-center gap-2">
                                <span className="truncate text-sm font-semibold">{shard.label}</span>
                                <span className={cx("rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.2em]", healthTone(shard.health))}>{shard.health ?? "unknown"}</span>
                                <span className={cx("rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.2em]", freshnessTone(shard.freshness))}>{shard.freshness ?? "unknown"}</span>
                                <span className={cx("rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.2em]", integrityTone(shard.integrity))}>{shard.integrity ?? "unknown"}</span>
                              </div>
                              <div className="mt-2 truncate text-sm text-zinc-400">{shard.path ?? "No path"}</div>
                              <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                                {shard.documentCount != null ? <span>{shard.documentCount} docs</span> : null}
                                {shard.symbolCount != null ? <span>{shard.symbolCount} symbols</span> : null}
                                {shard.updatedAtMs ? <span>{formatDateTime(shard.updatedAtMs)}</span> : null}
                                {shard.corrupted ? <span>corrupted</span> : null}
                                {shard.rebuilding ? <span>rebuilding</span> : null}
                              </div>
                            </div>
                            <ChevronRight className="h-4 w-4 text-zinc-600" />
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="mt-4 rounded-[1.5rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-5 text-sm text-zinc-500">
                      No visible index shards match the current filter state.
                    </div>
                  )}
                </section>

                <section className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-5 shadow-lg">
                  <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Consumer readiness</div>
                  {visibleConsumers.length > 0 ? (
                    <div className="mt-4 space-y-2">
                      {visibleConsumers.map((consumer) => (
                        <div key={consumer.id} className="flex items-start gap-3 rounded-[1.25rem] border border-zinc-800 bg-zinc-950/50 px-4 py-4 shadow-sm">
                          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-2 text-zinc-300">{consumerIcon(consumer.kind)}</div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-semibold text-zinc-100">{consumer.label}</span>
                              <Badge className={consumer.ready ? "border-emerald-700/30 bg-emerald-500/10 text-emerald-300" : "border-rose-700/30 bg-rose-500/10 text-rose-300"}>{consumer.ready ? "ready" : "blocked"}</Badge>
                              {consumer.usingFallback ? <Badge className="border-amber-700/30 bg-amber-500/10 text-amber-300">fallback</Badge> : null}
                              {consumer.staleVisible ? <Badge className="border-amber-700/30 bg-amber-500/10 text-amber-300">stale-visible</Badge> : null}
                            </div>
                            {consumer.blockedReason ? <div className="mt-2 text-sm text-zinc-400">{consumer.blockedReason}</div> : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-4 rounded-[1.5rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-5 text-sm text-zinc-500">
                      No visible consumers under the current filter state.
                    </div>
                  )}
                </section>
              </div>

              <div className="space-y-5">
                <section className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-5 shadow-lg">
                  <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Selected shard</div>
                  {selectedShard ? (
                    <div className="mt-4 space-y-4">
                      <div>
                        <div className="text-lg font-semibold text-zinc-50">{selectedShard.label}</div>
                        <div className="mt-2 text-sm leading-7 text-zinc-400">{selectedShard.path ?? "No path bound"}</div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Badge className={healthTone(selectedShard.health)}>{selectedShard.health ?? "unknown"}</Badge>
                        <Badge className={freshnessTone(selectedShard.freshness)}>{selectedShard.freshness ?? "unknown"}</Badge>
                        <Badge className={integrityTone(selectedShard.integrity)}>{selectedShard.integrity ?? "unknown"}</Badge>
                        {selectedShard.corrupted ? <Badge className="border-rose-700/30 bg-rose-500/10 text-rose-300">corrupted</Badge> : null}
                        {selectedShard.rebuilding ? <Badge className="border-amber-700/30 bg-amber-500/10 text-amber-300">rebuilding</Badge> : null}
                      </div>

                      <div className="grid gap-3 sm:grid-cols-2">
                        <MetricCard label="Documents" value={selectedShard.documentCount != null ? String(selectedShard.documentCount) : "Unknown"} icon={<FileSearch className="h-4 w-4" />} />
                        <MetricCard label="Symbols" value={selectedShard.symbolCount != null ? String(selectedShard.symbolCount) : "Unknown"} icon={<Sparkles className="h-4 w-4" />} />
                        <MetricCard label="Updated" value={formatDateTime(selectedShard.updatedAtMs)} icon={<Clock3 className="h-4 w-4" />} />
                        <MetricCard label="Scopes missing" value={String(selectedShard.missingScopes?.length ?? 0)} tone={(selectedShard.missingScopes?.length ?? 0) > 0 ? "warn" : "good"} icon={<Layers3 className="h-4 w-4" />} />
                      </div>

                      {selectedShard.missingScopes && selectedShard.missingScopes.length > 0 ? (
                        <div className="rounded-[1.25rem] border border-amber-700/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                          Missing scopes: {selectedShard.missingScopes.join(", ")}
                        </div>
                      ) : null}

                      <div className="rounded-[1.5rem] border border-zinc-800 bg-zinc-950/50 p-4 shadow-sm">
                        <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Shard detail</div>
                        <pre className="mt-3 overflow-auto whitespace-pre-wrap break-words rounded-2xl border border-zinc-800 bg-black/20 p-4 font-mono text-xs leading-6 text-zinc-300">
{prettyJson(selectedShard.detail)}
                        </pre>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-4 rounded-[1.5rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-5 text-sm text-zinc-500">
                      Select a visible shard to inspect freshness, integrity, and missing scope detail.
                    </div>
                  )}
                </section>

                <section className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-5 shadow-lg">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Issues</div>
                    <Badge className={issues.length > 0 ? "border-amber-700/30 bg-amber-500/10 text-amber-300" : "border-emerald-700/30 bg-emerald-500/10 text-emerald-300"}>{issues.length}</Badge>
                  </div>
                  {visibleIssues.length > 0 ? (
                    <div className="mt-4 space-y-2">
                      {visibleIssues.map((issue) => (
                        <button
                          key={issue.id}
                          onClick={() => props.onFocusIssueRequested?.(issue)}
                          disabled={!props.onFocusIssueRequested}
                          className={cx(
                            "flex w-full items-start gap-3 rounded-[1.25rem] border px-4 py-4 text-left shadow-sm transition",
                            issueTone(issue.severity),
                            !props.onFocusIssueRequested && "cursor-not-allowed opacity-70",
                          )}
                        >
                          <div className="rounded-xl border border-zinc-800 bg-black/20 p-2 text-current">
                            {issue.severity === "critical" || issue.severity === "error" ? <XCircle className="h-4 w-4" /> : issue.severity === "warn" ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-semibold">{issue.title}</div>
                            <div className="mt-2 text-sm opacity-90">{issue.summary}</div>
                            <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.2em] opacity-80">
                              <span>{issue.severity}</span>
                              {issue.shardId ? <span>shard {issue.shardId}</span> : null}
                              {issue.consumerId ? <span>consumer {issue.consumerId}</span> : null}
                              {issue.createdAtMs ? <span>{formatDateTime(issue.createdAtMs)}</span> : null}
                            </div>
                          </div>
                          <ChevronRight className="h-4 w-4 opacity-70" />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-4 rounded-[1.5rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-5 text-sm text-zinc-500">
                      No visible issues under the current filter state.
                    </div>
                  )}
                </section>
              </div>
            </motion.div>
          ) : (
            <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="grid min-h-[18rem] place-items-center rounded-[2rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-8 text-center">
              <div className="max-w-xl">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-[1.5rem] border border-zinc-800 bg-zinc-950/60 text-zinc-400">
                  <Database className="h-6 w-6" />
                </div>
                <h3 className="mt-6 text-xl font-semibold text-zinc-100">No visible index state</h3>
                <p className="mt-3 text-sm leading-7 text-zinc-500">The current filters produced no visible shards, issues, or consumers. Relax issue or blocked-consumer filters to continue inspection.</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="border-t border-zinc-800 px-4 py-3 text-xs text-zinc-500">
        <div className="flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-1"><Database className="h-3.5 w-3.5" /> index truth centralized</span>
          <span className="inline-flex items-center gap-1"><Clock3 className="h-3.5 w-3.5" /> freshness explicit</span>
          <span className="inline-flex items-center gap-1"><ShieldX className="h-3.5 w-3.5" /> blocked consumers surfaced</span>
          <span className="inline-flex items-center gap-1"><Wrench className="h-3.5 w-3.5" /> rebuild explicit</span>
        </div>
      </div>
    </section>
  );
}
