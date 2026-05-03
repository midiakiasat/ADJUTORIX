export type OrderingInvariantInput = unknown;

export type OrderingInvariantResult = {
  ok: boolean;
  pass: boolean;
  passed: boolean;
  allowed: boolean;
  denied: boolean;
  violations: string[];
  errors: string[];
  reasons: string[];
  values: unknown[];
  [key: string]: unknown;
};

const STATE_ORDER: Record<string, number> = {
  created: 0,
  pending: 1,
  queued: 1,
  scheduled: 2,
  running: 3,
  verifying: 4,
  verified: 5,
  approved: 6,
  applying: 7,
  applied: 8,
  committed: 9,
  complete: 10,
  completed: 10,
  done: 10,
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function numeric(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string") {
    const direct = Number(value);
    if (Number.isFinite(direct)) return direct;

    const state = STATE_ORDER[value.toLowerCase()];
    if (state !== undefined) return state;

    const time = Date.parse(value);
    if (Number.isFinite(time)) return time;
  }

  const record = asRecord(value);
  const candidate =
    record.order ??
    record.sequence ??
    record.seq ??
    record.index ??
    record.position ??
    record.timestamp ??
    record.time ??
    record.scheduledAt ??
    record.createdAt ??
    record.state ??
    record.status;

  if (candidate !== undefined) return numeric(candidate);

  return 0;
}

export function evaluateOrderingInvariant(input: OrderingInvariantInput = []): OrderingInvariantResult {
  const record = asRecord(input);
  const values = asArray(
    record.values ??
      record.sequence ??
      record.transitions ??
      record.events ??
      record.items ??
      (Array.isArray(input) ? input : undefined),
  );

  const ordered = values.map(numeric);
  const violations: string[] = [];

  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index] < ordered[index - 1]) {
      violations.push(`ordering regression at index ${index}: ${ordered[index - 1]} -> ${ordered[index]}`);
    }
  }

  const ok = violations.length === 0;

  return {
    ok,
    pass: ok,
    passed: ok,
    allowed: ok,
    denied: !ok,
    violations,
    errors: violations,
    reasons: violations,
    values,
  };
}

export default evaluateOrderingInvariant;
