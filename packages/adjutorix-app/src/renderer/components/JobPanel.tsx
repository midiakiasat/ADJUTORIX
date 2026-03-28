import React, { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  Archive,
  CheckCircle2,
  ChevronRight,
  Clock3,
  FileCode2,
  FileText,
  Filter,
  GitBranch,
  Loader2,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Sparkles,
  Square,
  TerminalSquare,
  Wrench,
  XCircle,
} from "lucide-react";

/**
 * ADJUTORIX APP — RENDERER / COMPONENTS / JobPanel.tsx
 *
 * Canonical governed job orchestration cockpit.
 *
 * Purpose:
 * - provide the authoritative renderer-side surface for queued, running, completed,
 *   failed, cancelled, and replayable jobs
 * - unify job identity, lifecycle phase, authority/trust posture, lineage references,
 *   logs, artifacts, operator interventions, and selection/detail state
 * - prevent jobs from degrading into a shallow progress list detached from what each
 *   job is allowed to do, what it produced, and whether it still corresponds to the
 *   active preview/request lineage
 * - expose explicit operator intent upward without performing hidden execution,
 *   cancellation, retry, or artifact mutation locally
 *
 * Architectural role:
 * - JobPanel is the presentation-and-control layer over declared job state
 * - it does not schedule or execute jobs; it renders externally supplied truth
 * - it should remain useful in sparse, high-volume, degraded, and partially-loaded sessions
 * - it must distinguish phase, outcome, authority, and lineage rather than collapsing
 *   them into a single badge
 *
 * Hard invariants:
 * - job ordering is the provided ordering after explicit filters only
 * - selected job identity is explicit and stable
 * - filters change visibility only, never underlying job truth
 * - logs and artifacts are attached to explicit jobs only
 * - action affordances are explicit callbacks or explicit disabled state
 * - identical props yield identical ordering, tallies, and visible posture
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type JobHealth = "healthy" | "degraded" | "unhealthy" | "unknown";
export type JobPhase =
  | "idle"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "partial"
  | "stale";

export type JobKind =
  | "workspace-scan"
  | "patch-preview"
  | "verify"
  | "apply"
  | "diagnostics-export"
  | "replay"
  | "agent"
  | "custom";

export type JobTrustLevel = "unknown" | "untrusted" | "restricted" | "trusted";
export type JobAttention = "none" | "low" | "medium" | "high" | "critical";
export type JobLogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type JobReference = {
  requestHash?: string | null;
  patchId?: string | null;
  previewHash?: string | null;
  verifyId?: string | null;
  ledgerSeq?: number | null;
};

export type JobArtifact = {
  id: string;
  label: string;
  path?: string | null;
  kind?: "file" | "directory" | "report" | "bundle" | "other";
  sizeLabel?: string | null;
};

export type JobLogEntry = {
  seq: number;
  atMs: number;
  level: JobLogLevel;
  message: string;
};

export type JobItem = {
  id: string;
  title: string;
  summary: string;
  kind: JobKind;
  phase: JobPhase;
  health?: JobHealth;
  attention?: JobAttention;
  trustLevel?: JobTrustLevel;
  progressPct?: number | null;
  startedAtMs?: number | null;
  endedAtMs?: number | null;
  queuePosition?: number | null;
  authorityLabel?: string | null;
  references?: JobReference;
  artifacts?: JobArtifact[];
  logs?: JobLogEntry[];
  detail?: Record<string, unknown> | null;
};

export type JobMetric = {
  id: string;
  label: string;
  value: string;
  tone?: "neutral" | "good" | "warn" | "bad";
};

export type JobPanelProps = {
  title?: string;
  subtitle?: string;
  health?: JobHealth;
  loading?: boolean;
  jobs: JobItem[];
  metrics?: JobMetric[];
  selectedJobId?: string | null;
  filterQuery?: string;
  kindFilters?: string[];
  attentionOnly?: boolean;
  runningOnly?: boolean;
  onRefreshRequested?: () => void;
  onSelectJob?: (job: JobItem) => void;
  onFilterQueryChange?: (query: string) => void;
  onKindFiltersChange?: (kinds: string[]) => void;
  onToggleAttentionOnly?: (value: boolean) => void;
  onToggleRunningOnly?: (value: boolean) => void;
  onRunRequested?: (job: JobItem) => void;
  onCancelRequested?: (job: JobItem) => void;
  onRetryRequested?: (job: JobItem) => void;
  onOpenArtifactRequested?: (job: JobItem, artifact: JobArtifact) => void;
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

function durationMs(start?: number | null, end?: number | null): string {
  if (!start || !end || end < start) return "Unknown";
  const ms = end - start;
  if (ms < 1000) return `${ms} ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(2)} s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${(sec % 60).toFixed(1)}s`;
}

function healthTone(level: JobHealth | undefined): string {
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

function phaseTone(phase: JobPhase): string {
  switch (phase) {
    case "running":
      return "border-sky-700/30 bg-sky-500/10 text-sky-300";
    case "queued":
      return "border-indigo-700/30 bg-indigo-500/10 text-indigo-300";
    case "succeeded":
      return "border-emerald-700/30 bg-emerald-500/10 text-emerald-300";
    case "failed":
    case "cancelled":
    case "interrupted":
      return "border-rose-700/30 bg-rose-500/10 text-rose-300";
    case "partial":
    case "stale":
      return "border-amber-700/30 bg-amber-500/10 text-amber-300";
    default:
      return "border-zinc-700/30 bg-zinc-500/10 text-zinc-300";
  }
}

function trustTone(level: JobTrustLevel | undefined): string {
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

function trustIcon(level: JobTrustLevel | undefined): JSX.Element {
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

function attentionRank(level: JobAttention | undefined): number {
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

function attentionTone(level: JobAttention | undefined): string {
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

function metricTone(tone?: JobMetric["tone"]): string {
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

function logLevelTone(level: JobLogLevel): string {
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

function kindIcon(kind: JobKind): JSX.Element {
  switch (kind) {
    case "patch-preview":
      return <GitBranch className="h-4 w-4" />;
    case "verify":
      return <ShieldCheck className="h-4 w-4" />;
    case "apply":
      return <Wrench className="h-4 w-4" />;
    case "diagnostics-export":
      return <Archive className="h-4 w-4" />;
    case "replay":
      return <PlayCircle className="h-4 w-4" />;
    case "agent":
      return <Sparkles className="h-4 w-4" />;
    case "workspace-scan":
      return <FileCode2 className="h-4 w-4" />;
    default:
      return <Activity className="h-4 w-4" />;
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
        <div className="rounded-xl border border-zinc-800 bg-black/20 p-2.5 text-zinc-300">{props.icon ?? <Activity className="h-4 w-4" />}</div>
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

function ActionButton(props: { label: string; icon?: React.ReactNode; disabled?: boolean; tone?: "primary" | "secondary" | "danger"; onClick?: () => void }): JSX.Element {
  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled || !props.onClick}
      className={cx(
        "inline-flex items-center gap-2 rounded-2xl border px-4 py-2 text-sm font-medium transition",
        props.tone === "danger"
          ? "border-rose-700/40 bg-rose-500/15 text-rose-200 hover:bg-rose-500/20"
          : props.tone === "secondary"
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

export default function JobPanel(props: JobPanelProps): JSX.Element {
  const title = props.title ?? "Job cockpit";
  const subtitle =
    props.subtitle ??
    "Governed surface for job identity, lifecycle phase, authority, lineage references, artifacts, logs, and operator interventions.";

  const health = props.health ?? "unknown";
  const loading = props.loading ?? false;
  const [localFilter, setLocalFilter] = useState(props.filterQuery ?? "");
  const [localKinds, setLocalKinds] = useState<string[]>(props.kindFilters ?? []);
  const attentionOnly = props.attentionOnly ?? false;
  const runningOnly = props.runningOnly ?? false;
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(props.selectedJobId ?? null);

  const visibleJobs = useMemo(() => {
    const q = localFilter.trim().toLowerCase();
    return props.jobs.filter((job) => {
      if (attentionOnly && attentionRank(job.attention) === 0) return false;
      if (runningOnly && job.phase !== "running" && job.phase !== "queued") return false;
      if (localKinds.length > 0 && !localKinds.includes(job.kind)) return false;
      if (!q) return true;
      return (
        job.title.toLowerCase().includes(q) ||
        job.summary.toLowerCase().includes(q) ||
        job.kind.toLowerCase().includes(q) ||
        (job.references?.patchId ?? "").toLowerCase().includes(q) ||
        (job.references?.verifyId ?? "").toLowerCase().includes(q) ||
        (job.references?.previewHash ?? "").toLowerCase().includes(q) ||
        (job.references?.requestHash ?? "").toLowerCase().includes(q)
      );
    });
  }, [attentionOnly, localFilter, localKinds, props.jobs, runningOnly]);

  const selectedJobId = props.selectedJobId ?? localSelectedId ?? visibleJobs[0]?.id ?? null;
  const selectedJob = visibleJobs.find((job) => job.id === selectedJobId) ?? visibleJobs[0] ?? null;

  const metrics = props.metrics ?? [
    { id: "visible", label: "Visible jobs", value: String(visibleJobs.length) },
    { id: "running", label: "Running", value: String(props.jobs.filter((j) => j.phase === "running").length), tone: props.jobs.some((j) => j.phase === "running") ? "warn" : "neutral" },
    { id: "failed", label: "Failed", value: String(props.jobs.filter((j) => j.phase === "failed").length), tone: props.jobs.some((j) => j.phase === "failed") ? "bad" : "neutral" },
    { id: "succeeded", label: "Succeeded", value: String(props.jobs.filter((j) => j.phase === "succeeded").length), tone: props.jobs.some((j) => j.phase === "succeeded") ? "good" : "neutral" },
  ];

  const kindUniverse = useMemo(() => [...new Set(props.jobs.map((j) => j.kind))].sort((a, b) => a.localeCompare(b)), [props.jobs]);

  return (
    <section className="flex h-full min-h-0 flex-col rounded-[2rem] border border-zinc-800 bg-zinc-900/70 shadow-xl">
      <div className="border-b border-zinc-800 px-5 py-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Jobs</div>
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
              icon={metric.id === "running" ? <Loader2 className="h-4 w-4" /> : metric.id === "failed" ? <XCircle className="h-4 w-4" /> : metric.id === "succeeded" ? <CheckCircle2 className="h-4 w-4" /> : <Activity className="h-4 w-4" />}
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
              placeholder="Filter jobs"
              className="w-full bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <ToggleChip label="Attention only" active={attentionOnly} icon={<AlertTriangle className="h-3.5 w-3.5" />} onClick={props.onToggleAttentionOnly ? () => props.onToggleAttentionOnly?.(!attentionOnly) : undefined} />
            <ToggleChip label="Running only" active={runningOnly} icon={<Loader2 className="h-3.5 w-3.5" />} onClick={props.onToggleRunningOnly ? () => props.onToggleRunningOnly?.(!runningOnly) : undefined} />
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
                icon={kindIcon(kind as JobKind)}
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
                Hydrating job cockpit…
              </div>
            </motion.div>
          ) : visibleJobs.length > 0 ? (
            <motion.div key="jobs" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.16 }} className="grid gap-5 xl:grid-cols-[0.95fr_1.05fr]">
              <div className="space-y-2">
                {visibleJobs.map((job) => {
                  const selected = selectedJob?.id === job.id;
                  return (
                    <button
                      key={job.id}
                      onClick={() => {
                        setLocalSelectedId(job.id);
                        props.onSelectJob?.(job);
                      }}
                      className={cx(
                        "flex w-full items-start gap-3 rounded-[1.5rem] border px-4 py-4 text-left shadow-sm transition",
                        selected ? "border-zinc-600 bg-zinc-800 text-zinc-50" : "border-zinc-800 bg-zinc-950/50 text-zinc-200 hover:bg-zinc-900",
                      )}
                    >
                      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-2 text-zinc-300">{kindIcon(job.kind)}</div>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-semibold">{job.title}</span>
                          <span className={cx("rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.2em]", phaseTone(job.phase))}>{job.phase}</span>
                          <span className={cx("rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.2em]", attentionTone(job.attention))}>{job.attention ?? "none"}</span>
                        </div>
                        <div className="mt-2 text-sm text-zinc-400">{job.summary}</div>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                          <span>{job.kind}</span>
                          {typeof job.progressPct === "number" ? <span>{job.progressPct}%</span> : null}
                          {job.queuePosition != null ? <span>queue {job.queuePosition}</span> : null}
                          {job.references?.patchId ? <span>patch {job.references.patchId}</span> : null}
                          {job.references?.verifyId ? <span>verify {job.references.verifyId}</span> : null}
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 text-zinc-600" />
                    </button>
                  );
                })}
              </div>

              <div className="space-y-5">
                <section className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-5 shadow-lg">
                  <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Selected job</div>
                  {selectedJob ? (
                    <div className="mt-4 space-y-4">
                      <div>
                        <div className="text-lg font-semibold text-zinc-50">{selectedJob.title}</div>
                        <div className="mt-2 text-sm leading-7 text-zinc-400">{selectedJob.summary}</div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Badge className={phaseTone(selectedJob.phase)}>
                          <Activity className="h-3.5 w-3.5" />
                          {selectedJob.phase}
                        </Badge>
                        <Badge className={healthTone(selectedJob.health)}>
                          <ShieldCheck className="h-3.5 w-3.5" />
                          {selectedJob.health ?? "unknown"}
                        </Badge>
                        <Badge className={trustTone(selectedJob.trustLevel)}>
                          {trustIcon(selectedJob.trustLevel)}
                          {selectedJob.trustLevel ?? "unknown"}
                        </Badge>
                        <Badge className={attentionTone(selectedJob.attention)}>
                          <AlertTriangle className="h-3.5 w-3.5" />
                          {selectedJob.attention ?? "none"}
                        </Badge>
                      </div>

                      <div className="grid gap-3 sm:grid-cols-2">
                        <MetricCard label="Started" value={formatDateTime(selectedJob.startedAtMs)} icon={<Clock3 className="h-4 w-4" />} />
                        <MetricCard label="Ended" value={formatDateTime(selectedJob.endedAtMs)} icon={<Clock3 className="h-4 w-4" />} />
                        <MetricCard label="Duration" value={durationMs(selectedJob.startedAtMs, selectedJob.endedAtMs)} icon={<Clock3 className="h-4 w-4" />} />
                        <MetricCard label="Authority" value={selectedJob.authorityLabel ?? "Unknown"} icon={<ShieldCheck className="h-4 w-4" />} />
                      </div>

                      <div className="grid gap-3 sm:grid-cols-2">
                        <MetricCard label="Patch" value={selectedJob.references?.patchId ?? "None"} icon={<GitBranch className="h-4 w-4" />} />
                        <MetricCard label="Verify" value={selectedJob.references?.verifyId ?? "None"} icon={<ShieldCheck className="h-4 w-4" />} />
                        <MetricCard label="Preview" value={selectedJob.references?.previewHash ?? "None"} icon={<Sparkles className="h-4 w-4" />} />
                        <MetricCard label="Ledger" value={selectedJob.references?.ledgerSeq != null ? String(selectedJob.references.ledgerSeq) : "None"} icon={<Activity className="h-4 w-4" />} />
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <ActionButton label="Run" icon={<PlayCircle className="h-4 w-4" />} disabled={selectedJob.phase === "running" || selectedJob.phase === "queued"} onClick={props.onRunRequested ? () => props.onRunRequested?.(selectedJob) : undefined} />
                        <ActionButton label="Cancel" icon={<Square className="h-4 w-4" />} tone="danger" disabled={selectedJob.phase !== "running" && selectedJob.phase !== "queued"} onClick={props.onCancelRequested ? () => props.onCancelRequested?.(selectedJob) : undefined} />
                        <ActionButton label="Retry" icon={<RefreshCw className="h-4 w-4" />} tone="secondary" disabled={selectedJob.phase === "running" || selectedJob.phase === "queued"} onClick={props.onRetryRequested ? () => props.onRetryRequested?.(selectedJob) : undefined} />
                      </div>
                    </div>
                  ) : (
                    <div className="mt-4 rounded-[1.5rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-5 text-sm text-zinc-500">
                      Select a visible job to inspect its lifecycle, authority, lineage references, and outputs.
                    </div>
                  )}
                </section>

                <section className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-5 shadow-lg">
                  <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Artifacts</div>
                  {selectedJob && selectedJob.artifacts && selectedJob.artifacts.length > 0 ? (
                    <div className="mt-4 space-y-2">
                      {selectedJob.artifacts.map((artifact) => (
                        <button
                          key={artifact.id}
                          onClick={() => props.onOpenArtifactRequested?.(selectedJob, artifact)}
                          disabled={!props.onOpenArtifactRequested}
                          className={cx(
                            "flex w-full items-start gap-3 rounded-[1.25rem] border border-zinc-800 bg-zinc-950/50 px-4 py-4 text-left shadow-sm transition hover:bg-zinc-900",
                            !props.onOpenArtifactRequested && "cursor-not-allowed opacity-40",
                          )}
                        >
                          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-2 text-zinc-300">
                            {artifact.kind === "report" || artifact.kind === "bundle" ? <Archive className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-semibold text-zinc-100">{artifact.label}</div>
                            <div className="mt-1 truncate text-xs text-zinc-500">{artifact.path ?? "No path"}</div>
                            <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                              <span>{artifact.kind ?? "other"}</span>
                              {artifact.sizeLabel ? <span>{artifact.sizeLabel}</span> : null}
                            </div>
                          </div>
                          <ChevronRight className="h-4 w-4 text-zinc-600" />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-4 rounded-[1.5rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-5 text-sm text-zinc-500">
                      No artifacts are currently attached to the selected job.
                    </div>
                  )}
                </section>

                <section className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-5 shadow-lg">
                  <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Logs</div>
                  {selectedJob && selectedJob.logs && selectedJob.logs.length > 0 ? (
                    <div className="mt-4 max-h-[18rem] space-y-2 overflow-auto">
                      {selectedJob.logs.map((log) => (
                        <div key={log.seq} className="rounded-[1.25rem] border border-zinc-800 bg-zinc-950/50 px-4 py-3 shadow-sm">
                          <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                            <span className={cx("font-semibold", logLevelTone(log.level))}>{log.level}</span>
                            <span>seq {log.seq}</span>
                            <span>{formatDateTime(log.atMs)}</span>
                          </div>
                          <pre className={cx("mt-2 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-6", logLevelTone(log.level))}>{log.message}</pre>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-4 rounded-[1.5rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-5 text-sm text-zinc-500">
                      No logs are currently attached to the selected job.
                    </div>
                  )}
                </section>

                <section className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-5 shadow-lg">
                  <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Detail payload</div>
                  <pre className="mt-4 overflow-auto whitespace-pre-wrap break-words rounded-[1.5rem] border border-zinc-800 bg-zinc-950/50 p-4 font-mono text-xs leading-6 text-zinc-300 shadow-sm">
{prettyJson(selectedJob?.detail)}
                  </pre>
                </section>
              </div>
            </motion.div>
          ) : (
            <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="grid min-h-[18rem] place-items-center rounded-[2rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-8 text-center">
              <div className="max-w-xl">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-[1.5rem] border border-zinc-800 bg-zinc-950/60 text-zinc-400">
                  <Activity className="h-6 w-6" />
                </div>
                <h3 className="mt-6 text-xl font-semibold text-zinc-100">No visible jobs</h3>
                <p className="mt-3 text-sm leading-7 text-zinc-500">The current job filters produced no visible entries. Relax query, kind, attention, or running-state filters to continue inspection.</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="border-t border-zinc-800 px-4 py-3 text-xs text-zinc-500">
        <div className="flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-1"><Activity className="h-3.5 w-3.5" /> lifecycle explicit</span>
          <span className="inline-flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5" /> authority visible</span>
          <span className="inline-flex items-center gap-1"><TerminalSquare className="h-3.5 w-3.5" /> logs bound to jobs</span>
          <span className="inline-flex items-center gap-1"><Archive className="h-3.5 w-3.5" /> artifacts explicit</span>
        </div>
      </div>
    </section>
  );
}
