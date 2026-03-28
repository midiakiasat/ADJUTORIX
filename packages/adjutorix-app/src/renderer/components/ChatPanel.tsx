import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  FileCode2,
  Filter,
  GitBranch,
  Link2,
  Loader2,
  Lock,
  MessageSquare,
  Paperclip,
  PlayCircle,
  Search,
  Send,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Sparkles,
  TerminalSquare,
  User,
  Wrench,
  XCircle,
} from "lucide-react";

/**
 * ADJUTORIX APP — RENDERER / COMPONENTS / ChatPanel.tsx
 *
 * Canonical governed conversational control surface.
 *
 * Purpose:
 * - provide the authoritative renderer-side conversation surface for operator ↔ system/agent dialogue
 * - unify conversational messages, intent posture, authority boundaries, lineage references,
 *   attachments, proposal/action separation, and operator response drafting under one deterministic UI
 * - prevent chat from degenerating into an ungoverned text box where discussion, proposal,
 *   execution, and unverifiable claims blur together
 * - expose explicit user intent upward without performing hidden execution, mutation, or send-side effects
 *
 * Architectural role:
 * - ChatPanel is a presentation-and-control layer over declared conversation/session state
 * - it does not own backend message truth or execution semantics; it renders externally supplied state
 * - it should remain useful for passive review, active planning, patch discussion, verify follow-up,
 *   and execution-gated conversations
 * - it must make visible what is merely talk, what is a proposal, what is evidence-backed,
 *   and what is bound to executable/patch/verify lineage
 *
 * Hard invariants:
 * - message ordering is the provided ordering after explicit filters only
 * - message role and intent class are explicit and stable
 * - action/proposal/evidence badges annotate but do not alter message identity
 * - attachments and lineage references are bound to explicit messages only
 * - action affordances are explicit callbacks or explicit disabled state
 * - identical props yield identical ordering, tallies, and visible posture
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type ChatHealth = "healthy" | "degraded" | "unhealthy" | "unknown";
export type ChatTrustLevel = "unknown" | "untrusted" | "restricted" | "trusted";
export type ChatRole = "user" | "assistant" | "system" | "tool";
export type ChatIntentClass = "discussion" | "proposal" | "evidence" | "action-request" | "status" | "warning";
export type ChatMessageState = "complete" | "streaming" | "failed" | "blocked" | "draft";
export type ChatAttention = "none" | "low" | "medium" | "high" | "critical";

export type ChatAttachment = {
  id: string;
  label: string;
  kind?: "file" | "patch" | "verify" | "ledger" | "diagnostic" | "other";
  path?: string | null;
  sizeLabel?: string | null;
};

export type ChatReference = {
  requestHash?: string | null;
  patchId?: string | null;
  previewHash?: string | null;
  verifyId?: string | null;
  ledgerSeq?: number | null;
  jobId?: string | null;
};

export type ChatMessage = {
  id: string;
  role: ChatRole;
  intentClass?: ChatIntentClass;
  state?: ChatMessageState;
  trustLevel?: ChatTrustLevel;
  attention?: ChatAttention;
  authorLabel?: string | null;
  createdAtMs: number;
  content: string;
  summary?: string | null;
  citations?: string[];
  references?: ChatReference;
  attachments?: ChatAttachment[];
  actionable?: boolean;
  blockedReason?: string | null;
};

export type ChatQuickAction = {
  id: string;
  label: string;
  icon?: "send" | "patch" | "verify" | "run" | "diagnostics" | "ledger" | "custom";
  disabled?: boolean;
  onInvoke?: () => void;
};

export type ChatMetric = {
  id: string;
  label: string;
  value: string;
  tone?: "neutral" | "good" | "warn" | "bad";
};

export type ChatPanelProps = {
  title?: string;
  subtitle?: string;
  health?: ChatHealth;
  loading?: boolean;
  trustLevel?: ChatTrustLevel;
  messages: ChatMessage[];
  metrics?: ChatMetric[];
  selectedMessageId?: string | null;
  draftInput?: string;
  filterQuery?: string;
  roleFilters?: string[];
  attentionOnly?: boolean;
  actionableOnly?: boolean;
  composerLocked?: boolean;
  composerLockReason?: string | null;
  quickActions?: ChatQuickAction[];
  onRefreshRequested?: () => void;
  onSelectMessage?: (message: ChatMessage) => void;
  onDraftInputChange?: (value: string) => void;
  onFilterQueryChange?: (query: string) => void;
  onRoleFiltersChange?: (roles: string[]) => void;
  onToggleAttentionOnly?: (value: boolean) => void;
  onToggleActionableOnly?: (value: boolean) => void;
  onSendRequested?: () => void;
  onOpenAttachmentRequested?: (message: ChatMessage, attachment: ChatAttachment) => void;
  onRunMessageActionRequested?: (message: ChatMessage) => void;
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

function healthTone(level: ChatHealth | undefined): string {
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

function trustTone(level: ChatTrustLevel | undefined): string {
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

function trustIcon(level: ChatTrustLevel | undefined): JSX.Element {
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

function attentionRank(level: ChatAttention | undefined): number {
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

function attentionTone(level: ChatAttention | undefined): string {
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

function intentTone(intent: ChatIntentClass | undefined): string {
  switch (intent) {
    case "proposal":
      return "border-indigo-700/30 bg-indigo-500/10 text-indigo-300";
    case "evidence":
      return "border-emerald-700/30 bg-emerald-500/10 text-emerald-300";
    case "action-request":
      return "border-violet-700/30 bg-violet-500/10 text-violet-300";
    case "warning":
      return "border-rose-700/30 bg-rose-500/10 text-rose-300";
    case "status":
      return "border-sky-700/30 bg-sky-500/10 text-sky-300";
    default:
      return "border-zinc-700/30 bg-zinc-500/10 text-zinc-300";
  }
}

function stateTone(state: ChatMessageState | undefined): string {
  switch (state) {
    case "streaming":
      return "border-sky-700/30 bg-sky-500/10 text-sky-300";
    case "complete":
      return "border-emerald-700/30 bg-emerald-500/10 text-emerald-300";
    case "failed":
    case "blocked":
      return "border-rose-700/30 bg-rose-500/10 text-rose-300";
    case "draft":
      return "border-amber-700/30 bg-amber-500/10 text-amber-300";
    default:
      return "border-zinc-700/30 bg-zinc-500/10 text-zinc-300";
  }
}

function metricTone(tone?: ChatMetric["tone"]): string {
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

function roleTone(role: ChatRole): string {
  switch (role) {
    case "assistant":
      return "border-sky-700/30 bg-sky-500/10 text-sky-300";
    case "user":
      return "border-indigo-700/30 bg-indigo-500/10 text-indigo-300";
    case "system":
      return "border-amber-700/30 bg-amber-500/10 text-amber-300";
    case "tool":
      return "border-violet-700/30 bg-violet-500/10 text-violet-300";
    default:
      return "border-zinc-700/30 bg-zinc-500/10 text-zinc-300";
  }
}

function quickActionIcon(icon?: ChatQuickAction["icon"]): JSX.Element {
  switch (icon) {
    case "patch":
      return <GitBranch className="h-4 w-4" />;
    case "verify":
      return <ShieldCheck className="h-4 w-4" />;
    case "run":
      return <PlayCircle className="h-4 w-4" />;
    case "diagnostics":
      return <Wrench className="h-4 w-4" />;
    case "ledger":
      return <ClipboardList className="h-4 w-4" />;
    default:
      return <Send className="h-4 w-4" />;
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
        <div className="rounded-xl border border-zinc-800 bg-black/20 p-2.5 text-zinc-300">{props.icon ?? <MessageSquare className="h-4 w-4" />}</div>
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

function ComposerButton(props: { label: string; icon?: React.ReactNode; disabled?: boolean; tone?: "primary" | "secondary"; onClick?: () => void }): JSX.Element {
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

export default function ChatPanel(props: ChatPanelProps): JSX.Element {
  const title = props.title ?? "Governed chat";
  const subtitle =
    props.subtitle ??
    "Conversation surface with explicit intent classes, authority boundaries, lineage references, attachments, and action gating.";

  const health = props.health ?? "unknown";
  const trustLevel = props.trustLevel ?? "unknown";
  const loading = props.loading ?? false;
  const [localFilter, setLocalFilter] = useState(props.filterQuery ?? "");
  const [localRoles, setLocalRoles] = useState<string[]>(props.roleFilters ?? []);
  const attentionOnly = props.attentionOnly ?? false;
  const actionableOnly = props.actionableOnly ?? false;
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(props.selectedMessageId ?? null);
  const [localDraft, setLocalDraft] = useState(props.draftInput ?? "");
  const composerLocked = props.composerLocked ?? false;
  const quickActions = props.quickActions ?? [];

  useEffect(() => {
    setLocalDraft(props.draftInput ?? "");
  }, [props.draftInput]);

  const visibleMessages = useMemo(() => {
    const q = localFilter.trim().toLowerCase();
    return props.messages.filter((message) => {
      if (attentionOnly && attentionRank(message.attention) === 0) return false;
      if (actionableOnly && !message.actionable) return false;
      if (localRoles.length > 0 && !localRoles.includes(message.role)) return false;
      if (!q) return true;
      return (
        message.content.toLowerCase().includes(q) ||
        (message.summary ?? "").toLowerCase().includes(q) ||
        (message.authorLabel ?? "").toLowerCase().includes(q) ||
        (message.references?.patchId ?? "").toLowerCase().includes(q) ||
        (message.references?.previewHash ?? "").toLowerCase().includes(q) ||
        (message.references?.verifyId ?? "").toLowerCase().includes(q) ||
        (message.references?.requestHash ?? "").toLowerCase().includes(q)
      );
    });
  }, [actionableOnly, attentionOnly, localFilter, localRoles, props.messages]);

  const selectedMessageId = props.selectedMessageId ?? localSelectedId ?? visibleMessages[visibleMessages.length - 1]?.id ?? null;
  const selectedMessage = visibleMessages.find((m) => m.id === selectedMessageId) ?? visibleMessages[visibleMessages.length - 1] ?? null;

  const metrics = props.metrics ?? [
    { id: "visible", label: "Visible messages", value: String(visibleMessages.length) },
    { id: "actionable", label: "Actionable", value: String(props.messages.filter((m) => m.actionable).length), tone: props.messages.some((m) => m.actionable) ? "warn" : "neutral" },
    { id: "blocked", label: "Blocked", value: String(props.messages.filter((m) => m.state === "blocked").length), tone: props.messages.some((m) => m.state === "blocked") ? "bad" : "neutral" },
    { id: "assistant", label: "Assistant", value: String(props.messages.filter((m) => m.role === "assistant").length), tone: props.messages.some((m) => m.role === "assistant") ? "good" : "neutral" },
  ];

  const roleUniverse = useMemo(() => [...new Set(props.messages.map((m) => m.role))].sort((a, b) => a.localeCompare(b)), [props.messages]);

  return (
    <section className="flex h-full min-h-0 flex-col rounded-[2rem] border border-zinc-800 bg-zinc-900/70 shadow-xl">
      <div className="border-b border-zinc-800 px-5 py-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Conversation</div>
            <h2 className="mt-1 text-lg font-semibold text-zinc-50">{title}</h2>
            <p className="mt-2 text-sm leading-7 text-zinc-400">{subtitle}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={healthTone(health)}>
              <ShieldCheck className="h-3.5 w-3.5" />
              {health}
            </Badge>
            <Badge className={trustTone(trustLevel)}>
              {trustIcon(trustLevel)}
              {trustLevel}
            </Badge>
            <button
              onClick={props.onRefreshRequested}
              disabled={!props.onRefreshRequested}
              className={cx(
                "rounded-2xl border border-zinc-800 bg-zinc-950/70 p-2.5 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100",
                !props.onRefreshRequested && "cursor-not-allowed opacity-40",
              )}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
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
              icon={metric.id === "actionable" ? <PlayCircle className="h-4 w-4" /> : metric.id === "blocked" ? <Lock className="h-4 w-4" /> : metric.id === "assistant" ? <Bot className="h-4 w-4" /> : <MessageSquare className="h-4 w-4" />}
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
              placeholder="Filter conversation"
              className="w-full bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <ToggleChip label="Attention only" active={attentionOnly} icon={<AlertTriangle className="h-3.5 w-3.5" />} onClick={props.onToggleAttentionOnly ? () => props.onToggleAttentionOnly?.(!attentionOnly) : undefined} />
            <ToggleChip label="Actionable only" active={actionableOnly} icon={<PlayCircle className="h-3.5 w-3.5" />} onClick={props.onToggleActionableOnly ? () => props.onToggleActionableOnly?.(!actionableOnly) : undefined} />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {roleUniverse.map((role) => {
            const active = localRoles.includes(role);
            return (
              <ToggleChip
                key={role}
                label={role}
                active={active}
                icon={role === "assistant" ? <Bot className="h-3.5 w-3.5" /> : role === "user" ? <User className="h-3.5 w-3.5" /> : role === "tool" ? <Wrench className="h-3.5 w-3.5" /> : <ShieldAlert className="h-3.5 w-3.5" />}
                onClick={
                  props.onRoleFiltersChange
                    ? () => {
                        const next = active ? localRoles.filter((r) => r !== role) : [...localRoles, role].sort((a, b) => a.localeCompare(b));
                        setLocalRoles(next);
                        props.onRoleFiltersChange?.(next);
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
                Hydrating governed conversation…
              </div>
            </motion.div>
          ) : visibleMessages.length > 0 ? (
            <motion.div key="chat" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.16 }} className="grid gap-5 xl:grid-cols-[1fr_0.92fr]">
              <div className="space-y-3">
                {visibleMessages.map((message) => {
                  const selected = selectedMessage?.id === message.id;
                  return (
                    <button
                      key={message.id}
                      onClick={() => {
                        setLocalSelectedId(message.id);
                        props.onSelectMessage?.(message);
                      }}
                      className={cx(
                        "w-full rounded-[1.5rem] border px-4 py-4 text-left shadow-sm transition",
                        selected ? "border-zinc-600 bg-zinc-800 text-zinc-50" : "border-zinc-800 bg-zinc-950/50 text-zinc-200 hover:bg-zinc-900",
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-2 text-zinc-300">
                          {message.role === "assistant" ? <Bot className="h-4 w-4" /> : message.role === "user" ? <User className="h-4 w-4" /> : message.role === "tool" ? <Wrench className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-semibold">{message.authorLabel ?? message.role}</span>
                            <span className={cx("rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.2em]", roleTone(message.role))}>{message.role}</span>
                            {message.intentClass ? <span className={cx("rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.2em]", intentTone(message.intentClass))}>{message.intentClass}</span> : null}
                            {message.state ? <span className={cx("rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.2em]", stateTone(message.state))}>{message.state}</span> : null}
                            {message.actionable ? <span className="rounded-full border border-violet-700/30 bg-violet-500/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] text-violet-300">actionable</span> : null}
                          </div>
                          <div className="mt-2 text-sm text-zinc-400 line-clamp-4 whitespace-pre-wrap">{message.summary ?? message.content}</div>
                          <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                            <span>{formatDateTime(message.createdAtMs)}</span>
                            {message.references?.patchId ? <span>patch {message.references.patchId}</span> : null}
                            {message.references?.verifyId ? <span>verify {message.references.verifyId}</span> : null}
                            {message.references?.previewHash ? <span>preview {message.references.previewHash}</span> : null}
                            {message.attachments && message.attachments.length > 0 ? <span>{message.attachments.length} attachments</span> : null}
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
                  <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Selected message</div>
                  {selectedMessage ? (
                    <div className="mt-4 space-y-4">
                      <div>
                        <div className="text-lg font-semibold text-zinc-50">{selectedMessage.authorLabel ?? selectedMessage.role}</div>
                        <div className="mt-2 whitespace-pre-wrap text-sm leading-7 text-zinc-300">{selectedMessage.content}</div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Badge className={roleTone(selectedMessage.role)}>{selectedMessage.role}</Badge>
                        {selectedMessage.intentClass ? <Badge className={intentTone(selectedMessage.intentClass)}>{selectedMessage.intentClass}</Badge> : null}
                        {selectedMessage.state ? <Badge className={stateTone(selectedMessage.state)}>{selectedMessage.state}</Badge> : null}
                        <Badge className={trustTone(selectedMessage.trustLevel)}>
                          {trustIcon(selectedMessage.trustLevel)}
                          {selectedMessage.trustLevel ?? "unknown"}
                        </Badge>
                        <Badge className={attentionTone(selectedMessage.attention)}>{selectedMessage.attention ?? "none"}</Badge>
                      </div>

                      {selectedMessage.blockedReason ? (
                        <div className="rounded-[1.25rem] border border-rose-700/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                          {selectedMessage.blockedReason}
                        </div>
                      ) : null}

                      <div className="grid gap-3 sm:grid-cols-2">
                        <MetricCard label="Patch" value={selectedMessage.references?.patchId ?? "None"} icon={<GitBranch className="h-4 w-4" />} />
                        <MetricCard label="Verify" value={selectedMessage.references?.verifyId ?? "None"} icon={<ShieldCheck className="h-4 w-4" />} />
                        <MetricCard label="Preview" value={selectedMessage.references?.previewHash ?? "None"} icon={<Sparkles className="h-4 w-4" />} />
                        <MetricCard label="Ledger" value={selectedMessage.references?.ledgerSeq != null ? String(selectedMessage.references.ledgerSeq) : "None"} icon={<ClipboardList className="h-4 w-4" />} />
                      </div>

                      {selectedMessage.attachments && selectedMessage.attachments.length > 0 ? (
                        <div className="space-y-2">
                          <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Attachments</div>
                          {selectedMessage.attachments.map((attachment) => (
                            <button
                              key={attachment.id}
                              onClick={() => props.onOpenAttachmentRequested?.(selectedMessage, attachment)}
                              disabled={!props.onOpenAttachmentRequested}
                              className={cx(
                                "flex w-full items-start gap-3 rounded-[1.25rem] border border-zinc-800 bg-zinc-950/50 px-4 py-3 text-left shadow-sm transition hover:bg-zinc-900",
                                !props.onOpenAttachmentRequested && "cursor-not-allowed opacity-40",
                              )}
                            >
                              <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-2 text-zinc-300">
                                <Paperclip className="h-4 w-4" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-semibold text-zinc-100">{attachment.label}</div>
                                <div className="mt-1 truncate text-xs text-zinc-500">{attachment.path ?? "No path"}</div>
                              </div>
                              <ChevronRight className="h-4 w-4 text-zinc-600" />
                            </button>
                          ))}
                        </div>
                      ) : null}

                      <div className="flex flex-wrap gap-2">
                        <ComposerButton label="Run message action" icon={<PlayCircle className="h-4 w-4" />} disabled={!selectedMessage.actionable} onClick={props.onRunMessageActionRequested ? () => props.onRunMessageActionRequested?.(selectedMessage) : undefined} />
                      </div>
                    </div>
                  ) : (
                    <div className="mt-4 rounded-[1.5rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-5 text-sm text-zinc-500">
                      Select a visible message to inspect its intent class, lineage references, and attachments.
                    </div>
                  )}
                </section>

                <section className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-5 shadow-lg">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Composer</div>
                      <div className="mt-1 text-sm text-zinc-400">Drafts stay explicit. Discussion does not silently become execution.</div>
                    </div>
                    {composerLocked ? (
                      <Badge className="border-rose-700/30 bg-rose-500/10 text-rose-300">
                        <Lock className="h-3.5 w-3.5" />
                        locked
                      </Badge>
                    ) : null}
                  </div>

                  <textarea
                    value={localDraft}
                    onChange={(e) => {
                      setLocalDraft(e.target.value);
                      props.onDraftInputChange?.(e.target.value);
                    }}
                    disabled={composerLocked}
                    placeholder="Compose governed operator intent"
                    className={cx(
                      "mt-4 h-32 w-full resize-none rounded-[1.5rem] border border-zinc-800 bg-zinc-950/60 px-4 py-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-600",
                      composerLocked && "cursor-not-allowed opacity-60",
                    )}
                  />

                  {props.composerLockReason ? (
                    <div className="mt-3 rounded-[1.25rem] border border-amber-700/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                      {props.composerLockReason}
                    </div>
                  ) : null}

                  <div className="mt-4 flex flex-wrap gap-2">
                    <ComposerButton label="Send" icon={<Send className="h-4 w-4" />} disabled={composerLocked || !localDraft.trim()} onClick={props.onSendRequested} />
                    {quickActions.map((action) => (
                      <ComposerButton
                        key={action.id}
                        label={action.label}
                        icon={quickActionIcon(action.icon)}
                        tone="secondary"
                        disabled={action.disabled}
                        onClick={action.onInvoke}
                      />
                    ))}
                  </div>
                </section>
              </div>
            </motion.div>
          ) : (
            <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="grid min-h-[18rem] place-items-center rounded-[2rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-8 text-center">
              <div className="max-w-xl">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-[1.5rem] border border-zinc-800 bg-zinc-950/60 text-zinc-400">
                  <MessageSquare className="h-6 w-6" />
                </div>
                <h3 className="mt-6 text-xl font-semibold text-zinc-100">No visible messages</h3>
                <p className="mt-3 text-sm leading-7 text-zinc-500">The current conversation filters produced no visible messages. Relax query, role, attention, or actionable-only filters to continue inspection.</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="border-t border-zinc-800 px-4 py-3 text-xs text-zinc-500">
        <div className="flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-1"><MessageSquare className="h-3.5 w-3.5" /> intent explicit</span>
          <span className="inline-flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5" /> authority visible</span>
          <span className="inline-flex items-center gap-1"><GitBranch className="h-3.5 w-3.5" /> lineage references bound</span>
          <span className="inline-flex items-center gap-1"><PlayCircle className="h-3.5 w-3.5" /> actions separated from talk</span>
        </div>
      </div>
    </section>
  );
}
