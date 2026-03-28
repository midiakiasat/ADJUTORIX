export type MetricType = "counter" | "gauge" | "histogram";

export interface MetricDefinition {
  readonly name: string;
  readonly type: MetricType;
  readonly description: string;
  readonly unit: string;
}

export interface MetricSample {
  readonly name: string;
  readonly value: number;
  readonly recordedAt: string;
  readonly labels?: Readonly<Record<string, string>>;
}

export const CORE_METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  {
    name: "adjutorix_jobs_running",
    type: "gauge",
    description: "Number of currently running jobs.",
    unit: "count"
  },
  {
    name: "adjutorix_patch_apply_total",
    type: "counter",
    description: "Total number of patch apply attempts.",
    unit: "count"
  },
  {
    name: "adjutorix_verify_duration_ms",
    type: "histogram",
    description: "Verification runtime duration in milliseconds.",
    unit: "ms"
  },
  {
    name: "adjutorix_workspace_files_indexed",
    type: "gauge",
    description: "Number of indexed workspace files.",
    unit: "count"
  }
] as const;

export function assertMetricName(value: string): void {
  if (!CORE_METRIC_DEFINITIONS.some((entry) => entry.name === value)) {
    throw new Error(`unknown metric name: ${value}`);
  }
}

export function assertMetricSample(value: MetricSample): void {
  assertMetricName(value.name);
  if (!Number.isFinite(value.value)) {
    throw new Error("metricSample.value must be finite");
  }
  if (value.recordedAt.trim().length === 0) {
    throw new Error("metricSample.recordedAt must be non-empty");
  }
  if (value.labels) {
    for (const [key, entry] of Object.entries(value.labels)) {
      if (key.trim().length === 0 || entry.trim().length === 0) {
        throw new Error("metricSample.labels entries must be non-empty");
      }
    }
  }
}

export function aggregateCounterSamples(values: readonly MetricSample[]): number {
  return values.reduce((total, value) => total + value.value, 0);
}
