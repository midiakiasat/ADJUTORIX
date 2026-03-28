import React, { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Command,
  Bell,
  Search,
  ShieldCheck,
  Activity,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Monitor,
  Wrench,
  FileCode2,
  FolderTree,
  History,
  Bot,
  LayoutGrid,
  ChevronRight,
} from "lucide-react";

/**
 * ADJUTORIX APP — RENDERER / COMPONENTS / AppShell.tsx
 *
 * Canonical renderer application shell component.
 *
 * Purpose:
 * - provide the single structural frame for the product UI
 * - own responsive region layout, shell chrome, pane choreography, and global
 *   interaction boundaries
 * - separate application frame concerns from feature-specific panel rendering
 * - keep left navigation, header, content well, right insights rail, bottom strip,
 *   overlays, toasts, and modal layers under one deterministic component contract
 * - provide a hardened host surface for workspace/patch/verify/ledger/agent/diagnostics
 *   panels without those panels needing to know shell geometry rules
 *
 * Architectural role:
 * - AppShell is the visual operating surface of the renderer
 * - it should be dumb about business logic but strict about surface composition
 * - it accepts precomputed state and render slots rather than reaching into globals
 *
 * Hard invariants:
 * - only one primary content region is mounted at a time
 * - shell chrome remains renderable even under degraded/failure state
 * - modal and overlay layers always render above panes and below toasts in stable order
 * - left/right/bottom regions collapse predictably and never destroy the center well
 * - visual status is derived from explicit props, never inferred from child content
 * - outputs remain deterministic for identical props
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type AppShellHealth = "healthy" | "degraded" | "unhealthy" | "unknown";
export type AppShellView =
  | "overview"
  | "workspace"
  | "patch"
  | "verify"
  | "ledger"
  | "agent"
  | "diagnostics"
  | "activity";

export type AppShellToastLevel = "info" | "warn" | "error" | "success";

export type AppShellToast = {
  id: string;
  level: AppShellToastLevel;
  title: string;
  message: string;
  createdAtMs: number;
};

export type AppShellBanner = {
  id: string;
  level: "info" | "warn" | "error" | "success";
  title: string;
  message: string;
  sticky?: boolean;
};

export type AppShellNavItem = {
  key: AppShellView;
  label: string;
  badge?: string | number | null;
  active?: boolean;
  disabled?: boolean;
};

export type AppShellStatusChip = {
  label: string;
  value: string;
  tone?: "neutral" | "good" | "warn" | "bad";
};

export type AppShellProps = {
  appTitle?: string;
  subtitle?: string;
  health: AppShellHealth;
  currentView: AppShellView;
  loading?: boolean;
  commandPaletteOpen?: boolean;
  leftRailCollapsed?: boolean;
  rightRailCollapsed?: boolean;
  bottomPanelVisible?: boolean;
  statusChips?: AppShellStatusChip[];
  navItems?: AppShellNavItem[];
  banners?: AppShellBanner[];
  toasts?: AppShellToast[];
  onSelectView?: (view: AppShellView) => void;
  onToggleLeftRail?: () => void;
  onToggleRightRail?: () => void;
  onToggleCommandPalette?: () => void;
  onDismissToast?: (id: string) => void;
  headerActions?: React.ReactNode;
  commandBar?: React.ReactNode;
  leftRail?: React.ReactNode;
  primaryContent?: React.ReactNode;
  rightRail?: React.ReactNode;
  bottomPanel?: React.ReactNode;
  modalLayer?: React.ReactNode;
  overlayLayer?: React.ReactNode;
  footer?: React.ReactNode;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const DEFAULT_NAV: AppShellNavItem[] = [
  { key: "overview", label: "Overview" },
  { key: "workspace", label: "Workspace" },
  { key: "patch", label: "Patch" },
  { key: "verify", label: "Verify" },
  { key: "ledger", label: "Ledger" },
  { key: "agent", label: "Agent" },
  { key: "diagnostics", label: "Diagnostics" },
  { key: "activity", label: "Activity" },
];

const VIEW_META: Record<AppShellView, { icon: React.ComponentType<{ className?: string }> }> = {
  overview: { icon: LayoutGrid },
  workspace: { icon: FolderTree },
  patch: { icon: FileCode2 },
  verify: { icon: ShieldCheck },
  ledger: { icon: History },
  agent: { icon: Bot },
  diagnostics: { icon: Wrench },
  activity: { icon: Activity },
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return String(ts);
  }
}

function healthTone(health: AppShellHealth): string {
  switch (health) {
    case "healthy":
      return "border-emerald-700/40 bg-emerald-500/10 text-emerald-300";
    case "degraded":
      return "border-amber-700/40 bg-amber-500/10 text-amber-300";
    case "unhealthy":
      return "border-rose-700/40 bg-rose-500/10 text-rose-300";
    default:
      return "border-zinc-700/40 bg-zinc-500/10 text-zinc-300";
  }
}

function toneChip(tone: AppShellStatusChip["tone"]): string {
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

function bannerTone(level: AppShellBanner["level"]): string {
  switch (level) {
    case "success":
      return "border-emerald-700/30 bg-emerald-500/10 text-emerald-200";
    case "warn":
      return "border-amber-700/30 bg-amber-500/10 text-amber-200";
    case "error":
      return "border-rose-700/30 bg-rose-500/10 text-rose-200";
    default:
      return "border-sky-700/30 bg-sky-500/10 text-sky-200";
  }
}

function toastIcon(level: AppShellToastLevel): JSX.Element {
  switch (level) {
    case "success":
      return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
    case "warn":
      return <AlertTriangle className="h-4 w-4 text-amber-400" />;
    case "error":
      return <AlertTriangle className="h-4 w-4 text-rose-400" />;
    default:
      return <Bell className="h-4 w-4 text-zinc-300" />;
  }
}

// -----------------------------------------------------------------------------
// SUBCOMPONENTS
// -----------------------------------------------------------------------------

function HealthBadge(props: { health: AppShellHealth }): JSX.Element {
  return (
    <span className={cx("rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em]", healthTone(props.health))}>
      {props.health}
    </span>
  );
}

function StatusChipRow(props: { chips: AppShellStatusChip[] }): JSX.Element | null {
  if (props.chips.length === 0) return null;
  return (
    <div className="mt-5 flex flex-wrap gap-3">
      {props.chips.map((chip) => (
        <div key={`${chip.label}:${chip.value}`} className={cx("rounded-2xl border px-4 py-3 shadow-sm", toneChip(chip.tone))}>
          <div className="text-[10px] uppercase tracking-[0.2em] opacity-70">{chip.label}</div>
          <div className="mt-1 text-sm font-medium">{chip.value}</div>
        </div>
      ))}
    </div>
  );
}

function BannerStack(props: { banners: AppShellBanner[] }): JSX.Element | null {
  if (props.banners.length === 0) return null;
  return (
    <div className="space-y-3 px-6 pt-4 lg:px-8">
      {props.banners.map((banner) => (
        <div key={banner.id} className={cx("rounded-2xl border px-4 py-3 shadow-sm", bannerTone(banner.level))}>
          <div className="flex items-start gap-3">
            <div className="pt-0.5">
              {banner.level === "success" ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : banner.level === "error" || banner.level === "warn" ? (
                <AlertTriangle className="h-4 w-4" />
              ) : (
                <Monitor className="h-4 w-4" />
              )}
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold">{banner.title}</div>
              <div className="mt-1 text-sm opacity-90">{banner.message}</div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ShellNav(props: {
  collapsed: boolean;
  currentView: AppShellView;
  items: AppShellNavItem[];
  onSelectView?: (view: AppShellView) => void;
  leftRail?: React.ReactNode;
}): JSX.Element {
  return (
    <aside className={cx("border-r border-zinc-800 bg-zinc-950/70 transition-all duration-200", props.collapsed ? "w-20" : "w-80")}>
      <div className="flex h-full flex-col">
        <div className="border-b border-zinc-800 px-3 py-3">
          <div className="space-y-2">
            {props.items.map((item) => {
              const Icon = VIEW_META[item.key].icon;
              const active = item.active ?? props.currentView === item.key;
              return (
                <button
                  key={item.key}
                  disabled={item.disabled}
                  onClick={() => props.onSelectView?.(item.key)}
                  className={cx(
                    "flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition",
                    active
                      ? "border-zinc-600 bg-zinc-800 text-zinc-50"
                      : "border-transparent text-zinc-400 hover:border-zinc-800 hover:bg-zinc-900 hover:text-zinc-100",
                    item.disabled && "cursor-not-allowed opacity-40",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {!props.collapsed && (
                    <>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.label}</span>
                      {item.badge !== undefined && item.badge !== null && (
                        <span className="rounded-full border border-zinc-700 bg-zinc-950/70 px-2 py-0.5 text-[10px] text-zinc-300">
                          {item.badge}
                        </span>
                      )}
                    </>
                  )}
                </button>
              );
            })}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{props.leftRail}</div>
      </div>
    </aside>
  );
}

function HeaderBar(props: {
  appTitle: string;
  subtitle: string;
  health: AppShellHealth;
  loading: boolean;
  commandPaletteOpen: boolean;
  leftRailCollapsed: boolean;
  rightRailCollapsed: boolean;
  statusChips: AppShellStatusChip[];
  onToggleLeftRail?: () => void;
  onToggleRightRail?: () => void;
  onToggleCommandPalette?: () => void;
  headerActions?: React.ReactNode;
  commandBar?: React.ReactNode;
}): JSX.Element {
  return (
    <header className="border-b border-zinc-800 bg-zinc-950/80 px-6 py-5 backdrop-blur lg:px-8">
      <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <button
              onClick={props.onToggleLeftRail}
              className="rounded-2xl border border-zinc-800 bg-zinc-900 p-2.5 text-zinc-200 hover:bg-zinc-800"
            >
              {props.leftRailCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </button>
            <button
              onClick={props.onToggleRightRail}
              className="rounded-2xl border border-zinc-800 bg-zinc-900 p-2.5 text-zinc-200 hover:bg-zinc-800"
            >
              {props.rightRailCollapsed ? <PanelRightOpen className="h-4 w-4" /> : <PanelRightClose className="h-4 w-4" />}
            </button>
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-[0.24em] text-zinc-500">Adjutorix</div>
              <h1 className="mt-1 truncate text-3xl font-semibold tracking-tight text-zinc-50">{props.appTitle}</h1>
              <p className="mt-2 max-w-3xl text-sm leading-7 text-zinc-400">{props.subtitle}</p>
            </div>
          </div>
          <StatusChipRow chips={props.statusChips} />
        </div>
        <div className="flex shrink-0 flex-col gap-3 xl:items-end">
          <div className="flex flex-wrap items-center gap-3">
            <HealthBadge health={props.health} />
            <button
              onClick={props.onToggleCommandPalette}
              className={cx(
                "inline-flex items-center gap-2 rounded-2xl border px-4 py-2 text-sm font-medium transition",
                props.commandPaletteOpen
                  ? "border-indigo-700/40 bg-indigo-500/15 text-indigo-200"
                  : "border-zinc-800 bg-zinc-900 text-zinc-100 hover:bg-zinc-800",
              )}
            >
              <Command className="h-4 w-4" />
              Commands
            </button>
            <button className="inline-flex items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-800">
              {props.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              {props.loading ? "Refreshing" : "Search"}
            </button>
            {props.headerActions}
          </div>
          {props.commandBar ? <div className="w-full xl:max-w-3xl">{props.commandBar}</div> : null}
        </div>
      </div>
    </header>
  );
}

function RightRailFrame(props: { collapsed: boolean; rightRail?: React.ReactNode }): JSX.Element {
  return (
    <aside className={cx("border-l border-zinc-800 bg-zinc-950/70 transition-all duration-200", props.collapsed ? "w-0 overflow-hidden" : "w-[30rem]")}>
      {!props.collapsed && <div className="h-full overflow-auto">{props.rightRail}</div>}
    </aside>
  );
}

function BottomPanelFrame(props: { visible: boolean; bottomPanel?: React.ReactNode }): JSX.Element {
  return (
    <AnimatePresence initial={false}>
      {props.visible && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 240, opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="border-t border-zinc-800 bg-zinc-950/80"
        >
          <div className="h-full overflow-auto">{props.bottomPanel}</div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function ToastViewport(props: { toasts: AppShellToast[]; onDismissToast?: (id: string) => void }): JSX.Element {
  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[70] flex max-w-md flex-col gap-3">
      <AnimatePresence>
        {props.toasts.map((toast) => (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.16 }}
            className="pointer-events-auto rounded-2xl border border-zinc-800 bg-zinc-950/95 p-4 shadow-2xl backdrop-blur"
          >
            <div className="flex items-start gap-3">
              <div className="mt-0.5">{toastIcon(toast.level)}</div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-zinc-100">{toast.title}</div>
                <div className="mt-1 text-sm text-zinc-400">{toast.message}</div>
                <div className="mt-2 text-[10px] uppercase tracking-[0.2em] text-zinc-600">{formatTime(toast.createdAtMs)}</div>
              </div>
              <button
                onClick={() => props.onDismissToast?.(toast.id)}
                className="rounded-xl border border-zinc-800 bg-zinc-900 px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-zinc-300 hover:bg-zinc-800"
              >
                Dismiss
              </button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function EmptyRailCard(props: { title: string; message: string; icon?: React.ReactNode }): JSX.Element {
  return (
    <div className="m-4 rounded-[2rem] border border-dashed border-zinc-800 bg-zinc-950/40 p-6 text-zinc-400">
      <div className="flex items-start gap-3">
        <div className="mt-1">{props.icon ?? <ChevronRight className="h-4 w-4" />}</div>
        <div>
          <div className="text-sm font-semibold text-zinc-200">{props.title}</div>
          <div className="mt-2 text-sm leading-7">{props.message}</div>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// MAIN COMPONENT
// -----------------------------------------------------------------------------

export default function AppShell(props: AppShellProps): JSX.Element {
  const [isNarrow, setIsNarrow] = useState(false);

  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth < 1200);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const navItems = useMemo(() => {
    const provided = props.navItems && props.navItems.length > 0 ? props.navItems : DEFAULT_NAV;
    return provided.map((item) => ({ ...item, active: item.active ?? item.key === props.currentView }));
  }, [props.currentView, props.navItems]);

  const statusChips = props.statusChips ?? [];
  const leftCollapsed = props.leftRailCollapsed ?? false;
  const rightCollapsed = props.rightRailCollapsed ?? false || isNarrow;
  const bottomVisible = props.bottomPanelVisible ?? false;
  const loading = props.loading ?? false;
  const commandPaletteOpen = props.commandPaletteOpen ?? false;
  const banners = props.banners ?? [];
  const toasts = props.toasts ?? [];

  return (
    <div className="relative flex min-h-screen bg-zinc-950 text-zinc-100">
      <ToastViewport toasts={toasts} onDismissToast={props.onDismissToast} />

      <ShellNav
        collapsed={leftCollapsed}
        currentView={props.currentView}
        items={navItems}
        onSelectView={props.onSelectView}
        leftRail={
          props.leftRail ?? (
            <EmptyRailCard
              title="Shell navigation region"
              message="Inject workspace navigation, quick actions, tree summaries, or contextual tool stacks here."
              icon={<FolderTree className="h-4 w-4" />}
            />
          )
        }
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <HeaderBar
          appTitle={props.appTitle ?? "Governed Execution Workspace"}
          subtitle={
            props.subtitle ??
            "Deterministic shell frame for workspace review, patch governance, verification evidence, ledger history, agent control, and diagnostics surfaces."
          }
          health={props.health}
          loading={loading}
          commandPaletteOpen={commandPaletteOpen}
          leftRailCollapsed={leftCollapsed}
          rightRailCollapsed={rightCollapsed}
          statusChips={statusChips}
          onToggleLeftRail={props.onToggleLeftRail}
          onToggleRightRail={props.onToggleRightRail}
          onToggleCommandPalette={props.onToggleCommandPalette}
          headerActions={props.headerActions}
          commandBar={props.commandBar}
        />

        <BannerStack banners={banners} />

        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <main className="min-h-0 flex-1 overflow-auto px-6 py-6 lg:px-8">
              <motion.div
                key={props.currentView}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18 }}
                className="h-full"
              >
                {props.primaryContent ?? (
                  <div className="grid h-full min-h-[36rem] place-items-center rounded-[2rem] border border-dashed border-zinc-800 bg-zinc-900/40 p-10 text-center">
                    <div className="max-w-2xl">
                      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-950/60">
                        <LayoutGrid className="h-6 w-6 text-zinc-300" />
                      </div>
                      <h2 className="mt-6 text-2xl font-semibold tracking-tight text-zinc-50">Primary content well</h2>
                      <p className="mt-4 text-sm leading-7 text-zinc-400">
                        Mount the currently selected feature surface here: workspace explorer, patch review, verification dashboard, ledger browser, agent console, or diagnostics cockpit.
                      </p>
                    </div>
                  </div>
                )}
              </motion.div>
            </main>

            <BottomPanelFrame
              visible={bottomVisible}
              bottomPanel={
                props.bottomPanel ?? (
                  <EmptyRailCard
                    title="Bottom evidence strip"
                    message="Use this region for logs, diagnostics, terminal output, activity trails, or secondary evidence panes."
                    icon={<Activity className="h-4 w-4" />}
                  />
                )
              }
            />

            <div className="border-t border-zinc-800 bg-zinc-950/80 px-6 py-3 text-xs text-zinc-500 lg:px-8">
              {props.footer ?? (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <span className="inline-flex items-center gap-2">
                    <Monitor className="h-3.5 w-3.5" />
                    Shell active
                  </span>
                  <span className="inline-flex items-center gap-2">
                    <Activity className="h-3.5 w-3.5" />
                    View: {props.currentView}
                  </span>
                  <span className="inline-flex items-center gap-2">
                    <HealthBadge health={props.health} />
                  </span>
                </div>
              )}
            </div>
          </div>

          <RightRailFrame
            collapsed={rightCollapsed}
            rightRail={
              props.rightRail ?? (
                <div className="space-y-4 p-4">
                  <EmptyRailCard
                    title="Insights rail"
                    message="Inject operational summaries, selected item details, status snapshots, apply gates, diagnostics highlights, or cross-cutting inspector panels here."
                    icon={<Wrench className="h-4 w-4" />}
                  />
                </div>
              )
            }
          />
        </div>
      </div>

      <div className="pointer-events-none absolute inset-0 z-40">
        {props.overlayLayer ? <div className="pointer-events-auto">{props.overlayLayer}</div> : null}
      </div>

      <div className="pointer-events-none absolute inset-0 z-50">
        {props.modalLayer ? <div className="pointer-events-auto">{props.modalLayer}</div> : null}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// OPTIONAL COMPOSABLE PRIMITIVES
// -----------------------------------------------------------------------------

export function AppShellSection(props: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="rounded-[2rem] border border-zinc-800 bg-zinc-900/70 shadow-lg">
      <div className="flex flex-col gap-4 border-b border-zinc-800 px-6 py-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">{props.title}</div>
          {props.subtitle ? <div className="mt-2 text-sm text-zinc-400">{props.subtitle}</div> : null}
        </div>
        {props.actions ? <div className="shrink-0">{props.actions}</div> : null}
      </div>
      <div className="p-6">{props.children}</div>
    </section>
  );
}

export function AppShellMetric(props: {
  label: string;
  value: string;
  icon?: React.ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad";
}): JSX.Element {
  return (
    <div className={cx("rounded-[1.5rem] border p-5 shadow-sm", toneChip(props.tone))}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] opacity-70">{props.label}</div>
          <div className="mt-3 text-2xl font-semibold tracking-tight">{props.value}</div>
        </div>
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/40 p-2.5">{props.icon ?? <Activity className="h-4 w-4" />}</div>
      </div>
    </div>
  );
}
