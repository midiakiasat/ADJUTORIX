import React, { useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  BadgeCheck,
  BookOpen,
  Boxes,
  Cpu,
  FileText,
  Fingerprint,
  GitBranch,
  Globe,
  HardDrive,
  Hash,
  Info,
  Layers3,
  Lock,
  RefreshCw,
  Scale,
  ScrollText,
  Server,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Sparkles,
  TerminalSquare,
  Wrench,
} from "lucide-react";

/**
 * ADJUTORIX APP — RENDERER / COMPONENTS / AboutPanel.tsx
 *
 * Canonical system identity / provenance / invariants surface.
 *
 * Purpose:
 * - provide the authoritative renderer-side panel for product identity, build provenance,
 *   runtime composition, compatibility posture, and governing invariants
 * - unify version metadata, build hashes, protocol surfaces, environment fingerprints,
 *   repository lineage, legal/license context, and operational guarantees under one
 *   deterministic component contract
 * - prevent "about" from degrading into decorative copy detached from the exact artifact
 *   and trust boundary the operator is running
 * - expose explicit open-documentation / refresh / inspect actions upward without hidden I/O
 *
 * Architectural role:
 * - AboutPanel is a static-but-authoritative truth surface over declared application metadata
 * - it should remain useful in production, development, portable, air-gapped, degraded,
 *   or partially connected environments
 * - it should answer: what is this build, what invariants does it claim, what runtime is it on,
 *   and what protocol or governance posture is currently in effect
 *
 * Hard invariants:
 * - identity, version, build, and provenance fields are explicit and never inferred stylistically
 * - invariants are displayed as declared guarantees, not marketing claims
 * - runtime, protocol, and governance metadata annotate the current artifact without mutating it
 * - all actions map to explicit callbacks or explicit disabled state
 * - identical props yield identical ordering, labels, and values
 * - no placeholders, fake release notes, or hidden refresh side effects
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type AboutHealth = "healthy" | "degraded" | "unhealthy" | "unknown";
export type AboutTrustLevel = "unknown" | "untrusted" | "restricted" | "trusted";
export type AboutMetricTone = "neutral" | "good" | "warn" | "bad";
export type AboutLinkKind = "docs" | "repo" | "license" | "changelog" | "protocol" | "custom";

export type AboutMetric = {
  id: string;
  label: string;
  value: string;
  tone?: AboutMetricTone;
};

export type AboutInvariant = {
  id: string;
  title: string;
  summary: string;
  severity?: "core" | "important" | "advisory";
};

export type AboutLink = {
  id: string;
  label: string;
  kind?: AboutLinkKind;
  hrefLabel?: string | null;
  enabled?: boolean;
};

export type AboutSectionField = {
  id: string;
  label: string;
  value: string;
  emphasized?: boolean;
};

export type AboutSection = {
  id: string;
  title: string;
  subtitle?: string | null;
  icon?: "identity" | "build" | "runtime" | "protocol" | "legal" | "governance" | "environment" | "storage" | "custom";
  fields: AboutSectionField[];
};

export type AboutPanelProps = {
  title?: string;
  subtitle?: string;
  health?: AboutHealth;
  trustLevel?: AboutTrustLevel;
  loading?: boolean;
  appName: string;
  appTagline?: string | null;
  version: string;
  buildChannel?: string | null;
  buildHash?: string | null;
  releaseDate?: string | null;
  protocolVersion?: string | null;
  repoRevision?: string | null;
  copyrightLine?: string | null;
  licenseName?: string | null;
  metrics?: AboutMetric[];
  invariants?: AboutInvariant[];
  links?: AboutLink[];
  sections?: AboutSection[];
  onRefreshRequested?: () => void;
  onOpenLinkRequested?: (link: AboutLink) => void;
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function healthTone(level: AboutHealth | undefined): string {
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

function trustTone(level: AboutTrustLevel | undefined): string {
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

function trustIcon(level: AboutTrustLevel | undefined): JSX.Element {
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

function metricTone(tone?: AboutMetricTone): string {
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

function invariantTone(severity?: AboutInvariant["severity"]): string {
  switch (severity) {
    case "core":
      return "border-emerald-700/30 bg-emerald-500/10 text-emerald-200";
    case "important":
      return "border-amber-700/30 bg-amber-500/10 text-amber-200";
    default:
      return "border-zinc-800 bg-zinc-950/60 text-zinc-200";
  }
}

function linkIcon(kind?: AboutLinkKind): JSX.Element {
  switch (kind) {
    case "docs":
      return <BookOpen className="h-4 w-4" />;
    case "repo":
      return <GitBranch className="h-4 w-4" />;
    case "license":
      return <Scale className="h-4 w-4" />;
    case "changelog":
      return <ScrollText className="h-4 w-4" />;
    case "protocol":
      return <Layers3 className="h-4 w-4" />;
    default:
      return <Globe className="h-4 w-4" />;
  }
}

function sectionIcon(kind?: AboutSection["icon"]): JSX.Element {
  switch (kind) {
    case "identity":
      return <BadgeCheck className="h-5 w-5" />;
    case "build":
      return <Hash className="h-5 w-5" />;
    case "runtime":
      return <Cpu className="h-5 w-5" />;
    case "protocol":
      return <Layers3 className="h-5 w-5" />;
    case "legal":
      return <Scale className="h-5 w-5" />;
    case "governance":
      return <ShieldCheck className="h-5 w-5" />;
    case "environment":
      return <TerminalSquare className="h-5 w-5" />;
    case "storage":
      return <HardDrive className="h-5 w-5" />;
    default:
      return <Info className="h-5 w-5" />;
  }
}

// -----------------------------------------------------------------------------
// SUBCOMPONENTS
// -----------------------------------------------------------------------------

function Badge(props: { className?: string; children: React.ReactNode }): JSX.Element {
  return <span className={cx("inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.2em]", props.className)}>{props.children}</span>;
}

function MetricCard(props: { label: string; value: string; tone?: AboutMetricTone; icon?: React.ReactNode }): JSX.Element {
  return (
    <div className={cx("rounded-[1.5rem] border p-4 shadow-sm", metricTone(props.tone))}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] opacity-70">{props.label}</div>
          <div className="mt-2 text-lg font-semibold tracking-tight">{props.value}</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-black/20 p-2.5 text-zinc-300">{props.icon ?? <Info className="h-4 w-4" />}</div>
      </div>
    </div>
  );
}

function LinkButton(props: { link: AboutLink; onOpen?: (link: AboutLink) => void }): JSX.Element {
  const enabled = props.link.enabled ?? true;
  return (
    <button
      onClick={() => props.onOpen?.(props.link)}
      disabled={!enabled || !props.onOpen}
      className={cx(
        "flex w-full items-start gap-3 rounded-[1.25rem] border px-4 py-4 text-left shadow-sm transition",
        enabled && props.onOpen
          ? "border-zinc-800 bg-zinc-950/60 text-zinc-200 hover:bg-zinc-900"
          : "cursor-not-allowed border-zinc-800 bg-zinc-950/40 text-zinc-500",
      )}
    >
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-2 text-zinc-300">{linkIcon(props.link.kind)}</div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{props.link.label}</div>
        {props.link.hrefLabel ? <div className="mt-1 truncate text-xs text-zinc-500">{props.link.hrefLabel}</div> : null}
      </div>
    </button>
  );
}

// -----------------------------------------------------------------------------
// MAIN COMPONENT
// -----------------------------------------------------------------------------

export default function AboutPanel(props: AboutPanelProps): JSX.Element {
  const title = props.title ?? "About ADJUTORIX";
  const subtitle =
    props.subtitle ??
    "Authoritative identity, provenance, build, runtime, governance, and compatibility posture for the current artifact.";

  const health = props.health ?? "unknown";
  const trustLevel = props.trustLevel ?? "unknown";
  const loading = props.loading ?? false;

  const metrics = props.metrics ?? [
    { id: "version", label: "Version", value: props.version, tone: "good" },
    { id: "channel", label: "Channel", value: props.buildChannel ?? "unknown", tone: "neutral" },
    { id: "protocol", label: "Protocol", value: props.protocolVersion ?? "unknown", tone: "neutral" },
    { id: "build", label: "Build hash", value: props.buildHash ?? "unknown", tone: "neutral" },
  ];

  const invariants = props.invariants ?? [
    {
      id: "no-invisible-action",
      title: "No invisible action",
      summary: "All consequential operations must be surfaced through explicit user-visible state, requests, or artifacts.",
      severity: "core",
    },
    {
      id: "no-unverifiable-claim",
      title: "No unverifiable claim",
      summary: "Claims about mutation, verification, lineage, or state must be bound to inspectable evidence.",
      severity: "core",
    },
    {
      id: "no-ambiguous-state",
      title: "No ambiguous state",
      summary: "Lifecycle, preview, verify, apply, and replay posture must remain explicit at all governed boundaries.",
      severity: "important",
    },
    {
      id: "no-hidden-authority",
      title: "No hidden authority",
      summary: "Authority, capability, and trust constraints must remain visible where they affect actionability.",
      severity: "important",
    },
  ];

  const links = props.links ?? [
    { id: "docs", label: "Documentation", kind: "docs", hrefLabel: "Internal docs surface", enabled: true },
    { id: "repo", label: "Repository lineage", kind: "repo", hrefLabel: props.repoRevision ?? "Unknown revision", enabled: true },
    { id: "license", label: "License", kind: "license", hrefLabel: props.licenseName ?? "Unknown license", enabled: true },
  ];

  const sections = props.sections ?? [
    {
      id: "identity",
      title: "Artifact identity",
      subtitle: "Exact product/build identity currently loaded in the renderer.",
      icon: "identity",
      fields: [
        { id: "app-name", label: "Application", value: props.appName, emphasized: true },
        { id: "tagline", label: "Tagline", value: props.appTagline ?? "Governed coding and verification workbench." },
        { id: "version", label: "Version", value: props.version },
        { id: "channel", label: "Channel", value: props.buildChannel ?? "Unknown" },
      ],
    },
    {
      id: "build",
      title: "Build provenance",
      subtitle: "Build-time identifiers and repository lineage for the running artifact.",
      icon: "build",
      fields: [
        { id: "build-hash", label: "Build hash", value: props.buildHash ?? "Unknown", emphasized: true },
        { id: "repo-revision", label: "Repository revision", value: props.repoRevision ?? "Unknown" },
        { id: "release-date", label: "Release date", value: props.releaseDate ?? "Unknown" },
        { id: "protocol-version", label: "Protocol version", value: props.protocolVersion ?? "Unknown" },
      ],
    },
    {
      id: "legal",
      title: "Legal and notice context",
      subtitle: "License and attribution posture attached to this artifact.",
      icon: "legal",
      fields: [
        { id: "license", label: "License", value: props.licenseName ?? "Unknown" },
        { id: "copyright", label: "Copyright", value: props.copyrightLine ?? "Not declared" },
      ],
    },
  ];

  return (
    <section className="flex h-full min-h-0 flex-col rounded-[2rem] border border-zinc-800 bg-zinc-900/70 shadow-xl">
      <div className="border-b border-zinc-800 px-5 py-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">System identity</div>
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
              <RefreshCw className={cx("h-4 w-4", loading && "animate-spin")} />
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
              icon={metric.id === "version" ? <BadgeCheck className="h-4 w-4" /> : metric.id === "channel" ? <Sparkles className="h-4 w-4" /> : metric.id === "protocol" ? <Layers3 className="h-4 w-4" /> : <Hash className="h-4 w-4" />}
            />
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
        <AnimatePresence mode="wait">
          {loading ? (
            <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="grid min-h-[18rem] place-items-center rounded-[2rem] border border-zinc-800 bg-zinc-950/30">
              <div className="flex items-center gap-3 text-sm text-zinc-300">
                <RefreshCw className="h-4 w-4 animate-spin" />
                Hydrating system identity surface…
              </div>
            </motion.div>
          ) : (
            <motion.div key="about" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.16 }} className="space-y-5">
              <div className="grid gap-5 xl:grid-cols-[1.02fr_0.98fr]">
                <div className="space-y-5">
                  {sections.map((section) => (
                    <section key={section.id} className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-5 shadow-lg">
                      <div className="flex items-start gap-3">
                        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-3 text-zinc-300">{sectionIcon(section.icon)}</div>
                        <div className="min-w-0 flex-1">
                          <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Section</div>
                          <h3 className="mt-1 text-lg font-semibold text-zinc-50">{section.title}</h3>
                          {section.subtitle ? <p className="mt-2 text-sm leading-7 text-zinc-400">{section.subtitle}</p> : null}
                        </div>
                      </div>

                      <div className="mt-4 grid gap-3 sm:grid-cols-2">
                        {section.fields.map((field) => (
                          <div key={field.id} className="rounded-[1.5rem] border border-zinc-800 bg-zinc-950/60 p-4 shadow-sm sm:odd:col-span-1">
                            <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">{field.label}</div>
                            <div className={cx("mt-2 text-sm text-zinc-200", field.emphasized && "text-lg font-semibold text-zinc-50")}>{field.value}</div>
                          </div>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>

                <div className="space-y-5">
                  <section className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-5 shadow-lg">
                    <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Core invariants</div>
                    <div className="mt-4 space-y-3">
                      {invariants.map((invariant) => (
                        <div key={invariant.id} className={cx("rounded-[1.5rem] border p-4 shadow-sm", invariantTone(invariant.severity))}>
                          <div className="flex items-start gap-3">
                            <div className="rounded-xl border border-zinc-800 bg-black/20 p-2 text-current">
                              {invariant.severity === "core" ? <ShieldCheck className="h-4 w-4" /> : invariant.severity === "important" ? <AlertTriangle className="h-4 w-4" /> : <Info className="h-4 w-4" />}
                            </div>
                            <div>
                              <div className="text-sm font-semibold">{invariant.title}</div>
                              <div className="mt-2 text-sm leading-7 opacity-90">{invariant.summary}</div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section className="rounded-[2rem] border border-zinc-800 bg-zinc-950/40 p-5 shadow-lg">
                    <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">References</div>
                    <div className="mt-4 space-y-2">
                      {links.map((link) => (
                        <LinkButton key={link.id} link={link} onOpen={props.onOpenLinkRequested} />
                      ))}
                    </div>
                  </section>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="border-t border-zinc-800 px-4 py-3 text-xs text-zinc-500">
        <div className="flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-1"><BadgeCheck className="h-3.5 w-3.5" /> artifact identity explicit</span>
          <span className="inline-flex items-center gap-1"><Hash className="h-3.5 w-3.5" /> build provenance visible</span>
          <span className="inline-flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5" /> invariants surfaced</span>
          <span className="inline-flex items-center gap-1"><Layers3 className="h-3.5 w-3.5" /> protocol posture explicit</span>
        </div>
      </div>
    </section>
  );
}
