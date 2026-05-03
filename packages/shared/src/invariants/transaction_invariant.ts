export type TransactionInvariantResult = {
  ok: boolean;
  pass: boolean;
  passed: boolean;
  allowed: boolean;
  denied: boolean;
  violations: string[];
  errors: string[];
  reasons: string[];
  transactions: unknown[];
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

function text(value: unknown): string {
  return String(value ?? "").toLowerCase();
}

export function evaluateTransactionInvariant(input: unknown = []): TransactionInvariantResult {
  const record = asRecord(input);
  const transactions = asArray(
    Array.isArray(input)
      ? input
      : record.transactions ?? record.items ?? record.events ?? record.entries,
  );

  const violations: string[] = [];

  for (const item of transactions) {
    const tx = asRecord(item);
    const id = String(tx.id ?? tx.transactionId ?? tx.name ?? "unknown");
    const state = text(tx.state ?? tx.status ?? tx.phase);

    if (state === "failed" || state === "error" || state === "invalid" || state === "rejected") {
      violations.push(`transaction rejected: ${id}`);
    }

    if ((tx.id === undefined && tx.transactionId === undefined) && Object.keys(tx).length > 0) {
      violations.push("transaction missing stable id");
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
    transactions,
  };
}

export default evaluateTransactionInvariant;
