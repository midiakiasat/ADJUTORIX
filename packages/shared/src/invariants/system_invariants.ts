import {
  evaluateGovernanceInvariant,
} from "./governance_invariant.js";
import {
  evaluateLedgerInvariant,
} from "./ledger_invariant.js";
import {
  evaluateMutationInvariant,
} from "./mutation_invariant.js";
import {
  evaluateOrderingInvariant,
} from "./ordering_invariant.js";
import {
  evaluateTransactionInvariant,
} from "./transaction_invariant.js";
import {
  evaluateVerifyInvariant,
} from "./verify_invariant.js";

export type SystemInvariantInput = Record<string, unknown>;

export type SystemInvariantResult = {
  ok: boolean;
  pass: boolean;
  passed: boolean;
  allowed: boolean;
  denied: boolean;
  violations: string[];
  errors: string[];
  reasons: string[];
  checks: Record<string, unknown>;
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

function collectRendererIsolationViolations(input: Record<string, unknown>): string[] {
  const renderer = asRecord(input.renderer ?? input.rendererIsolation ?? input.ui ?? input.webview);
  const violations: string[] = [];

  const capabilities = [
    ...asArray(renderer.capabilities),
    ...asArray(renderer.permissions),
    ...asArray(renderer.exposed),
    ...asArray(input.capabilities),
  ].map(text);

  for (const capability of capabilities) {
    if (
      capability.includes("fs") ||
      capability.includes("filesystem") ||
      capability.includes("child_process") ||
      capability.includes("shell") ||
      capability.includes("nodeintegration") ||
      capability.includes("node_integration") ||
      capability.includes("ipcmain")
    ) {
      violations.push(`renderer isolation violation: ${capability}`);
    }
  }

  const flags = [
    ["nodeIntegration", renderer.nodeIntegration],
    ["contextIsolation", renderer.contextIsolation],
    ["sandbox", renderer.sandbox],
    ["directFileSystemAccess", renderer.directFileSystemAccess ?? renderer.fsAccess],
    ["shellAccess", renderer.shellAccess],
  ] as const;

  for (const [name, value] of flags) {
    if (name === "contextIsolation" || name === "sandbox") {
      if (value === false || value === "false") violations.push(`renderer isolation violation: ${name} disabled`);
    } else if (value === true || value === "true") {
      violations.push(`renderer isolation violation: ${name} enabled`);
    }
  }

  return violations;
}

function collectViolations(value: unknown): string[] {
  const record = asRecord(value);
  return [
    ...asArray(record.violations),
    ...asArray(record.errors),
    ...asArray(record.reasons),
  ].map(String).filter(Boolean);
}

function resultOk(value: unknown): boolean {
  const record = asRecord(value);
  if (typeof record.ok === "boolean") return record.ok;
  if (typeof record.pass === "boolean") return record.pass;
  if (typeof record.passed === "boolean") return record.passed;
  if (typeof record.allowed === "boolean") return record.allowed;
  if (typeof record.denied === "boolean") return !record.denied;
  return collectViolations(record).length === 0;
}

export function evaluateSystemInvariants(input: unknown = {}): SystemInvariantResult {
  const record = asRecord(input);

  const mutationInput =
    record.mutation ??
    record.mutations ??
    record.writes ??
    record.proposedWrites ??
    record.fileWrites ??
    record.operations ??
    {};

  const transactionInput =
    record.transactions ??
    record.transaction ??
    [];

  const ledgerRecord = asRecord(record.ledger ?? {});
  const ledgerInput = {
    transactions: asArray(ledgerRecord.transactions ?? record.ledgerTransactions ?? []),
    artifacts: asArray(ledgerRecord.artifacts ?? record.ledgerArtifacts ?? []),
    edges: asArray(ledgerRecord.edges ?? record.ledgerEntries ?? record.edges ?? []),
  } as Parameters<typeof evaluateLedgerInvariant>[0];

  const orderingInput =
    record.ordering ??
    record.edges ??
    record.sequence ??
    record.transitions ??
    [];

  const governanceInput =
    record.governance ??
    {
      action: record.action,
      target: record.target,
      approved: record.approved,
      approval: record.approval,
      denied: record.denied,
    };

  const verifyInput =
    record.verify ??
    record.verification ??
    {
      required: record.required,
      checks: record.checks,
      missing: record.missing,
    };

  const checks: Record<string, unknown> = {
    mutation: evaluateMutationInvariant(mutationInput),
    transaction: evaluateTransactionInvariant(transactionInput),
    ledger: evaluateLedgerInvariant(ledgerInput),
    ordering: evaluateOrderingInvariant(orderingInput),
    governance: evaluateGovernanceInvariant(governanceInput),
    verify: evaluateVerifyInvariant(verifyInput),
  };

  const violations = [
    ...Object.values(checks).flatMap(collectViolations),
    ...collectRendererIsolationViolations(record),
  ];

  const ok = Object.values(checks).every(resultOk) && violations.length === 0;

  return {
    ok,
    pass: ok,
    passed: ok,
    allowed: ok,
    denied: !ok,
    violations,
    errors: violations,
    reasons: violations,
    checks,
  };
}

export default evaluateSystemInvariants;
