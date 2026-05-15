import React, { useMemo } from "react";

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

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function chipTone(tone: AppShellStatusChip["tone"]): string {
  if (tone === "good") return "border-emerald-800 bg-emerald-500/10 text-emerald-300";
  if (tone === "warn") return "border-amber-800 bg-amber-500/10 text-amber-300";
  if (tone === "bad") return "border-rose-800 bg-rose-500/10 text-rose-300";
  return "border-zinc-800 bg-zinc-950 text-zinc-300";
}

function healthTone(health: AppShellHealth): string {
  if (health === "healthy") return "border-emerald-800 bg-emerald-500/10 text-emerald-300";
  if (health === "degraded") return "border-amber-800 bg-amber-500/10 text-amber-300";
  if (health === "unhealthy") return "border-rose-800 bg-rose-500/10 text-rose-300";
  return "border-zinc-800 bg-zinc-950 text-zinc-300";
}

function bannerTone(level: AppShellBanner["level"]): string {
  if (level === "success") return "border-emerald-800 bg-emerald-500/10 text-emerald-200";
  if (level === "warn") return "border-amber-800 bg-amber-500/10 text-amber-200";
  if (level === "error") return "border-rose-800 bg-rose-500/10 text-rose-200";
  return "border-sky-800 bg-sky-500/10 text-sky-200";
}

function ToastViewport(props: { toasts: AppShellToast[]; onDismissToast?: (id: string) => void }) {
  if (props.toasts.length === 0) return null;

  return (
    <div className="fixed right-4 top-4 z-[80] flex w-[24rem] max-w-[calc(100vw-2rem)] flex-col gap-3">
      {props.toasts.map((toast) => (
        <div key={toast.id} className="rounded-2xl border border-zinc-800 bg-zinc-950 p-4 shadow-2xl">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-zinc-100">{toast.title}</div>
              <div className="mt-1 text-sm text-zinc-400">{toast.message}</div>
            </div>
            <button
              type="button"
              className="rounded-xl border border-zinc-800 px-2 py-1 text-xs uppercase tracking-[0.18em] text-zinc-400 hover:text-zinc-100"
              onClick={() => props.onDismissToast?.(toast.id)}
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function AppShell(props: AppShellProps): JSX.Element {
  const navItems = useMemo(() => {
    const source = props.navItems && props.navItems.length > 0 ? props.navItems : DEFAULT_NAV;
    return source.map((item) => ({ ...item, active: item.active ?? item.key === props.currentView }));
  }, [props.currentView, props.navItems]);

  const leftCollapsed = props.leftRailCollapsed ?? false;
  const rightCollapsed = props.rightRailCollapsed ?? false;
  const bottomVisible = props.bottomPanelVisible ?? false;
  const statusChips = props.statusChips ?? [];
  const banners = props.banners ?? [];
  const toasts = props.toasts ?? [];

  return (
    <div className="flex h-screen min-h-0 w-screen overflow-hidden bg-zinc-950 text-zinc-100">
      <ToastViewport toasts={toasts} onDismissToast={props.onDismissToast} />

      <aside
        className={cx(
          "flex min-h-0 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950",
          leftCollapsed ? "w-16" : "w-56",
        )}
      >
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-zinc-800 px-3">
          <button
            type="button"
            aria-label="Toggle left rail"
            className="rounded-xl border border-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-900"
            onClick={props.onToggleLeftRail}
          >
            {leftCollapsed ? ">" : "<"}
          </button>
          {!leftCollapsed ? <div className="truncate text-sm font-semibold">Workbench</div> : null}
        </div>

        <nav className="shrink-0 space-y-1 p-2">
          {navItems.map((item) => (
            <button
              key={item.key}
              type="button"
              disabled={item.disabled}
              className={cx(
                "flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm transition",
                item.active
                  ? "bg-zinc-800 text-zinc-50"
                  : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100",
                item.disabled && "cursor-not-allowed opacity-40",
              )}
              onClick={() => props.onSelectView?.(item.key)}
              title={item.label}
            >
              <span className="truncate">{leftCollapsed ? item.label.slice(0, 1) : item.label}</span>
              {!leftCollapsed && item.badge ? (
                <span className="ml-2 rounded-full bg-zinc-950 px-2 py-0.5 text-xs text-zinc-300">{item.badge}</span>
              ) : null}
            </button>
          ))}
        </nav>

        {!leftCollapsed && props.leftRail ? (
          <div className="min-h-0 flex-1 overflow-auto border-t border-zinc-800">{props.leftRail}</div>
        ) : null}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-zinc-800 bg-zinc-950 px-4">
          <h1 className="shrink-0 text-base font-semibold tracking-tight text-zinc-50">
            {props.appTitle ?? "Adjutorix"}
          </h1>

          {props.subtitle ? (
            <div className="hidden min-w-0 truncate text-sm text-zinc-500 xl:block">{props.subtitle}</div>
          ) : null}

          <div className="ml-auto flex min-w-0 items-center gap-2">
            <span className={cx("rounded-full border px-2.5 py-1 text-[0.65rem] uppercase tracking-[0.16em]", healthTone(props.health))}>
              {props.health}
            </span>

            {statusChips.slice(0, 5).map((chip) => (
              <span
                key={`${chip.label}:${chip.value}`}
                className={cx("hidden rounded-full border px-2.5 py-1 text-xs lg:inline-flex", chipTone(chip.tone))}
                title={`${chip.label}: ${chip.value}`}
              >
                <span className="mr-1 text-zinc-500">{chip.label}</span>
                <span>{chip.value}</span>
              </span>
            ))}

            <button
              type="button"
              aria-label="Toggle command palette"
              className="rounded-xl border border-zinc-800 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-900"
              onClick={props.onToggleCommandPalette}
            >
              Commands
            </button>

            <button
              type="button"
              aria-label="Toggle right rail"
              className="rounded-xl border border-zinc-800 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-900"
              onClick={props.onToggleRightRail}
            >
              {rightCollapsed ? "Context" : "Hide"}
            </button>

            {props.headerActions}
          </div>
        </header>

        {props.commandBar ? (
          <div className="shrink-0 border-b border-zinc-800 bg-zinc-950 px-4 py-2">{props.commandBar}</div>
        ) : null}

        {banners.length > 0 ? (
          <div className="shrink-0 space-y-2 border-b border-zinc-800 bg-zinc-950 px-4 py-3">
            {banners.map((banner) => (
              <div key={banner.id} className={cx("rounded-xl border px-3 py-2 text-sm", bannerTone(banner.level))}>
                <span className="font-semibold">{banner.title}</span>
                <span className="ml-2 opacity-80">{banner.message}</span>
              </div>
            ))}
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1">
          <main className="min-h-0 min-w-0 flex-1 overflow-hidden bg-zinc-950 p-3">
            {props.primaryContent ?? (
              <div className="grid h-full place-items-center rounded-2xl border border-dashed border-zinc-800 text-zinc-500">
                Primary workbench empty
              </div>
            )}
          </main>

          {!rightCollapsed ? (
            <aside className="min-h-0 w-80 shrink-0 overflow-auto border-l border-zinc-800 bg-zinc-950">
              {props.rightRail}
            </aside>
          ) : null}
        </div>

        {bottomVisible ? (
          <div className="h-64 shrink-0 overflow-hidden border-t border-zinc-800 bg-zinc-950">
            {props.bottomPanel}
          </div>
        ) : null}

        <footer className="h-8 shrink-0 overflow-hidden border-t border-zinc-800 bg-zinc-950 px-4 py-1.5 text-xs text-zinc-500">
          {props.footer ?? `View: ${props.currentView}`}
        </footer>
      </div>

      {props.overlayLayer}
      {props.modalLayer}
    </div>
  );
}

export function AppShellSection(props: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="flex min-h-0 flex-col rounded-2xl border border-zinc-800 bg-zinc-900/70">
      <div className="flex shrink-0 items-center justify-between gap-4 border-b border-zinc-800 px-4 py-3">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">{props.title}</div>
          {props.subtitle ? <div className="mt-1 text-sm text-zinc-400">{props.subtitle}</div> : null}
        </div>
        {props.actions}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">{props.children}</div>
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
    <div className={cx("rounded-2xl border px-4 py-3", chipTone(props.tone))}>
      <div className="text-[0.65rem] uppercase tracking-[0.18em] opacity-70">{props.label}</div>
      <div className="mt-1 text-lg font-semibold">{props.value}</div>
    </div>
  );
}
