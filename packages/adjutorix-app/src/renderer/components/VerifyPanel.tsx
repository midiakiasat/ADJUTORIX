import React, { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Clock3,
  FileCheck2,
  FileCode2,
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
  Target,
  TerminalSquare,
  XCircle,
} from "lucide-react";

/**
 * ADJUTORIX APP — RENDERER / COMPONENTS / VerifyPanel.tsx
 *
 * Canonical verification orchestration cockpit.
 *
 * Purpose:
 * - provide the authoritative renderer-side verification surface
 * - unify verify job identity, bound patch/preview lineage, target scope, streamed check state,
 *   terminal outcome, evidence posture, and patch-binding readiness under one deterministic UI
 * - prevent verification from collapsing into a flat “passed/failed” widget that hides whether
 *   the result still corresponds to the active preview lineage
 * - expose explicit verify/refresh/rebind/navigation intent upward without executing work locally
 *
 * Architectural role:
 * - VerifyPanel is the control-and-context layer over verification state
 * - it does not execute verification, fetch logs, or mutate patch state on its own
 * - it renders declared verification state and emits explicit user intent callbacks
 * - it should stay informative through requested, queued, running, partial, stale, failed,
 *   and patch-bindable success states
 *
 * Hard invariants:
 * - verify identity and bound lineage are visually explicit whenever provided
 * - terminal outcome is distinct from transient phase and from patch-bindable status
 * - visible check ordering is the provided ordering; no hidden resorting
 * - filters change visibility only, never underlying check identity
 * - action affordances are explicit callbacks or explicit disabled state
 * - identical props yield identical ordering, tallies, and visible posture
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type VerifyPanelPhase =
  | "idle"
  | "requested"
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "partial"
  | "cancelled"
  | "stale"
  | "error";

export type VerifyPanelOutcome = "unknown" | "passed" | "failed" | "partial" | "cancelled";
export type VerifyPanelTrustLevel = "unknown" | "untrusted" | "restricted" | "trusted";
export type VerifyPanelSeverity = "none" | "info" | "warn" | "error" | "fatal";
export type VerifyCheckStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export type VerifyCheckItem = {
  id: string;
  name: string;
  status: VerifyCheckStatus;
  severity?: VerifyPanelSeverity;
  message?: string | null;
  targetPath?: string | null;
  startedAtMs?: number | null;
  endedAtMs?: number | null;
  referenced?: boolean;
  diagnosticsCount?: number;
};

export type VerifyTargetItem = {
  id: string;
  path: string;
  kind?: "file" | "directory" | "workspace";
};

export type VerifyEvidenceItem = {
  id: string;
  label: string;
  value: string;
  tone?: "neutral" | "good" | "warn" | "bad";
};

export type VerifyPanelProps = {
  title?: string;
  subtitle?: string;
  phase?: VerifyPanelPhase;
  outcome?: VerifyPanelOutcome;
  trustLevel?: VerifyPanelTrustLevel;
  verifyId?: string | null;
  patchId?: string | null;
  previewHash?: string | null;
  verifiedPreviewHash?: string | null;
  requestHash?: string | null;
  canBindToPatch?: boolean;
  boundToPatchReview?: boolean;
  loading?: boolean;
  targets?: VerifyTargetItem[];
  checks?: VerifyCheckItem[];
  selectedCheckId?: string | null;
  filterQuery?: string;
  showOnlyFailures?: boolean;
  showOnlyAttention?: boolean;
  startedAtMs?: number | null;
  endedAtMs?: number | null;
  lastStatusAtMs?: number | null;
  statusMessage?: string | null;
  evidenceItems?: VerifyEvidenceItem[];
  onRunRequested?: () => void;
  onRefreshRequested?: () => void;
  onBindToPatchRequested?: () => void;
  onSelectCheck?: (check: VerifyCheckItem) => void;
  onFilterQueryChange?: (query: string) => void;
  onToggleShowOnlyFailures?: (value: boolean) => void;
  onToggleShowOnlyAttention?: (value: boolean) => void;
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function basename(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
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

function trustTone(level: VerifyPanelTrustLevel | undefined): string {
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

function trustIcon(level: VerifyPanelTrustLevel | undefined): JSX.Element {
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

function phaseTone(phase: VerifyPanelPhase | undefined): string {
  switch (phase) {
    case "running":
    case "queued":
    case "requested":
      return "border-sky-700/30 bg-sky-500/10 text-sky-300";
    case "passed":
      return "border-emerald-700/30 bg-emerald-500/10 text-emerald-300";
    case "failed":
    case "error":
    case "cancelled":
      return "border-rose-700/30 bg-rose-500/10 text-rose-300";
    case "partial":
    case "stale":
      return "border-amber-700/30 bg-amber-500/10 text-amber-300";
    default:
      return "border-zinc-700/30 bg-zinc-500/10 text-zinc-300";
  }
}

function outcomeTone(outcome: VerifyPanelOutcome | undefined): string {
  switch (outcome) {
    case "passed":
      return "border-emerald-700/30 bg-emerald-500/10 text-emerald-300";
    case "failed":
    case "cancelled":
      return "border-rose-700/30 bg-rose-500/10 text-rose-300";
    case "partial":
      return "border-amber-700/30 bg-amber-500/10 text-amber-300";
    default:
      return "border-zinc-700/30 bg-zinc-500/10 text-zinc-300";
  }
}

function checkStatusTone(status: VerifyCheckStatus): string {
  switch (status) {
    case "passed":
      return "border-emerald-700/30 bg-emerald-500/10 text-emerald-300";
    case "failed":
      return "border-rose-700/30 bg-rose-500/10 text-rose-300";
    case "running":
      return "border-sky-700/30 bg-sky-500/10 text-sky-300";
    case "skipped":
      return "border-amber-700/30 bg-amber-500/10 text-amber-300";
    default:
      return "border-zinc-700/30 bg-zinc-500/10 text-zinc-400";
  }
}

function severityTone(severity: VerifyPanelSeverity | undefined): string {
  switch (severity) {
    case "fatal":
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

// -----------------------------------------------------------------------------
// SUBCOMPONENTS
// -----------------------------------------------------------------------------

function Badge(props: { className?: string; children: React.ReactNode }): JSX.Element {
  return <span className={cx("inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.2em]", props.className)}>{props.children}</span>;
}

function MetricCard(props: { label: string; value: string; tone?: "neutral" | "good" | "warn" | "bad"; icon?: React.ReactNode }): JSX.Element {
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
        <div className="rounded-xl border border-zinc-800 bg-black/20 p-2.5 text-zinc-300">{props.icon ?? <ClipboardList className="h-4 w-4" />}</div>
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

export default function VerifyPanel(props: VerifyPanelProps): JSX.Element {
  const title = props.title ?? "Verification cockpit";
  const subtitle =
    props.subtitle ??
    "Unified verification surface for job identity, bound lineage, streamed checks, terminal outcome, and patch-bindable readiness.";

  const phase = props.phase ?? "idle";
  const outcome = props.outcome ?? "unknown";
  const trustLevel = props.trustLevel ?? "unknown";
  const loading = props.loading ?? false;
  const showOnlyFailures = props.showOnlyFailures ?? false;
  const showOnlyAttention = props.showOnlyAttention ?? false;
  const targets = props.targets ?? [];
  const checks = props.checks ?? [];
  const [localSelectedCheckId, setLocalSelectedCheckId] = useState<string | null>(props.selectedCheckId ?? null);
  const [localFilter, setLocalFilter] = useState(props.filterQuery ?? "");

  const visibleChecks = useMemo(() => {
    const q = localFilter.trim().toLowerCase();
    return checks.filter((check) => {
      if (showOnlyFailures && check.status !== "failed") return false;
      if (showOnlyAttention && !((check.diagnosticsCount ?? 0) > 0 || check.status === "failed" || check.severity === "warn" || check.severity === "error" || check.severity === "fatal")) return false;
      if (!q) return true;
      return (
        check.name.toLowerCase().includes(q) ||
        (check.message ?? "").toLowerCase().includes(q) ||
        (check.targetPath ?? "").toLowerCase().includes(q)
      );
    });
  }, [checks, localFilter, showOnlyAttention, showOnlyFailures]);

  const selectedCheckId = props.selectedCheckId ?? localSelectedCheckId ?? visibleChecks[0]?.id ?? null;
  const selectedCheck = visibleChecks.find((check) => check.id === selectedCheckId) ?? visibleChecks[0] ?? null;

  const metrics = useMemo(() => {
    const passed = checks.filter((check) => check.status === "passed").length;
    const failed = checks.filter((check) => check.status === "failed").length;
    const running = checks.filter((check) => check.status === "running").length;
    const skipped = checks.filter((check) => check.status === "skipped").length;
    return { passed, failed, running, skipped };
  }, [checks]);

  const evidenceItems = props.evidenceItems ?? [
    { id: "phase", label: "Phase", value: phase, tone: phase === "passed" ? "good" : phase === "failed" || phase === "error" ? "bad" : phase === "partial" || phase === "stale" ? "warn" : "neutral" },
    { id: "outcome", label: "Outcome", value: outcome, tone: outcome === "passed" ? "good" : outcome === "failed" ? "bad" : outcome === "partial" ? "warn" : "neutral" },
    { id: "bindable", label: "Patch bindable", value: props.canBindToPatch ? "yes" : "no", tone: props.canBindToPatch ? "good" : "neutral" },
    { id: "bound", label: "Bound to patch", value: props.boundToPatchReview ? "yes" : "no", tone: props.boundToPatchReview ? "good" : "neutral" },
  ];

  return (
    <section className="flex h-full min-h-0 flex-col rounded-[2rem] border border-zinc-800 bg-zinc-900/70 shadow-xl">
      <div className="border-b border-zinc-800 px-5 py-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Verification</div>
            <h2 className="mt-1 text-lg font-semibold text-zinc-50">{title}</h2>
            <p className="mt-2 text-sm leading-7 text-zinc-400">{subtitle}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={trustTone(trustLevel)}>
              {trustIcon(trustLevel)}
              {trustLevel}
            </Badge>
            <Badge className={phaseTone(phase)}>
              <Activity className="h-3.5 w-3.5" />
              {phase}
            </Badge>
            <Badge className={outcomeTone(outcome)}>
              <ShieldCheck className="h-3.5 w-3.5" />
              {outcome}
            </Badge>
            {props.previewHash ? (
              <Badge className="border-sky-700/30 bg-sky-500/10 text-sky-300">
                <Sparkles className="h-3.5 w-3.5" />
                {props.previewHash}
              </Badge>
            ) : null}
            {props.verifyId ? (
              <Badge className="border-indigo-700/30 bg-indigo-500/10 text-indigo-300">
                <ClipboardList className="h-3.5 w-3.5" />
                {props.verifyId}
              </Badge>
            ) : null}
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Checks passed" value={String(metrics.passed)} tone={metrics.passed > 0 ? "good" : "neutral"} icon={<CheckCircle2 className="h-4 w-4" />} />
          <MetricCard label="Checks failed" value={String(metrics.failed)} tone={metrics.failed > 0 ? "bad" : "neutral"} icon={<XCircle className="h-4 w-4" />} />
          <MetricCard label="Running" value={String(metrics.running)} tone={metrics.running > 0 ? "warn" : "neutral"} icon={<Loader2 className="h-4 w-4" />} />
          <MetricCard label="Targets" value={String(targets.length)} icon={<FileCode2 className="h-4 w-4" />} />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <ToggleChip label="Failures only" active={showOnlyFailures} icon={<XCircle className="h-3.5 w-3.5" />} onClick={props.onToggleShowOnlyFailures ? () => props.onToggleShowOnlyFailures?.(!showOnlyFailures) : undefined} />
          <ToggleChip label="Attention only" active={showOnlyAttention} icon={<AlertTriangle className="h-3.5 w-3.5" />} onClick={props.onToggleShowOnlyAttention ? () => props.onToggleShowOnlyAttention?.(!showOnlyAttention) : undefined} />
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <ActionButton label="Run verify" icon={<PlayCircle className="h-4 w-4" />} disabled={phase === "running" || phase === "queued" || phase === "requested"} onClick={props.onRunRequested} />
          <ActionButton label="Refresh" icon={<RefreshCw className="h-4 w-4" />} tone="secondary" onClick={props.onRefreshRequested} />
          <ActionButton label="Bind to patch" icon={<GitBranch className="h-4 w-4" />} tone={props.canBindToPatch ? "primary" : "secondary"} disabled={!props.canBindToPatch || props.boundToPatchReview} onClick={props.onBindToPatchRequested} />
        </div>

        {props.statusMessage ? (
          <div className="mt-4 rounded-[1.25rem] border border-zinc-800 bg-zinc-950/50 px-4 py-3 text-sm text-zinc-300">
            {props.statusMessage}
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
        <AnimatePresence mode="wait">
          {loading ? (
            <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="grid min-h-[18rem] place-items-center rounded-[2rem] border border-zinc-800 bg-zinc-950/30">
              <div className="flex items-center gap-3 text-sm text-zinc-300">
                <Loader2 className="h-4 w-4 animate-spin" />
                Hydrating verification cockpit…
              </div>
            </motion.div>
          ) : (
            <motion.div key="verify" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.16 }} className="grid gap-5 xl:grid-cols-[0.95fr_1.05fr]">
              <div className="space-y-5">
                <section className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-5 shadow-lg">
                  <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Targets</div>
                  {targets.length > 0 ? (
                    <div className="mt-4 space-y-2">
                      {targets.map((target) => (
                        <div key={target.id} className="flex items-start gap-3 rounded-[1.25rem] border border-zinc-800 bg-zinc-950/50 px-4 py-3 text-sm text-zinc-200">
                          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-2 text-zinc-300">
                            <Target className="h-4 w-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium">{basename(target.path)}</div>
                            <div className="mt-1 truncate text-xs text-zinc-500">{target.path}</div>
                          </div>
                          <span className="rounded-full border border-zinc-800 bg-zinc-950/60 px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] text-zinc-400">{target.kind ?? "file"}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-4 rounded-[1.5rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-5 text-sm text-zinc-500">
                      No verification targets are currently bound.
                    </div>
                  )}
                </section>

                <section className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-5 shadow-lg">
                  <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                    <div>
                      <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Checks</div>
                      <div className="mt-1 text-sm text-zinc-400">Stable ordering and explicit terminal status per check.</div>
                    </div>
                    <div className="flex items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-2.5 xl:w-[18rem]">
                      <Search className="h-4 w-4 text-zinc-500" />
                      <input
                        value={localFilter}
                        onChange={(e) => {
                          setLocalFilter(e.target.value);
                          props.onFilterQueryChange?.(e.target.value);
                        }}
                        placeholder="Filter checks"
                        className="w-full bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
                      />
                    </div>
                  </div>

                  {visibleChecks.length > 0 ? (
                    <div className="mt-4 space-y-2">
                      {visibleChecks.map((check) => {
                        const selected = selectedCheck?.id === check.id;
                        return (
                          <button
                            key={check.id}
                            onClick={() => {
                              setLocalSelectedCheckId(check.id);
                              props.onSelectCheck?.(check);
                            }}
                            className={cx(
                              "flex w-full items-start gap-3 rounded-[1.25rem] border px-4 py-4 text-left shadow-sm transition",
                              selected ? "border-zinc-600 bg-zinc-800 text-zinc-50" : "border-zinc-800 bg-zinc-950/50 text-zinc-200 hover:bg-zinc-900",
                            )}
                          >
                            <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-2 text-zinc-300">
                              {check.status === "passed" ? (
                                <CheckCircle2 className="h-4 w-4" />
                              ) : check.status === "failed" ? (
                                <XCircle className="h-4 w-4" />
                              ) : check.status === "running" ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : check.status === "skipped" ? (
                                <PauseCircle className="h-4 w-4" />
                              ) : (
                                <Clock3 className="h-4 w-4" />
                              )}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex min-w-0 flex-wrap items-center gap-2">
                                <span className="truncate text-sm font-semibold">{check.name}</span>
                                <span className={cx("rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.2em]", checkStatusTone(check.status))}>{check.status}</span>
                                {check.severity && check.severity !== "none" ? <span className={cx("rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.2em]", severityTone(check.severity))}>{check.severity}</span> : null}
                                {check.diagnosticsCount ? <span className="rounded-full border border-zinc-700/30 bg-zinc-500/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] text-zinc-300">{check.diagnosticsCount} diagnostics</span> : null}
                                {check.referenced ? <span className="rounded-full border border-sky-700/30 bg-sky-500/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] text-sky-300">referenced</span> : null}
                              </div>
                              {check.message ? <div className="mt-2 text-sm text-zinc-400">{check.message}</div> : null}
                              <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                                {check.targetPath ? <span>{check.targetPath}</span> : null}
                                {check.startedAtMs ? <span>started {formatDateTime(check.startedAtMs)}</span> : null}
                              </div>
                            </div>
                            <ChevronRight className="h-4 w-4 text-zinc-600" />
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="mt-4 rounded-[1.5rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-5 text-sm text-zinc-500">
                      No visible checks under the current filter state.
                    </div>
                  )}
                </section>
              </div>

              <div className="space-y-5">
                <section className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-5 shadow-lg">
                  <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Verification evidence</div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    {evidenceItems.map((item) => (
                      <MetricCard
                        key={item.id}
                        label={item.label}
                        value={item.value}
                        tone={item.tone}
                        icon={item.id.includes("bind") ? <GitBranch className="h-4 w-4" /> : item.id.includes("phase") ? <Activity className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
                      />
                    ))}
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                    {props.patchId ? <span className="rounded-full border border-zinc-800 bg-zinc-950/60 px-2 py-0.5">patch {props.patchId}</span> : null}
                    {props.requestHash ? <span className="rounded-full border border-zinc-800 bg-zinc-950/60 px-2 py-0.5">request {props.requestHash}</span> : null}
                    {props.verifiedPreviewHash ? <span className="rounded-full border border-zinc-800 bg-zinc-950/60 px-2 py-0.5">verified {props.verifiedPreviewHash}</span> : null}
                  </div>
                </section>

                <section className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-5 shadow-lg">
                  <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Selected check</div>
                  {selectedCheck ? (
                    <div className="mt-4 space-y-4">
                      <div>
                        <div className="text-lg font-semibold text-zinc-50">{selectedCheck.name}</div>
                        {selectedCheck.message ? <div className="mt-2 text-sm leading-7 text-zinc-400">{selectedCheck.message}</div> : null}
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Badge className={checkStatusTone(selectedCheck.status)}>
                          <TerminalSquare className="h-3.5 w-3.5" />
                          {selectedCheck.status}
                        </Badge>
                        {selectedCheck.severity && selectedCheck.severity !== "none" ? <Badge className={severityTone(selectedCheck.severity)}>{selectedCheck.severity}</Badge> : null}
                        {selectedCheck.referenced ? <Badge className="border-sky-700/30 bg-sky-500/10 text-sky-300">referenced</Badge> : null}
                      </div>

                      <div className="grid gap-3 sm:grid-cols-2">
                        <MetricCard label="Started" value={formatDateTime(selectedCheck.startedAtMs)} icon={<Clock3 className="h-4 w-4" />} />
                        <MetricCard label="Duration" value={durationMs(selectedCheck.startedAtMs, selectedCheck.endedAtMs)} icon={<Clock3 className="h-4 w-4" />} />
                      </div>

                      {selectedCheck.targetPath ? (
                        <div className="rounded-[1.25rem] border border-zinc-800 bg-zinc-950/50 px-4 py-3 text-sm text-zinc-300">
                          <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Target path</div>
                          <div className="mt-2 break-all">{selectedCheck.targetPath}</div>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="mt-4 rounded-[1.5rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-5 text-sm text-zinc-500">
                      Select a visible check to inspect its explicit terminal status and timing.
                    </div>
                  )}
                </section>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="border-t border-zinc-800 px-4 py-3 text-xs text-zinc-500">
        <div className="flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-1"><ClipboardList className="h-3.5 w-3.5" /> verify identity explicit</span>
          <span className="inline-flex items-center gap-1"><GitBranch className="h-3.5 w-3.5" /> lineage bound or not bound</span>
          <span className="inline-flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5" /> terminal outcome distinct</span>
          <span className="inline-flex items-center gap-1"><Target className="h-3.5 w-3.5" /> checks remain actionable</span>
        </div>
      </div>
    </section>
  );
}
