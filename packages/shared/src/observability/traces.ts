export interface TraceSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly component: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

export interface TraceTreeNode {
  readonly span: TraceSpan;
  readonly children: readonly TraceTreeNode[];
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${field} must be non-empty`);
  }
}

export function assertTraceSpan(value: TraceSpan): void {
  assertNonEmpty(value.traceId, "traceSpan.traceId");
  assertNonEmpty(value.spanId, "traceSpan.spanId");
  assertNonEmpty(value.name, "traceSpan.name");
  assertNonEmpty(value.startedAt, "traceSpan.startedAt");
  assertNonEmpty(value.component, "traceSpan.component");
  if (value.parentSpanId !== undefined) {
    assertNonEmpty(value.parentSpanId, "traceSpan.parentSpanId");
  }
  if (value.endedAt !== undefined) {
    assertNonEmpty(value.endedAt, "traceSpan.endedAt");
  }
  if (value.attributes) {
    for (const [key, entry] of Object.entries(value.attributes)) {
      if (key.trim().length === 0 || entry.trim().length === 0) {
        throw new Error("traceSpan.attributes entries must be non-empty");
      }
    }
  }
}

export function rootTraceSpans(values: readonly TraceSpan[]): TraceSpan[] {
  return values.filter((value) => value.parentSpanId === undefined);
}

export function spanDurationMs(startedAtMs: number, endedAtMs: number): number {
  const duration = endedAtMs - startedAtMs;
  if (duration < 0) {
    throw new Error("trace span duration cannot be negative");
  }
  return duration;
}
