import type { LedgerTransaction } from "../ledger/transaction.js";

export interface TransactionInvariantResult {
  readonly ok: boolean;
  readonly violations: readonly string[];
}

const TERMINAL_STATES = new Set([
  "verified",
  "applied",
  "rolled-back",
  "rejected",
  "failed",
  "cancelled"
]);

export function evaluateTransactionInvariant(
  transactions: readonly LedgerTransaction[]
): TransactionInvariantResult {
  const violations: string[] = [];
  const seenIds = new Set<string>();

  for (const transaction of transactions) {
    if (seenIds.has(transaction.id)) {
      violations.push(`Duplicate transaction identifier: ${transaction.id}`);
    }
    seenIds.add(transaction.id);

    if (transaction.workspaceId.trim().length === 0) {
      violations.push(`Transaction ${transaction.id} has empty workspaceId.`);
    }

    if (transaction.timing.submittedAt.trim().length === 0) {
      violations.push(`Transaction ${transaction.id} has empty timing.submittedAt.`);
    }

    if (transaction.timing.finishedAt && !TERMINAL_STATES.has(transaction.state)) {
      violations.push(
        `Transaction ${transaction.id} has timing.finishedAt but is not terminal (${transaction.state}).`
      );
    }

    if (transaction.timing.startedAt && Date.parse(transaction.timing.startedAt) < Date.parse(transaction.timing.submittedAt)) {
      violations.push(
        `Transaction ${transaction.id} has timing.startedAt earlier than timing.submittedAt.`
      );
    }

    if (
      transaction.timing.startedAt &&
      transaction.timing.finishedAt &&
      Date.parse(transaction.timing.finishedAt) < Date.parse(transaction.timing.startedAt)
    ) {
      violations.push(
        `Transaction ${transaction.id} has timing.finishedAt earlier than timing.startedAt.`
      );
    }
  }

  return {
    ok: violations.length === 0,
    violations
  };
}
