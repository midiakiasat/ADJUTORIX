import type { LedgerArtifact } from "../ledger/artifact.js";
import type { LedgerEdge } from "../ledger/edges.js";
import type { LedgerTransaction } from "../ledger/transaction.js";

export interface LedgerInvariantResult {
  readonly ok: boolean;
  readonly violations: readonly string[];
}

export interface LedgerInvariantInput {
  readonly transactions: readonly LedgerTransaction[];
  readonly artifacts: readonly LedgerArtifact[];
  readonly edges: readonly LedgerEdge[];
}

export function evaluateLedgerInvariant(
  input: LedgerInvariantInput
): LedgerInvariantResult {
  const violations: string[] = [];
  const transactionIds = new Set(input.transactions.map((entry) => entry.id));
  const artifactIds = new Set(input.artifacts.map((entry) => entry.id));
  const transactionSequences = new Set(input.transactions.map((entry) => entry.sequence));
  const edgeSequenceSet = new Set<number>();

  for (const artifact of input.artifacts) {
    if (!transactionSequences.has(artifact.producedAtSequence)) {
      violations.push(
        `Artifact ${artifact.id} references unknown producedAtSequence ${artifact.producedAtSequence}.`
      );
    }
  }

  for (const edge of input.edges) {
    const fromKnown = transactionIds.has(edge.from) || artifactIds.has(edge.from);
    const toKnown = transactionIds.has(edge.to) || artifactIds.has(edge.to);

    if (!fromKnown) {
      violations.push(`Edge ${edge.id} has unknown from ${edge.from}.`);
    }
    if (!toKnown) {
      violations.push(`Edge ${edge.id} has unknown to ${edge.to}.`);
    }
    if (edgeSequenceSet.has(edge.sequence)) {
      violations.push(`Duplicate ledger edge sequence detected: ${edge.sequence}.`);
    }
    edgeSequenceSet.add(edge.sequence);
  }

  return {
    ok: violations.length === 0,
    violations
  };
}
