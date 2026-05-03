export type VerifyInvariantInput = Record<string, unknown>;

export type VerifyInvariantResult = {
  ok: boolean;
  pass: boolean;
  passed: boolean;
  allowed: boolean;
  denied: boolean;
  violations: string[];
  errors: string[];
  reasons: string[];
  missing: string[];
  required: string[];
  present: string[];
  [key: string]: unknown;
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

function nameOf(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  return String(record.name ?? record.id ?? record.check ?? record.phase ?? record.task ?? "");
}

function passed(value: unknown): boolean {
  if (typeof value === "string") return true;
  if (value === true) return true;

  const record = asRecord(value);
  const status = String(record.status ?? record.conclusion ?? record.result ?? record.state ?? "").toLowerCase();

  if (record.ok === true || record.pass === true || record.passed === true || record.success === true) return true;
  if (["ok", "pass", "passed", "success", "successful", "complete", "completed"].includes(status)) return true;

  return false;
}

function stringList(value: unknown): string[] {
  return asArray(value).map(nameOf).filter(Boolean);
}

export function evaluateVerifyInvariant(input: unknown = {}): VerifyInvariantResult {
  const record = asRecord(input);
  const policy = asRecord(record.policy);
  const verification = asRecord(record.verification);

  const required = stringList(
    record.required ??
      record.requiredChecks ??
      record.requiredPhases ??
      policy.required ??
      policy.requiredChecks ??
      verification.required,
  );

  const checkValues = asArray(
    record.checks ??
      record.results ??
      record.phases ??
      verification.checks ??
      verification.results,
  );

  const present = new Set<string>();

  for (const check of checkValues) {
    const name = nameOf(check);
    if (name && passed(check)) present.add(name);
  }

  for (const [key, value] of Object.entries(record)) {
    if (["required", "requiredChecks", "requiredPhases", "checks", "results", "phases", "policy", "verification"].includes(key)) continue;
    if (passed(value)) present.add(key);
  }

  const explicitMissing = stringList(record.missing ?? verification.missing);
  const missing = [
    ...required.filter((name) => !present.has(name)),
    ...explicitMissing,
  ].filter((value, index, array) => array.indexOf(value) === index);

  const violations = missing.map((name) => `required verification check missing: ${name}`);
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
    missing,
    required,
    present: [...present],
  };
}

export default evaluateVerifyInvariant;
