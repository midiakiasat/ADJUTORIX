import type { LedgerArtifact } from "../ledger/artifact.js";
import type { LedgerEdge } from "../ledger/edges.js";
import type { LedgerTransaction } from "../ledger/transaction.js";
import type { PatchArtifact } from "../patch/patch_artifact.js";
import type { RuntimeCapabilityProfile } from "../runtime/capabilities.js";
import {
  evaluateGovernanceInvariant,
  type GovernanceInvariantResult
} from "./governance_invariant.js";
import {
  evaluateLedgerInvariant,
  type LedgerInvariantResult
} from "./ledger_invariant.js";
import {
  evaluateMutationInvariant,
  type MutationInvariantResult,
  type MutationInvariantInput
} from "./mutation_invariant.js";
import {
  evaluateOrderingInvariant,
  type OrderingInvariantResult
} from "./ordering_invariant.js";
import {
  evaluateTransactionInvariant,
  type TransactionInvariantResult
} from "./transaction_invariant.js";
import {
  evaluateVerifyInvariant,
  type VerifyInvariantResult
} from "./verify_invariant.js";

export interface SystemInvariantInput {
  readonly transactions: readonly LedgerTransaction[];
  readonly artifacts: readonly LedgerArtifact[];
  readonly edges: readonly LedgerEdge[];
  readonly patchArtifact?: PatchArtifact;
  readonly directWriteDetected: boolean;
  readonly governedPaths: readonly string[];
  readonly changedPaths: readonly string[];
  readonly capabilityProfile: RuntimeCapabilityProfile;
  readonly requiresApproval: boolean;
  readonly approved: boolean;
  readonly deniedTargets: readonly string[];
  readonly verifyRequested: boolean;
  readonly verifyCompleted: boolean;
  readonly verifySuccess: boolean;
  readonly verifySummaryArtifactPresent: boolean;
  readonly diagnosticsCaptured: boolean;
}

export interface SystemInvariantReport {
  readonly ok: boolean;
  readonly mutation: MutationInvariantResult;
  readonly transaction: TransactionInvariantResult;
  readonly ledger: LedgerInvariantResult;
  readonly ordering: OrderingInvariantResult;
  readonly governance: GovernanceInvariantResult;
  readonly verify: VerifyInvariantResult;
  readonly violations: readonly string[];
}

export function evaluateSystemInvariants(
  input: SystemInvariantInput
): SystemInvariantReport {
  const mutationInput: MutationInvariantInput = {
    directWriteDetected: input.directWriteDetected,
    governedPaths: input.governedPaths,
    changedPaths: input.changedPaths,
    ...(input.patchArtifact ? { patchArtifact: input.patchArtifact } : {})
  };

  const mutation = evaluateMutationInvariant(mutationInput);
  const transaction = evaluateTransactionInvariant(input.transactions);
  const ledger = evaluateLedgerInvariant({
    transactions: input.transactions,
    artifacts: input.artifacts,
    edges: input.edges
  });
  const ordering = evaluateOrderingInvariant(input.edges);
  const governance = evaluateGovernanceInvariant({
    capabilityProfile: input.capabilityProfile,
    requiresApproval: input.requiresApproval,
    approved: input.approved,
    deniedTargets: input.deniedTargets,
    changedPaths: input.changedPaths
  });
  const verify = evaluateVerifyInvariant({
    requested: input.verifyRequested,
    completed: input.verifyCompleted,
    success: input.verifySuccess,
    summaryArtifactPresent: input.verifySummaryArtifactPresent,
    diagnosticsCaptured: input.diagnosticsCaptured
  });

  const violations = [
    ...mutation.violations,
    ...transaction.violations,
    ...ledger.violations,
    ...ordering.violations,
    ...governance.violations,
    ...verify.violations
  ];

  return {
    ok: violations.length === 0,
    mutation,
    transaction,
    ledger,
    ordering,
    governance,
    verify,
    violations
  };
}
