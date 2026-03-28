import type { LedgerArtifact } from "./artifact.js";
import type { LedgerEdge } from "./edges.js";
import type { LedgerTransaction, TransactionState } from "./transaction.js";

export interface TransactionStateCount {
  readonly state: TransactionState;
  readonly count: number;
}

export interface LedgerOverview {
  readonly transactionCount: number;
  readonly artifactCount: number;
  readonly edgeCount: number;
  readonly stateCounts: readonly TransactionStateCount[];
}

export function buildLedgerOverview(
  transactions: readonly LedgerTransaction[],
  artifacts: readonly LedgerArtifact[],
  edges: readonly LedgerEdge[]
): LedgerOverview {
  const counters = new Map<TransactionState, number>();

  for (const transaction of transactions) {
    counters.set(transaction.state, (counters.get(transaction.state) ?? 0) + 1);
  }

  const stateCounts = [...counters.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([state, count]) => ({ state, count }));

  return {
    transactionCount: transactions.length,
    artifactCount: artifacts.length,
    edgeCount: edges.length,
    stateCounts
  };
}
