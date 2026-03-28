export type ObservabilityErrorSeverity = "info" | "warning" | "error" | "fatal";

export interface ObservabilityErrorDefinition {
  readonly code: string;
  readonly severity: ObservabilityErrorSeverity;
  readonly title: string;
  readonly description: string;
  readonly retryable: boolean;
}

export interface ObservabilityErrorRecord {
  readonly code: string;
  readonly message: string;
  readonly severity: ObservabilityErrorSeverity;
  readonly occurredAt: string;
  readonly component: string;
  readonly context?: Readonly<Record<string, string>>;
}

export const OBSERVABILITY_ERROR_DEFINITIONS: readonly ObservabilityErrorDefinition[] = [
  {
    code: "OBS_CONFIG_INVALID",
    severity: "error",
    title: "Invalid Observability Configuration",
    description: "The observability subsystem received malformed or incomplete configuration.",
    retryable: false
  },
  {
    code: "OBS_EVENT_REJECTED",
    severity: "warning",
    title: "Event Rejected",
    description: "An event payload failed validation and was rejected before emission.",
    retryable: true
  },
  {
    code: "OBS_METRIC_OVERFLOW",
    severity: "error",
    title: "Metric Overflow",
    description: "A metric exceeded an allowed boundary or cardinality limit.",
    retryable: true
  },
  {
    code: "OBS_TRACE_BROKEN",
    severity: "fatal",
    title: "Broken Trace Chain",
    description: "A required trace parent-child relationship could not be reconstructed.",
    retryable: false
  }
] as const;

export function assertObservabilityErrorCode(value: string): void {
  if (!OBSERVABILITY_ERROR_DEFINITIONS.some((entry) => entry.code === value)) {
    throw new Error(`unknown observability error code: ${value}`);
  }
}

export function assertObservabilityErrorRecord(value: ObservabilityErrorRecord): void {
  assertObservabilityErrorCode(value.code);
  if (!["info", "warning", "error", "fatal"].includes(value.severity)) {
    throw new Error("observabilityErrorRecord.severity is invalid");
  }
  if (value.message.trim().length === 0) {
    throw new Error("observabilityErrorRecord.message must be non-empty");
  }
  if (value.occurredAt.trim().length === 0) {
    throw new Error("observabilityErrorRecord.occurredAt must be non-empty");
  }
  if (value.component.trim().length === 0) {
    throw new Error("observabilityErrorRecord.component must be non-empty");
  }
  if (value.context) {
    for (const [key, entry] of Object.entries(value.context)) {
      if (key.trim().length === 0 || entry.trim().length === 0) {
        throw new Error("observabilityErrorRecord.context entries must be non-empty");
      }
    }
  }
}

export function lookupObservabilityErrorDefinition(
  code: string
): ObservabilityErrorDefinition | undefined {
  return OBSERVABILITY_ERROR_DEFINITIONS.find((entry) => entry.code === code);
}
