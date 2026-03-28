import React, { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronRight,
  Cloud,
  Database,
  Gauge,
  KeyRound,
  Link2,
  Loader2,
  Lock,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Sparkles,
  TerminalSquare,
  Wrench,
  XCircle,
} from "lucide-react";

/**
 * ADJUTORIX APP — RENDERER / COMPONENTS / ProviderStatus.tsx
 *
 * Canonical provider/dependency posture surface.
 *
 * Purpose:
 * - provide the authoritative renderer-side status surface for runtime providers,
 *   backends, shells, model endpoints, auth material, and verification dependencies
 * - unify availability, degradation, auth posture, capability exposure, latency,
 *   fallback paths, and operator actions under one deterministic component contract
 * - prevent each feature surface from inventing its own readiness interpretation
 * - expose explicit refresh/reconnect/open-details intent upward without hidden checks
 *
 * Architectural role:
 * - ProviderStatus is shared infrastructure chrome, not feature-local business logic
 * - it renders externally supplied provider truth and aggregates posture at UI level
 * - it should remain useful when fully healthy, partially degraded, disconnected,
 *   auth-blocked, rate-limited, or operating on fallback providers only
 *
 * Hard invariants:
 * - provider ordering is the provided ordering after explicit filters only
 * - aggregate health is derived from explicit provider state, not inferred stylistically
 * - capabilities/fallback/auth/degradation badges annotate but never alter identity
 * - identical props yield identical provider summaries and visual order
 * - all actions are explicit callbacks or explicit disabled state
 * - no placeholders, fake pings, or hidden probing side effects
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type ProviderHealth = "healthy" | "degraded" | "unhealthy" | "unknown";
export type ProviderTrustLevel = "unknown" | "untrusted" | "restricted" | "trusted";
export type ProviderAuthState = "unknown" | "available" | "missing" | "expired" | "invalid" | "not-required";
export type ProviderConnectivity = "connected" | "connecting" | "disconnected" | "rate-limited" | "blocked" | "unknown";
export type ProviderKind =
  | "agent"
  | "model"
  | "verify"
  | "workspace"
  | "ledger"
  | "diagnostics"
  | "shell"
  | "storage"
  | "custom";

export type ProviderCapability = {
  id: string;
  label: string;
  enabled: boolean;
};

export type ProviderFallback = {
  id: string;
  label: string;
  active?: boolean;
};

export type ProviderItem = {
  id: string;
  label: string;
  subtitle?: string | null;
  kind: ProviderKind;
  health?: ProviderHealth;
  connectivity?: ProviderConnectivity;
  authState?: ProviderAuthState;
  trustLevel?: ProviderTrustLevel;
  available?: boolean;
  latencyMs?: number | null;
  version?: string | null;
  endpointLabel?: string | null;
  rateLimitLabel?: string | null;
  attentionMessage?: string | null;
  capabilities?: ProviderCapability[];
  fallbacks?: ProviderFallback[];
  detail?: Record<string, unknown> | null;
};

export type ProviderMetric = {
  id: string;
  label: string;
  value: string;
  tone?: "neutral" | "good" | "warn" | "bad";
};

export type ProviderStatusProps = {
  title?: string;
  subtitle?: string;
  health?: ProviderHealth;
  loading?: boolean;
  providers: ProviderItem[];
  metrics?: ProviderMetric[];
  selectedProviderId?: string | null;
  showOnlyIssues?: boolean;
  kindFilters?: string[];
  onRefreshRequested?: () => void;
  onSelectProvider?: (provider: ProviderItem) => void;
  onToggleShowOnlyIssues?: (value: boolean) => void;
  onKindFiltersChange?: (kinds: string[]) => void;
  onReconnectRequested?: (provider: ProviderItem) => void;
  onOpenAuthRequested?: (provider: ProviderItem) => void;
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function healthTone(level: ProviderHealth | undefined): string {
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

function trustTone(level: ProviderTrustLevel | undefined): string {
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

function trustIcon(level: ProviderTrustLevel | undefined): JSX.Element {
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

function connectivityTone(state: ProviderConnectivity | undefined): string {
  switch (state) {
    case "connected":
      return "border-emerald-700/30 bg-emerald-500/10 text-emerald-300";
    case "connecting":
      return "border-sky-700/30 bg-sky-500/10 text-sky-300";
    case "rate-limited":
      return "border-amber-700/30 bg-amber-500/10 text-amber-300";
    case "blocked":
    case "disconnected":
      return "border-rose-700/30 bg-rose-500/10 text-rose-300";
    default:
      return "border-zinc-700/30 bg-zinc-500/10 text-zinc-300";
  }
}

function authTone(state: ProviderAuthState | undefined): string {
  switch (state) {
    case "available":
    case "not-required":
      return "border-emerald-700/30 bg-emerald-500/10 text-emerald-300";
    case "expired":
    case "invalid":
      return "border-amber-700/30 bg-amber-500/10 text-amber-300";
    case "missing":
      return "border-rose-700/30 bg-rose-500/10 text-rose-300";
    default:
      return "border-zinc-700/30 bg-zinc-500/10 text-zinc-300";
  }
}

function metricTone(tone?: ProviderMetric["tone"]): string {
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

function providerIcon(kind: ProviderKind): JSX.Element {
  switch (kind) {
    case "agent":
      return <Bot className="h-4 w-4" />;
    case "model":
      return <Sparkles className="h-4 w-4" />;
    case "verify":
      return <ShieldCheck className="h-4 w-4" />;
    case "workspace":
      return <FileCode2 className="h-4 w-4" />;
    case "ledger":
      return <Link2 className="h-4 w-4" />;
    case "diagnostics":
      return <Wrench className="h-4 w-4" />;
    case "shell":
      return <TerminalSquare className="h-4 w-4" />;
    case "storage":
      return <Database className="h-4 w-4" />;
    default:
      return <Server className="h-4 w-4" />;
  }
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}

function providerHasIssue(provider: ProviderItem): boolean {
  return (
    provider.health === "degraded" ||
    provider.health === "unhealthy" ||
    provider.connectivity === "disconnected" ||
    provider.connectivity === "blocked" ||
    provider.connectivity === "rate-limited" ||
    provider.authState === "missing" ||
    provider.authState === "expired" ||
    provider.authState === "invalid" ||
    provider.available === false
  );
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
        <div className="rounded-xl border border-zinc-800 bg-black/20 p-2.5 text-zinc-300">{props.icon ?? <Gauge className="h-4 w-4" />}</div>
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

// -----------------------------------------------------------------------------
// MAIN COMPONENT
// -----------------------------------------------------------------------------

export default function ProviderStatus(props: ProviderStatusProps): JSX.Element {
  const title = props.title ?? "Provider posture";
  const subtitle =
    props.subtitle ??
    "Single shared source of truth for provider availability, auth posture, capability exposure, fallbacks, and operator-safe readiness.";

  const health = props.health ?? "unknown";
  const loading = props.loading ?? false;
  const [localKinds, setLocalKinds] = useState<string[]>(props.kindFilters ?? []);
  const showOnlyIssues = props.showOnlyIssues ?? false;
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(props.selectedProviderId ?? null);

  const visibleProviders = useMemo(() => {
    return props.providers.filter((provider) => {
      if (showOnlyIssues && !providerHasIssue(provider)) return false;
      if (localKinds.length > 0 && !localKinds.includes(provider.kind)) return false;
      return true;
    });
  }, [localKinds, props.providers, showOnlyIssues]);

  const selectedProviderId = props.selectedProviderId ?? localSelectedId ?? visibleProviders[0]?.id ?? null;
  const selectedProvider = visibleProviders.find((provider) => provider.id === selectedProviderId) ?? visibleProviders[0] ?? null;

  const metrics = props.metrics ?? [
    { id: "visible", label: "Visible providers", value: String(visibleProviders.length) },
    { id: "healthy", label: "Healthy", value: String(props.providers.filter((p) => p.health === "healthy").length), tone: props.providers.some((p) => p.health === "healthy") ? "good" : "neutral" },
    { id: "issues", label: "Issues", value: String(props.providers.filter(providerHasIssue).length), tone: props.providers.some(providerHasIssue) ? "warn" : "neutral" },
    { id: "connected", label: "Connected", value: String(props.providers.filter((p) => p.connectivity === "connected").length), tone: props.providers.some((p) => p.connectivity === "connected") ? "good" : "neutral" },
  ];

  const kindUniverse = useMemo(() => [...new Set(props.providers.map((p) => p.kind))].sort((a, b) => a.localeCompare(b)), [props.providers]);

  return (
    <section className="flex h-full min-h-0 flex-col rounded-[2rem] border border-zinc-800 bg-zinc-900/70 shadow-xl">
      <div className="border-b border-zinc-800 px-5 py-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Providers</div>
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
              icon={metric.id === "issues" ? <AlertTriangle className="h-4 w-4" /> : metric.id === "connected" ? <Cloud className="h-4 w-4" /> : <Gauge className="h-4 w-4" />}
            />
          ))}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <ToggleChip label="Issues only" active={showOnlyIssues} icon={<AlertTriangle className="h-3.5 w-3.5" />} onClick={props.onToggleShowOnlyIssues ? () => props.onToggleShowOnlyIssues?.(!showOnlyIssues) : undefined} />
          {kindUniverse.map((kind) => {
            const active = localKinds.includes(kind);
            return (
              <ToggleChip
                key={kind}
                label={kind}
                active={active}
                icon={providerIcon(kind as ProviderKind)}
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
                Hydrating provider posture…
              </div>
            </motion.div>
          ) : visibleProviders.length > 0 ? (
            <motion.div key="providers" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.16 }} className="grid gap-5 xl:grid-cols-[0.95fr_1.05fr]">
              <div className="space-y-2">
                {visibleProviders.map((provider) => {
                  const selected = selectedProvider?.id === provider.id;
                  return (
                    <button
                      key={provider.id}
                      onClick={() => {
                        setLocalSelectedId(provider.id);
                        props.onSelectProvider?.(provider);
                      }}
                      className={cx(
                        "flex w-full items-start gap-3 rounded-[1.5rem] border px-4 py-4 text-left shadow-sm transition",
                        selected ? "border-zinc-600 bg-zinc-800 text-zinc-50" : "border-zinc-800 bg-zinc-950/50 text-zinc-200 hover:bg-zinc-900",
                      )}
                    >
                      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-2 text-zinc-300">{providerIcon(provider.kind)}</div>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-semibold">{provider.label}</span>
                          <span className={cx("rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.2em]", healthTone(provider.health))}>{provider.health ?? "unknown"}</span>
                          <span className={cx("rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.2em]", connectivityTone(provider.connectivity))}>{provider.connectivity ?? "unknown"}</span>
                        </div>
                        {provider.subtitle ? <div className="mt-2 text-sm text-zinc-400">{provider.subtitle}</div> : null}
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                          <span>{provider.kind}</span>
                          {provider.latencyMs != null ? <span>{provider.latencyMs} ms</span> : null}
                          {provider.version ? <span>{provider.version}</span> : null}
                          {provider.endpointLabel ? <span>{provider.endpointLabel}</span> : null}
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 text-zinc-600" />
                    </button>
                  );
                })}
              </div>

              <div className="space-y-5">
                <section className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-5 shadow-lg">
                  <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Selected provider</div>
                  {selectedProvider ? (
                    <div className="mt-4 space-y-4">
                      <div>
                        <div className="text-lg font-semibold text-zinc-50">{selectedProvider.label}</div>
                        {selectedProvider.subtitle ? <div className="mt-2 text-sm leading-7 text-zinc-400">{selectedProvider.subtitle}</div> : null}
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Badge className={healthTone(selectedProvider.health)}>{selectedProvider.health ?? "unknown"}</Badge>
                        <Badge className={connectivityTone(selectedProvider.connectivity)}>{selectedProvider.connectivity ?? "unknown"}</Badge>
                        <Badge className={authTone(selectedProvider.authState)}>
                          <KeyRound className="h-3.5 w-3.5" />
                          {selectedProvider.authState ?? "unknown"}
                        </Badge>
                        <Badge className={trustTone(selectedProvider.trustLevel)}>
                          {trustIcon(selectedProvider.trustLevel)}
                          {selectedProvider.trustLevel ?? "unknown"}
                        </Badge>
                        {selectedProvider.available === false ? <Badge className="border-rose-700/30 bg-rose-500/10 text-rose-300">unavailable</Badge> : null}
                      </div>

                      {selectedProvider.attentionMessage ? (
                        <div className="rounded-[1.25rem] border border-amber-700/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                          {selectedProvider.attentionMessage}
                        </div>
                      ) : null}

                      <div className="grid gap-3 sm:grid-cols-2">
                        <MetricCard label="Latency" value={selectedProvider.latencyMs != null ? `${selectedProvider.latencyMs} ms` : "Unknown"} icon={<Gauge className="h-4 w-4" />} />
                        <MetricCard label="Version" value={selectedProvider.version ?? "Unknown"} icon={<Activity className="h-4 w-4" />} />
                        <MetricCard label="Endpoint" value={selectedProvider.endpointLabel ?? "Unknown"} icon={<Cloud className="h-4 w-4" />} />
                        <MetricCard label="Rate limit" value={selectedProvider.rateLimitLabel ?? "Unknown"} icon={<AlertTriangle className="h-4 w-4" />} />
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <ActionButton label="Reconnect" icon={<RefreshCw className="h-4 w-4" />} disabled={selectedProvider.connectivity === "connected"} onClick={props.onReconnectRequested ? () => props.onReconnectRequested?.(selectedProvider) : undefined} />
                        <ActionButton label="Open auth" icon={<KeyRound className="h-4 w-4" />} tone="secondary" onClick={props.onOpenAuthRequested ? () => props.onOpenAuthRequested?.(selectedProvider) : undefined} />
                      </div>
                    </div>
                  ) : (
                    <div className="mt-4 rounded-[1.5rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-5 text-sm text-zinc-500">
                      Select a visible provider to inspect its readiness, auth posture, and fallback capability surface.
                    </div>
                  )}
                </section>

                <section className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-5 shadow-lg">
                  <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Capabilities</div>
                  {selectedProvider && selectedProvider.capabilities && selectedProvider.capabilities.length > 0 ? (
                    <div className="mt-4 flex flex-wrap gap-2">
                      {selectedProvider.capabilities.map((capability) => (
                        <Badge
                          key={capability.id}
                          className={capability.enabled ? "border-emerald-700/30 bg-emerald-500/10 text-emerald-300" : "border-zinc-700/30 bg-zinc-500/10 text-zinc-400"}
                        >
                          {capability.enabled ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                          {capability.label}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-4 rounded-[1.5rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-5 text-sm text-zinc-500">
                      No explicit capability map is attached to the selected provider.
                    </div>
                  )}
                </section>

                <section className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-5 shadow-lg">
                  <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Fallbacks</div>
                  {selectedProvider && selectedProvider.fallbacks && selectedProvider.fallbacks.length > 0 ? (
                    <div className="mt-4 space-y-2">
                      {selectedProvider.fallbacks.map((fallback) => (
                        <div key={fallback.id} className="flex items-center justify-between gap-3 rounded-[1.25rem] border border-zinc-800 bg-zinc-950/50 px-4 py-3 text-sm text-zinc-200 shadow-sm">
                          <div className="flex items-center gap-3">
                            <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-2 text-zinc-300">
                              <Link2 className="h-4 w-4" />
                            </div>
                            <span>{fallback.label}</span>
                          </div>
                          {fallback.active ? <Badge className="border-emerald-700/30 bg-emerald-500/10 text-emerald-300">active</Badge> : <Badge className="border-zinc-700/30 bg-zinc-500/10 text-zinc-400">standby</Badge>}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-4 rounded-[1.5rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-5 text-sm text-zinc-500">
                      No fallback graph is attached to the selected provider.
                    </div>
                  )}
                </section>

                <section className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-5 shadow-lg">
                  <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Detail payload</div>
                  <pre className="mt-4 overflow-auto whitespace-pre-wrap break-words rounded-[1.5rem] border border-zinc-800 bg-zinc-950/50 p-4 font-mono text-xs leading-6 text-zinc-300 shadow-sm">
{prettyJson(selectedProvider?.detail)}
                  </pre>
                </section>
              </div>
            </motion.div>
          ) : (
            <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="grid min-h-[18rem] place-items-center rounded-[2rem] border border-dashed border-zinc-800 bg-zinc-950/30 p-8 text-center">
              <div className="max-w-xl">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-[1.5rem] border border-zinc-800 bg-zinc-950/60 text-zinc-400">
                  <Server className="h-6 w-6" />
                </div>
                <h3 className="mt-6 text-xl font-semibold text-zinc-100">No visible providers</h3>
                <p className="mt-3 text-sm leading-7 text-zinc-500">The current provider filters produced no visible dependencies. Relax issue or kind filters to continue inspection.</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="border-t border-zinc-800 px-4 py-3 text-xs text-zinc-500">
        <div className="flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-1"><Gauge className="h-3.5 w-3.5" /> readiness centralized</span>
          <span className="inline-flex items-center gap-1"><KeyRound className="h-3.5 w-3.5" /> auth posture explicit</span>
          <span className="inline-flex items-center gap-1"><Link2 className="h-3.5 w-3.5" /> fallbacks visible</span>
          <span className="inline-flex items-center gap-1"><RefreshCw className="h-3.5 w-3.5" /> refresh explicit</span>
        </div>
      </div>
    </section>
  );
}
