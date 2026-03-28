import type { SequenceNumber } from "./sequence.js";

export type TransactionState =
  | "submitted"
  | "scheduled"
  | "running"
  | "verifying"
  | "verified"
  | "applied"
  | "rolled-back"
  | "rejected"
  | "failed"
  | "cancelled";

export type TransactionIntent =
  | "open-workspace"
  | "scan-workspace"
  | "build-index"
  | "create-patch"
  | "apply-patch"
  | "reject-patch"
  | "rollback-patch"
  | "run-verify"
  | "replay-ledger"
  | "recover-state"
  | "governance-check";

export interface TransactionTiming {
  readonly submittedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

export interface LedgerTransaction {
  readonly id: string;
  readonly sequence: SequenceNumber;
  readonly intent: TransactionIntent;
  readonly state: TransactionState;
  readonly workspaceId: string;
  readonly actor: string;
  readonly summary: string;
  readonly timing: TransactionTiming;
  readonly labels: readonly string[];
  readonly metadata: Readonly<Record<string, string>>;
}

const LEGAL_TRANSITIONS: Readonly<Record<TransactionState, readonly TransactionState[]>> = {
  submitted: ["scheduled", "running", "rejected", "cancelled", "failed"],
  scheduled: ["running", "cancelled", "failed"],
  running: ["verifying", "applied", "failed", "cancelled"],
  verifying: ["verified", "failed"],
  verified: ["applied", "rolled-back", "failed"],
  applied: ["rolled-back"],
  "rolled-back": [],
  rejected: [],
  failed: [],
  cancelled: []
};

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${field} must be non-empty`);
  }
}

function assertIsoDateTime(value: string, field: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} must be an ISO-compatible datetime`);
  }
}

export function canTransitionTransactionState(
  current: TransactionState,
  next: TransactionState
): boolean {
  return LEGAL_TRANSITIONS[current].includes(next);
}

export function assertLedgerTransaction(transaction: LedgerTransaction): void {
  assertNonEmpty(transaction.id, "transaction.id");
  assertNonEmpty(transaction.workspaceId, "transaction.workspaceId");
  assertNonEmpty(transaction.actor, "transaction.actor");
  assertNonEmpty(transaction.summary, "transaction.summary");
  assertIsoDateTime(transaction.timing.submittedAt, "transaction.timing.submittedAt");
  if (transaction.timing.startedAt) {
    assertIsoDateTime(transaction.timing.startedAt, "transaction.timing.startedAt");
  }
  if (transaction.timing.finishedAt) {
    assertIsoDateTime(transaction.timing.finishedAt, "transaction.timing.finishedAt");
  }
  for (const label of transaction.labels) {
    assertNonEmpty(label, "transaction.labels[]");
  }
  for (const [key, value] of Object.entries(transaction.metadata)) {
    assertNonEmpty(key, "transaction.metadata key");
    assertNonEmpty(value, `transaction.metadata.${key}`);
  }
}

export function assertStateTransition(current: TransactionState, next: TransactionState): void {
  if (!canTransitionTransactionState(current, next)) {
    throw new Error(`illegal transaction transition: ${current} -> ${next}`);
  }
}
