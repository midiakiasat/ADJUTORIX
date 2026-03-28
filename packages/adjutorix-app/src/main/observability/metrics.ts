import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * ADJUTORIX APP — MAIN / OBSERVABILITY / metrics.ts
 *
 * Canonical in-process metrics subsystem for the Electron main process.
 *
 * Responsibilities:
 * - define typed counters, gauges, histograms, and timers
 * - enforce deterministic metric naming and label normalization
 * - maintain bounded cardinality and explicit registry ownership
 * - export stable snapshots for diagnostics, smoke tests, and logging
 * - support periodic flush to JSON without introducing hidden background state
 * - provide helper instrumentation for bootstrap, IPC, agent, window, menu flows
 *
 * Hard invariants:
 * - metric names are normalized and immutable after registration
 * - label keys/values are deterministic and bounded
 * - histograms use explicit bucket boundaries only
 * - snapshots are content-addressable and stable for identical metric state
 * - no renderer authority over main-process metric mutation
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type MetricKind = "counter" | "gauge" | "histogram";
export type MetricValue = number;
export type MetricLabelValue = string | number | boolean;
export type MetricLabels = Record<string, MetricLabelValue>;

export type MetricBase = {
  name: string;
  description: string;
  unit: string;
  kind: MetricKind;
};

export type CounterMetric = MetricBase & {
  kind: "counter";
  monotonic: true;
};

export type GaugeMetric = MetricBase & {
  kind: "gauge";
  monotonic: false;
};

export type HistogramMetric = MetricBase & {
  kind: "histogram";
  buckets: number[];
};

export type MetricDefinition = CounterMetric | GaugeMetric | HistogramMetric;

export type HistogramBucketSample = {
  le: number;
  count: number;
};

export type MetricSeriesSnapshot = {
  labels: Record<string, string>;
  value?: number;
  count?: number;
  sum?: number;
  min?: number;
  max?: number;
  buckets?: HistogramBucketSample[];
};

export type MetricSnapshot = {
  name: string;
  description: string;
  unit: string;
  kind: MetricKind;
  series: MetricSeriesSnapshot[];
};

export type RegistrySnapshot = {
  schema: 1;
  created_at_ms: number;
  exported_at_ms: number;
  metric_count: number;
  series_count: number;
  hash: string;
  metrics: MetricSnapshot[];
};

export type MetricsRegistryOptions = {
  maxSeriesPerMetric?: number;
  snapshotDir?: string;
  snapshotFileName?: string;
};

export type TimerStopResult = {
  duration_ms: number;
  labels: Record<string, string>;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const DEFAULT_MAX_SERIES_PER_METRIC = 128;
const DEFAULT_SNAPSHOT_FILE = "main-metrics.json";

const BUILTIN_HISTOGRAMS = {
  duration_ms: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  bytes: [64, 256, 1024, 4096, 16384, 65536, 262144, 1048576],
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`main:observability:metrics:${message}`);
  }
}

function stableJson(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(normalize);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      out[key] = normalize((v as Record<string, unknown>)[key]);
    }
    return out;
  };
  return JSON.stringify(normalize(value));
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function nowMs(): number {
  return Date.now();
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeMetricName(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/[^a-z0-9_:]+/g, "_").replace(/^_+|_+$/g, "");
  assert(/^[a-z_:][a-z0-9_:]*$/.test(normalized), `invalid_metric_name:${name}`);
  return normalized;
}

function normalizeDescription(description: string): string {
  const normalized = description.trim();
  assert(normalized.length > 0, "description_empty");
  return normalized;
}

function normalizeUnit(unit: string): string {
  const normalized = unit.trim().toLowerCase();
  assert(normalized.length > 0, "unit_empty");
  return normalized;
}

function normalizeLabels(labels: MetricLabels = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(labels).sort()) {
    const normalizedKey = key.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
    assert(/^[a-z][a-z0-9_]*$/.test(normalizedKey), `invalid_label_key:${key}`);
    const raw = labels[key];
    const value = typeof raw === "string" ? raw : typeof raw === "boolean" ? (raw ? "true" : "false") : String(raw);
    const normalizedValue = value.trim();
    assert(normalizedValue.length > 0, `invalid_label_value:${key}`);
    out[normalizedKey] = normalizedValue;
  }
  return out;
}

function seriesKey(labels: Record<string, string>): string {
  return stableJson(labels);
}

function sortedUniqueBuckets(buckets: number[]): number[] {
  const normalized = [...new Set(buckets.map((v) => {
    assert(Number.isFinite(v), "bucket_non_finite");
    assert(v >= 0, "bucket_negative");
    return v;
  }))].sort((a, b) => a - b);
  assert(normalized.length > 0, "histogram_buckets_empty");
  return normalized;
}

// -----------------------------------------------------------------------------
// SERIES STORAGE
// -----------------------------------------------------------------------------

type CounterSeries = {
  labels: Record<string, string>;
  value: number;
};

type GaugeSeries = {
  labels: Record<string, string>;
  value: number;
};

type HistogramSeries = {
  labels: Record<string, string>;
  count: number;
  sum: number;
  min: number | null;
  max: number | null;
  bucketCounts: number[];
};

type MetricStorage = {
  definition: MetricDefinition;
  series: Map<string, CounterSeries | GaugeSeries | HistogramSeries>;
};

// -----------------------------------------------------------------------------
// REGISTRY
// -----------------------------------------------------------------------------

export class MetricsRegistry {
  private readonly createdAtMs: number;
  private readonly maxSeriesPerMetric: number;
  private readonly snapshotDir?: string;
  private readonly snapshotFileName: string;
  private readonly metrics: Map<string, MetricStorage>;

  constructor(options: MetricsRegistryOptions = {}) {
    this.createdAtMs = nowMs();
    this.maxSeriesPerMetric = options.maxSeriesPerMetric ?? DEFAULT_MAX_SERIES_PER_METRIC;
    this.snapshotDir = options.snapshotDir;
    this.snapshotFileName = options.snapshotFileName ?? DEFAULT_SNAPSHOT_FILE;
    this.metrics = new Map();
  }

  registerCounter(name: string, description: string, unit = "count"): CounterMetric {
    const definition: CounterMetric = {
      name: normalizeMetricName(name),
      description: normalizeDescription(description),
      unit: normalizeUnit(unit),
      kind: "counter",
      monotonic: true,
    };
    this.register(definition);
    return definition;
  }

  registerGauge(name: string, description: string, unit = "value"): GaugeMetric {
    const definition: GaugeMetric = {
      name: normalizeMetricName(name),
      description: normalizeDescription(description),
      unit: normalizeUnit(unit),
      kind: "gauge",
      monotonic: false,
    };
    this.register(definition);
    return definition;
  }

  registerHistogram(name: string, description: string, unit: string, buckets: number[]): HistogramMetric {
    const definition: HistogramMetric = {
      name: normalizeMetricName(name),
      description: normalizeDescription(description),
      unit: normalizeUnit(unit),
      kind: "histogram",
      buckets: sortedUniqueBuckets(buckets),
    };
    this.register(definition);
    return definition;
  }

  increment(name: string, delta = 1, labels: MetricLabels = {}): void {
    const metric = this.lookup(name, "counter");
    assert(Number.isFinite(delta) && delta >= 0, "counter_delta_invalid");
    const series = this.getOrCreateCounterSeries(metric, labels);
    series.value += delta;
  }

  setGauge(name: string, value: number, labels: MetricLabels = {}): void {
    const metric = this.lookup(name, "gauge");
    assert(Number.isFinite(value), "gauge_value_invalid");
    const series = this.getOrCreateGaugeSeries(metric, labels);
    series.value = value;
  }

  adjustGauge(name: string, delta: number, labels: MetricLabels = {}): void {
    const metric = this.lookup(name, "gauge");
    assert(Number.isFinite(delta), "gauge_delta_invalid");
    const series = this.getOrCreateGaugeSeries(metric, labels);
    series.value += delta;
  }

  observe(name: string, value: number, labels: MetricLabels = {}): void {
    const metric = this.lookup(name, "histogram");
    assert(Number.isFinite(value) && value >= 0, "histogram_value_invalid");
    const series = this.getOrCreateHistogramSeries(metric, labels);
    series.count += 1;
    series.sum += value;
    series.min = series.min === null ? value : Math.min(series.min, value);
    series.max = series.max === null ? value : Math.max(series.max, value);

    metric.definition.buckets.forEach((le, index) => {
      if (value <= le) {
        series.bucketCounts[index] += 1;
      }
    });
  }

  startTimer(metricName: string, labels: MetricLabels = {}): { stop: (extraLabels?: MetricLabels) => TimerStopResult } {
    const startedAt = nowMs();
    const baseLabels = normalizeLabels(labels);

    return {
      stop: (extraLabels: MetricLabels = {}) => {
        const duration_ms = nowMs() - startedAt;
        const finalLabels = { ...baseLabels, ...normalizeLabels(extraLabels) };
        this.observe(metricName, duration_ms, finalLabels);
        return { duration_ms, labels: finalLabels };
      },
    };
  }

  snapshot(): RegistrySnapshot {
    const exportedAtMs = nowMs();
    const metrics = [...this.metrics.values()]
      .map((storage) => this.snapshotMetric(storage))
      .sort((a, b) => a.name.localeCompare(b.name));

    const series_count = metrics.reduce((acc, metric) => acc + metric.series.length, 0);
    const core = {
      schema: 1 as const,
      created_at_ms: this.createdAtMs,
      exported_at_ms: exportedAtMs,
      metric_count: metrics.length,
      series_count,
      metrics,
    };

    return {
      ...core,
      hash: sha256(stableJson(core)),
    };
  }

  flushSnapshot(): RegistrySnapshot {
    const snap = this.snapshot();
    if (this.snapshotDir) {
      ensureDir(this.snapshotDir);
      const out = path.join(this.snapshotDir, this.snapshotFileName);
      fs.writeFileSync(out, `${stableJson(snap)}\n`, "utf8");
    }
    return snap;
  }

  reset(): void {
    this.metrics.clear();
  }

  private register(definition: MetricDefinition): void {
    const existing = this.metrics.get(definition.name);
    if (existing) {
      assert(stableJson(existing.definition) === stableJson(definition), `metric_redefinition:${definition.name}`);
      return;
    }
    this.metrics.set(definition.name, {
      definition,
      series: new Map(),
    });
  }

  private lookup(name: string, kind: MetricKind): MetricStorage {
    const normalized = normalizeMetricName(name);
    const storage = this.metrics.get(normalized);
    assert(storage, `metric_not_registered:${normalized}`);
    assert(storage.definition.kind === kind, `metric_kind_mismatch:${normalized}`);
    return storage;
  }

  private enforceSeriesBound(storage: MetricStorage, key: string): void {
    if (storage.series.has(key)) return;
    assert(storage.series.size < this.maxSeriesPerMetric, `series_cardinality_exceeded:${storage.definition.name}`);
  }

  private getOrCreateCounterSeries(storage: MetricStorage, labels: MetricLabels): CounterSeries {
    const normalizedLabels = normalizeLabels(labels);
    const key = seriesKey(normalizedLabels);
    this.enforceSeriesBound(storage, key);
    if (!storage.series.has(key)) {
      storage.series.set(key, { labels: normalizedLabels, value: 0 } satisfies CounterSeries);
    }
    return storage.series.get(key) as CounterSeries;
  }

  private getOrCreateGaugeSeries(storage: MetricStorage, labels: MetricLabels): GaugeSeries {
    const normalizedLabels = normalizeLabels(labels);
    const key = seriesKey(normalizedLabels);
    this.enforceSeriesBound(storage, key);
    if (!storage.series.has(key)) {
      storage.series.set(key, { labels: normalizedLabels, value: 0 } satisfies GaugeSeries);
    }
    return storage.series.get(key) as GaugeSeries;
  }

  private getOrCreateHistogramSeries(storage: MetricStorage, labels: MetricLabels): HistogramSeries {
    const normalizedLabels = normalizeLabels(labels);
    const key = seriesKey(normalizedLabels);
    this.enforceSeriesBound(storage, key);
    if (!storage.series.has(key)) {
      const histogram = storage.definition as HistogramMetric;
      storage.series.set(key, {
        labels: normalizedLabels,
        count: 0,
        sum: 0,
        min: null,
        max: null,
        bucketCounts: histogram.buckets.map(() => 0),
      } satisfies HistogramSeries);
    }
    return storage.series.get(key) as HistogramSeries;
  }

  private snapshotMetric(storage: MetricStorage): MetricSnapshot {
    const definition = storage.definition;
    const series = [...storage.series.values()]
      .map((entry) => {
        if (definition.kind === "counter") {
          const counter = entry as CounterSeries;
          return {
            labels: counter.labels,
            value: counter.value,
          } satisfies MetricSeriesSnapshot;
        }

        if (definition.kind === "gauge") {
          const gauge = entry as GaugeSeries;
          return {
            labels: gauge.labels,
            value: gauge.value,
          } satisfies MetricSeriesSnapshot;
        }

        const histogram = definition as HistogramMetric;
        const sample = entry as HistogramSeries;
        return {
          labels: sample.labels,
          count: sample.count,
          sum: sample.sum,
          ...(sample.min !== null ? { min: sample.min } : {}),
          ...(sample.max !== null ? { max: sample.max } : {}),
          buckets: histogram.buckets.map((le, index) => ({
            le,
            count: sample.bucketCounts[index],
          })),
        } satisfies MetricSeriesSnapshot;
      })
      .sort((a, b) => stableJson(a.labels).localeCompare(stableJson(b.labels)));

    return {
      name: definition.name,
      description: definition.description,
      unit: definition.unit,
      kind: definition.kind,
      series,
    };
  }
}

// -----------------------------------------------------------------------------
// VALIDATION / SERIALIZATION
// -----------------------------------------------------------------------------

export function validateRegistrySnapshot(snapshot: RegistrySnapshot): void {
  assert(snapshot.schema === 1, "snapshot_schema_invalid");
  assert(Number.isFinite(snapshot.created_at_ms), "snapshot_created_at_invalid");
  assert(Number.isFinite(snapshot.exported_at_ms), "snapshot_exported_at_invalid");
  assert(Array.isArray(snapshot.metrics), "snapshot_metrics_invalid");

  const recomputedCore = {
    schema: 1 as const,
    created_at_ms: snapshot.created_at_ms,
    exported_at_ms: snapshot.exported_at_ms,
    metric_count: snapshot.metric_count,
    series_count: snapshot.series_count,
    metrics: snapshot.metrics,
  };

  assert(sha256(stableJson(recomputedCore)) === snapshot.hash, "snapshot_hash_drift");
}

export function serializeRegistrySnapshot(snapshot: RegistrySnapshot): string {
  validateRegistrySnapshot(snapshot);
  return stableJson(snapshot);
}

export function deserializeRegistrySnapshot(raw: string): RegistrySnapshot {
  const parsed = JSON.parse(raw) as RegistrySnapshot;
  validateRegistrySnapshot(parsed);
  return parsed;
}

// -----------------------------------------------------------------------------
// FACTORY / BUILTIN METRICS
// -----------------------------------------------------------------------------

export function createMetricsRegistry(options: MetricsRegistryOptions = {}): MetricsRegistry {
  return new MetricsRegistry(options);
}

export function registerBuiltinMainMetrics(registry: MetricsRegistry): void {
  registry.registerCounter("runtime_bootstrap_total", "Total runtime bootstrap attempts", "count");
  registry.registerCounter("runtime_bootstrap_failures_total", "Total runtime bootstrap failures", "count");
  registry.registerGauge("runtime_window_open", "Whether the main window currently exists", "bool");
  registry.registerGauge("runtime_agent_healthy", "Whether the managed/reused agent is currently healthy", "bool");
  registry.registerGauge("runtime_workspace_open", "Whether a workspace is currently open", "bool");
  registry.registerHistogram("runtime_bootstrap_duration_ms", "Bootstrap duration in milliseconds", "ms", BUILTIN_HISTOGRAMS.duration_ms);
  registry.registerHistogram("ipc_handler_duration_ms", "IPC handler latency in milliseconds", "ms", BUILTIN_HISTOGRAMS.duration_ms);
  registry.registerCounter("ipc_handler_invocations_total", "Total IPC handler invocations", "count");
  registry.registerCounter("ipc_handler_failures_total", "Total IPC handler failures", "count");
  registry.registerHistogram("agent_health_latency_ms", "Agent health probe latency in milliseconds", "ms", BUILTIN_HISTOGRAMS.duration_ms);
  registry.registerCounter("agent_health_checks_total", "Total agent health checks", "count");
  registry.registerCounter("window_events_total", "Total tracked window events", "count");
  registry.registerCounter("menu_actions_total", "Total menu actions invoked", "count");
  registry.registerHistogram("diagnostic_export_bytes", "Size of exported diagnostic payloads", "bytes", BUILTIN_HISTOGRAMS.bytes);
}

// -----------------------------------------------------------------------------
// INSTRUMENTATION HELPERS
// -----------------------------------------------------------------------------

export function recordBootstrapAttempt(registry: MetricsRegistry, phase: string, success: boolean, durationMs?: number): void {
  registry.increment("runtime_bootstrap_total", 1, { phase });
  if (!success) {
    registry.increment("runtime_bootstrap_failures_total", 1, { phase });
  }
  if (typeof durationMs === "number") {
    registry.observe("runtime_bootstrap_duration_ms", durationMs, { phase, success });
  }
}

export function recordIpcInvocation(registry: MetricsRegistry, channel: string, success: boolean, durationMs: number): void {
  registry.increment("ipc_handler_invocations_total", 1, { channel, success });
  if (!success) {
    registry.increment("ipc_handler_failures_total", 1, { channel });
  }
  registry.observe("ipc_handler_duration_ms", durationMs, { channel, success });
}

export function recordAgentHealth(registry: MetricsRegistry, ok: boolean, durationMs: number, status: number | null): void {
  registry.increment("agent_health_checks_total", 1, { ok, status: status ?? "none" });
  registry.observe("agent_health_latency_ms", durationMs, { ok, status: status ?? "none" });
  registry.setGauge("runtime_agent_healthy", ok ? 1 : 0);
}

export function recordWindowEvent(registry: MetricsRegistry, event: string, windowKind = "main"): void {
  registry.increment("window_events_total", 1, { event, window_kind: windowKind });
  if (event === "created") registry.setGauge("runtime_window_open", 1, { window_kind: windowKind });
  if (event === "closed") registry.setGauge("runtime_window_open", 0, { window_kind: windowKind });
}

export function recordMenuAction(registry: MetricsRegistry, action: string): void {
  registry.increment("menu_actions_total", 1, { action });
}

export function recordWorkspaceOpenState(registry: MetricsRegistry, isOpen: boolean): void {
  registry.setGauge("runtime_workspace_open", isOpen ? 1 : 0);
}

export function recordDiagnosticExport(registry: MetricsRegistry, bytes: number, kind: string): void {
  registry.observe("diagnostic_export_bytes", bytes, { kind });
}
