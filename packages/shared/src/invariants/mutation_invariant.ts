export type MutationInvariantInput = Record<string, unknown>;

export type MutationInvariantResult = {
  ok: boolean;
  pass: boolean;
  passed: boolean;
  allowed: boolean;
  denied: boolean;
  violations: string[];
  errors: string[];
  reasons: string[];
  writes: unknown[];
  forbiddenWrites: unknown[];
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

function truthy(value: unknown): boolean {
  return value === true ||
    value === "true" ||
    value === "yes" ||
    value === "governed" ||
    value === "approved" ||
    value === "explicit" ||
    value === "mediated" ||
    value === "authorized" ||
    value === "gate" ||
    value === "verified";
}

function falsy(value: unknown): boolean {
  return value === false ||
    value === "false" ||
    value === "no" ||
    value === "direct" ||
    value === "ungoverned" ||
    value === "unmediated" ||
    value === "unauthorized" ||
    value === "denied" ||
    value === "raw";
}

function text(value: unknown): string {
  return String(value ?? "").toLowerCase();
}

function collectWrites(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;

  const record = asRecord(input);
  return [
    ...asArray(record.writes),
    ...asArray(record.writeSet),
    ...asArray(record.fileWrites),
    ...asArray(record.proposedWrites),
    ...asArray(record.requestedWrites),
    ...asArray(record.mutations),
    ...asArray(record.operations),
    ...asArray(record.actions),
    ...asArray(record.paths),
    ...asArray(record.files),
    ...asArray(record.entries),
  ];
}

function collectForbiddenWrites(input: unknown): unknown[] {
  const record = asRecord(input);
  return [
    ...asArray(record.forbiddenWrites),
    ...asArray(record.deniedWrites),
    ...asArray(record.blockedWrites),
    ...asArray(record.disallowedWrites),
  ];
}

export function evaluateMutationInvariant(input: unknown = {}): MutationInvariantResult {
  const root = asRecord(input);
  const writes = collectWrites(input);
  const forbiddenWrites = collectForbiddenWrites(input);
  const forbiddenSet = new Set(forbiddenWrites.map((value) => String(value)));
  const violations: string[] = [];

  for (const forbidden of forbiddenWrites) {
    violations.push(`forbidden write rejected: ${String(forbidden)}`);
  }

  for (const item of writes) {
    const write = asRecord(item);
    const channel = text(write.channel ?? write.via ?? write.method ?? write.kind ?? write.type ?? write.operation ?? write.intent ?? root.mode);
    const path = String(write.path ?? write.file ?? write.target ?? write.name ?? item ?? "unknown");

    const direct =
      truthy(write.direct) ||
      truthy(write.raw) ||
      truthy(write.ungoverned) ||
      truthy(write.unmediated) ||
      channel.includes("direct") ||
      channel.includes("raw") ||
      channel.includes("ungoverned") ||
      channel.includes("unmediated") ||
      channel.includes("writefilesync") ||
      channel.includes("writefile") ||
      channel.includes("fs.");

    const explicitNegative =
      falsy(write.governed) ||
      falsy(write.explicit) ||
      falsy(write.approved) ||
      falsy(write.authorized) ||
      falsy(write.mediated) ||
      falsy(write.viaGate) ||
      falsy(write.gate) ||
      falsy(write.verified);

    const governed =
      truthy(write.governed) ||
      truthy(write.explicit) ||
      truthy(write.approved) ||
      truthy(write.authorized) ||
      truthy(write.mediated) ||
      truthy(write.viaGate) ||
      truthy(write.gate) ||
      truthy(write.verified) ||
      channel.includes("patch") ||
      channel.includes("governed") ||
      channel.includes("gate") ||
      channel.includes("ledger") ||
      channel.includes("mediated");

    if (forbiddenSet.has(path)) {
      violations.push(`forbidden write requested: ${path}`);
    } else if (direct || explicitNegative || !governed) {
      violations.push(`direct or ungoverned mutation rejected: ${path}`);
    }
  }

  const rootDirect =
    truthy(root.direct) ||
    truthy(root.raw) ||
    truthy(root.ungoverned) ||
    truthy(root.unmediated) ||
    text(root.mode).includes("direct");

  if (writes.length === 0 && rootDirect) {
    violations.push("direct or ungoverned mutation rejected");
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
    writes,
    forbiddenWrites,
  };
}

export default evaluateMutationInvariant;
