import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clipboard,
  Eye,
  Filter,
  History,
  Info,
  Lock,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  TerminalSquare,
  Trash2,
  Wand2,
  XCircle,
} from "lucide-react";

/**
 * ADJUTORIX APP — RENDERER / COMPONENTS / TerminalPanel.tsx
 *
 * Canonical governed terminal surface.
 *
 * Purpose:
 * - provide the authoritative renderer-side terminal and command-output surface
 * - unify command provenance, execution state, shell/environment posture, streamed output,
 *   exit status, filters, and user intent under one deterministic component contract
 * - prevent terminal output from appearing authoritative without preserving whether it is
 *   pending, completed, failed, interrupted, trusted, or merely observed text
 * - expose explicit command/terminal actions upward without performing hidden execution
 *
 * Architectural role:
 * - TerminalPanel is a presentation/controller surface over explicit shell state
 * - it does not spawn processes or own terminal truth; it renders declared session state
 * - it should remain useful during running, failed, interrupted, and idle sessions
 * - it should make the governance boundary between command intent and command result visible
 *
 * Hard invariants:
 * - all visible actions map to explicit callbacks or explicit disabled state
 * - command identity and output ordering are stable for identical props
 * - output filtering changes visibility only, never underlying transcript identity
 * - execution posture is explicit: idle/running/succeeded/failed/interrupted
 * - environment posture and trust are visible without altering transcript content
 * - no placeholders, fake PTY behavior, or hidden execution side effects
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type TerminalExecutionState = "idle" | "running" | "succeeded" | "failed" | "interrupted" | "degraded";
export type TerminalTrustLevel = "unknown" | "untrusted" | "restricted" | "trusted";
export type TerminalOutputKind = "stdout" | "stderr" | "system" | "command";
export type TerminalSeverity = "none" | "info" | "warn" | "error" | "critical";

export type TerminalCommandSummary = {
  commandId: string;
  commandText: string;
  cwd?: string | null;
  shell?: string | null;
  startedAtMs?: number | null;
  endedAtMs?: number | null;
  exitCode?: number | null;
  executionState?: TerminalExecutionState;
  trustLevel?: TerminalTrustLevel;
  requestHash?: string | null;
  sourceLabel?: string | null;
};

export type TerminalOutputEntry = {
  seq: number;
  kind: TerminalOutputKind;
  text: string;
  atMs: number;
  severity?: TerminalSeverity;
  commandId?: string | null;
};

export type TerminalPanelProps = {
  title?: string;
  subtitle?: string;
  executionState?: TerminalExecutionState;
  trustLevel?: TerminalTrustLevel;
  loading?: boolean;
  shellPath?: string | null;
  cwd?: string | null;
  commandInput?: string;
  currentCommand?: TerminalCommandSummary | null;
  commandHistory?: TerminalCommandSummary[];
  outputEntries?: TerminalOutputEntry[];
  filterQuery?: string;
  showStdout?: boolean;
  showStderr?: boolean;
  showSystem?: boolean;
  showCommands?: boolean;
  autoScroll?: boolean;
  onCommandInputChange?: (value: string) => void;
  onRunRequested?: () => void;
  onInterruptRequested?: () => void;
  onClearRequested?: () => void;
  onCopyTranscriptRequested?: () => void;
  onRetryRequested?: () => void;
  onToggleAutoScroll?: (value: boolean) => void;
  onToggleStdout?: (value: boolean) => void;
  onToggleStderr?: (value: boolean) => void;
  onToggleSystem?: (value: boolean) => void;
  onToggleCommands?: (value: boolean) => void;
  onFilterQueryChange?: (value: string) => void;
  onSelectHistoryCommand?: (command: TerminalCommandSummary) => void;
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function formatTime(ts?: number | null): string {
  if (!ts) return "Unknown";
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return String(ts);
  }
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

function trustTone(level: TerminalTrustLevel | undefined): string {
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

function stateTone(state: TerminalExecutionState | undefined): string {
  switch (state) {
    case "running":
      return "border-sky-700/30 bg-sky-500/10 text-sky-300";
    case "succeeded":
      return "border-emerald-700/30 bg-emerald-500/10 text-emerald-300";
    case "failed":
    case "interrupted":
      return "border-rose-700/30 bg-rose-500/10 text-rose-300";
    case "degraded":
      return "border-amber-700/30 bg-amber-500/10 text-amber-300";
    default:
      return "border-zinc-700/30 bg-zinc-500/10 text-zinc-300";
  }
}

function severityTone(severity: TerminalSeverity | undefined): string {
  switch (severity) {
    case "critical":
    case "error":
      return "text-rose-300";
    case "warn":
      return "text-amber-300";
    case "info":
      return "text-sky-300";
    default:
      return "text-zinc-300";
  }
}

function outputBadgeTone(kind: TerminalOutputKind): string {
  switch (kind) {
    case "stderr":
      return "border-rose-700/30 bg-rose-500/10 text-rose-300";
    case "system":
      return "border-amber-700/30 bg-amber-500/10 text-amber-300";
    case "command":
      return "border-indigo-700/30 bg-indigo-500/10 text-indigo-300";
    default:
      return "border-zinc-700/30 bg-zinc-500/10 text-zinc-300";
  }
}

function terminalStateLabel(state: TerminalExecutionState | undefined): string {
  return state ?? "idle";
}

// -----------------------------------------------------------------------------
// SUBCOMPONENTS
// -----------------------------------------------------------------------------

function Section(props: { title: string; subtitle?: string; actions?: React.ReactNode; children: React.ReactNode }): JSX.Element {
  return (
    <section className="rounded-[2rem] border border-zinc-800 bg-zinc-900/70 shadow-lg">
      <div className="flex flex-col gap-4 border-b border-zinc-800 px-5 py-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Terminal</div>
          <h3 className="mt-1 text-lg font-semibold text-zinc-50">{props.title}</h3>
          {props.subtitle ? <p className="mt-2 text-sm leading-7 text-zinc-400">{props.subtitle}</p> : null}
        </div>
        {props.actions ? <div className="shrink-0">{props.actions}</div> : null}
      </div>
      <div className="p-5">{props.children}</div>
    </section>
  );
}

function SummaryCard(props: { label: string; value: string; tone?: "neutral" | "good" | "warn" | "bad"; icon?: React.ReactNode }): JSX.Element {
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
        <div className="rounded-xl border border-zinc-800 bg-black/20 p-2.5 text-zinc-300">{props.icon ?? <TerminalSquare className="h-4 w-4" />}</div>
      </div>
    </div>
  );
}

function ToggleChip(props: { label: string; active: boolean; onClick?: () => void; icon?: React.ReactNode }): JSX.Element {
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

export default function TerminalPanel(props: TerminalPanelProps): JSX.Element {
  const title = props.title ?? "Governed terminal";
  const subtitle =
    props.subtitle ??
    "Observed command execution with explicit provenance, environment posture, status, and filtered transcript visibility.";

  const executionState = props.executionState ?? "idle";
  const trustLevel = props.trustLevel ?? "unknown";
  const loading = props.loading ?? false;
  const showStdout = props.showStdout ?? true;
  const showStderr = props.showStderr ?? true;
  const showSystem = props.showSystem ?? true;
  const showCommands = props.showCommands ?? true;
  const autoScroll = props.autoScroll ?? true;
  const filterQuery = props.filterQuery ?? "";
  const outputEntries = props.outputEntries ?? [];
  const commandHistory = props.commandHistory ?? [];
  const currentCommand = props.currentCommand ?? null;

  const [localInput, setLocalInput] = useState(props.commandInput ?? "");
  const [localFilter, setLocalFilter] = useState(filterQuery);

  useEffect(() => {
    setLocalInput(props.commandInput ?? "");
  }, [props.commandInput]);

  useEffect(() => {
    setLocalFilter(filterQuery);
  }, [filterQuery]);

  const filteredEntries = useMemo(() => {
    const q = localFilter.trim().toLowerCase();
    return outputEntries.filter((entry) => {
      if (entry.kind === "stdout" && !showStdout) return false;
      if (entry.kind === "stderr" && !showStderr) return false;
      if (entry.kind === "system" && !showSystem) return false;
      if (entry.kind === "command" && !showCommands) return false;
      if (!q) return true;
      return entry.text.toLowerCase().includes(q);
    });
  }, [localFilter, outputEntries, showCommands, showStderr, showStdout, showSystem]);

  const transcriptRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!autoScroll || !transcriptRef.current) return;
    transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [autoScroll, filteredEntries.length]);

  const currentDuration = currentCommand?.startedAtMs
    ? durationMs(currentCommand.startedAtMs, currentCommand.endedAtMs ?? Date.now())
    : "Unknown";

  return (
    <section className="flex h-full min-h-0 flex-col rounded-[2rem] border border-zinc-800 bg-zinc-900/70 shadow-xl">
      <div className="border-b border-zinc-800 px-5 py-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Shell surface</div>
            <h2 className="mt-1 text-lg font-semibold text-zinc-50">{title}</h2>
            <p className="mt-2 text-sm leading-7 text-zinc-400">{subtitle}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={cx("inline-flex items-center gap-1 rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.2em]", trustTone(trustLevel))}>
              <ShieldCheck className="h-3.5 w-3.5" />
              {trustLevel}
            </span>
            <span className={cx("inline-flex items-center gap-1 rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.2em]", stateTone(executionState))}>
              <Activity className="h-3.5 w-3.5" />
              {terminalStateLabel(executionState)}
            </span>
          </div>
        </div>

        <div className="mt-5 grid gap-4 xl:grid-cols-[1fr_auto]">
          <div className="space-y-3">
            <div className="rounded-[1.5rem] border border-zinc-800 bg-zinc-950/60 px-4 py-3 shadow-sm">
              <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Command intent</div>
              <textarea
                value={localInput}
                onChange={(e) => {
                  setLocalInput(e.target.value);
                  props.onCommandInputChange?.(e.target.value);
                }}
                placeholder="Enter command intent (explicitly surfaced, not implicitly executed)"
                className="mt-3 h-24 w-full resize-none rounded-2xl border border-zinc-800 bg-black/20 px-4 py-3 font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
              />
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  onClick={props.onRunRequested}
                  disabled={!props.onRunRequested || executionState === "running"}
                  className={cx(
                    "inline-flex items-center gap-2 rounded-2xl border px-4 py-2 text-sm font-medium transition",
                    props.onRunRequested && executionState !== "running"
                      ? "border-indigo-700/40 bg-indigo-500/15 text-indigo-200 hover:bg-indigo-500/20"
                      : "cursor-not-allowed border-zinc-800 bg-zinc-950/60 text-zinc-500",
                  )}
                >
                  <PlayCircle className="h-4 w-4" />
                  Run
                </button>
                <button
                  onClick={props.onInterruptRequested}
                  disabled={!props.onInterruptRequested || executionState !== "running"}
                  className={cx(
                    "inline-flex items-center gap-2 rounded-2xl border px-4 py-2 text-sm font-medium transition",
                    props.onInterruptRequested && executionState === "running"
                      ? "border-rose-700/40 bg-rose-500/15 text-rose-200 hover:bg-rose-500/20"
                      : "cursor-not-allowed border-zinc-800 bg-zinc-950/60 text-zinc-500",
                  )}
                >
                  <Square className="h-4 w-4" />
                  Interrupt
                </button>
                <button
                  onClick={props.onRetryRequested}
                  disabled={!props.onRetryRequested || executionState === "running"}
                  className={cx(
                    "inline-flex items-center gap-2 rounded-2xl border px-4 py-2 text-sm font-medium transition",
                    props.onRetryRequested && executionState !== "running"
                      ? "border-zinc-800 bg-zinc-950/70 text-zinc-200 hover:bg-zinc-900"
                      : "cursor-not-allowed border-zinc-800 bg-zinc-950/60 text-zinc-500",
                  )}
                >
                  <RefreshCw className="h-4 w-4" />
                  Retry
                </button>
              </div>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:w-[30rem] xl:grid-cols-2">
            <SummaryCard label="Shell" value={props.shellPath ?? "Unknown"} icon={<TerminalSquare className="h-4 w-4" />} />
            <SummaryCard label="CWD" value={props.cwd ?? "Unknown"} icon={<Eye className="h-4 w-4" />} />
            <SummaryCard
              label="Exit"
              value={typeof currentCommand?.exitCode === "number" ? String(currentCommand.exitCode) : "N/A"}
              tone={currentCommand?.exitCode === 0 ? "good" : typeof currentCommand?.exitCode === "number" ? "bad" : "neutral"}
              icon={<CheckCircle2 className="h-4 w-4" />}
            />
            <SummaryCard label="Duration" value={currentDuration} icon={<History className="h-4 w-4" />} />
          </div>
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
                Hydrating terminal transcript…
              </div>
            </motion.div>
          ) : (
            <motion.div key="terminal" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.16 }} className="space-y-5">
              <Section
                title="Current command"
                subtitle="Command provenance, request lineage, and execution status remain visible alongside transcript output."
                actions={
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={props.onCopyTranscriptRequested}
                      disabled={!props.onCopyTranscriptRequested}
                      className={cx(
                        "inline-flex items-center gap-2 rounded-2xl border px-4 py-2 text-sm font-medium transition",
                        props.onCopyTranscriptRequested
                          ? "border-zinc-800 bg-zinc-950/70 text-zinc-200 hover:bg-zinc-900"
                          : "cursor-not-allowed border-zinc-800 bg-zinc-950/60 text-zinc-500",
                      )}
                    >
                      <Clipboard className="h-4 w-4" />
                      Copy transcript
                    </button>
                    <button
                      onClick={props.onClearRequested}
                      disabled={!props.onClearRequested}
                      className={cx(
                        "inline-flex items-center gap-2 rounded-2xl border px-4 py-2 text-sm font-medium transition",
                        props.onClearRequested
                          ? "border-zinc-800 bg-zinc-950/70 text-zinc-200 hover:bg-zinc-900"
                          : "cursor-not-allowed border-zinc-800 bg-zinc-950/60 text-zinc-500",
                      )}
                    >
                      <Trash2 className="h-4 w-4" />
                      Clear
                    </button>
                  </div>
                }
              >
                <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
                  <div className="rounded-[1.5rem] border border-zinc-800 bg-zinc-950/50 p-4 shadow-sm">
                    <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Command</div>
                    <pre className="mt-3 overflow-auto whitespace-pre-wrap break-words rounded-2xl border border-zinc-800 bg-black/20 p-4 font-mono text-sm leading-7 text-zinc-100">
{currentCommand?.commandText ?? localInput || "No command selected"}
                    </pre>
                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      <div className="rounded-2xl border border-zinc-800 bg-zinc-950/50 px-4 py-3">
                        <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Source</div>
                        <div className="mt-1 text-sm font-medium text-zinc-100">{currentCommand?.sourceLabel ?? "User terminal intent"}</div>
                      </div>
                      <div className="rounded-2xl border border-zinc-800 bg-zinc-950/50 px-4 py-3">
                        <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Request hash</div>
                        <div className="mt-1 break-all text-sm font-medium text-zinc-100">{currentCommand?.requestHash ?? "None"}</div>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-[1.5rem] border border-zinc-800 bg-zinc-950/50 p-4 shadow-sm">
                    <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Execution summary</div>
                    <div className="mt-4 space-y-3 text-sm text-zinc-300">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-zinc-500">Started</span>
                        <span>{formatDateTime(currentCommand?.startedAtMs)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-zinc-500">Ended</span>
                        <span>{formatDateTime(currentCommand?.endedAtMs)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-zinc-500">Exit code</span>
                        <span>{typeof currentCommand?.exitCode === "number" ? currentCommand.exitCode : "N/A"}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-zinc-500">State</span>
                        <span className={cx("inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.2em]", stateTone(currentCommand?.executionState ?? executionState))}>
                          <Sparkles className="h-3 w-3" />
                          {terminalStateLabel(currentCommand?.executionState ?? executionState)}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </Section>

              <Section
                title="Transcript"
                subtitle="Observed output remains filtered and inspectable without losing explicit output kind or command association."
                actions={
                  <div className="flex flex-wrap gap-2">
                    <ToggleChip label="stdout" active={showStdout} icon={<CheckCircle2 className="h-3.5 w-3.5" />} onClick={props.onToggleStdout ? () => props.onToggleStdout?.(!showStdout) : undefined} />
                    <ToggleChip label="stderr" active={showStderr} icon={<AlertTriangle className="h-3.5 w-3.5" />} onClick={props.onToggleStderr ? () => props.onToggleStderr?.(!showStderr) : undefined} />
                    <ToggleChip label="system" active={showSystem} icon={<Info className="h-3.5 w-3.5" />} onClick={props.onToggleSystem ? () => props.onToggleSystem?.(!showSystem) : undefined} />
                    <ToggleChip label="command" active={showCommands} icon={<Wand2 className="h-3.5 w-3.5" />} onClick={props.onToggleCommands ? () => props.onToggleCommands?.(!showCommands) : undefined} />
                    <ToggleChip label="autoscroll" active={autoScroll} icon={<Eye className="h-3.5 w-3.5" />} onClick={props.onToggleAutoScroll ? () => props.onToggleAutoScroll?.(!autoScroll) : undefined} />
                  </div>
                }
              >
                <div className="space-y-4">
                  <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                    <div className="flex items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-2.5 xl:w-[32rem]">
                      <Search className="h-4 w-4 text-zinc-500" />
                      <input
                        value={localFilter}
                        onChange={(e) => {
                          setLocalFilter(e.target.value);
                          props.onFilterQueryChange?.(e.target.value);
                        }}
                        placeholder="Filter transcript output"
                        className="w-full bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
                      />
                    </div>
                    <div className="rounded-full border border-zinc-800 bg-zinc-950/60 px-3 py-1.5 text-xs text-zinc-400">
                      {filteredEntries.length} visible entries
                    </div>
                  </div>

                  <div ref={transcriptRef} className="max-h-[34rem] overflow-auto rounded-[1.5rem] border border-zinc-800 bg-black/30 p-4 shadow-inner">
                    {filteredEntries.length > 0 ? (
                      <div className="space-y-2 font-mono text-sm leading-7">
                        {filteredEntries.map((entry) => (
                          <div key={`${entry.seq}:${entry.kind}`} className="rounded-2xl border border-zinc-800 bg-zinc-950/30 px-4 py-3">
                            <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                              <span className={cx("inline-flex items-center gap-1 rounded-full border px-2 py-0.5", outputBadgeTone(entry.kind))}>
                                {entry.kind}
                              </span>
                              <span>seq {entry.seq}</span>
                              <span>{formatTime(entry.atMs)}</span>
                              {entry.commandId ? <span>cmd {entry.commandId}</span> : null}
                            </div>
                            <pre className={cx("mt-2 overflow-auto whitespace-pre-wrap break-words", severityTone(entry.severity))}>{entry.text}</pre>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="grid min-h-[16rem] place-items-center rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/30 p-6 text-center">
                        <div className="max-w-lg">
                          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-950/60 text-zinc-400">
                            {localFilter.trim() ? <XCircle className="h-5 w-5" /> : executionState === "running" ? <PauseCircle className="h-5 w-5" /> : <TerminalSquare className="h-5 w-5" />}
                          </div>
                          <h3 className="mt-5 text-lg font-semibold text-zinc-100">
                            {localFilter.trim() ? "No visible transcript lines" : executionState === "running" ? "Awaiting output" : "No transcript yet"}
                          </h3>
                          <p className="mt-3 text-sm leading-7 text-zinc-500">
                            {localFilter.trim()
                              ? "The current transcript filter removes all visible entries. Clear filters or widen the visible output kinds."
                              : executionState === "running"
                                ? "The command is still running, but no visible output has been surfaced yet."
                                : "No terminal transcript is currently bound to this surface."}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </Section>

              <Section title="Command history" subtitle="Previously surfaced commands remain selectable as explicit provenance, not inferred shell memory.">
                {commandHistory.length > 0 ? (
                  <div className="space-y-2">
                    {commandHistory.map((command) => (
                      <button
                        key={command.commandId}
                        onClick={() => props.onSelectHistoryCommand?.(command)}
                        className="flex w-full items-start gap-3 rounded-[1.5rem] border border-zinc-800 bg-zinc-950/50 px-4 py-4 text-left shadow-sm transition hover:bg-zinc-900"
                      >
                        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-2 text-zinc-300">
                          <History className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-mono text-sm text-zinc-100">{command.commandText}</div>
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                            <span className={cx("inline-flex items-center gap-1 rounded-full border px-2 py-0.5", stateTone(command.executionState))}>{terminalStateLabel(command.executionState)}</span>
                            <span>{formatDateTime(command.startedAtMs)}</span>
                            {typeof command.exitCode === "number" ? <span>exit {command.exitCode}</span> : null}
                            {command.requestHash ? <span>{command.requestHash}</span> : null}
                          </div>
                        </div>
                        <ChevronRight className="h-4 w-4 text-zinc-600" />
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-[1.5rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-5 text-sm text-zinc-500">
                    No command history is currently bound to the terminal surface.
                  </div>
                )}
              </Section>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="border-t border-zinc-800 px-4 py-3 text-xs text-zinc-500">
        <div className="flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5" /> trust visible</span>
          <span className="inline-flex items-center gap-1"><TerminalSquare className="h-3.5 w-3.5" /> transcript explicit</span>
          <span className="inline-flex items-center gap-1"><History className="h-3.5 w-3.5" /> provenance preserved</span>
          <span className="inline-flex items-center gap-1"><Filter className="h-3.5 w-3.5" /> filtering non-destructive</span>
        </div>
      </div>
    </section>
  );
}
