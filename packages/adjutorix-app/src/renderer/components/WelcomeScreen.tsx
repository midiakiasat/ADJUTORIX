import React, { useMemo } from "react";
import { motion } from "framer-motion";
import {
  ArrowRight,
  CheckCircle2,
  FolderOpen,
  ShieldCheck,
  History,
  Wrench,
  Bot,
  Search,
  FileCode2,
  Sparkles,
  AlertTriangle,
  Lock,
  Activity,
} from "lucide-react";

/**
 * ADJUTORIX APP — RENDERER / COMPONENTS / WelcomeScreen.tsx
 *
 * Canonical first-run / no-workspace entry surface.
 *
 * Purpose:
 * - provide the authoritative renderer entry experience when no workspace is open
 * - establish the product's governed-execution mental model immediately
 * - surface trust, verification, ledger, diagnostics, and agent concepts without
 *   misleading the user into expecting invisible mutation
 * - provide explicit entry paths into opening a workspace, viewing diagnostics,
 *   reading invariants, and understanding the workflow
 * - remain fully usable as a degraded fallback when the main shell cannot yet
 *   hydrate feature-specific state
 *
 * Architectural role:
 * - WelcomeScreen is not a marketing splash
 * - it is an operational onboarding surface and system-state gateway
 * - it must make explicit what ADJUTORIX does, what it refuses to do, and how
 *   a session begins under trust and verification constraints
 *
 * Hard invariants:
 * - all visible actions must map to explicit callbacks or explicit disabled state
 * - no hidden assumptions about an already-open workspace
 * - invariant messaging must be stable and not contradicted by CTA wording
 * - degraded/system-warning state must be rendered above normal onboarding content
 * - identical props yield identical output structure
 * - no placeholder panels, fake metrics, or decorative nonsense
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type WelcomeHealth = "healthy" | "degraded" | "unhealthy" | "unknown";

export type WelcomeAction = {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
  tone?: "primary" | "secondary" | "danger";
  onClick?: () => void;
};

export type WelcomeInvariant = {
  id: string;
  title: string;
  description: string;
  icon?: React.ComponentType<{ className?: string }>;
};

export type WelcomeQuickLink = {
  id: string;
  title: string;
  description: string;
  icon?: React.ComponentType<{ className?: string }>;
  onClick?: () => void;
  disabled?: boolean;
};

export type WelcomeRecentWorkspace = {
  id: string;
  name: string;
  path: string;
  trustLevel?: "untrusted" | "restricted" | "trusted" | "unknown";
  lastOpenedAtMs?: number | null;
  onClick?: () => void;
  disabled?: boolean;
};

export type WelcomeScreenProps = {
  productName?: string;
  title?: string;
  subtitle?: string;
  health?: WelcomeHealth;
  blockingMessage?: string | null;
  diagnosticsHint?: string | null;
  primaryAction?: WelcomeAction;
  secondaryActions?: WelcomeAction[];
  quickLinks?: WelcomeQuickLink[];
  invariants?: WelcomeInvariant[];
  recentWorkspaces?: WelcomeRecentWorkspace[];
  footerNote?: string | null;
};

// -----------------------------------------------------------------------------
// DEFAULT CONTENT
// -----------------------------------------------------------------------------

const DEFAULT_INVARIANTS: WelcomeInvariant[] = [
  {
    id: "no-invisible-action",
    title: "No invisible action",
    description: "Every material action is explicit, reviewable, and surfaced in the UI before irreversible effects occur.",
    icon: ShieldCheck,
  },
  {
    id: "verify-before-apply",
    title: "Verify before apply",
    description: "Patch application is downstream of preview lineage and verification evidence, not a blind text replacement step.",
    icon: CheckCircle2,
  },
  {
    id: "ledger-backed-history",
    title: "Ledger-backed history",
    description: "State transitions, patch lineage, and replay anchors are preserved as explicit history rather than hidden editor state.",
    icon: History,
  },
  {
    id: "diagnostic-first-failure",
    title: "Failure is inspectable",
    description: "When something degrades, runtime snapshots, logs, crash context, and exportable diagnostics remain available.",
    icon: Wrench,
  },
];

const DEFAULT_QUICK_LINKS: WelcomeQuickLink[] = [
  {
    id: "open-workspace",
    title: "Open workspace posture",
    description: "Workspace opening is guarded; refresh workspace posture first, then bind a trusted folder through the explicit bridge path.",
    icon: FolderOpen,
  },
  {
    id: "review-diagnostics",
    title: "Diagnostics posture",
    description: "Inspect provider status, runtime state, logs, and crash context before governed work.",
    icon: Activity,
  },
  {
    id: "understand-patch-flow",
    title: "Patch review contract",
    description: "Preview lineage, approval state, and verification evidence before apply.",
    icon: FileCode2,
  },
  {
    id: "agent-readiness",
    title: "Agent readiness posture",
    description: "Agent process, auth posture, reconnect state, and failure state remain inspectable before use.",
    icon: Bot,
  },
];

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function formatTime(ts?: number | null): string {
  if (!ts) return "Unknown";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function trustTone(level: WelcomeRecentWorkspace["trustLevel"]): string {
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

function healthTone(health: WelcomeHealth): string {
  switch (health) {
    case "healthy":
      return "border-emerald-700/30 bg-emerald-500/10 text-emerald-200";
    case "degraded":
      return "border-amber-700/30 bg-amber-500/10 text-amber-200";
    case "unhealthy":
      return "border-rose-700/30 bg-rose-500/10 text-rose-200";
    default:
      return "border-zinc-700/30 bg-zinc-500/10 text-zinc-200";
  }
}

function actionTone(tone: WelcomeAction["tone"]): string {
  switch (tone) {
    case "secondary":
      return "border-zinc-800 bg-zinc-900 text-zinc-100 hover:bg-zinc-800";
    case "danger":
      return "border-rose-700/40 bg-rose-500/15 text-rose-200 hover:bg-rose-500/20";
    default:
      return "border-indigo-700/40 bg-indigo-500/15 text-indigo-200 hover:bg-indigo-500/20";
  }
}

function disabledClass(disabled?: boolean): string {
  return disabled ? "cursor-not-allowed opacity-40" : "";
}

// -----------------------------------------------------------------------------
// SUBCOMPONENTS
// -----------------------------------------------------------------------------

function StatusBanner(props: { health: WelcomeHealth; blockingMessage?: string | null; diagnosticsHint?: string | null }): JSX.Element {
  const show = props.health !== "healthy" || !!props.blockingMessage || !!props.diagnosticsHint;
  if (!show) return <></>;

  return (
    <div className={cx("rounded-[2rem] border px-5 py-4 shadow-sm", healthTone(props.health))}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5">
          {props.health === "healthy" ? <CheckCircle2 className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold uppercase tracking-[0.2em]">System posture: {props.health}</div>
          {props.blockingMessage ? <div className="mt-2 text-sm leading-7">{props.blockingMessage}</div> : null}
          {props.diagnosticsHint ? <div className="mt-2 text-sm opacity-90">{props.diagnosticsHint}</div> : null}
        </div>
      </div>
    </div>
  );
}

function ActionButton(props: { action: WelcomeAction }): JSX.Element {
  return (
    <button
      disabled={props.action.disabled || !props.action.onClick}
      onClick={props.action.onClick}
      className={cx(
        "inline-flex items-center gap-2 rounded-2xl border px-5 py-3 text-sm font-semibold transition",
        actionTone(props.action.tone),
        disabledClass(props.action.disabled || !props.action.onClick),
      )}
    >
      <ArrowRight className="h-4 w-4" />
      {props.action.label}
    </button>
  );
}

function InvariantCard(props: { item: WelcomeInvariant }): JSX.Element {
  const Icon = props.item.icon ?? ShieldCheck;
  return (
    <div className="rounded-[2rem] border border-zinc-800 bg-zinc-900/70 p-5 shadow-lg">
      <div className="flex items-start gap-4">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-3">
          <Icon className="h-5 w-5 text-zinc-200" />
        </div>
        <div>
          <div className="text-sm font-semibold text-zinc-50">{props.item.title}</div>
          <div className="mt-2 text-sm leading-7 text-zinc-400">{props.item.description}</div>
        </div>
      </div>
    </div>
  );
}

function QuickLinkCard(props: { item: WelcomeQuickLink }): JSX.Element {
  const Icon = props.item.icon ?? Sparkles;
  return (
    <button
      disabled={props.item.disabled || !props.item.onClick}
      onClick={props.item.onClick}
      className={cx(
        "group rounded-[2rem] border border-zinc-800 bg-zinc-900/70 p-5 text-left shadow-lg transition hover:border-zinc-700 hover:bg-zinc-900",
        disabledClass(props.item.disabled || !props.item.onClick),
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-3">
          <Icon className="h-5 w-5 text-zinc-200" />
        </div>
        <ArrowRight className="h-4 w-4 text-zinc-600 transition group-hover:translate-x-0.5 group-hover:text-zinc-300" />
      </div>
      <div className="mt-5 text-base font-semibold text-zinc-50">{props.item.title}</div>
      <div className="mt-2 text-sm leading-7 text-zinc-400">{props.item.description}</div>
    </button>
  );
}

function WorkspaceCard(props: { item: WelcomeRecentWorkspace }): JSX.Element {
  const trustLevel = props.item.trustLevel ?? "unknown";
  return (
    <button
      disabled={props.item.disabled || !props.item.onClick}
      onClick={props.item.onClick}
      className={cx(
        "w-full rounded-[2rem] border border-zinc-800 bg-zinc-900/70 p-5 text-left shadow-lg transition hover:border-zinc-700 hover:bg-zinc-900",
        disabledClass(props.item.disabled || !props.item.onClick),
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-base font-semibold text-zinc-50">{props.item.name}</div>
          <div className="mt-2 break-all text-sm text-zinc-400">{props.item.path}</div>
        </div>
        <span className={cx("rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.2em]", trustTone(trustLevel))}>
          {trustLevel}
        </span>
      </div>
      <div className="mt-4 flex items-center justify-between gap-4 text-xs text-zinc-500">
        <span>Last opened</span>
        <span>{formatTime(props.item.lastOpenedAtMs)}</span>
      </div>
    </button>
  );
}

function Section(props: { eyebrow: string; title: string; subtitle?: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="rounded-[2rem] border border-zinc-800 bg-zinc-900/60 shadow-xl">
      <div className="border-b border-zinc-800 px-6 py-5">
        <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">{props.eyebrow}</div>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-50">{props.title}</h2>
        {props.subtitle ? <p className="mt-3 max-w-3xl text-sm leading-7 text-zinc-400">{props.subtitle}</p> : null}
      </div>
      <div className="p-6">{props.children}</div>
    </section>
  );
}

// -----------------------------------------------------------------------------
// MAIN COMPONENT
// -----------------------------------------------------------------------------

export default function WelcomeScreen(props: WelcomeScreenProps): JSX.Element {
  const health = props.health ?? "unknown";
  const productName = props.productName ?? "ADJUTORIX";
  const title = props.title ?? "Governed execution begins with an explicit workspace";
  const subtitle =
    props.subtitle ??
    "Open a repository, establish trust posture, inspect system readiness, and move through preview → review → verify → apply without hidden mutation.";

  const invariants = useMemo(() => props.invariants ?? DEFAULT_INVARIANTS, [props.invariants]);
  const quickLinks = useMemo(() => props.quickLinks ?? DEFAULT_QUICK_LINKS, [props.quickLinks]);
  const recentWorkspaces = props.recentWorkspaces ?? [];
  const secondaryActions = props.secondaryActions ?? [];

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-8 px-6 py-8 lg:px-8 xl:py-10">
        <motion.section
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18 }}
          className="rounded-[2.25rem] border border-zinc-800 bg-zinc-900/70 p-8 shadow-2xl"
        >
          <div className="grid gap-8 xl:grid-cols-[1.1fr_0.9fr] xl:items-start">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-950/70 px-4 py-2 text-xs uppercase tracking-[0.24em] text-zinc-400">
                <Lock className="h-3.5 w-3.5" />
                {productName}
              </div>
              <h1 className="mt-6 max-w-4xl text-4xl font-semibold tracking-tight text-zinc-50 sm:text-5xl">{title}</h1>
              <p className="mt-5 max-w-3xl text-base leading-8 text-zinc-400">{subtitle}</p>

              <div className="mt-8 flex flex-wrap gap-3">
                {props.primaryAction ? <ActionButton action={props.primaryAction} /> : null}
                {secondaryActions.map((action) => (
                  <ActionButton key={action.id} action={action} />
                ))}
              </div>

              <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {[
                  { label: "Workspace trust", value: "Explicit", icon: ShieldCheck },
                  { label: "Patch flow", value: "Review-first", icon: FileCode2 },
                  { label: "Verification", value: "Bound lineage", icon: CheckCircle2 },
                  { label: "History", value: "Ledger-backed", icon: History },
                ].map((item) => {
                  const Icon = item.icon;
                  return (
                    <div key={item.label} className="rounded-[1.5rem] border border-zinc-800 bg-zinc-950/60 p-4 shadow-sm">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <div className="text-[10px] uppercase tracking-[0.22em] text-zinc-500">{item.label}</div>
                          <div className="mt-2 text-lg font-semibold text-zinc-100">{item.value}</div>
                        </div>
                        <div className="rounded-2xl border border-zinc-800 bg-black/20 p-2.5">
                          <Icon className="h-4 w-4 text-zinc-300" />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="space-y-5">
              <StatusBanner health={health} blockingMessage={props.blockingMessage} diagnosticsHint={props.diagnosticsHint} />

              <div className="rounded-[2rem] border border-zinc-800 bg-zinc-950/60 p-6 shadow-lg">
                <div className="flex items-center gap-3">
                  <Sparkles className="h-5 w-5 text-zinc-300" />
                  <div className="text-sm font-semibold text-zinc-100">What starts here</div>
                </div>
                <div className="mt-5 space-y-4 text-sm leading-7 text-zinc-400">
                  <div>1. Open a real workspace folder.</div>
                  <div>2. Inspect trust posture, health, and diagnostics.</div>
                  <div>3. Generate a preview rather than mutating files directly.</div>
                  <div>4. Review diffs, bind verification evidence, then decide whether apply is justified.</div>
                </div>
              </div>
            </div>
          </div>
        </motion.section>

        <div className="grid gap-8 xl:grid-cols-[1fr_1fr]">
          <Section
            eyebrow="Operational invariants"
            title="The system refuses ambiguous mutation"
            subtitle="These are not suggestions. They are the product boundary conditions that keep the workflow inspectable and replayable."
          >
            <div className="grid gap-4 md:grid-cols-2">
              {invariants.map((item) => (
                <InvariantCard key={item.id} item={item} />
              ))}
            </div>
          </Section>

          <Section
            eyebrow="Entry paths"
            title="Start from an explicit action"
            subtitle="Every visible entry point must either perform an action, open an explicit surface, or explain why it is unavailable."
          >
            <div className="grid gap-4 md:grid-cols-2">
              {quickLinks.map((item) => (
                <QuickLinkCard key={item.id} item={item} />
              ))}
            </div>
          </Section>
        </div>

        <Section
          eyebrow="Recent workspaces"
          title="Re-enter with explicit trust context"
          subtitle="A recent workspace is not assumed safe. Trust posture remains visible at the point of entry."
        >
          {recentWorkspaces.length > 0 ? (
            <div className="grid gap-4 xl:grid-cols-2">
              {recentWorkspaces.map((workspace) => (
                <WorkspaceCard key={workspace.id} item={workspace} />
              ))}
            </div>
          ) : (
            <div className="rounded-[2rem] border border-dashed border-zinc-800 bg-zinc-950/40 p-6 text-sm leading-7 text-zinc-500">
              No recent workspaces are available yet. Open a repository or project folder to establish a governed session.
            </div>
          )}
        </Section>

        <div className="rounded-[2rem] border border-zinc-800 bg-zinc-900/50 px-6 py-5 text-sm leading-7 text-zinc-400 shadow-lg">
          <div className="flex flex-wrap items-center gap-3 text-zinc-300">
            <Search className="h-4 w-4" />
            <span className="font-medium">Session rule:</span>
            <span>No invisible action. No unverifiable claim. No irreversible mutation without explicit lineage and evidence.</span>
          </div>
          {props.footerNote ? <div className="mt-3 text-zinc-500">{props.footerNote}</div> : null}
        </div>
      </div>
    </div>
  );
}
