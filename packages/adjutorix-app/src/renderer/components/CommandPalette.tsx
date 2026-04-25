import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, ArrowRight, Bot, CheckCircle2, ChevronRight, Command, FileCode2, Filter, FolderTree, GitBranch, Hammer, Layers3, Loader2, PlayCircle, Search, ShieldAlert, ShieldCheck, ShieldX, Sparkles, TerminalSquare, Wrench, XCircle } from "lucide-react";

/**
 * ADJUTORIX APP — RENDERER / COMPONENTS / CommandPalette.tsx
 *
 * Canonical governed command palette.
 *
 * Purpose:
 * - provide the authoritative renderer-side command launcher for navigation, review,
 *   verification, execution, diagnostics, workspace, and system actions
 * - unify command discovery, category structure, authority posture, consequence visibility,
 *   scope targeting, search/ranking, and keyboard navigation under one deterministic component
 * - prevent the command palette from degenerating into a fuzzy action list where destructive,
 *   irreversible, or high-authority commands appear equivalent to harmless navigation
 * - expose explicit operator intent upward without performing hidden execution locally
 *
 * Architectural role:
 * - CommandPalette is an infrastructure control surface shared across the renderer
 * - it does not own command truth; it renders externally supplied command registry/state
 * - it should remain useful for novice browsing, expert keyboard dispatch, degraded mode,
 *   and authority-restricted sessions
 * - it must distinguish discovery from execution and low-risk from high-risk actions
 *
 * Hard invariants:
 * - command ordering is deterministic after explicit search and ranking rules only
 * - command scope, risk, authority, and readiness are visible before invocation
 * - disabled commands remain visible when useful, with explicit reason
 * - keyboard selection and mouse selection resolve to the same command identity
 * - identical props and local query state yield identical visible ordering
 * - no placeholders, fake commands, or hidden dispatch side effects
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type CommandPaletteHealth = "healthy" | "degraded" | "unhealthy" | "unknown";
export type CommandPaletteTrustLevel = "unknown" | "untrusted" | "restricted" | "trusted";
export type CommandRisk = "safe" | "guarded" | "destructive";
export type CommandScope = "global" | "workspace" | "editor" | "selection" | "patch" | "verify" | "job" | "chat";
export type CommandCategory =
  | "navigation"
  | "workspace"
  | "editor"
  | "patch"
  | "verify"
  | "terminal"
  | "diagnostics"
  | "ledger"
  | "chat"
  | "system";

export type CommandPaletteItem = {
  id: string;
  title: string;
  subtitle?: string | null;
  category: CommandCategory;
  scope: CommandScope;
  risk?: CommandRisk;
  trustLevel?: CommandPaletteTrustLevel;
  enabled: boolean;
  enabledReason?: string | null;
  authorityLabel?: string | null;
  keywords?: string[];
  shortcutHint?: string | null;
  lineageHint?: string | null;
  icon?:
    | "search"
    | "file"
    | "folder"
    | "patch"
    | "verify"
    | "terminal"
    | "diagnostics"
    | "ledger"
    | "chat"
    | "system"
    | "run"
    | "bot";

  shortcutLabel?: string;
};

export type CommandPaletteMetric = {
  id: string;
  label: string;
  value: string;
  tone?: "neutral" | "good" | "warn" | "bad";
};

export type CommandPaletteProps = {
  title?: string;
  subtitle?: string;
  health?: CommandPaletteHealth;
  trustLevel?: CommandPaletteTrustLevel;
  loading?: boolean;
  isOpen: boolean;
  query?: string;
  commands: CommandPaletteItem[];
  selectedCommandId?: string | null;
  selectedCategory?: CommandCategory | "all";
  metrics?: CommandPaletteMetric[];
  onQueryChange?: (query: string) => void;
  onSelectCommand?: (command: CommandPaletteItem) => void;
  onRunCommand?: (command: CommandPaletteItem) => void;
  onClose?: () => void;
  onSelectedCategoryChange?: (category: CommandCategory | "all") => void;
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function healthTone(level: CommandPaletteHealth | undefined): string {
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

function trustTone(level: CommandPaletteTrustLevel | undefined): string {
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

function trustIcon(level: CommandPaletteTrustLevel | undefined): JSX.Element {
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

function riskTone(risk: CommandRisk | undefined): string {
  switch (risk) {
    case "destructive":
      return "border-rose-700/30 bg-rose-500/10 text-rose-300";
    case "guarded":
      return "border-amber-700/30 bg-amber-500/10 text-amber-300";
    default:
      return "border-emerald-700/30 bg-emerald-500/10 text-emerald-300";
  }
}

function metricTone(tone?: CommandPaletteMetric["tone"]): string {
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

function categoryLabel(category: CommandCategory | "all"): string {
  if (category === "all") return "All";
  return category.replace(/-/g, " ");
}

function categoryIcon(category: CommandCategory): JSX.Element {
  switch (category) {
    case "navigation":
      return <Search className="h-4 w-4" />;
    case "workspace":
      return <FolderTree className="h-4 w-4" />;
    case "editor":
      return <FileCode2 className="h-4 w-4" />;
    case "patch":
      return <GitBranch className="h-4 w-4" />;
    case "verify":
      return <ShieldCheck className="h-4 w-4" />;
    case "terminal":
      return <TerminalSquare className="h-4 w-4" />;
    case "diagnostics":
      return <Wrench className="h-4 w-4" />;
    case "ledger":
      return <Layers3 className="h-4 w-4" />;
    case "chat":
      return <Bot className="h-4 w-4" />;
    default:
      return <Command className="h-4 w-4" />;
  }
}

function itemIcon(icon: CommandPaletteItem["icon"], category: CommandCategory): JSX.Element {
  switch (icon) {
    case "search":
      return <Search className="h-4 w-4" />;
    case "file":
      return <FileCode2 className="h-4 w-4" />;
    case "folder":
      return <FolderTree className="h-4 w-4" />;
    case "patch":
      return <GitBranch className="h-4 w-4" />;
    case "verify":
      return <ShieldCheck className="h-4 w-4" />;
    case "terminal":
      return <TerminalSquare className="h-4 w-4" />;
    case "diagnostics":
      return <Wrench className="h-4 w-4" />;
    case "ledger":
      return <Layers3 className="h-4 w-4" />;
    case "chat":
      return <Bot className="h-4 w-4" />;
    case "system":
      return <Hammer className="h-4 w-4" />;
    case "run":
      return <PlayCircle className="h-4 w-4" />;
    case "bot":
      return <Sparkles className="h-4 w-4" />;
    default:
      return categoryIcon(category);
  }
}

function scopeTone(scope: CommandScope): string {
  switch (scope) {
    case "global":
      return "border-zinc-700/30 bg-zinc-500/10 text-zinc-300";
    case "workspace":
      return "border-sky-700/30 bg-sky-500/10 text-sky-300";
    case "editor":
      return "border-indigo-700/30 bg-indigo-500/10 text-indigo-300";
    case "patch":
      return "border-violet-700/30 bg-violet-500/10 text-violet-300";
    case "verify":
      return "border-emerald-700/30 bg-emerald-500/10 text-emerald-300";
    case "selection":
    case "job":
    case "chat":
      return "border-amber-700/30 bg-amber-500/10 text-amber-300";
    default:
      return "border-zinc-700/30 bg-zinc-500/10 text-zinc-300";
  }
}

function scoreCommand(command: CommandPaletteItem, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;

  const title = command.title.toLowerCase();
  const subtitle = (command.subtitle ?? "").toLowerCase();
  const keywords = (command.keywords ?? []).join(" ").toLowerCase();

  let score = 0;
  if (title === q) score += 100;
  if (title.startsWith(q)) score += 60;
  if (title.includes(q)) score += 35;
  if (subtitle.includes(q)) score += 15;
  if (keywords.includes(q)) score += 25;
  if (!command.enabled) score -= 5;
  if (command.risk === "destructive") score -= 3;
  return score;
}

// -----------------------------------------------------------------------------
// MAIN COMPONENT
// -----------------------------------------------------------------------------

export default function CommandPalette(props: CommandPaletteProps): JSX.Element | null {
  const title = props.title ?? "Command palette";
  const subtitle =
    props.subtitle ??
    "Governed intent launcher with explicit category, scope, authority, readiness, and consequence posture before invocation.";

  const health = props.health ?? "unknown";
  const trustLevel = props.trustLevel ?? "unknown";
  const loading = props.loading ?? false;
  const [localQuery, setLocalQuery] = useState(props.query ?? "");
  const [localCategory, setLocalCategory] = useState<CommandCategory | "all">(props.selectedCategory ?? "all");
  const [highlightIndex, setHighlightIndex] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setLocalQuery(props.query ?? "");
  }, [props.query]);

  useEffect(() => {
    setLocalCategory(props.selectedCategory ?? "all");
  }, [props.selectedCategory]);

  const visibleCommands = useMemo(() => {
    const q = localQuery.trim();
    const ranked = props.commands
      .filter((command) => (localCategory === "all" ? true : command.category === localCategory))
      .filter((command) => {
        if (!q) return true;
        const haystack = [
          command.title,
          command.subtitle ?? "",
          command.category,
          command.scope,
          ...(command.keywords ?? []),
          command.authorityLabel ?? "",
          command.lineageHint ?? "",
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(q.toLowerCase());
      })
      .map((command) => ({ command, score: scoreCommand(command, q) }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.command.enabled !== b.command.enabled) return a.command.enabled ? -1 : 1;
        if (a.command.risk !== b.command.risk) {
          const riskRank = { safe: 0, guarded: 1, destructive: 2 };
          return riskRank[a.command.risk ?? "safe"] - riskRank[b.command.risk ?? "safe"];
        }
        return a.command.title.localeCompare(b.command.title);
      })
      .map((item) => item.command);

    return ranked;
  }, [localCategory, localQuery, props.commands]);

  useEffect(() => {
    setHighlightIndex((prev) => {
      if (visibleCommands.length === 0) return 0;
      return Math.max(0, Math.min(prev, visibleCommands.length - 1));
    });
  }, [visibleCommands.length]);

  const highlighted = visibleCommands[highlightIndex] ?? null;
  const selected = props.selectedCommandId ? visibleCommands.find((command) => command.id === props.selectedCommandId) ?? highlighted : highlighted;

  const metrics = props.metrics ?? [
    { id: "visible", label: "Visible commands", value: String(visibleCommands.length) },
    { id: "enabled", label: "Enabled", value: String(props.commands.filter((c) => c.enabled).length), tone: props.commands.some((c) => c.enabled) ? "good" : "neutral" },
    { id: "guarded", label: "Guarded", value: String(props.commands.filter((c) => c.risk === "guarded").length), tone: props.commands.some((c) => c.risk === "guarded") ? "warn" : "neutral" },
    { id: "destructive", label: "Destructive", value: String(props.commands.filter((c) => c.risk === "destructive").length), tone: props.commands.some((c) => c.risk === "destructive") ? "bad" : "neutral" },
  ];

  const categories: Array<CommandCategory | "all"> = [
    "all",
    "navigation",
    "workspace",
    "editor",
    "patch",
    "verify",
    "terminal",
    "diagnostics",
    "ledger",
    "chat",
    "system",
  ];

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!props.isOpen) return;

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightIndex((prev) => Math.min(prev + 1, Math.max(visibleCommands.length - 1, 0)));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightIndex((prev) => Math.max(prev - 1, 0));
      } else if (event.key === "Enter") {
        if (highlighted && highlighted.enabled) {
          event.preventDefault();
          props.onRunCommand?.(highlighted);
        }
      } else if (event.key === "Escape") {
        event.preventDefault();
        props.onClose?.();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [highlighted, props, visibleCommands.length]);

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLButtonElement>(`[data-index="${highlightIndex}"]`);
    if (typeof node?.scrollIntoView === "function") {
      node.scrollIntoView({ block: "nearest" });
    }
  }, [highlightIndex]);

  if (!props.isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-6 backdrop-blur-md">
      <motion.section
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.98 }}
        transition={{ duration: 0.14 }}
        className="flex h-[88vh] w-full max-w-7xl flex-col overflow-hidden rounded-[2rem] border border-zinc-800 bg-zinc-900/95 shadow-2xl"
      >
        <div className="border-b border-zinc-800 px-5 py-4">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Intent launcher</div>
              <h2 className="mt-1 text-lg font-semibold text-zinc-50">{title}</h2>
              <p className="mt-2 text-sm leading-7 text-zinc-400">{subtitle}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className={cx("inline-flex items-center gap-1 rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.2em]", healthTone(health))}>
                <ShieldCheck className="h-3.5 w-3.5" />
                {health}
              </span>
              <span className={cx("inline-flex items-center gap-1 rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.2em]", trustTone(trustLevel))}>
                {trustIcon(trustLevel)}
                {trustLevel}
              </span>
              <button
                onClick={props.onClose}
                className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-900"
              >
                Close
              </button>
            </div>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {metrics.map((metric) => (
              <div key={metric.id} className={cx("rounded-[1.5rem] border p-4 shadow-sm", metricTone(metric.tone))}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.2em] opacity-70">{metric.label}</div>
                    <div className="mt-2 text-lg font-semibold tracking-tight">{metric.value}</div>
                  </div>
                  <div className="rounded-xl border border-zinc-800 bg-black/20 p-2.5 text-zinc-300">
                    {metric.id === "enabled" ? <CheckCircle2 className="h-4 w-4" /> : metric.id === "guarded" ? <AlertTriangle className="h-4 w-4" /> : metric.id === "destructive" ? <XCircle className="h-4 w-4" /> : <Command className="h-4 w-4" />}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 flex items-center gap-2 rounded-[1.5rem] border border-zinc-800 bg-zinc-950/70 px-4 py-3">
            <Search className="h-4 w-4 text-zinc-500" />
            <input
              autoFocus
              value={localQuery}
              onChange={(e) => {
                setLocalQuery(e.target.value);
                props.onQueryChange?.(e.target.value);
                setHighlightIndex(0);
              }}
              placeholder="Search governed commands"
              className="w-full bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
            />
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {categories.map((category) => {
              const active = localCategory === category;
              return (
                <button
                  key={category}
                  onClick={() => {
                    setLocalCategory(category);
                    props.onSelectedCategoryChange?.(category);
                    setHighlightIndex(0);
                  }}
                  className={cx(
                    "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition",
                    active
                      ? "border-indigo-700/30 bg-indigo-500/10 text-indigo-200"
                      : "border-zinc-800 bg-zinc-950/60 text-zinc-300 hover:bg-zinc-900",
                  )}
                >
                  {category === "all" ? <Filter className="h-3.5 w-3.5" /> : categoryIcon(category)}
                  {categoryLabel(category)}
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid min-h-0 flex-1 gap-0 xl:grid-cols-[0.95fr_1.05fr]">
          <div ref={listRef} className="min-h-0 overflow-auto border-r border-zinc-800 px-4 py-4">
            <AnimatePresence mode="popLayout">
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
                    Hydrating command registry…
                  </div>
                </motion.div>
              ) : visibleCommands.length > 0 ? (
                <div className="space-y-2">
                  {visibleCommands.map((command, index) => {
                    const highlightedRow = index === highlightIndex;
                    const selectedRow = selected?.id === command.id;
                    return (
                      <button
                        key={command.id}
                        data-index={index}
                        onMouseEnter={() => setHighlightIndex(index)}
                        onClick={() => {
                          setHighlightIndex(index);
                          props.onSelectCommand?.(command);
                        }}
                        className={cx(
                          "flex w-full items-start gap-3 rounded-[1.5rem] border px-4 py-4 text-left shadow-sm transition",
                          highlightedRow || selectedRow
                            ? "border-zinc-600 bg-zinc-800 text-zinc-50"
                            : "border-zinc-800 bg-zinc-950/50 text-zinc-200 hover:bg-zinc-900",
                          !command.enabled && "opacity-70",
                        )}
                      >
                        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-2 text-zinc-300">{itemIcon(command.icon, command.category)}</div>
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-semibold">{command.title}</span>
                            {command.shortcutLabel ? (
                      <span className="rounded-full border border-zinc-700/30 bg-zinc-500/10 px-2 py-0.5 text-[10px] font-medium tracking-[0.2em] text-zinc-300">
                        {command.shortcutLabel}
                      </span>
                    ) : null}
                    <span className={cx("rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.2em]", scopeTone(command.scope))}>{command.scope}</span>
                            <span className={cx("rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.2em]", riskTone(command.risk))}>{command.risk ?? "safe"}</span>
                            {!command.enabled ? <span className="rounded-full border border-zinc-700/30 bg-zinc-500/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] text-zinc-400">disabled</span> : null}
                          </div>
                          {command.subtitle ? <div className="mt-2 text-sm text-zinc-400">{command.subtitle}</div> : null}
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                            <span>{command.category}</span>
                            {command.shortcutHint ? <span>{command.shortcutHint}</span> : null}
                            {command.authorityLabel ? <span>{command.authorityLabel}</span> : null}
                            {command.lineageHint ? <span>{command.lineageHint}</span> : null}
                          </div>
                        </div>
                        <ChevronRight className="h-4 w-4 text-zinc-600" />
                      </button>
                    );
                  })}
                </div>
              ) : (
                <motion.div
                  key="empty"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="grid min-h-[18rem] place-items-center rounded-[2rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-8 text-center"
                >
                  <div className="max-w-xl">
                    <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-[1.5rem] border border-zinc-800 bg-zinc-950/60 text-zinc-400">
                      <Command className="h-6 w-6" />
                    </div>
                    <h3 className="mt-6 text-xl font-semibold text-zinc-100">No visible commands</h3>
                    <p className="mt-3 text-sm leading-7 text-zinc-500">The current search and category constraints produced no visible commands.</p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="min-h-0 overflow-auto px-5 py-5">
            {selected ? (
              <div className="space-y-5">
                <section className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-5 shadow-lg">
                  <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Selected command</div>
                  <div className="mt-4 space-y-4">
                    <div>
                      <div className="text-lg font-semibold text-zinc-50">{selected.title}</div>
                      {selected.subtitle ? <div className="mt-2 text-sm leading-7 text-zinc-400">{selected.subtitle}</div> : null}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cx("inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.2em]", roleSafeTone(selected.category))}>
                        {categoryIcon(selected.category)}
                        {selected.category}
                      </span>
                      <span className={cx("inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.2em]", scopeTone(selected.scope))}>
                        <ArrowRight className="h-3.5 w-3.5" />
                        {selected.scope}
                      </span>
                      <span className={cx("inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.2em]", riskTone(selected.risk))}>
                        <AlertTriangle className="h-3.5 w-3.5" />
                        {selected.risk ?? "safe"}
                      </span>
                      <span className={cx("inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.2em]", trustTone(selected.trustLevel))}>
                        {trustIcon(selected.trustLevel)}
                        {selected.trustLevel ?? "unknown"}
                      </span>
                      {!selected.enabled ? <span className="inline-flex items-center gap-1 rounded-full border border-zinc-700/30 bg-zinc-500/10 px-2.5 py-1 text-[10px] uppercase tracking-[0.2em] text-zinc-400">disabled</span> : null}
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="rounded-[1.5rem] border border-zinc-800 bg-zinc-950/50 p-4 shadow-sm">
                        <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Authority</div>
                        <div className="mt-2 text-sm font-semibold text-zinc-100">{selected.authorityLabel ?? "Standard renderer authority"}</div>
                      </div>
                      <div className="rounded-[1.5rem] border border-zinc-800 bg-zinc-950/50 p-4 shadow-sm">
                        <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Shortcut</div>
                        <div className="mt-2 text-sm font-semibold text-zinc-100">{selected.shortcutHint ?? "None"}</div>
                      </div>
                      <div className="rounded-[1.5rem] border border-zinc-800 bg-zinc-950/50 p-4 shadow-sm sm:col-span-2">
                        <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Lineage / scope hint</div>
                        <div className="mt-2 text-sm font-semibold text-zinc-100">{selected.lineageHint ?? "No lineage requirement declared"}</div>
                      </div>
                    </div>

                    {!selected.enabled && selected.enabledReason ? (
                      <div className="rounded-[1.25rem] border border-amber-700/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                        {selected.enabledReason}
                      </div>
                    ) : null}

                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => props.onRunCommand?.(selected)}
                        disabled={!selected.enabled || !props.onRunCommand}
                        className={cx(
                          "inline-flex items-center gap-2 rounded-2xl border px-4 py-2 text-sm font-medium transition",
                          selected.enabled && props.onRunCommand
                            ? "border-indigo-700/40 bg-indigo-500/15 text-indigo-200 hover:bg-indigo-500/20"
                            : "cursor-not-allowed border-zinc-800 bg-zinc-950/60 text-zinc-500",
                        )}
                      >
                        <PlayCircle className="h-4 w-4" />
                        Run command
                      </button>
                    </div>
                  </div>
                </section>

                <section className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-5 shadow-lg">
                  <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Keyboard controls</div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-[1.5rem] border border-zinc-800 bg-zinc-950/50 p-4 shadow-sm">
                      <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Navigate</div>
                      <div className="mt-2 text-sm font-semibold text-zinc-100">↑ / ↓</div>
                    </div>
                    <div className="rounded-[1.5rem] border border-zinc-800 bg-zinc-950/50 p-4 shadow-sm">
                      <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Run</div>
                      <div className="mt-2 text-sm font-semibold text-zinc-100">Enter</div>
                    </div>
                    <div className="rounded-[1.5rem] border border-zinc-800 bg-zinc-950/50 p-4 shadow-sm sm:col-span-2">
                      <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Close</div>
                      <div className="mt-2 text-sm font-semibold text-zinc-100">Escape</div>
                    </div>
                  </div>
                </section>
              </div>
            ) : (
              <div className="grid min-h-[24rem] place-items-center rounded-[2rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-8 text-center">
                <div className="max-w-xl">
                  <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-[1.5rem] border border-zinc-800 bg-zinc-950/60 text-zinc-400">
                    <Command className="h-6 w-6" />
                  </div>
                  <h3 className="mt-6 text-xl font-semibold text-zinc-100">No command selected</h3>
                  <p className="mt-3 text-sm leading-7 text-zinc-500">Choose a visible command to inspect its scope, authority, and execution posture.</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </motion.section>
    </div>
  );
}

function roleSafeTone(category: CommandCategory): string {
  switch (category) {
    case "patch":
      return "border-violet-700/30 bg-violet-500/10 text-violet-300";
    case "verify":
      return "border-emerald-700/30 bg-emerald-500/10 text-emerald-300";
    case "terminal":
      return "border-amber-700/30 bg-amber-500/10 text-amber-300";
    case "diagnostics":
      return "border-sky-700/30 bg-sky-500/10 text-sky-300";
    case "system":
      return "border-rose-700/30 bg-rose-500/10 text-rose-300";
    default:
      return "border-zinc-700/30 bg-zinc-500/10 text-zinc-300";
  }
}
