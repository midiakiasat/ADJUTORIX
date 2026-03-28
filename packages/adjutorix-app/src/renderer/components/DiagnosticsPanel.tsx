import React, { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  Archive,
  CheckCircle2,
  ChevronRight,
  Download,
  Eye,
  FileWarning,
  Filter,
  Gauge,
  HardDriveDownload,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  TerminalSquare,
  Wrench,
  XCircle,
} from "lucide-react";

/**
 * ADJUTORIX APP — RENDERER / COMPONENTS / DiagnosticsPanel.tsx
 *
 * Canonical renderer diagnostics cockpit.
 *
 * Purpose:
 * - provide the authoritative renderer surface for diagnostics and observability
 * - unify runtime health, startup evidence, crash context, log streams, export workflow,
 *   and operational actions under one deterministic component contract
 * - prevent diagnostics from degrading into disconnected widgets that mix stale and
 *   current evidence without a coherent operational posture
 * - surface actionable failure context without performing hidden collection/export work
 *
 * Architectural role:
 * - DiagnosticsPanel is a presentation/controller surface over explicit diagnostics state
 * - it should remain useful in healthy, degraded, and failed sessions
 * - it must distinguish evidence categories clearly and preserve temporal/action context
 *
 * Hard invariants:
 * - all visible actions map to explicit callbacks or explicit disabled state
 * - active evidence panel is explicit and stable
 * - log/result/export state is visible without mutating evidence identity
 * - identical props produce identical rendered ordering and summaries
 * - export readiness is surfaced explicitly, never implied by UI chrome
 * - no placeholders, fake telemetry, or hidden side effects
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type DiagnosticsHealth = "healthy" | "degraded" | "unhealthy" | "unknown";
export type DiagnosticsSeverity = "none" | "info" | "warn" | "error" | "critical";
export type DiagnosticsPanelView = "overview" | "runtime" | "startup" | "logs" | "crash" | "observability" | "export";
export type DiagnosticsExportPhase = "idle" | "requested" | "running" | "succeeded" | "failed";
export type DiagnosticsLogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
export type DiagnosticsLogTarget = "main" | "observability" | "custom";

export type DiagnosticsMetric = {
  id: string;
  label: string;
  value: string;
  tone?: "neutral" | "good" | "warn" | "bad";
};

export type DiagnosticsLogEntry = {
  seq: number;
  target: DiagnosticsLogTarget;
  level: DiagnosticsLogLevel;
  message: string;
  atMs: number;
};

export type DiagnosticsLogStream = {
  target: DiagnosticsLogTarget;
  entries: DiagnosticsLogEntry[];
  truncated?: boolean;
  requestedLines?: number | null;
  requestedBytes?: number | null;
  lastLoadedAtMs?: number | null;
};

export type DiagnosticsPanelProps = {
  title?: string;
  subtitle?: string;
  health?: DiagnosticsHealth;
  severity?: DiagnosticsSeverity;
  loading?: boolean;
  activeView?: DiagnosticsPanelView;
  runtimeSnapshot?: Record<string, unknown> | null;
  startupReport?: Record<string, unknown> | null;
  crashContext?: Record<string, unknown> | null;
  observabilityBundle?: Record<string, unknown> | null;
  logsByTarget?: Record<DiagnosticsLogTarget, DiagnosticsLogStream>;
  exportPhase?: DiagnosticsExportPhase;
  exportReady?: boolean;
  exportArtifactPath?: string | null;
  exportError?: string | null;
  metrics?: DiagnosticsMetric[];
  filterQuery?: string;
  selectedLogTarget?: DiagnosticsLogTarget;
  selectedLogSeq?: number | null;
  showOnlyErrors?: boolean;
  onRefresh?: () => void;
  onSetActiveView?: (view: DiagnosticsPanelView) => void;
  onSetFilterQuery?: (query: string) => void;
  onSetSelectedLogTarget?: (target: DiagnosticsLogTarget) => void;
  onSelectLogEntry?: (entry: DiagnosticsLogEntry) => void;
  onToggleShowOnlyErrors?: (value: boolean) => void;
  onExportRequested?: () => void;
  onOpenArtifact?: () => void;
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}

function formatTime(ts?: number | null): string {
  if (!ts) return "Unknown";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function toneForHealth(health: DiagnosticsHealth): string {
  switch (health) {
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

function toneForSeverity(severity: DiagnosticsSeverity): string {
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

function metricTone(tone?: DiagnosticsMetric["tone"]): string {
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

function logLevelTone(level: DiagnosticsLogLevel): string {
  switch (level) {
    case "fatal":
    case "error":
      return "text-rose-300";
    case "warn":
      return "text-amber-300";
    case "info":
      return "text-sky-300";
    default:
      return "text-zinc-400";
  }
}

function exportTone(phase: DiagnosticsExportPhase): string {
  switch (phase) {
    case "succeeded":
      return "border-emerald-700/30 bg-emerald-500/10 text-emerald-300";
    case "failed":
      return "border-rose-700/30 bg-rose-500/10 text-rose-300";
    case "running":
    case "requested":
      return "border-amber-700/30 bg-amber-500/10 text-amber-300";
    default:
      return "border-zinc-700/30 bg-zinc-500/10 text-zinc-300";
  }
}

function levelRank(level: DiagnosticsLogLevel): number {
  return { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 }[level];
}

// -----------------------------------------------------------------------------
// SUBCOMPONENTS
// -----------------------------------------------------------------------------

function Section(props: { title: string; subtitle?: string; actions?: React.ReactNode; children: React.ReactNode }): JSX.Element {
  return (
    <section className="rounded-[2rem] border border-zinc-800 bg-zinc-900/70 shadow-lg">
      <div className="flex flex-col gap-4 border-b border-zinc-800 px-5 py-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Diagnostics</div>
          <h3 className="mt-1 text-lg font-semibold text-zinc-50">{props.title}</h3>
          {props.subtitle ? <p className="mt-2 text-sm leading-7 text-zinc-400">{props.subtitle}</p> : null}
        </div>
        {props.actions ? <div className="shrink-0">{props.actions}</div> : null}
      </div>
      <div className="p-5">{props.children}</div>
    </section>
  );
}

function MetricCard(props: { metric: DiagnosticsMetric; icon?: React.ReactNode }): JSX.Element {
  return (
    <div className={cx("rounded-[1.5rem] border p-4 shadow-sm", metricTone(props.metric.tone))}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] opacity-70">{props.metric.label}</div>
          <div className="mt-2 text-lg font-semibold tracking-tight">{props.metric.value}</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-black/20 p-2.5 text-zinc-300">{props.icon ?? <Gauge className="h-4 w-4" />}</div>
      </div>
    </div>
  );
}

function JsonEvidenceCard(props: { title: string; value: Record<string, unknown> | null | undefined; emptyLabel: string }): JSX.Element {
  return (
    <div className="rounded-[1.5rem] border border-zinc-800 bg-zinc-950/50 shadow-sm">
      <div className="border-b border-zinc-800 px-4 py-3">
        <div className="text-sm font-semibold text-zinc-100">{props.title}</div>
      </div>
      <div className="max-h-[28rem] overflow-auto px-4 py-4">
        {props.value ? (
          <pre className="overflow-auto whitespace-pre-wrap break-words rounded-2xl border border-zinc-800 bg-black/20 p-4 font-mono text-xs leading-6 text-zinc-300">
            {prettyJson(props.value)}
          </pre>
        ) : (
          <div className="rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/30 p-4 text-sm text-zinc-500">{props.emptyLabel}</div>
        )}
      </div>
    </div>
  );
}

function ViewTab(props: { active: boolean; label: string; onClick?: () => void }): JSX.Element {
  return (
    <button
      onClick={props.onClick}
      className={cx(
        "rounded-full border px-3 py-1.5 text-xs font-medium transition",
        props.active
          ? "border-indigo-700/30 bg-indigo-500/10 text-indigo-200"
          : "border-zinc-800 bg-zinc-950/60 text-zinc-300 hover:bg-zinc-900",
      )}
    >
      {props.label}
    </button>
  );
}

// -----------------------------------------------------------------------------
// MAIN COMPONENT
// -----------------------------------------------------------------------------

export default function DiagnosticsPanel(props: DiagnosticsPanelProps): JSX.Element {
  const health = props.health ?? "unknown";
  const severity = props.severity ?? "none";
  const loading = props.loading ?? false;
  const title = props.title ?? "Diagnostics cockpit";
  const subtitle =
    props.subtitle ??
    "Operational diagnostics surface for runtime posture, startup evidence, logs, crash context, observability, and export readiness.";
  const activeView = props.activeView ?? "overview";
  const exportPhase = props.exportPhase ?? "idle";
  const exportReady = props.exportReady ?? false;
  const filterQuery = props.filterQuery ?? "";
  const showOnlyErrors = props.showOnlyErrors ?? false;
  const selectedLogTarget = props.selectedLogTarget ?? "main";
  const selectedLogSeq = props.selectedLogSeq ?? null;

  const [localQuery, setLocalQuery] = useState(filterQuery);

  const logsByTarget: Record<DiagnosticsLogTarget, DiagnosticsLogStream> = props.logsByTarget ?? {
    main: { target: "main", entries: [] },
    observability: { target: "observability", entries: [] },
    custom: { target: "custom", entries: [] },
  };

  const currentStream = logsByTarget[selectedLogTarget] ?? { target: selectedLogTarget, entries: [] };

  const filteredLogs = useMemo(() => {
    const q = localQuery.trim().toLowerCase();
    return currentStream.entries.filter((entry) => {
      if (showOnlyErrors && levelRank(entry.level) < levelRank("error")) return false;
      if (!q) return true;
      return entry.message.toLowerCase().includes(q);
    });
  }, [currentStream.entries, localQuery, showOnlyErrors]);

  const selectedLog = filteredLogs.find((entry) => entry.seq === selectedLogSeq) ?? null;

  const derivedMetrics = props.metrics ?? [
    { id: "health", label: "Health", value: health, tone: health === "healthy" ? "good" : health === "degraded" ? "warn" : health === "unhealthy" ? "bad" : "neutral" },
    { id: "logs", label: "Log entries", value: String(currentStream.entries.length), tone: currentStream.entries.length > 0 ? "neutral" : "warn" },
    { id: "export", label: "Export", value: exportPhase, tone: exportPhase === "succeeded" ? "good" : exportPhase === "failed" ? "bad" : exportPhase === "running" ? "warn" : "neutral" },
    { id: "severity", label: "Severity", value: severity, tone: severity === "error" || severity === "critical" ? "bad" : severity === "warn" ? "warn" : "neutral" },
  ];

  return (
    <section className="flex h-full min-h-0 flex-col rounded-[2rem] border border-zinc-800 bg-zinc-900/70 shadow-xl">
      <div className="border-b border-zinc-800 px-5 py-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Diagnostics</div>
            <h2 className="mt-1 text-lg font-semibold text-zinc-50">{title}</h2>
            <p className="mt-2 text-sm leading-7 text-zinc-400">{subtitle}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className={cx("inline-flex items-center gap-1 rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.2em]", toneForHealth(health))}>
              <ShieldCheck className="h-3.5 w-3.5" />
              {health}
            </span>
            <span className={cx("inline-flex items-center gap-1 rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.2em]", toneForSeverity(severity))}>
              <AlertTriangle className="h-3.5 w-3.5" />
              {severity}
            </span>
            <button
              onClick={props.onRefresh}
              disabled={!props.onRefresh}
              className={cx(
                "rounded-2xl border border-zinc-800 bg-zinc-950/70 p-2.5 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100",
                !props.onRefresh && "cursor-not-allowed opacity-40",
              )}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          {(["overview", "runtime", "startup", "logs", "crash", "observability", "export"] as DiagnosticsPanelView[]).map((view) => (
            <ViewTab key={view} active={activeView === view} label={view} onClick={props.onSetActiveView ? () => props.onSetActiveView?.(view) : undefined} />
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
        <AnimatePresence mode="wait">
          {loading ? (
            <motion.div
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="grid min-h-[18rem] place-items-center rounded-[2rem] border border-zinc-800 bg-zinc-950/30"
            >
              <div className="flex items-center gap-3 text-sm text-zinc-300">
                <Loader2 className="h-4 w-4 animate-spin" />
                Hydrating diagnostics cockpit…
              </div>
            </motion.div>
          ) : (
            <motion.div key={activeView} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.16 }} className="space-y-5">
              {activeView === "overview" && (
                <>
                  <Section title="Operational posture" subtitle="Current diagnostic posture, evidence freshness, and export readiness at a glance.">
                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                      {derivedMetrics.map((metric) => (
                        <MetricCard
                          key={metric.id}
                          metric={metric}
                          icon={metric.id === "health" ? <Gauge className="h-4 w-4" /> : metric.id === "logs" ? <TerminalSquare className="h-4 w-4" /> : metric.id === "export" ? <Archive className="h-4 w-4" /> : <Activity className="h-4 w-4" />}
                        />
                      ))}
                    </div>
                  </Section>

                  <div className="grid gap-5 xl:grid-cols-2">
                    <JsonEvidenceCard title="Runtime snapshot" value={props.runtimeSnapshot} emptyLabel="No runtime snapshot is bound." />
                    <JsonEvidenceCard title="Startup report" value={props.startupReport} emptyLabel="No startup report is bound." />
                  </div>
                </>
              )}

              {activeView === "runtime" && (
                <Section title="Runtime evidence" subtitle="Authoritative runtime diagnostics snapshot and currently surfaced operational state.">
                  <JsonEvidenceCard title="Runtime snapshot" value={props.runtimeSnapshot} emptyLabel="No runtime snapshot is available." />
                </Section>
              )}

              {activeView === "startup" && (
                <Section title="Startup evidence" subtitle="Startup report, initialization posture, and boot-time diagnostics context.">
                  <JsonEvidenceCard title="Startup report" value={props.startupReport} emptyLabel="No startup report is available." />
                </Section>
              )}

              {activeView === "crash" && (
                <Section title="Crash context" subtitle="Crash context remains visible so failure stays inspectable instead of becoming anecdotal.">
                  <JsonEvidenceCard title="Crash context" value={props.crashContext} emptyLabel="No crash context is bound." />
                </Section>
              )}

              {activeView === "observability" && (
                <Section title="Observability bundle" subtitle="Structured observability evidence and bundle metadata for current session state.">
                  <JsonEvidenceCard title="Observability bundle" value={props.observabilityBundle} emptyLabel="No observability bundle is bound." />
                </Section>
              )}

              {activeView === "logs" && (
                <Section
                  title="Log streams"
                  subtitle="Bounded log tails with explicit target selection, error filtering, and stable entry identity."
                  actions={
                    <div className="flex flex-wrap items-center gap-2">
                      {(["main", "observability", "custom"] as DiagnosticsLogTarget[]).map((target) => (
                        <ViewTab key={target} active={selectedLogTarget === target} label={target} onClick={props.onSetSelectedLogTarget ? () => props.onSetSelectedLogTarget?.(target) : undefined} />
                      ))}
                    </div>
                  }
                >
                  <div className="space-y-4">
                    <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                      <div className="flex items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-2.5 xl:w-[32rem]">
                        <Search className="h-4 w-4 text-zinc-500" />
                        <input
                          value={localQuery}
                          onChange={(e) => {
                            setLocalQuery(e.target.value);
                            props.onSetFilterQuery?.(e.target.value);
                          }}
                          placeholder="Filter log messages"
                          className="w-full bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={props.onToggleShowOnlyErrors ? () => props.onToggleShowOnlyErrors?.(!showOnlyErrors) : undefined}
                          disabled={!props.onToggleShowOnlyErrors}
                          className={cx(
                            "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition",
                            showOnlyErrors
                              ? "border-indigo-700/30 bg-indigo-500/10 text-indigo-200"
                              : "border-zinc-800 bg-zinc-950/60 text-zinc-300 hover:bg-zinc-900",
                            !props.onToggleShowOnlyErrors && "cursor-not-allowed opacity-40",
                          )}
                        >
                          <Filter className="h-3.5 w-3.5" />
                          Errors only
                        </button>
                        <div className="rounded-full border border-zinc-800 bg-zinc-950/60 px-3 py-1.5 text-xs text-zinc-400">
                          {filteredLogs.length} visible
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
                      <div className="rounded-[1.5rem] border border-zinc-800 bg-zinc-950/40">
                        <div className="border-b border-zinc-800 px-4 py-3 text-sm font-semibold text-zinc-100">Log entries</div>
                        <div className="max-h-[32rem] overflow-auto px-3 py-3">
                          {filteredLogs.length > 0 ? (
                            <div className="space-y-2">
                              {filteredLogs.map((entry) => (
                                <button
                                  key={`${entry.target}:${entry.seq}`}
                                  onClick={() => props.onSelectLogEntry?.(entry)}
                                  className={cx(
                                    "flex w-full items-start gap-3 rounded-2xl border px-3 py-3 text-left transition",
                                    selectedLogSeq === entry.seq
                                      ? "border-zinc-600 bg-zinc-800 text-zinc-50"
                                      : "border-zinc-800 bg-zinc-950/60 text-zinc-300 hover:bg-zinc-900",
                                  )}
                                >
                                  <span className={cx("mt-0.5 text-xs font-semibold uppercase tracking-[0.18em]", logLevelTone(entry.level))}>{entry.level}</span>
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate text-sm font-medium">{entry.message}</div>
                                    <div className="mt-1 text-xs text-zinc-500">seq {entry.seq} • {formatTime(entry.atMs)}</div>
                                  </div>
                                  <ChevronRight className="h-4 w-4 text-zinc-600" />
                                </button>
                              ))}
                            </div>
                          ) : (
                            <div className="rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/30 p-4 text-sm text-zinc-500">No visible log entries for the current target/filter.</div>
                          )}
                        </div>
                      </div>

                      <div className="rounded-[1.5rem] border border-zinc-800 bg-zinc-950/40">
                        <div className="border-b border-zinc-800 px-4 py-3 text-sm font-semibold text-zinc-100">Selected entry</div>
                        <div className="max-h-[32rem] overflow-auto px-4 py-4">
                          {selectedLog ? (
                            <pre className="overflow-auto whitespace-pre-wrap break-words rounded-2xl border border-zinc-800 bg-black/20 p-4 font-mono text-xs leading-6 text-zinc-300">
{prettyJson(selectedLog)}
                            </pre>
                          ) : (
                            <div className="rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/30 p-4 text-sm text-zinc-500">Select a log entry to inspect its stable identity and timestamped message.</div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </Section>
              )}

              {activeView === "export" && (
                <Section
                  title="Diagnostics export"
                  subtitle="Export current diagnostics evidence explicitly. Export readiness is surfaced, not assumed."
                  actions={
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={props.onExportRequested}
                        disabled={!props.onExportRequested || !exportReady || exportPhase === "running"}
                        className={cx(
                          "inline-flex items-center gap-2 rounded-2xl border px-4 py-2 text-sm font-medium transition",
                          props.onExportRequested && exportReady && exportPhase !== "running"
                            ? "border-indigo-700/40 bg-indigo-500/15 text-indigo-200 hover:bg-indigo-500/20"
                            : "cursor-not-allowed border-zinc-800 bg-zinc-950/60 text-zinc-500",
                        )}
                      >
                        {exportPhase === "running" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                        Export
                      </button>
                      <button
                        onClick={props.onOpenArtifact}
                        disabled={!props.onOpenArtifact || !props.exportArtifactPath}
                        className={cx(
                          "inline-flex items-center gap-2 rounded-2xl border px-4 py-2 text-sm font-medium transition",
                          props.onOpenArtifact && props.exportArtifactPath
                            ? "border-zinc-800 bg-zinc-950/70 text-zinc-200 hover:bg-zinc-900"
                            : "cursor-not-allowed border-zinc-800 bg-zinc-950/60 text-zinc-500",
                        )}
                      >
                        <HardDriveDownload className="h-4 w-4" />
                        Open artifact
                      </button>
                    </div>
                  }
                >
                  <div className="grid gap-4 xl:grid-cols-2">
                    <div className={cx("rounded-[1.5rem] border p-5 shadow-sm", exportTone(exportPhase))}>
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <div className="text-[10px] uppercase tracking-[0.2em] opacity-70">Export phase</div>
                          <div className="mt-2 text-xl font-semibold tracking-tight">{exportPhase}</div>
                          <div className="mt-3 text-sm opacity-90">{exportReady ? "Evidence is available for explicit export." : "Export is not ready because evidence has not yet been sufficiently bound."}</div>
                        </div>
                        <div className="rounded-2xl border border-zinc-800 bg-black/20 p-3">
                          <Archive className="h-5 w-5" />
                        </div>
                      </div>
                    </div>

                    <div className="rounded-[1.5rem] border border-zinc-800 bg-zinc-950/50 p-5 shadow-sm">
                      <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Artifact path</div>
                      <div className="mt-2 break-all text-sm font-medium text-zinc-100">{props.exportArtifactPath ?? "No artifact generated"}</div>
                      {props.exportError ? <div className="mt-4 rounded-2xl border border-rose-700/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">{props.exportError}</div> : null}
                    </div>
                  </div>
                </Section>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="border-t border-zinc-800 px-4 py-3 text-xs text-zinc-500">
        <div className="flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-1"><Gauge className="h-3.5 w-3.5" /> posture explicit</span>
          <span className="inline-flex items-center gap-1"><TerminalSquare className="h-3.5 w-3.5" /> log identity stable</span>
          <span className="inline-flex items-center gap-1"><FileWarning className="h-3.5 w-3.5" /> failure inspectable</span>
          <span className="inline-flex items-center gap-1"><Archive className="h-3.5 w-3.5" /> export explicit</span>
        </div>
      </div>
    </section>
  );
}
