import type { LedgerArtifact } from "./artifact.js";
import { artifactKey } from "./artifact.js";
import type { LedgerEdge } from "./edges.js";
import { assertLedgerEdge } from "./edges.js";
import type { SequenceNumber } from "./sequence.js";
import { assertStrictAscending, compareSequence, highestSequence } from "./sequence.js";
import type { LedgerTransaction } from "./transaction.js";
import { assertLedgerTransaction } from "./transaction.js";

export interface ReplaySnapshot {
  readonly transactions: readonly LedgerTransaction[];
  readonly artifacts: readonly LedgerArtifact[];
  readonly edges: readonly LedgerEdge[];
  readonly highestSequence: SequenceNumber;
}

export function buildReplaySnapshot(input: {
  readonly transactions: readonly LedgerTransaction[];
  readonly artifacts: readonly LedgerArtifact[];
  readonly edges: readonly LedgerEdge[];
}): ReplaySnapshot {
  for (const transaction of input.transactions) {
    assertLedgerTransaction(transaction);
  }

  for (const edge of input.edges) {
    assertLedgerEdge(edge);
  }

  const transactionSequences = input.transactions
    .map((entry) => entry.sequence)
    .sort(compareSequence);

  const edgeSequences = input.edges
    .map((entry) => entry.sequence)
    .sort(compareSequence);

  if (transactionSequences.length > 1) {
    assertStrictAscending(transactionSequences);
  }

  if (edgeSequences.length > 1) {
    assertStrictAscending(edgeSequences);
  }

  const allSequences = [...transactionSequences, ...edgeSequences];
  const highest = highestSequence(allSequences);

  const edgesByKind: Record<string, string[]> = {};
  for (const edge of input.edges) {
    if (!edgesByKind[edge.kind]) {
      edgesByKind[edge.kind] = [];
    }
    edgesByKind[edge.kind]!.push(`${edge.from}->${edge.to}`);
  }

  for (const artifact of input.artifacts) {
    artifactKey(artifact);
  }

  return {
    transactions: input.transactions,
    artifacts: input.artifacts,
    edges: input.edges,
    highestSequence: highest
  };
}
