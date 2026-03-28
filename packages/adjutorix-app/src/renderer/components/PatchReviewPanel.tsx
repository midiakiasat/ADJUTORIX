import React, { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Eye,
  FileCode2,
  Filter,
  GitBranch,
  ListChecks,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Sparkles,
  Target,
  Wand2,
  XCircle,
} from "lucide-react";

/**
 * ADJUTORIX APP — RENDERER / COMPONENTS / PatchReviewPanel.tsx
 *
 * Canonical governed patch review orchestration surface.
 *
 * Purpose:
 * - provide the authoritative renderer-side review cockpit for a patch/preview lineage
 * - unify patch identity, preview lineage, per-file review decisions, verification evidence,
 *   reviewer attention, approval posture, and apply readiness under one deterministic component
 * - prevent review from fragmenting into unrelated widgets that separately display diff state,
 *   verify state, and apply state without one coherent decision surface
 * - expose explicit review/approval/apply intent upward without mutating files locally
 *
 * Architectural role:
 * - PatchReviewPanel is the control-and-context layer above raw diff rendering
 * - it does not generate diffs, run verification, or apply changes itself
 * - it renders declared patch review state and emits explicit user intent callbacks
 * - it should remain informative through preview-only, partially reviewed, verified, failed,
 *   and apply-ready stages
 *
 * Hard invariants:
 * - lineage identifiers are always visually explicit when provided
 * - apply readiness is shown as explicit state, never inferred by button styling alone
 * - file decision tallies are derived from provided items and remain deterministic
 * - approval/verify/apply actions are explicit callbacks or explicit disabled state
 * - identical props yield identical ordering, tallies, and visible posture
 * - no placeholders, fake verification, or hidden patch mutation side effects
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type PatchReviewTrustLevel = "unknown" | "untrusted" | "restricted" | "trusted";
export type PatchReviewSeverity = "none" | "info" | "warn" | "error" | "critical";
export type PatchReviewState = "none" | "preview" | "approved" | "verified" | "applied";
export type PatchDecision = "unreviewed" | "accepted" | "rejected" | "needs-attention";
export type PatchVerifyOutcome = "unknown" | "passed" | "failed" | "partial" | "cancelled";

export type PatchReviewFileItem = {
  id: string;
  path: string;
  previousPath?: string | null;
  addedLines?: number;
  removedLines?: number;
  decision?: PatchDecision;
  diagnosticsCount?: number;
  diagnosticsSeverity?: PatchReviewSeverity;
  reviewState?: PatchReviewState;
  trustLevel?: PatchReviewTrustLevel;
  attention?: "none" | "low" | "medium" | "high" | "critical";
  modified?: boolean;
  generated?: boolean;
};

export type PatchReviewEvidenceItem = {
  id: string;
  label: string;
  value: string;
  tone?: "neutral" | "good" | "warn" | "bad";
};

export type PatchReviewPanelProps = {
  title?: string;
  subtitle?: string;
  patchId?: string | null;
  previewHash?: string | null;
  requestHash?: string | null;
  verifyId?: string | null;
  verifiedPreviewHash?: string | null;
  trustLevel?: PatchReviewTrustLevel;
  reviewState?: PatchReviewState;
  verifyOutcome?: PatchVerifyOutcome;
  approved?: boolean;
  applyReady?: boolean;
  applied?: boolean;
  loading?: boolean;
  files: PatchReviewFileItem[];
  selectedFileId?: string | null;
  showOnlyAttention?: boolean;
  showOnlyDiagnostics?: boolean;
  showOnlyRejected?: boolean;
  evidenceItems?: PatchReviewEvidenceItem[];
  statusMessage?: string | null;
  onSelectFile?: (file: PatchReviewFileItem) => void;
  onToggleAttentionOnly?: (value: boolean) => void;
  onToggleDiagnosticsOnly?: (value: boolean) => void;
  onToggleRejectedOnly?: (value: boolean) => void;
  onSetFileDecision?: (file: PatchReviewFileItem, decision: PatchDecision) => void;
  onApproveRequested?: () => void;
  onResetApprovalRequested?: () => void;
  onVerifyRequested?: () => void;
  onApplyRequested?: () => void;
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

function trustTone(level: PatchReviewTrustLevel | undefined): string {
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

function trustIcon(level: PatchReviewTrustLevel | undefined): JSX.Element {
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

function severityTone(severity: PatchReviewSeverity | undefined): string {
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

function reviewTone(state: PatchReviewState | undefined): string {
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

function decisionTone(decision: PatchDecision | undefined): string {
  switch (decision) {
    case "accepted":
      return "border-emerald-700/30 bg-emerald-500/10 text-emerald-300";
    case "rejected":
      return "border-rose-700/30 bg-rose-500/10 text-rose-300";
    case "needs-attention":
      return "border-amber-700/30 bg-amber-500/10 text-amber-300";
    default:
      return "border-zinc-700/30 bg-zinc-500/10 text-zinc-400";
  }
}

function verifyTone(outcome: PatchVerifyOutcome | undefined): string {
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

function attentionRank(level: PatchReviewFileItem["attention"]): number {
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
        <div className="rounded-xl border border-zinc-800 bg-black/20 p-2.5 text-zinc-300">{props.icon ?? <ListChecks className="h-4 w-4" />}</div>
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

export default function PatchReviewPanel(props: PatchReviewPanelProps): JSX.Element {
  const title = props.title ?? "Patch review cockpit";
  const subtitle =
    props.subtitle ??
    "Unified review surface for preview lineage, file decisions, verification evidence, reviewer attention, and explicit apply readiness.";

  const trustLevel = props.trustLevel ?? "unknown";
  const reviewState = props.reviewState ?? "preview";
  const verifyOutcome = props.verifyOutcome ?? "unknown";
  const loading = props.loading ?? false;
  const showOnlyAttention = props.showOnlyAttention ?? false;
  const showOnlyDiagnostics = props.showOnlyDiagnostics ?? false;
  const showOnlyRejected = props.showOnlyRejected ?? false;

  const [localSelectedFileId, setLocalSelectedFileId] = useState<string | null>(props.selectedFileId ?? null);

  const visibleFiles = useMemo(() => {
    return props.files.filter((file) => {
      if (showOnlyAttention && attentionRank(file.attention) === 0 && file.decision !== "needs-attention") return false;
      if (showOnlyDiagnostics && !(file.diagnosticsCount && file.diagnosticsCount > 0)) return false;
      if (showOnlyRejected && file.decision !== "rejected") return false;
      return true;
    });
  }, [props.files, showOnlyAttention, showOnlyDiagnostics, showOnlyRejected]);

  const selectedFileId = props.selectedFileId ?? localSelectedFileId ?? visibleFiles[0]?.id ?? null;
  const selectedFile = visibleFiles.find((file) => file.id === selectedFileId) ?? visibleFiles[0] ?? null;

  const metrics = useMemo(() => {
    const accepted = visibleFiles.filter((file) => file.decision === "accepted").length;
    const rejected = visibleFiles.filter((file) => file.decision === "rejected").length;
    const attention = visibleFiles.filter((file) => file.decision === "needs-attention" || attentionRank(file.attention) > 0).length;
    const diagnostics = visibleFiles.filter((file) => (file.diagnosticsCount ?? 0) > 0).length;
    return { accepted, rejected, attention, diagnostics };
  }, [visibleFiles]);

  const evidenceItems = props.evidenceItems ?? [
    { id: "review-state", label: "Review state", value: reviewState, tone: reviewState === "verified" || reviewState === "applied" ? "good" : reviewState === "approved" ? "warn" : "neutral" },
    { id: "verify-outcome", label: "Verify", value: verifyOutcome, tone: verifyOutcome === "passed" ? "good" : verifyOutcome === "failed" ? "bad" : verifyOutcome === "partial" ? "warn" : "neutral" },
    { id: "approved", label: "Approved", value: props.approved ? "yes" : "no", tone: props.approved ? "good" : "warn" },
    { id: "apply-ready", label: "Apply ready", value: props.applyReady ? "yes" : "no", tone: props.applyReady ? "good" : "neutral" },
  ];

  return (
    <section className="flex h-full min-h-0 flex-col rounded-[2rem] border border-zinc-800 bg-zinc-900/70 shadow-xl">
      <div className="border-b border-zinc-800 px-5 py-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Patch governance</div>
            <h2 className="mt-1 text-lg font-semibold text-zinc-50">{title}</h2>
            <p className="mt-2 text-sm leading-7 text-zinc-400">{subtitle}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={trustTone(trustLevel)}>
              {trustIcon(trustLevel)}
              {trustLevel}
            </Badge>
            <Badge className={reviewTone(reviewState)}>
              <GitBranch className="h-3.5 w-3.5" />
              {reviewState}
            </Badge>
            <Badge className={verifyTone(verifyOutcome)}>
              <ShieldCheck className="h-3.5 w-3.5" />
              {verifyOutcome}
            </Badge>
            {props.previewHash ? (
              <Badge className="border-sky-700/30 bg-sky-500/10 text-sky-300">
                <Sparkles className="h-3.5 w-3.5" />
                {props.previewHash}
              </Badge>
            ) : null}
            {props.patchId ? (
              <Badge className="border-indigo-700/30 bg-indigo-500/10 text-indigo-300">
                <GitBranch className="h-3.5 w-3.5" />
                {props.patchId}
              </Badge>
            ) : null}
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Files" value={String(visibleFiles.length)} icon={<FileCode2 className="h-4 w-4" />} />
          <MetricCard label="Accepted" value={String(metrics.accepted)} tone={metrics.accepted > 0 ? "good" : "neutral"} icon={<CheckCircle2 className="h-4 w-4" />} />
          <MetricCard label="Attention" value={String(metrics.attention)} tone={metrics.attention > 0 ? "warn" : "neutral"} icon={<AlertTriangle className="h-4 w-4" />} />
          <MetricCard label="Rejected" value={String(metrics.rejected)} tone={metrics.rejected > 0 ? "bad" : "neutral"} icon={<XCircle className="h-4 w-4" />} />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <ToggleChip label="Attention only" active={showOnlyAttention} icon={<AlertTriangle className="h-3.5 w-3.5" />} onClick={props.onToggleAttentionOnly ? () => props.onToggleAttentionOnly?.(!showOnlyAttention) : undefined} />
          <ToggleChip label="Diagnostics only" active={showOnlyDiagnostics} icon={<Filter className="h-3.5 w-3.5" />} onClick={props.onToggleDiagnosticsOnly ? () => props.onToggleDiagnosticsOnly?.(!showOnlyDiagnostics) : undefined} />
          <ToggleChip label="Rejected only" active={showOnlyRejected} icon={<XCircle className="h-3.5 w-3.5" />} onClick={props.onToggleRejectedOnly ? () => props.onToggleRejectedOnly?.(!showOnlyRejected) : undefined} />
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <ActionButton label="Approve" icon={<ClipboardCheck className="h-4 w-4" />} disabled={props.approved || visibleFiles.length === 0} onClick={props.onApproveRequested} />
          <ActionButton label="Reset approval" icon={<ChevronRight className="h-4 w-4" />} tone="secondary" disabled={!props.approved} onClick={props.onResetApprovalRequested} />
          <ActionButton label="Verify" icon={<ShieldCheck className="h-4 w-4" />} tone="secondary" disabled={visibleFiles.length === 0} onClick={props.onVerifyRequested} />
          <ActionButton label="Apply" icon={<Wand2 className="h-4 w-4" />} tone={props.applyReady ? "primary" : "secondary"} disabled={!props.applyReady || props.applied} onClick={props.onApplyRequested} />
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
                Hydrating patch review cockpit…
              </div>
            </motion.div>
          ) : visibleFiles.length > 0 ? (
            <motion.div key="review" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.16 }} className="grid gap-5 xl:grid-cols-[0.95fr_1.05fr]">
              <div className="space-y-3">
                {visibleFiles.map((file) => {
                  const selected = selectedFile?.id === file.id;
                  return (
                    <button
                      key={file.id}
                      onClick={() => {
                        setLocalSelectedFileId(file.id);
                        props.onSelectFile?.(file);
                      }}
                      className={cx(
                        "w-full rounded-[1.5rem] border px-4 py-4 text-left shadow-sm transition",
                        selected ? "border-zinc-600 bg-zinc-800 text-zinc-50" : "border-zinc-800 bg-zinc-950/50 text-zinc-200 hover:bg-zinc-900",
                      )}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-3">
                            <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-2 text-zinc-300">
                              <FileCode2 className="h-4 w-4" />
                            </div>
                            <div className="min-w-0">
                              <div className="truncate text-sm font-semibold">{basename(file.path)}</div>
                              <div className="mt-1 truncate text-xs text-zinc-500">{file.path}</div>
                              {file.previousPath ? <div className="mt-1 truncate text-xs text-zinc-600">from {file.previousPath}</div> : null}
                            </div>
                          </div>
                          <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.2em]">
                            <span className={cx("inline-flex items-center gap-1 rounded-full border px-2 py-0.5", trustTone(file.trustLevel))}>
                              {trustIcon(file.trustLevel)}
                              {file.trustLevel ?? "unknown"}
                            </span>
                            {file.reviewState && file.reviewState !== "none" ? <span className={cx("rounded-full border px-2 py-0.5", reviewTone(file.reviewState))}>{file.reviewState}</span> : null}
                            {file.decision ? <span className={cx("rounded-full border px-2 py-0.5", decisionTone(file.decision))}>{file.decision}</span> : null}
                            {file.diagnosticsCount ? <span className={cx("rounded-full border px-2 py-0.5", severityTone(file.diagnosticsSeverity))}>{file.diagnosticsCount} diagnostics</span> : null}
                            {typeof file.addedLines === "number" ? <span className="rounded-full border border-emerald-700/30 bg-emerald-500/10 px-2 py-0.5 text-emerald-300">+{file.addedLines}</span> : null}
                            {typeof file.removedLines === "number" ? <span className="rounded-full border border-rose-700/30 bg-rose-500/10 px-2 py-0.5 text-rose-300">-{file.removedLines}</span> : null}
                          </div>
                        </div>
                        <ChevronRight className="h-4 w-4 text-zinc-600" />
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="space-y-5">
                <section className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-5 shadow-lg">
                  <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Selected file</div>
                  {selectedFile ? (
                    <div className="mt-3 space-y-4">
                      <div>
                        <div className="text-lg font-semibold text-zinc-50">{basename(selectedFile.path)}</div>
                        <div className="mt-1 text-sm text-zinc-500">{selectedFile.path}</div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Badge className={trustTone(selectedFile.trustLevel)}>
                          {trustIcon(selectedFile.trustLevel)}
                          {selectedFile.trustLevel ?? "unknown"}
                        </Badge>
                        {selectedFile.reviewState && selectedFile.reviewState !== "none" ? <Badge className={reviewTone(selectedFile.reviewState)}>{selectedFile.reviewState}</Badge> : null}
                        {selectedFile.decision ? <Badge className={decisionTone(selectedFile.decision)}>{selectedFile.decision}</Badge> : null}
                        {selectedFile.diagnosticsCount ? <Badge className={severityTone(selectedFile.diagnosticsSeverity)}>{selectedFile.diagnosticsCount} diagnostics</Badge> : null}
                      </div>

                      <div className="grid gap-3 sm:grid-cols-2">
                        <MetricCard label="Added" value={String(selectedFile.addedLines ?? 0)} tone={(selectedFile.addedLines ?? 0) > 0 ? "good" : "neutral"} icon={<CheckCircle2 className="h-4 w-4" />} />
                        <MetricCard label="Removed" value={String(selectedFile.removedLines ?? 0)} tone={(selectedFile.removedLines ?? 0) > 0 ? "bad" : "neutral"} icon={<XCircle className="h-4 w-4" />} />
                      </div>

                      <div className="flex flex-wrap gap-2">
                        {(["accepted", "needs-attention", "rejected"] as PatchDecision[]).map((decision) => (
                          <ActionButton
                            key={decision}
                            label={decision}
                            icon={<Target className="h-4 w-4" />}
                            tone={decision === "rejected" ? "danger" : decision === "accepted" ? "primary" : "secondary"}
                            onClick={props.onSetFileDecision ? () => props.onSetFileDecision?.(selectedFile, decision) : undefined}
                          />
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 rounded-[1.5rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-5 text-sm text-zinc-500">
                      Select a visible file to inspect and decide on its review posture.
                    </div>
                  )}
                </section>

                <section className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-5 shadow-lg">
                  <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Evidence</div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    {evidenceItems.map((item) => (
                      <MetricCard
                        key={item.id}
                        label={item.label}
                        value={item.value}
                        tone={item.tone}
                        icon={item.id.includes("verify") ? <ShieldCheck className="h-4 w-4" /> : item.id.includes("apply") ? <Wand2 className="h-4 w-4" /> : <ListChecks className="h-4 w-4" />}
                      />
                    ))}
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                    {props.requestHash ? <span className="rounded-full border border-zinc-800 bg-zinc-950/60 px-2 py-0.5">request {props.requestHash}</span> : null}
                    {props.verifyId ? <span className="rounded-full border border-zinc-800 bg-zinc-950/60 px-2 py-0.5">verify {props.verifyId}</span> : null}
                    {props.verifiedPreviewHash ? <span className="rounded-full border border-zinc-800 bg-zinc-950/60 px-2 py-0.5">verified {props.verifiedPreviewHash}</span> : null}
                  </div>
                </section>
              </div>
            </motion.div>
          ) : (
            <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="grid min-h-[18rem] place-items-center rounded-[2rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-8 text-center">
              <div className="max-w-xl">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-[1.5rem] border border-zinc-800 bg-zinc-950/60 text-zinc-400">
                  <GitBranch className="h-6 w-6" />
                </div>
                <h3 className="mt-6 text-xl font-semibold text-zinc-100">No visible review files</h3>
                <p className="mt-3 text-sm leading-7 text-zinc-500">The current patch review filters produced no visible files. Relax attention, diagnostics, or rejection filters to continue review.</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="border-t border-zinc-800 px-4 py-3 text-xs text-zinc-500">
        <div className="flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-1"><GitBranch className="h-3.5 w-3.5" /> lineage explicit</span>
          <span className="inline-flex items-center gap-1"><ClipboardCheck className="h-3.5 w-3.5" /> approval explicit</span>
          <span className="inline-flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5" /> verification surfaced</span>
          <span className="inline-flex items-center gap-1"><Wand2 className="h-3.5 w-3.5" /> apply readiness explicit</span>
        </div>
      </div>
    </section>
  );
}
