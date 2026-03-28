import React, { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  Eye,
  FileCode2,
  Filter,
  Gauge,
  GitBranch,
  KeyRound,
  Layers3,
  Lock,
  RefreshCw,
  Save,
  Search,
  Server,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  SlidersHorizontal,
  Sparkles,
  TerminalSquare,
  Wrench,
  XCircle,
} from "lucide-react";

/**
 * ADJUTORIX APP — RENDERER / COMPONENTS / SettingsPanel.tsx
 *
 * Canonical governed settings/control-plane surface.
 *
 * Purpose:
 * - provide the authoritative renderer-side configuration cockpit for user-visible,
 *   workspace-scoped, session-scoped, and system-governed settings
 * - unify configuration domains such as execution, review, verification, index posture,
 *   provider behavior, UI preferences, diagnostics, and safety/authority gates
 * - prevent settings from degrading into unrelated toggles that silently mutate system behavior
 *   without making scope, defaults, risk, or restart/rebuild requirements explicit
 * - expose explicit draft/edit/save/reset intent upward without mutating runtime configuration locally
 *
 * Architectural role:
 * - SettingsPanel is the presentation/control layer over declared configuration state
 * - it does not persist settings or enforce them locally; it renders and edits supplied state
 * - it should remain useful in read-only, editable, partially-invalid, degraded-provider,
 *   and restart-required sessions
 * - it must make configuration scope and operational consequences visible before save
 *
 * Hard invariants:
 * - setting identity, current value, effective value, and default value are explicit
 * - scope, mutability, and consequence posture are visible before mutation intent
 * - draft changes are distinct from saved/effective state
 * - validation issues annotate but never alter setting identity
 * - identical props and local draft state yield identical visible ordering
 * - no placeholders, fake persistence, or hidden side effects
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type SettingsHealth = "healthy" | "degraded" | "unhealthy" | "unknown";
export type SettingScope = "user" | "workspace" | "session" | "system";
export type SettingRisk = "safe" | "guarded" | "destructive";
export type SettingKind = "boolean" | "enum" | "string" | "number" | "path";
export type SettingCategory =
  | "general"
  | "appearance"
  | "workspace"
  | "execution"
  | "patch-review"
  | "verify"
  | "providers"
  | "indexing"
  | "diagnostics"
  | "security";
export type SettingValidationSeverity = "info" | "warn" | "error";

export type SettingOption = {
  value: string;
  label: string;
  description?: string | null;
};

export type SettingValidationIssue = {
  id: string;
  severity: SettingValidationSeverity;
  message: string;
};

export type SettingItem = {
  id: string;
  key: string;
  title: string;
  description?: string | null;
  category: SettingCategory;
  scope: SettingScope;
  risk?: SettingRisk;
  kind: SettingKind;
  currentValue: string | number | boolean | null;
  effectiveValue?: string | number | boolean | null;
  defaultValue?: string | number | boolean | null;
  draftValue?: string | number | boolean | null;
  placeholder?: string | null;
  options?: SettingOption[];
  unitLabel?: string | null;
  mutable?: boolean;
  requiresRestart?: boolean;
  requiresReindex?: boolean;
  requiresReconnect?: boolean;
  lockedReason?: string | null;
  authorityLabel?: string | null;
  lineageHint?: string | null;
  validationIssues?: SettingValidationIssue[];
};

export type SettingsMetric = {
  id: string;
  label: string;
  value: string;
  tone?: "neutral" | "good" | "warn" | "bad";
};

export type SettingsPanelProps = {
  title?: string;
  subtitle?: string;
  health?: SettingsHealth;
  loading?: boolean;
  settings: SettingItem[];
  metrics?: SettingsMetric[];
  selectedSettingId?: string | null;
  selectedCategory?: SettingCategory | "all";
  filterQuery?: string;
  showOnlyChanged?: boolean;
  showOnlyIssues?: boolean;
  dirty?: boolean;
  readOnly?: boolean;
  onRefreshRequested?: () => void;
  onSelectSetting?: (setting: SettingItem) => void;
  onSelectedCategoryChange?: (category: SettingCategory | "all") => void;
  onFilterQueryChange?: (query: string) => void;
  onToggleShowOnlyChanged?: (value: boolean) => void;
  onToggleShowOnlyIssues?: (value: boolean) => void;
  onDraftValueChange?: (setting: SettingItem, value: string | number | boolean | null) => void;
  onSaveRequested?: () => void;
  onResetRequested?: () => void;
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function healthTone(level: SettingsHealth | undefined): string {
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

function scopeTone(scope: SettingScope): string {
  switch (scope) {
    case "user":
      return "border-sky-700/30 bg-sky-500/10 text-sky-300";
    case "workspace":
      return "border-indigo-700/30 bg-indigo-500/10 text-indigo-300";
    case "session":
      return "border-amber-700/30 bg-amber-500/10 text-amber-300";
    case "system":
      return "border-violet-700/30 bg-violet-500/10 text-violet-300";
    default:
      return "border-zinc-700/30 bg-zinc-500/10 text-zinc-300";
  }
}

function riskTone(risk: SettingRisk | undefined): string {
  switch (risk) {
    case "destructive":
      return "border-rose-700/30 bg-rose-500/10 text-rose-300";
    case "guarded":
      return "border-amber-700/30 bg-amber-500/10 text-amber-300";
    default:
      return "border-emerald-700/30 bg-emerald-500/10 text-emerald-300";
  }
}

function validationTone(severity: SettingValidationSeverity): string {
  switch (severity) {
    case "error":
      return "border-rose-700/30 bg-rose-500/10 text-rose-300";
    case "warn":
      return "border-amber-700/30 bg-amber-500/10 text-amber-300";
    default:
      return "border-sky-700/30 bg-sky-500/10 text-sky-300";
  }
}

function metricTone(tone?: SettingsMetric["tone"]): string {
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

function categoryIcon(category: SettingCategory): JSX.Element {
  switch (category) {
    case "appearance":
      return <Eye className="h-4 w-4" />;
    case "workspace":
      return <FileCode2 className="h-4 w-4" />;
    case "execution":
      return <TerminalSquare className="h-4 w-4" />;
    case "patch-review":
      return <GitBranch className="h-4 w-4" />;
    case "verify":
      return <ShieldCheck className="h-4 w-4" />;
    case "providers":
      return <Server className="h-4 w-4" />;
    case "indexing":
      return <Database className="h-4 w-4" />;
    case "diagnostics":
      return <Wrench className="h-4 w-4" />;
    case "security":
      return <Lock className="h-4 w-4" />;
    default:
      return <SlidersHorizontal className="h-4 w-4" />;
  }
}

function categoryLabel(category: SettingCategory | "all"): string {
  if (category === "all") return "All";
  return category.replace(/-/g, " ");
}

function isChanged(setting: SettingItem): boolean {
  return setting.draftValue !== undefined && setting.draftValue !== setting.currentValue;
}

function hasIssues(setting: SettingItem): boolean {
  return !!setting.validationIssues && setting.validationIssues.length > 0;
}

function stringifyValue(value: string | number | boolean | null | undefined, unit?: string | null): string {
  if (value === null || value === undefined || value === "") return "Unset";
  if (typeof value === "boolean") return value ? "Enabled" : "Disabled";
  return `${String(value)}${unit ? ` ${unit}` : ""}`;
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
        <div className="rounded-xl border border-zinc-800 bg-black/20 p-2.5 text-zinc-300">{props.icon ?? <SlidersHorizontal className="h-4 w-4" />}</div>
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

function ActionButton(props: { label: string; icon?: React.ReactNode; disabled?: boolean; tone?: "primary" | "secondary"; onClick?: () => void }): JSX.Element {
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

function DraftEditor(props: {
  setting: SettingItem;
  readOnly: boolean;
  onDraftValueChange?: (setting: SettingItem, value: string | number | boolean | null) => void;
}): JSX.Element {
  const value = props.setting.draftValue ?? props.setting.currentValue;
  const mutable = props.setting.mutable ?? true;
  const disabled = props.readOnly || !mutable;

  if (props.setting.kind === "boolean") {
    const checked = Boolean(value);
    return (
      <button
        onClick={() => props.onDraftValueChange?.(props.setting, !checked)}
        disabled={disabled || !props.onDraftValueChange}
        className={cx(
          "inline-flex items-center gap-3 rounded-2xl border px-4 py-3 text-sm font-medium transition",
          checked
            ? "border-emerald-700/30 bg-emerald-500/10 text-emerald-200"
            : "border-zinc-800 bg-zinc-950/60 text-zinc-300 hover:bg-zinc-900",
          (disabled || !props.onDraftValueChange) && "cursor-not-allowed opacity-50",
        )}
      >
        {checked ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
        {checked ? "Enabled" : "Disabled"}
      </button>
    );
  }

  if (props.setting.kind === "enum" && props.setting.options && props.setting.options.length > 0) {
    return (
      <div className="relative">
        <select
          value={String(value ?? "")}
          disabled={disabled || !props.onDraftValueChange}
          onChange={(e) => props.onDraftValueChange?.(props.setting, e.target.value)}
          className={cx(
            "w-full appearance-none rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-sm text-zinc-100 outline-none",
            (disabled || !props.onDraftValueChange) && "cursor-not-allowed opacity-50",
          )}
        >
          {props.setting.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
      </div>
    );
  }

  return (
    <input
      type={props.setting.kind === "number" ? "number" : "text"}
      value={value === null || value === undefined ? "" : String(value)}
      disabled={disabled || !props.onDraftValueChange}
      placeholder={props.setting.placeholder ?? "Set value"}
      onChange={(e) => {
        const raw = e.target.value;
        if (props.setting.kind === "number") {
          props.onDraftValueChange?.(props.setting, raw === "" ? null : Number(raw));
        } else {
          props.onDraftValueChange?.(props.setting, raw === "" ? null : raw);
        }
      }}
      className={cx(
        "w-full rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-600",
        (disabled || !props.onDraftValueChange) && "cursor-not-allowed opacity-50",
      )}
    />
  );
}

// -----------------------------------------------------------------------------
// MAIN COMPONENT
// -----------------------------------------------------------------------------

export default function SettingsPanel(props: SettingsPanelProps): JSX.Element {
  const title = props.title ?? "Settings control plane";
  const subtitle =
    props.subtitle ??
    "Governed configuration surface for execution, review, verify, indexing, providers, diagnostics, and security posture.";

  const health = props.health ?? "unknown";
  const loading = props.loading ?? false;
  const readOnly = props.readOnly ?? false;
  const [localFilter, setLocalFilter] = useState(props.filterQuery ?? "");
  const [localCategory, setLocalCategory] = useState<SettingCategory | "all">(props.selectedCategory ?? "all");
  const showOnlyChanged = props.showOnlyChanged ?? false;
  const showOnlyIssues = props.showOnlyIssues ?? false;
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(props.selectedSettingId ?? null);

  const visibleSettings = useMemo(() => {
    const q = localFilter.trim().toLowerCase();
    return props.settings.filter((setting) => {
      if (localCategory !== "all" && setting.category !== localCategory) return false;
      if (showOnlyChanged && !isChanged(setting)) return false;
      if (showOnlyIssues && !hasIssues(setting)) return false;
      if (!q) return true;
      return (
        setting.title.toLowerCase().includes(q) ||
        (setting.description ?? "").toLowerCase().includes(q) ||
        setting.key.toLowerCase().includes(q) ||
        (setting.authorityLabel ?? "").toLowerCase().includes(q) ||
        (setting.lineageHint ?? "").toLowerCase().includes(q)
      );
    });
  }, [localCategory, localFilter, props.settings, showOnlyChanged, showOnlyIssues]);

  const selectedSettingId = props.selectedSettingId ?? localSelectedId ?? visibleSettings[0]?.id ?? null;
  const selectedSetting = visibleSettings.find((setting) => setting.id === selectedSettingId) ?? visibleSettings[0] ?? null;

  const metrics = props.metrics ?? [
    { id: "visible", label: "Visible settings", value: String(visibleSettings.length) },
    { id: "changed", label: "Changed", value: String(props.settings.filter(isChanged).length), tone: props.settings.some(isChanged) ? "warn" : "neutral" },
    { id: "issues", label: "Issues", value: String(props.settings.filter(hasIssues).length), tone: props.settings.some(hasIssues) ? "bad" : "good" },
    { id: "locked", label: "Locked", value: String(props.settings.filter((s) => (s.mutable ?? true) === false).length), tone: props.settings.some((s) => (s.mutable ?? true) === false) ? "warn" : "neutral" },
  ];

  const categories: Array<SettingCategory | "all"> = [
    "all",
    "general",
    "appearance",
    "workspace",
    "execution",
    "patch-review",
    "verify",
    "providers",
    "indexing",
    "diagnostics",
    "security",
  ];

  return (
    <section className="flex h-full min-h-0 flex-col rounded-[2rem] border border-zinc-800 bg-zinc-900/70 shadow-xl">
      <div className="border-b border-zinc-800 px-5 py-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Settings</div>
            <h2 className="mt-1 text-lg font-semibold text-zinc-50">{title}</h2>
            <p className="mt-2 text-sm leading-7 text-zinc-400">{subtitle}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={healthTone(health)}>
              <ShieldCheck className="h-3.5 w-3.5" />
              {health}
            </Badge>
            {readOnly ? (
              <Badge className="border-amber-700/30 bg-amber-500/10 text-amber-300">
                <Lock className="h-3.5 w-3.5" />
                read-only
              </Badge>
            ) : null}
            {props.dirty ? (
              <Badge className="border-indigo-700/30 bg-indigo-500/10 text-indigo-300">
                <Save className="h-3.5 w-3.5" />
                unsaved
              </Badge>
            ) : null}
            <button
              onClick={props.onRefreshRequested}
              disabled={!props.onRefreshRequested}
              className={cx(
                "rounded-2xl border border-zinc-800 bg-zinc-950/70 p-2.5 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100",
                !props.onRefreshRequested && "cursor-not-allowed opacity-40",
              )}
            >
              {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
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
              icon={metric.id === "changed" ? <Save className="h-4 w-4" /> : metric.id === "issues" ? <AlertTriangle className="h-4 w-4" /> : metric.id === "locked" ? <Lock className="h-4 w-4" /> : <SlidersHorizontal className="h-4 w-4" />}
            />
          ))}
        </div>

        <div className="mt-4 flex items-center gap-2 rounded-[1.5rem] border border-zinc-800 bg-zinc-950/70 px-4 py-3">
          <Search className="h-4 w-4 text-zinc-500" />
          <input
            value={localFilter}
            onChange={(e) => {
              setLocalFilter(e.target.value);
              props.onFilterQueryChange?.(e.target.value);
            }}
            placeholder="Filter settings"
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

        <div className="mt-3 flex flex-wrap gap-2">
          <ToggleChip label="Changed only" active={showOnlyChanged} icon={<Save className="h-3.5 w-3.5" />} onClick={props.onToggleShowOnlyChanged ? () => props.onToggleShowOnlyChanged?.(!showOnlyChanged) : undefined} />
          <ToggleChip label="Issues only" active={showOnlyIssues} icon={<AlertTriangle className="h-3.5 w-3.5" />} onClick={props.onToggleShowOnlyIssues ? () => props.onToggleShowOnlyIssues?.(!showOnlyIssues) : undefined} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
        <AnimatePresence mode="wait">
          {loading ? (
            <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="grid min-h-[18rem] place-items-center rounded-[2rem] border border-zinc-800 bg-zinc-950/30">
              <div className="flex items-center gap-3 text-sm text-zinc-300">
                <RefreshCw className="h-4 w-4 animate-spin" />
                Hydrating settings control plane…
              </div>
            </motion.div>
          ) : visibleSettings.length > 0 ? (
            <motion.div key="settings" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.16 }} className="grid gap-5 xl:grid-cols-[0.95fr_1.05fr]">
              <div className="space-y-2">
                {visibleSettings.map((setting) => {
                  const selected = selectedSetting?.id === setting.id;
                  return (
                    <button
                      key={setting.id}
                      onClick={() => {
                        setLocalSelectedId(setting.id);
                        props.onSelectSetting?.(setting);
                      }}
                      className={cx(
                        "flex w-full items-start gap-3 rounded-[1.5rem] border px-4 py-4 text-left shadow-sm transition",
                        selected ? "border-zinc-600 bg-zinc-800 text-zinc-50" : "border-zinc-800 bg-zinc-950/50 text-zinc-200 hover:bg-zinc-900",
                      )}
                    >
                      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-2 text-zinc-300">{categoryIcon(setting.category)}</div>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-semibold">{setting.title}</span>
                          <span className={cx("rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.2em]", scopeTone(setting.scope))}>{setting.scope}</span>
                          <span className={cx("rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.2em]", riskTone(setting.risk))}>{setting.risk ?? "safe"}</span>
                          {isChanged(setting) ? <span className="rounded-full border border-indigo-700/30 bg-indigo-500/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] text-indigo-300">changed</span> : null}
                          {hasIssues(setting) ? <span className="rounded-full border border-amber-700/30 bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] text-amber-300">issues</span> : null}
                        </div>
                        {setting.description ? <div className="mt-2 text-sm text-zinc-400">{setting.description}</div> : null}
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                          <span>{setting.kind}</span>
                          <span>{setting.key}</span>
                          {setting.requiresRestart ? <span>restart</span> : null}
                          {setting.requiresReindex ? <span>reindex</span> : null}
                          {setting.requiresReconnect ? <span>reconnect</span> : null}
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 text-zinc-600" />
                    </button>
                  );
                })}
              </div>

              <div className="space-y-5">
                <section className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-5 shadow-lg">
                  <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Selected setting</div>
                  {selectedSetting ? (
                    <div className="mt-4 space-y-4">
                      <div>
                        <div className="text-lg font-semibold text-zinc-50">{selectedSetting.title}</div>
                        {selectedSetting.description ? <div className="mt-2 text-sm leading-7 text-zinc-400">{selectedSetting.description}</div> : null}
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Badge className={scopeTone(selectedSetting.scope)}>{selectedSetting.scope}</Badge>
                        <Badge className={riskTone(selectedSetting.risk)}>{selectedSetting.risk ?? "safe"}</Badge>
                        <Badge className="border-zinc-700/30 bg-zinc-500/10 text-zinc-300">{selectedSetting.kind}</Badge>
                        {(selectedSetting.mutable ?? true) === false ? (
                          <Badge className="border-amber-700/30 bg-amber-500/10 text-amber-300">
                            <Lock className="h-3.5 w-3.5" />
                            locked
                          </Badge>
                        ) : null}
                      </div>

                      <div className="grid gap-3 sm:grid-cols-2">
                        <MetricCard label="Current" value={stringifyValue(selectedSetting.currentValue, selectedSetting.unitLabel)} icon={<CheckCircle2 className="h-4 w-4" />} />
                        <MetricCard label="Effective" value={stringifyValue(selectedSetting.effectiveValue ?? selectedSetting.currentValue, selectedSetting.unitLabel)} icon={<Sparkles className="h-4 w-4" />} />
                        <MetricCard label="Default" value={stringifyValue(selectedSetting.defaultValue, selectedSetting.unitLabel)} icon={<RefreshCw className="h-4 w-4" />} />
                        <MetricCard label="Authority" value={selectedSetting.authorityLabel ?? "Standard settings authority"} icon={<ShieldCheck className="h-4 w-4" />} />
                      </div>

                      <div>
                        <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Draft editor</div>
                        <div className="mt-3">
                          <DraftEditor setting={selectedSetting} readOnly={readOnly} onDraftValueChange={props.onDraftValueChange} />
                        </div>
                      </div>

                      {selectedSetting.lockedReason ? (
                        <div className="rounded-[1.25rem] border border-amber-700/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                          {selectedSetting.lockedReason}
                        </div>
                      ) : null}

                      {(selectedSetting.requiresRestart || selectedSetting.requiresReindex || selectedSetting.requiresReconnect) ? (
                        <div className="rounded-[1.25rem] border border-sky-700/30 bg-sky-500/10 px-4 py-3 text-sm text-sky-200">
                          Consequences: {selectedSetting.requiresRestart ? "restart " : ""}{selectedSetting.requiresReindex ? "reindex " : ""}{selectedSetting.requiresReconnect ? "reconnect" : ""}
                        </div>
                      ) : null}

                      {selectedSetting.lineageHint ? (
                        <div className="rounded-[1.25rem] border border-zinc-800 bg-zinc-950/50 px-4 py-3 text-sm text-zinc-300">
                          {selectedSetting.lineageHint}
                        </div>
                      ) : null}

                      {hasIssues(selectedSetting) ? (
                        <div className="space-y-2">
                          <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Validation issues</div>
                          {selectedSetting.validationIssues!.map((issue) => (
                            <div key={issue.id} className={cx("rounded-[1.25rem] border px-4 py-3 text-sm", validationTone(issue.severity))}>
                              {issue.message}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="mt-4 rounded-[1.5rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-5 text-sm text-zinc-500">
                      Select a visible setting to inspect scope, defaults, effective value, and edit posture.
                    </div>
                  )}
                </section>

                <section className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-5 shadow-lg">
                  <div className="flex flex-wrap gap-2">
                    <ActionButton label="Save changes" icon={<Save className="h-4 w-4" />} disabled={readOnly || !props.dirty} onClick={props.onSaveRequested} />
                    <ActionButton label="Reset drafts" icon={<RefreshCw className="h-4 w-4" />} tone="secondary" disabled={readOnly || !props.dirty} onClick={props.onResetRequested} />
                  </div>
                </section>
              </div>
            </motion.div>
          ) : (
            <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="grid min-h-[18rem] place-items-center rounded-[2rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-8 text-center">
              <div className="max-w-xl">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-[1.5rem] border border-zinc-800 bg-zinc-950/60 text-zinc-400">
                  <SlidersHorizontal className="h-6 w-6" />
                </div>
                <h3 className="mt-6 text-xl font-semibold text-zinc-100">No visible settings</h3>
                <p className="mt-3 text-sm leading-7 text-zinc-500">The current search, category, or validation filters produced no visible settings.</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="border-t border-zinc-800 px-4 py-3 text-xs text-zinc-500">
        <div className="flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-1"><SlidersHorizontal className="h-3.5 w-3.5" /> scope explicit</span>
          <span className="inline-flex items-center gap-1"><Lock className="h-3.5 w-3.5" /> mutability visible</span>
          <span className="inline-flex items-center gap-1"><Save className="h-3.5 w-3.5" /> drafts separated from saved</span>
          <span className="inline-flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" /> consequences surfaced</span>
        </div>
      </div>
    </section>
  );
}
