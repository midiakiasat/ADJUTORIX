// @ts-nocheck
import React from "react";

const LOCAL_OPERATOR_CONTROL_INVARIANTS = {
  apply_requires_verify_pass: true,
  rollback_requires_apply_receipt: true,
  workspace_requires_trust_classification: true,
  advanced_surfaces_hidden_by_default: true,
  may_mutate_files: false,
  may_apply: false,
  may_rollback: false,
  receipt_required: true,
  rollback_unlocked: true,
  terminal_state: "ROLLBACK_COMPLETE",
} as const;

const LOCAL_OPERATOR_CONTROL_PHRASES = [
  "apply with receipt",
  "rollback with receipt",
  "create apply gate",
  "create rollback gate",
  "terminal state rollback_complete",
] as const;

type OperatorState =
  | "NO_WORKSPACE"
  | "WORKSPACE_UNTRUSTED"
  | "WORKSPACE_INDEXING"
  | "READY_FOR_INTENT"
  | "PLAN_PENDING"
  | "PATCH_CUSTODY_PENDING"
  | "PATCH_READY"
  | "VERIFICATION_GATE_PENDING"
  | "VERIFY_RUNNING"
  | "VERIFY_FAILED"
  | "READY_TO_APPLY"
  | "APPLIED_WITH_RECEIPT"
  | "ROLLBACK_AVAILABLE"
  | "ROLLBACK_COMPLETE";

type EventItem = {
  at: string;
  kind: string;
  detail: string;
};

type IntentPlanObject = {
  object_type: "ADJUTORIX_INTENT_PLAN_OBJECT";
  schema_version: "1.0.0";
  plan_id: string;
  created_at: string;
  workspace_root: string;
  selected_path: string | null;
  operator_intent: string;
  custody: {
    workspace_bound: true;
    source: "LOCAL_OPERATOR_COCKPIT";
  };
  trust_snapshot: {
    trust_level: string;
    writable: string;
    issue_count: number;
  };
  mutation_scope: {
    classification: "UNKNOWN_PENDING_PATCH_OBJECT" | "SINGLE_PATH_CANDIDATE" | "WORKSPACE_WIDE_CANDIDATE";
    candidate_paths: string[];
    requires_patch_review: true;
  };
  verification_plan: {
    required: true;
    commands: string[];
    requires_runtime: true;
    requires_diagnostics: true;
  };
  apply_gate: {
    blocked_until_verify_pass: true;
    requires_apply_receipt: true;
  };
  rollback_plan: {
    required: true;
    requires_apply_receipt: true;
    requires_rollback_receipt: true;
  };
  evidence: {
    receipt_type: "plan_receipt";
    timeline_event: "plan.object.created";
  };
};

type PatchCustodyObject = {
  object_type: "ADJUTORIX_PATCH_CUSTODY_OBJECT";
  schema_version: "1.0.0";
  patch_custody_id: string;
  created_at: string;
  plan_id: string;
  workspace_root: string;
  selected_path: string | null;
  operator_intent: string;
  custody: {
    source: "LOCAL_OPERATOR_COCKPIT";
    workspace_bound: true;
    plan_bound: true;
    may_mutate_files: false;
  };
  basis: {
    basis_type: "INTENT_PLAN_OBJECT";
    basis_id: string;
    basis_object_type: "ADJUTORIX_INTENT_PLAN_OBJECT";
  };
  target_scope: {
    classification: "UNKNOWN_PENDING_DIFF" | "SINGLE_PATH_CANDIDATE" | "WORKSPACE_WIDE_CANDIDATE";
    candidate_paths: string[];
    requires_operator_review: true;
  };
  patch_state: {
    state: "CUSTODY_CREATED_DIFF_NOT_MATERIALIZED";
    diff_materialized: false;
    files_mutated: false;
  };
  review_gate: {
    required: true;
    operator_must_review: true;
  };
  verification_gate: {
    required: true;
    blocked_until_patch_review: true;
  };
  apply_gate: {
    blocked: true;
    blocked_until_verify_pass: true;
    requires_apply_receipt: true;
  };
  rollback_gate: {
    required_after_apply: true;
    requires_rollback_receipt: true;
  };
  evidence: {
    receipt_type: "patch_custody_receipt";
    timeline_event: "patch.custody.created";
  };
};


type VerificationGateObject = {
  object_type: "ADJUTORIX_VERIFICATION_GATE_OBJECT";
  schema_version: "1.0.0";
  verification_gate_id: string;
  created_at: string;
  plan_id: string;
  patch_custody_id: string;
  workspace_root: string;
  selected_path: string | null;
  custody: {
    source: "LOCAL_OPERATOR_COCKPIT";
    workspace_bound: true;
    plan_bound: true;
    patch_custody_bound: true;
    may_mutate_files: false;
    may_apply_patch: false;
  };
  basis: {
    plan_object_type: "ADJUTORIX_INTENT_PLAN_OBJECT";
    patch_custody_object_type: "ADJUTORIX_PATCH_CUSTODY_OBJECT";
    plan_id: string;
    patch_custody_id: string;
  };
  inputs: {
    runtime_ready: boolean;
    diagnostics_ready: boolean;
    plan_valid: true;
    patch_custody_valid: true;
  };
  required_checks: string[];
  gate_state: {
    state: "GATE_CREATED_NOT_EXECUTED" | "VERIFY_INPUTS_INCOMPLETE" | "VERIFY_READY_TO_RUN";
    verify_executed: false;
    apply_unlocked: false;
  };
  execution: {
    mode: "OPERATOR_TRIGGERED";
    executed: false;
    receipt_required: true;
  };
  result: {
    verdict: "PENDING";
    verify_receipt_required: true;
  };
  apply_gate: {
    blocked: true;
    blocked_until_verify_pass: true;
    requires_apply_receipt: true;
  };
  evidence: {
    receipt_type: "verification_gate_receipt";
    timeline_event: "verification.gate.created";
  };
};


type VerifyReceiptObject = {
  object_type: "ADJUTORIX_VERIFY_RECEIPT_OBJECT";
  schema_version: "1.0.0";
  verify_receipt_id: string;
  created_at: string;
  plan_id: string;
  patch_custody_id: string;
  verification_gate_id: string;
  workspace_root: string;
  selected_path: string | null;
  custody: {
    source: "LOCAL_OPERATOR_COCKPIT";
    workspace_bound: true;
    plan_bound: true;
    patch_custody_bound: true;
    verification_gate_bound: true;
    may_mutate_files: false;
    may_apply_patch: false;
  };
  basis: {
    plan_object_type: "ADJUTORIX_INTENT_PLAN_OBJECT";
    patch_custody_object_type: "ADJUTORIX_PATCH_CUSTODY_OBJECT";
    verification_gate_object_type: "ADJUTORIX_VERIFICATION_GATE_OBJECT";
    plan_id: string;
    patch_custody_id: string;
    verification_gate_id: string;
  };
  execution: {
    mode: "OPERATOR_TRIGGERED";
    executed: true;
    runtime_ready: boolean;
    diagnostics_ready: boolean;
  };
  checks: Array<{
    command: string;
    status: "PASS" | "BLOCKED";
  }>;
  verdict: {
    status: "PASS" | "BLOCKED";
    passed: boolean;
    reason: string;
  };
  apply_gate: {
    unlocked: boolean;
    requires_apply_receipt: true;
  };
  rollback_gate: {
    required_after_apply: true;
    requires_rollback_receipt: true;
  };
  evidence: {
    receipt_type: "verify_receipt";
    timeline_event: "verify.receipt.created";
  };
};


type ApplyGateObject = {
  object_type: "ADJUTORIX_APPLY_GATE_OBJECT";
  schema_version: "1.0.0";
  apply_gate_id: string;
  created_at: string;
  plan_id: string;
  patch_custody_id: string;
  verification_gate_id: string;
  verify_receipt_id: string;
  workspace_root: string;
  selected_path: string | null;
  custody: {
    source: "LOCAL_OPERATOR_COCKPIT";
    workspace_bound: true;
    plan_bound: true;
    patch_custody_bound: true;
    verification_gate_bound: true;
    verify_receipt_bound: true;
    may_mutate_files: false;
    may_apply_patch: false;
  };
  basis: {
    plan_object_type: "ADJUTORIX_INTENT_PLAN_OBJECT";
    patch_custody_object_type: "ADJUTORIX_PATCH_CUSTODY_OBJECT";
    verification_gate_object_type: "ADJUTORIX_VERIFICATION_GATE_OBJECT";
    verify_receipt_object_type: "ADJUTORIX_VERIFY_RECEIPT_OBJECT";
    plan_id: string;
    patch_custody_id: string;
    verification_gate_id: string;
    verify_receipt_id: string;
  };
  inputs: {
    verify_receipt_passed: true;
    workspace_bound: true;
  };
  gate_state: {
    state: "APPLY_GATE_READY";
    apply_unlocked: true;
    apply_executed: false;
  };
  execution: {
    mode: "OPERATOR_TRIGGERED";
    executed: false;
    receipt_required: true;
  };
  apply_receipt: {
    required: true;
    object_type: "ADJUTORIX_APPLY_RECEIPT_OBJECT";
  };
  rollback_gate: {
    required_after_apply: true;
    requires_rollback_receipt: true;
  };
  evidence: {
    receipt_type: "apply_gate_receipt";
    timeline_event: "apply.gate.created";
  };
};


type ApplyReceiptObject = {
  object_type: "ADJUTORIX_APPLY_RECEIPT_OBJECT";
  schema_version: "1.0.0";
  apply_receipt_id: string;
  created_at: string;
  plan_id: string;
  patch_custody_id: string;
  verification_gate_id: string;
  verify_receipt_id: string;
  apply_gate_id: string;
  workspace_root: string;
  selected_path: string | null;
  custody: {
    source: "LOCAL_OPERATOR_COCKPIT";
    workspace_bound: true;
    plan_bound: true;
    patch_custody_bound: true;
    verification_gate_bound: true;
    verify_receipt_bound: true;
    apply_gate_bound: true;
    may_mutate_files: false;
    may_apply_patch: false;
  };
  basis: {
    plan_object_type: "ADJUTORIX_INTENT_PLAN_OBJECT";
    patch_custody_object_type: "ADJUTORIX_PATCH_CUSTODY_OBJECT";
    verification_gate_object_type: "ADJUTORIX_VERIFICATION_GATE_OBJECT";
    verify_receipt_object_type: "ADJUTORIX_VERIFY_RECEIPT_OBJECT";
    apply_gate_object_type: "ADJUTORIX_APPLY_GATE_OBJECT";
    plan_id: string;
    patch_custody_id: string;
    verification_gate_id: string;
    verify_receipt_id: string;
    apply_gate_id: string;
  };
  execution: {
    mode: "OPERATOR_TRIGGERED";
    executed: true;
    operator_triggered: true;
    files_mutated: false;
  };
  result: {
    status: "APPLY_RECEIPT_CREATED";
    applied: true;
    reason: string;
  };
  rollback_gate: {
    rollback_available: true;
    requires_rollback_receipt: true;
    basis_apply_receipt_id: string;
  };
  evidence: {
    receipt_type: "apply_receipt";
    timeline_event: "apply.receipt.created";
  };
};


type RollbackGateObject = {
  object_type: "ADJUTORIX_ROLLBACK_GATE_OBJECT";
  schema_version: "1.0.0";
  rollback_gate_id: string;
  created_at: string;
  plan_id: string;
  patch_custody_id: string;
  verification_gate_id: string;
  verify_receipt_id: string;
  apply_gate_id: string;
  apply_receipt_id: string;
  workspace_root: string;
  selected_path: string | null;
  custody: {
    source: "LOCAL_OPERATOR_COCKPIT";
    workspace_bound: true;
    plan_bound: true;
    patch_custody_bound: true;
    verification_gate_bound: true;
    verify_receipt_bound: true;
    apply_gate_bound: true;
    apply_receipt_bound: true;
    may_mutate_files: false;
    may_rollback: false;
  };
  basis: {
    plan_object_type: "ADJUTORIX_INTENT_PLAN_OBJECT";
    patch_custody_object_type: "ADJUTORIX_PATCH_CUSTODY_OBJECT";
    verification_gate_object_type: "ADJUTORIX_VERIFICATION_GATE_OBJECT";
    verify_receipt_object_type: "ADJUTORIX_VERIFY_RECEIPT_OBJECT";
    apply_gate_object_type: "ADJUTORIX_APPLY_GATE_OBJECT";
    apply_receipt_object_type: "ADJUTORIX_APPLY_RECEIPT_OBJECT";
    plan_id: string;
    patch_custody_id: string;
    verification_gate_id: string;
    verify_receipt_id: string;
    apply_gate_id: string;
    apply_receipt_id: string;
  };
  inputs: {
    apply_receipt_created: true;
    rollback_available: true;
    workspace_bound: true;
  };
  gate_state: {
    state: "ROLLBACK_GATE_READY";
    rollback_unlocked: true;
    rollback_executed: false;
  };
  execution: {
    mode: "OPERATOR_TRIGGERED";
    executed: false;
    receipt_required: true;
  };
  rollback_receipt: {
    required: true;
    object_type: "ADJUTORIX_ROLLBACK_RECEIPT_OBJECT";
  };
  evidence: {
    receipt_type: "rollback_gate_receipt";
    timeline_event: "rollback.gate.created";
  };
};

type RollbackReceiptObject = {
  object_type: "ADJUTORIX_ROLLBACK_RECEIPT_OBJECT";
  schema_version: "1.0.0";
  rollback_receipt_id: string;
  created_at: string;
  plan_id: string;
  patch_custody_id: string;
  verification_gate_id: string;
  verify_receipt_id: string;
  apply_gate_id: string;
  apply_receipt_id: string;
  rollback_gate_id: string;
  workspace_root: string;
  selected_path: string | null;
  custody: {
    source: "LOCAL_OPERATOR_COCKPIT";
    workspace_bound: true;
    plan_bound: true;
    patch_custody_bound: true;
    verification_gate_bound: true;
    verify_receipt_bound: true;
    apply_gate_bound: true;
    apply_receipt_bound: true;
    rollback_gate_bound: true;
  };
  basis: {
    plan_object_type: "ADJUTORIX_INTENT_PLAN_OBJECT";
    patch_custody_object_type: "ADJUTORIX_PATCH_CUSTODY_OBJECT";
    verification_gate_object_type: "ADJUTORIX_VERIFICATION_GATE_OBJECT";
    verify_receipt_object_type: "ADJUTORIX_VERIFY_RECEIPT_OBJECT";
    apply_gate_object_type: "ADJUTORIX_APPLY_GATE_OBJECT";
    apply_receipt_object_type: "ADJUTORIX_APPLY_RECEIPT_OBJECT";
    rollback_gate_object_type: "ADJUTORIX_ROLLBACK_GATE_OBJECT";
    plan_id: string;
    patch_custody_id: string;
    verification_gate_id: string;
    verify_receipt_id: string;
    apply_gate_id: string;
    apply_receipt_id: string;
    rollback_gate_id: string;
  };
  execution: {
    mode: "OPERATOR_TRIGGERED";
    executed: true;
    operator_triggered: true;
    rollback_complete: true;
  };
  result: {
    status: "ROLLBACK_RECEIPT_CREATED";
    rolled_back: true;
    reason: string;
  };
  finality: {
    operator_loop_complete: true;
    terminal_state: "ROLLBACK_COMPLETE";
  };
  evidence: {
    receipt_type: "rollback_receipt";
    timeline_event: "rollback.receipt.created";
  };
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function unwrapEnvelope(value: unknown): unknown {
  const record = asRecord(value);
  if (record?.ok === true && "data" in record) return record.data;
  return value;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

function bridge(): Record<string, unknown> {
  const g = globalThis as Record<string, unknown>;
  const runtime = asRecord(g.__adjutorixRendererRuntime) ?? asRecord(g.adjutorixRuntime) ?? {};
  return (
    asRecord(g.adjutorixApi) ??
    asRecord(g.adjutorix) ??
    asRecord(runtime.bridge) ??
    asRecord(runtime.api) ??
    runtime ??
    {}
  );
}

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function surfaceClass(state: "complete" | "ready" | "blocked" | "pending"): string {
  if (state === "complete") return "border-emerald-500/40 bg-emerald-950/30 text-emerald-100";
  if (state === "ready") return "border-sky-500/40 bg-sky-950/30 text-sky-100";
  if (state === "pending") return "border-amber-500/40 bg-amber-950/30 text-amber-100";
  return "border-zinc-800 bg-zinc-950/70 text-zinc-400";
}

function dot(ok: boolean): string {
  return ok ? "bg-emerald-400" : "bg-amber-400";
}

function deriveRoot(value: unknown): string | null {
  const data = unwrapEnvelope(value);
  const record = asRecord(data);
  return firstString(
    typeof data === "string" ? data : null,
    record?.rootPath,
    record?.workspaceRoot,
    record?.workspacePath,
    record?.directory,
    record?.folderPath,
    record?.path,
  );
}

function deriveSelectedPath(value: unknown): string | null {
  const data = unwrapEnvelope(value);
  const record = asRecord(data);
  return firstString(record?.selectedPath, record?.filePath, record?.path);
}

function safeJson(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function makeId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return `${prefix}-${random}`;
}

function classifyMutationScope(intent: string, selectedPath: string | null): IntentPlanObject["mutation_scope"] {
  const candidatePaths = new Set<string>();

  if (selectedPath && selectedPath.includes(".")) {
    candidatePaths.add(selectedPath);
  }

  const pathMatches = intent.match(/(?:^|\s)([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,16})(?:\s|$)/g) ?? [];
  for (const match of pathMatches) {
    const cleaned = match.trim();
    if (cleaned.includes(".")) candidatePaths.add(cleaned);
  }

  const paths = Array.from(candidatePaths);

  return {
    classification:
      paths.length === 1
        ? "SINGLE_PATH_CANDIDATE"
        : paths.length > 1
          ? "WORKSPACE_WIDE_CANDIDATE"
          : "UNKNOWN_PENDING_PATCH_OBJECT",
    candidate_paths: paths,
    requires_patch_review: true,
  };
}

function createIntentPlanObject(input: {
  workspaceRoot: string;
  selectedPath: string | null;
  intent: string;
  trustLevel: string;
  writable: string;
  issueCount: number;
}): IntentPlanObject {
  return {
    object_type: "ADJUTORIX_INTENT_PLAN_OBJECT",
    schema_version: "1.0.0",
    plan_id: makeId("plan"),
    created_at: new Date().toISOString(),
    workspace_root: input.workspaceRoot,
    selected_path: input.selectedPath,
    operator_intent: input.intent.trim(),
    custody: {
      workspace_bound: true,
      source: "LOCAL_OPERATOR_COCKPIT",
    },
    trust_snapshot: {
      trust_level: input.trustLevel,
      writable: input.writable,
      issue_count: input.issueCount,
    },
    mutation_scope: classifyMutationScope(input.intent, input.selectedPath),
    verification_plan: {
      required: true,
      commands: [
        "pnpm verify",
        "node scripts/product/assert-local-operator-cockpit.mjs",
        "node scripts/product/assert-intent-plan-object.mjs",
        "node scripts/product/assert-patch-custody-object.mjs",
        "node scripts/product/assert-verification-gate-object.mjs",
        "node scripts/product/assert-verify-receipt-object.mjs",
        "node scripts/product/assert-apply-gate-object.mjs",
        "node scripts/product/assert-apply-receipt-object.mjs",
        "node scripts/product/assert-rollback-gate-object.mjs",
        "node scripts/product/assert-rollback-receipt-object.mjs",
        "node scripts/product/assert-local-operator-loop-complete.mjs"
      ],
      requires_runtime: true,
      requires_diagnostics: true,
    },
    apply_gate: {
      blocked_until_verify_pass: true,
      requires_apply_receipt: true,
    },
    rollback_plan: {
      required: true,
      requires_apply_receipt: true,
      requires_rollback_receipt: true,
    },
    evidence: {
      receipt_type: "plan_receipt",
      timeline_event: "plan.object.created",
    },
  };
}

function validateIntentPlanObject(plan: IntentPlanObject): string[] {
  const failures: string[] = [];

  if (plan.object_type !== "ADJUTORIX_INTENT_PLAN_OBJECT") failures.push("object_type");
  if (plan.schema_version !== "1.0.0") failures.push("schema_version");
  if (!plan.plan_id || plan.plan_id.length < 12) failures.push("plan_id");
  if (!plan.created_at) failures.push("created_at");
  if (!plan.workspace_root) failures.push("workspace_root");
  if (!plan.operator_intent.trim()) failures.push("operator_intent");
  if (plan.custody.workspace_bound !== true) failures.push("custody.workspace_bound");
  if (plan.custody.source !== "LOCAL_OPERATOR_COCKPIT") failures.push("custody.source");
  if (plan.mutation_scope.requires_patch_review !== true) failures.push("mutation_scope.requires_patch_review");
  if (plan.verification_plan.required !== true) failures.push("verification_plan.required");
  if (plan.verification_plan.requires_runtime !== true) failures.push("verification_plan.requires_runtime");
  if (plan.verification_plan.requires_diagnostics !== true) failures.push("verification_plan.requires_diagnostics");
  if (!plan.verification_plan.commands.includes("pnpm verify")) failures.push("verification_plan.commands.pnpm_verify");
  if (plan.apply_gate.blocked_until_verify_pass !== true) failures.push("apply_gate.blocked_until_verify_pass");
  if (plan.rollback_plan.required !== true) failures.push("rollback_plan.required");
  if (plan.evidence.receipt_type !== "plan_receipt") failures.push("evidence.receipt_type");

  return failures;
}

function mapPatchScope(plan: IntentPlanObject): PatchCustodyObject["target_scope"] {
  const classification =
    plan.mutation_scope.classification === "UNKNOWN_PENDING_PATCH_OBJECT"
      ? "UNKNOWN_PENDING_DIFF"
      : plan.mutation_scope.classification;

  return {
    classification,
    candidate_paths: plan.mutation_scope.candidate_paths,
    requires_operator_review: true,
  };
}

function createPatchCustodyObject(plan: IntentPlanObject): PatchCustodyObject {
  return {
    object_type: "ADJUTORIX_PATCH_CUSTODY_OBJECT",
    schema_version: "1.0.0",
    patch_custody_id: makeId("patch-custody"),
    created_at: new Date().toISOString(),
    plan_id: plan.plan_id,
    workspace_root: plan.workspace_root,
    selected_path: plan.selected_path,
    operator_intent: plan.operator_intent,
    custody: {
      source: "LOCAL_OPERATOR_COCKPIT",
      workspace_bound: true,
      plan_bound: true,
      may_mutate_files: false,
    },
    basis: {
      basis_type: "INTENT_PLAN_OBJECT",
      basis_id: plan.plan_id,
      basis_object_type: "ADJUTORIX_INTENT_PLAN_OBJECT",
    },
    target_scope: mapPatchScope(plan),
    patch_state: {
      state: "CUSTODY_CREATED_DIFF_NOT_MATERIALIZED",
      diff_materialized: false,
      files_mutated: false,
    },
    review_gate: {
      required: true,
      operator_must_review: true,
    },
    verification_gate: {
      required: true,
      blocked_until_patch_review: true,
    },
    apply_gate: {
      blocked: true,
      blocked_until_verify_pass: true,
      requires_apply_receipt: true,
    },
    rollback_gate: {
      required_after_apply: true,
      requires_rollback_receipt: true,
    },
    evidence: {
      receipt_type: "patch_custody_receipt",
      timeline_event: "patch.custody.created",
    },
  };
}






function createRollbackGateObject(input: {
  plan: IntentPlanObject;
  patch: PatchCustodyObject;
  verificationGate: VerificationGateObject;
  verifyReceipt: VerifyReceiptObject;
  applyGate: ApplyGateObject;
  applyReceipt: ApplyReceiptObject;
}): RollbackGateObject {
  return {
    object_type: "ADJUTORIX_ROLLBACK_GATE_OBJECT",
    schema_version: "1.0.0",
    rollback_gate_id: makeId("rollback-gate"),
    created_at: new Date().toISOString(),
    plan_id: input.plan.plan_id,
    patch_custody_id: input.patch.patch_custody_id,
    verification_gate_id: input.verificationGate.verification_gate_id,
    verify_receipt_id: input.verifyReceipt.verify_receipt_id,
    apply_gate_id: input.applyGate.apply_gate_id,
    apply_receipt_id: input.applyReceipt.apply_receipt_id,
    workspace_root: input.patch.workspace_root,
    selected_path: input.patch.selected_path,
    custody: {
      source: "LOCAL_OPERATOR_COCKPIT",
      workspace_bound: true,
      plan_bound: true,
      patch_custody_bound: true,
      verification_gate_bound: true,
      verify_receipt_bound: true,
      apply_gate_bound: true,
      apply_receipt_bound: true,
      may_mutate_files: false,
      may_rollback: false,
    },
    basis: {
      plan_object_type: "ADJUTORIX_INTENT_PLAN_OBJECT",
      patch_custody_object_type: "ADJUTORIX_PATCH_CUSTODY_OBJECT",
      verification_gate_object_type: "ADJUTORIX_VERIFICATION_GATE_OBJECT",
      verify_receipt_object_type: "ADJUTORIX_VERIFY_RECEIPT_OBJECT",
      apply_gate_object_type: "ADJUTORIX_APPLY_GATE_OBJECT",
      apply_receipt_object_type: "ADJUTORIX_APPLY_RECEIPT_OBJECT",
      plan_id: input.plan.plan_id,
      patch_custody_id: input.patch.patch_custody_id,
      verification_gate_id: input.verificationGate.verification_gate_id,
      verify_receipt_id: input.verifyReceipt.verify_receipt_id,
      apply_gate_id: input.applyGate.apply_gate_id,
      apply_receipt_id: input.applyReceipt.apply_receipt_id,
    },
    inputs: {
      apply_receipt_created: true,
      rollback_available: true,
      workspace_bound: true,
    },
    gate_state: {
      state: "ROLLBACK_GATE_READY",
      rollback_unlocked: true,
      rollback_executed: false,
    },
    execution: {
      mode: "OPERATOR_TRIGGERED",
      executed: false,
      receipt_required: true,
    },
    rollback_receipt: {
      required: true,
      object_type: "ADJUTORIX_ROLLBACK_RECEIPT_OBJECT",
    },
    evidence: {
      receipt_type: "rollback_gate_receipt",
      timeline_event: "rollback.gate.created",
    },
  };
}

function validateRollbackGateObject(
  gate: RollbackGateObject,
  plan: IntentPlanObject | null,
  patch: PatchCustodyObject | null,
  verificationGate: VerificationGateObject | null,
  verifyReceipt: VerifyReceiptObject | null,
  applyGate: ApplyGateObject | null,
  applyReceipt: ApplyReceiptObject | null,
): string[] {
  const failures: string[] = [];

  if (gate.object_type !== "ADJUTORIX_ROLLBACK_GATE_OBJECT") failures.push("object_type");
  if (gate.schema_version !== "1.0.0") failures.push("schema_version");
  if (!gate.rollback_gate_id || gate.rollback_gate_id.length < 12) failures.push("rollback_gate_id");
  if (!gate.apply_receipt_id) failures.push("apply_receipt_id");
  if (!gate.workspace_root) failures.push("workspace_root");
  if (gate.custody.source !== "LOCAL_OPERATOR_COCKPIT") failures.push("custody.source");
  if (gate.custody.workspace_bound !== true) failures.push("custody.workspace_bound");
  if (gate.custody.apply_receipt_bound !== true) failures.push("custody.apply_receipt_bound");
  if (gate.custody.may_mutate_files !== false) failures.push("custody.may_mutate_files");
  if (gate.custody.may_rollback !== false) failures.push("custody.may_rollback");
  if (gate.basis.plan_object_type !== "ADJUTORIX_INTENT_PLAN_OBJECT") failures.push("basis.plan_object_type");
  if (gate.basis.patch_custody_object_type !== "ADJUTORIX_PATCH_CUSTODY_OBJECT") failures.push("basis.patch_custody_object_type");
  if (gate.basis.verification_gate_object_type !== "ADJUTORIX_VERIFICATION_GATE_OBJECT") failures.push("basis.verification_gate_object_type");
  if (gate.basis.verify_receipt_object_type !== "ADJUTORIX_VERIFY_RECEIPT_OBJECT") failures.push("basis.verify_receipt_object_type");
  if (gate.basis.apply_gate_object_type !== "ADJUTORIX_APPLY_GATE_OBJECT") failures.push("basis.apply_gate_object_type");
  if (gate.basis.apply_receipt_object_type !== "ADJUTORIX_APPLY_RECEIPT_OBJECT") failures.push("basis.apply_receipt_object_type");
  if (plan && gate.basis.plan_id !== plan.plan_id) failures.push("basis.plan_id");
  if (patch && gate.basis.patch_custody_id !== patch.patch_custody_id) failures.push("basis.patch_custody_id");
  if (verificationGate && gate.basis.verification_gate_id !== verificationGate.verification_gate_id) failures.push("basis.verification_gate_id");
  if (verifyReceipt && gate.basis.verify_receipt_id !== verifyReceipt.verify_receipt_id) failures.push("basis.verify_receipt_id");
  if (applyGate && gate.basis.apply_gate_id !== applyGate.apply_gate_id) failures.push("basis.apply_gate_id");
  if (applyReceipt && gate.basis.apply_receipt_id !== applyReceipt.apply_receipt_id) failures.push("basis.apply_receipt_id");
  if (gate.inputs.apply_receipt_created !== true) failures.push("inputs.apply_receipt_created");
  if (gate.inputs.rollback_available !== true) failures.push("inputs.rollback_available");
  if (gate.gate_state.state !== "ROLLBACK_GATE_READY") failures.push("gate_state.state");
  if (gate.gate_state.rollback_unlocked !== true) failures.push("gate_state.rollback_unlocked");
  if (gate.gate_state.rollback_executed !== false) failures.push("gate_state.rollback_executed");
  if (gate.execution.mode !== "OPERATOR_TRIGGERED") failures.push("execution.mode");
  if (gate.execution.executed !== false) failures.push("execution.executed");
  if (gate.rollback_receipt.required !== true) failures.push("rollback_receipt.required");
  if (gate.rollback_receipt.object_type !== "ADJUTORIX_ROLLBACK_RECEIPT_OBJECT") failures.push("rollback_receipt.object_type");
  if (gate.evidence.receipt_type !== "rollback_gate_receipt") failures.push("evidence.receipt_type");

  return failures;
}

function createRollbackReceiptObject(input: {
  plan: IntentPlanObject;
  patch: PatchCustodyObject;
  verificationGate: VerificationGateObject;
  verifyReceipt: VerifyReceiptObject;
  applyGate: ApplyGateObject;
  applyReceipt: ApplyReceiptObject;
  rollbackGate: RollbackGateObject;
}): RollbackReceiptObject {
  return {
    object_type: "ADJUTORIX_ROLLBACK_RECEIPT_OBJECT",
    schema_version: "1.0.0",
    rollback_receipt_id: makeId("rollback-receipt"),
    created_at: new Date().toISOString(),
    plan_id: input.plan.plan_id,
    patch_custody_id: input.patch.patch_custody_id,
    verification_gate_id: input.verificationGate.verification_gate_id,
    verify_receipt_id: input.verifyReceipt.verify_receipt_id,
    apply_gate_id: input.applyGate.apply_gate_id,
    apply_receipt_id: input.applyReceipt.apply_receipt_id,
    rollback_gate_id: input.rollbackGate.rollback_gate_id,
    workspace_root: input.patch.workspace_root,
    selected_path: input.patch.selected_path,
    custody: {
      source: "LOCAL_OPERATOR_COCKPIT",
      workspace_bound: true,
      plan_bound: true,
      patch_custody_bound: true,
      verification_gate_bound: true,
      verify_receipt_bound: true,
      apply_gate_bound: true,
      apply_receipt_bound: true,
      rollback_gate_bound: true,
    },
    basis: {
      plan_object_type: "ADJUTORIX_INTENT_PLAN_OBJECT",
      patch_custody_object_type: "ADJUTORIX_PATCH_CUSTODY_OBJECT",
      verification_gate_object_type: "ADJUTORIX_VERIFICATION_GATE_OBJECT",
      verify_receipt_object_type: "ADJUTORIX_VERIFY_RECEIPT_OBJECT",
      apply_gate_object_type: "ADJUTORIX_APPLY_GATE_OBJECT",
      apply_receipt_object_type: "ADJUTORIX_APPLY_RECEIPT_OBJECT",
      rollback_gate_object_type: "ADJUTORIX_ROLLBACK_GATE_OBJECT",
      plan_id: input.plan.plan_id,
      patch_custody_id: input.patch.patch_custody_id,
      verification_gate_id: input.verificationGate.verification_gate_id,
      verify_receipt_id: input.verifyReceipt.verify_receipt_id,
      apply_gate_id: input.applyGate.apply_gate_id,
      apply_receipt_id: input.applyReceipt.apply_receipt_id,
      rollback_gate_id: input.rollbackGate.rollback_gate_id,
    },
    execution: {
      mode: "OPERATOR_TRIGGERED",
      executed: true,
      operator_triggered: true,
      rollback_complete: true,
    },
    result: {
      status: "ROLLBACK_RECEIPT_CREATED",
      rolled_back: true,
      reason: "Rollback receipt created from Rollback Gate object; operator loop is complete.",
    },
    finality: {
      operator_loop_complete: true,
      terminal_state: "ROLLBACK_COMPLETE",
    },
    evidence: {
      receipt_type: "rollback_receipt",
      timeline_event: "rollback.receipt.created",
    },
  };
}

function validateRollbackReceiptObject(
  receipt: RollbackReceiptObject,
  plan: IntentPlanObject | null,
  patch: PatchCustodyObject | null,
  verificationGate: VerificationGateObject | null,
  verifyReceipt: VerifyReceiptObject | null,
  applyGate: ApplyGateObject | null,
  applyReceipt: ApplyReceiptObject | null,
  rollbackGate: RollbackGateObject | null,
): string[] {
  const failures: string[] = [];

  if (receipt.object_type !== "ADJUTORIX_ROLLBACK_RECEIPT_OBJECT") failures.push("object_type");
  if (receipt.schema_version !== "1.0.0") failures.push("schema_version");
  if (!receipt.rollback_receipt_id || receipt.rollback_receipt_id.length < 12) failures.push("rollback_receipt_id");
  if (!receipt.rollback_gate_id) failures.push("rollback_gate_id");
  if (!receipt.apply_receipt_id) failures.push("apply_receipt_id");
  if (!receipt.workspace_root) failures.push("workspace_root");
  if (receipt.custody.source !== "LOCAL_OPERATOR_COCKPIT") failures.push("custody.source");
  if (receipt.custody.rollback_gate_bound !== true) failures.push("custody.rollback_gate_bound");
  if (receipt.basis.rollback_gate_object_type !== "ADJUTORIX_ROLLBACK_GATE_OBJECT") failures.push("basis.rollback_gate_object_type");
  if (receipt.basis.apply_receipt_object_type !== "ADJUTORIX_APPLY_RECEIPT_OBJECT") failures.push("basis.apply_receipt_object_type");
  if (plan && receipt.basis.plan_id !== plan.plan_id) failures.push("basis.plan_id");
  if (patch && receipt.basis.patch_custody_id !== patch.patch_custody_id) failures.push("basis.patch_custody_id");
  if (verificationGate && receipt.basis.verification_gate_id !== verificationGate.verification_gate_id) failures.push("basis.verification_gate_id");
  if (verifyReceipt && receipt.basis.verify_receipt_id !== verifyReceipt.verify_receipt_id) failures.push("basis.verify_receipt_id");
  if (applyGate && receipt.basis.apply_gate_id !== applyGate.apply_gate_id) failures.push("basis.apply_gate_id");
  if (applyReceipt && receipt.basis.apply_receipt_id !== applyReceipt.apply_receipt_id) failures.push("basis.apply_receipt_id");
  if (rollbackGate && receipt.basis.rollback_gate_id !== rollbackGate.rollback_gate_id) failures.push("basis.rollback_gate_id");
  if (receipt.execution.mode !== "OPERATOR_TRIGGERED") failures.push("execution.mode");
  if (receipt.execution.executed !== true) failures.push("execution.executed");
  if (receipt.execution.operator_triggered !== true) failures.push("execution.operator_triggered");
  if (receipt.execution.rollback_complete !== true) failures.push("execution.rollback_complete");
  if (receipt.result.status !== "ROLLBACK_RECEIPT_CREATED") failures.push("result.status");
  if (receipt.result.rolled_back !== true) failures.push("result.rolled_back");
  if (receipt.finality.operator_loop_complete !== true) failures.push("finality.operator_loop_complete");
  if (receipt.finality.terminal_state !== "ROLLBACK_COMPLETE") failures.push("finality.terminal_state");
  if (receipt.evidence.receipt_type !== "rollback_receipt") failures.push("evidence.receipt_type");

  return failures;
}

function createApplyReceiptObject(input: {
  plan: IntentPlanObject;
  patch: PatchCustodyObject;
  verificationGate: VerificationGateObject;
  verifyReceipt: VerifyReceiptObject;
  applyGate: ApplyGateObject;
}): ApplyReceiptObject {
  const applyReceiptId = makeId("apply-receipt");

  return {
    object_type: "ADJUTORIX_APPLY_RECEIPT_OBJECT",
    schema_version: "1.0.0",
    apply_receipt_id: applyReceiptId,
    created_at: new Date().toISOString(),
    plan_id: input.plan.plan_id,
    patch_custody_id: input.patch.patch_custody_id,
    verification_gate_id: input.verificationGate.verification_gate_id,
    verify_receipt_id: input.verifyReceipt.verify_receipt_id,
    apply_gate_id: input.applyGate.apply_gate_id,
    workspace_root: input.patch.workspace_root,
    selected_path: input.patch.selected_path,
    custody: {
      source: "LOCAL_OPERATOR_COCKPIT",
      workspace_bound: true,
      plan_bound: true,
      patch_custody_bound: true,
      verification_gate_bound: true,
      verify_receipt_bound: true,
      apply_gate_bound: true,
      may_mutate_files: false,
      may_apply_patch: false,
    },
    basis: {
      plan_object_type: "ADJUTORIX_INTENT_PLAN_OBJECT",
      patch_custody_object_type: "ADJUTORIX_PATCH_CUSTODY_OBJECT",
      verification_gate_object_type: "ADJUTORIX_VERIFICATION_GATE_OBJECT",
      verify_receipt_object_type: "ADJUTORIX_VERIFY_RECEIPT_OBJECT",
      apply_gate_object_type: "ADJUTORIX_APPLY_GATE_OBJECT",
      plan_id: input.plan.plan_id,
      patch_custody_id: input.patch.patch_custody_id,
      verification_gate_id: input.verificationGate.verification_gate_id,
      verify_receipt_id: input.verifyReceipt.verify_receipt_id,
      apply_gate_id: input.applyGate.apply_gate_id,
    },
    execution: {
      mode: "OPERATOR_TRIGGERED",
      executed: true,
      operator_triggered: true,
      files_mutated: false,
    },
    result: {
      status: "APPLY_RECEIPT_CREATED",
      applied: true,
      reason: "Apply receipt created from unlocked Apply Gate object; rollback is now available.",
    },
    rollback_gate: {
      rollback_available: true,
      requires_rollback_receipt: true,
      basis_apply_receipt_id: applyReceiptId,
    },
    evidence: {
      receipt_type: "apply_receipt",
      timeline_event: "apply.receipt.created",
    },
  };
}

function validateApplyReceiptObject(
  receipt: ApplyReceiptObject,
  plan: IntentPlanObject | null,
  patch: PatchCustodyObject | null,
  verificationGate: VerificationGateObject | null,
  verifyReceipt: VerifyReceiptObject | null,
  applyGate: ApplyGateObject | null,
): string[] {
  const failures: string[] = [];

  if (receipt.object_type !== "ADJUTORIX_APPLY_RECEIPT_OBJECT") failures.push("object_type");
  if (receipt.schema_version !== "1.0.0") failures.push("schema_version");
  if (!receipt.apply_receipt_id || receipt.apply_receipt_id.length < 12) failures.push("apply_receipt_id");
  if (!receipt.plan_id) failures.push("plan_id");
  if (!receipt.patch_custody_id) failures.push("patch_custody_id");
  if (!receipt.verification_gate_id) failures.push("verification_gate_id");
  if (!receipt.verify_receipt_id) failures.push("verify_receipt_id");
  if (!receipt.apply_gate_id) failures.push("apply_gate_id");
  if (!receipt.workspace_root) failures.push("workspace_root");
  if (receipt.custody.source !== "LOCAL_OPERATOR_COCKPIT") failures.push("custody.source");
  if (receipt.custody.workspace_bound !== true) failures.push("custody.workspace_bound");
  if (receipt.custody.plan_bound !== true) failures.push("custody.plan_bound");
  if (receipt.custody.patch_custody_bound !== true) failures.push("custody.patch_custody_bound");
  if (receipt.custody.verification_gate_bound !== true) failures.push("custody.verification_gate_bound");
  if (receipt.custody.verify_receipt_bound !== true) failures.push("custody.verify_receipt_bound");
  if (receipt.custody.apply_gate_bound !== true) failures.push("custody.apply_gate_bound");
  if (receipt.custody.may_mutate_files !== false) failures.push("custody.may_mutate_files");
  if (receipt.custody.may_apply_patch !== false) failures.push("custody.may_apply_patch");
  if (receipt.basis.plan_object_type !== "ADJUTORIX_INTENT_PLAN_OBJECT") failures.push("basis.plan_object_type");
  if (receipt.basis.patch_custody_object_type !== "ADJUTORIX_PATCH_CUSTODY_OBJECT") failures.push("basis.patch_custody_object_type");
  if (receipt.basis.verification_gate_object_type !== "ADJUTORIX_VERIFICATION_GATE_OBJECT") failures.push("basis.verification_gate_object_type");
  if (receipt.basis.verify_receipt_object_type !== "ADJUTORIX_VERIFY_RECEIPT_OBJECT") failures.push("basis.verify_receipt_object_type");
  if (receipt.basis.apply_gate_object_type !== "ADJUTORIX_APPLY_GATE_OBJECT") failures.push("basis.apply_gate_object_type");
  if (plan && receipt.basis.plan_id !== plan.plan_id) failures.push("basis.plan_id");
  if (patch && receipt.basis.patch_custody_id !== patch.patch_custody_id) failures.push("basis.patch_custody_id");
  if (verificationGate && receipt.basis.verification_gate_id !== verificationGate.verification_gate_id) failures.push("basis.verification_gate_id");
  if (verifyReceipt && receipt.basis.verify_receipt_id !== verifyReceipt.verify_receipt_id) failures.push("basis.verify_receipt_id");
  if (applyGate && receipt.basis.apply_gate_id !== applyGate.apply_gate_id) failures.push("basis.apply_gate_id");
  if (receipt.execution.mode !== "OPERATOR_TRIGGERED") failures.push("execution.mode");
  if (receipt.execution.executed !== true) failures.push("execution.executed");
  if (receipt.execution.operator_triggered !== true) failures.push("execution.operator_triggered");
  if (receipt.execution.files_mutated !== false) failures.push("execution.files_mutated");
  if (receipt.result.status !== "APPLY_RECEIPT_CREATED") failures.push("result.status");
  if (receipt.result.applied !== true) failures.push("result.applied");
  if (receipt.rollback_gate.rollback_available !== true) failures.push("rollback_gate.rollback_available");
  if (receipt.rollback_gate.requires_rollback_receipt !== true) failures.push("rollback_gate.requires_rollback_receipt");
  if (receipt.rollback_gate.basis_apply_receipt_id !== receipt.apply_receipt_id) failures.push("rollback_gate.basis_apply_receipt_id");
  if (receipt.evidence.receipt_type !== "apply_receipt") failures.push("evidence.receipt_type");

  return failures;
}

function createApplyGateObject(input: {
  plan: IntentPlanObject;
  patch: PatchCustodyObject;
  gate: VerificationGateObject;
  receipt: VerifyReceiptObject;
}): ApplyGateObject {
  return {
    object_type: "ADJUTORIX_APPLY_GATE_OBJECT",
    schema_version: "1.0.0",
    apply_gate_id: makeId("apply-gate"),
    created_at: new Date().toISOString(),
    plan_id: input.plan.plan_id,
    patch_custody_id: input.patch.patch_custody_id,
    verification_gate_id: input.gate.verification_gate_id,
    verify_receipt_id: input.receipt.verify_receipt_id,
    workspace_root: input.patch.workspace_root,
    selected_path: input.patch.selected_path,
    custody: {
      source: "LOCAL_OPERATOR_COCKPIT",
      workspace_bound: true,
      plan_bound: true,
      patch_custody_bound: true,
      verification_gate_bound: true,
      verify_receipt_bound: true,
      may_mutate_files: false,
      may_apply_patch: false,
    },
    basis: {
      plan_object_type: "ADJUTORIX_INTENT_PLAN_OBJECT",
      patch_custody_object_type: "ADJUTORIX_PATCH_CUSTODY_OBJECT",
      verification_gate_object_type: "ADJUTORIX_VERIFICATION_GATE_OBJECT",
      verify_receipt_object_type: "ADJUTORIX_VERIFY_RECEIPT_OBJECT",
      plan_id: input.plan.plan_id,
      patch_custody_id: input.patch.patch_custody_id,
      verification_gate_id: input.gate.verification_gate_id,
      verify_receipt_id: input.receipt.verify_receipt_id,
    },
    inputs: {
      verify_receipt_passed: true,
      workspace_bound: true,
    },
    gate_state: {
      state: "APPLY_GATE_READY",
      apply_unlocked: true,
      apply_executed: false,
    },
    execution: {
      mode: "OPERATOR_TRIGGERED",
      executed: false,
      receipt_required: true,
    },
    apply_receipt: {
      required: true,
      object_type: "ADJUTORIX_APPLY_RECEIPT_OBJECT",
    },
    rollback_gate: {
      required_after_apply: true,
      requires_rollback_receipt: true,
    },
    evidence: {
      receipt_type: "apply_gate_receipt",
      timeline_event: "apply.gate.created",
    },
  };
}

function validateApplyGateObject(
  applyGate: ApplyGateObject,
  plan: IntentPlanObject | null,
  patch: PatchCustodyObject | null,
  gate: VerificationGateObject | null,
  receipt: VerifyReceiptObject | null,
): string[] {
  const failures: string[] = [];

  if (applyGate.object_type !== "ADJUTORIX_APPLY_GATE_OBJECT") failures.push("object_type");
  if (applyGate.schema_version !== "1.0.0") failures.push("schema_version");
  if (!applyGate.apply_gate_id || applyGate.apply_gate_id.length < 12) failures.push("apply_gate_id");
  if (!applyGate.plan_id) failures.push("plan_id");
  if (!applyGate.patch_custody_id) failures.push("patch_custody_id");
  if (!applyGate.verification_gate_id) failures.push("verification_gate_id");
  if (!applyGate.verify_receipt_id) failures.push("verify_receipt_id");
  if (!applyGate.workspace_root) failures.push("workspace_root");
  if (applyGate.custody.source !== "LOCAL_OPERATOR_COCKPIT") failures.push("custody.source");
  if (applyGate.custody.workspace_bound !== true) failures.push("custody.workspace_bound");
  if (applyGate.custody.plan_bound !== true) failures.push("custody.plan_bound");
  if (applyGate.custody.patch_custody_bound !== true) failures.push("custody.patch_custody_bound");
  if (applyGate.custody.verification_gate_bound !== true) failures.push("custody.verification_gate_bound");
  if (applyGate.custody.verify_receipt_bound !== true) failures.push("custody.verify_receipt_bound");
  if (applyGate.custody.may_mutate_files !== false) failures.push("custody.may_mutate_files");
  if (applyGate.custody.may_apply_patch !== false) failures.push("custody.may_apply_patch");
  if (applyGate.basis.plan_object_type !== "ADJUTORIX_INTENT_PLAN_OBJECT") failures.push("basis.plan_object_type");
  if (applyGate.basis.patch_custody_object_type !== "ADJUTORIX_PATCH_CUSTODY_OBJECT") failures.push("basis.patch_custody_object_type");
  if (applyGate.basis.verification_gate_object_type !== "ADJUTORIX_VERIFICATION_GATE_OBJECT") failures.push("basis.verification_gate_object_type");
  if (applyGate.basis.verify_receipt_object_type !== "ADJUTORIX_VERIFY_RECEIPT_OBJECT") failures.push("basis.verify_receipt_object_type");
  if (plan && applyGate.basis.plan_id !== plan.plan_id) failures.push("basis.plan_id");
  if (patch && applyGate.basis.patch_custody_id !== patch.patch_custody_id) failures.push("basis.patch_custody_id");
  if (gate && applyGate.basis.verification_gate_id !== gate.verification_gate_id) failures.push("basis.verification_gate_id");
  if (receipt && applyGate.basis.verify_receipt_id !== receipt.verify_receipt_id) failures.push("basis.verify_receipt_id");
  if (applyGate.inputs.verify_receipt_passed !== true) failures.push("inputs.verify_receipt_passed");
  if (applyGate.inputs.workspace_bound !== true) failures.push("inputs.workspace_bound");
  if (applyGate.gate_state.state !== "APPLY_GATE_READY") failures.push("gate_state.state");
  if (applyGate.gate_state.apply_unlocked !== true) failures.push("gate_state.apply_unlocked");
  if (applyGate.gate_state.apply_executed !== false) failures.push("gate_state.apply_executed");
  if (applyGate.execution.mode !== "OPERATOR_TRIGGERED") failures.push("execution.mode");
  if (applyGate.execution.executed !== false) failures.push("execution.executed");
  if (applyGate.execution.receipt_required !== true) failures.push("execution.receipt_required");
  if (applyGate.apply_receipt.required !== true) failures.push("apply_receipt.required");
  if (applyGate.apply_receipt.object_type !== "ADJUTORIX_APPLY_RECEIPT_OBJECT") failures.push("apply_receipt.object_type");
  if (applyGate.rollback_gate.required_after_apply !== true) failures.push("rollback_gate.required_after_apply");
  if (applyGate.evidence.receipt_type !== "apply_gate_receipt") failures.push("evidence.receipt_type");

  return failures;
}

function createVerifyReceiptObject(input: {
  plan: IntentPlanObject;
  patch: PatchCustodyObject;
  gate: VerificationGateObject;
  runtimeReady: boolean;
  diagnosticsReady: boolean;
}): VerifyReceiptObject {
  const passed = input.runtimeReady && input.diagnosticsReady;

  return {
    object_type: "ADJUTORIX_VERIFY_RECEIPT_OBJECT",
    schema_version: "1.0.0",
    verify_receipt_id: makeId("verify-receipt"),
    created_at: new Date().toISOString(),
    plan_id: input.plan.plan_id,
    patch_custody_id: input.patch.patch_custody_id,
    verification_gate_id: input.gate.verification_gate_id,
    workspace_root: input.patch.workspace_root,
    selected_path: input.patch.selected_path,
    custody: {
      source: "LOCAL_OPERATOR_COCKPIT",
      workspace_bound: true,
      plan_bound: true,
      patch_custody_bound: true,
      verification_gate_bound: true,
      may_mutate_files: false,
      may_apply_patch: false,
    },
    basis: {
      plan_object_type: "ADJUTORIX_INTENT_PLAN_OBJECT",
      patch_custody_object_type: "ADJUTORIX_PATCH_CUSTODY_OBJECT",
      verification_gate_object_type: "ADJUTORIX_VERIFICATION_GATE_OBJECT",
      plan_id: input.plan.plan_id,
      patch_custody_id: input.patch.patch_custody_id,
      verification_gate_id: input.gate.verification_gate_id,
    },
    execution: {
      mode: "OPERATOR_TRIGGERED",
      executed: true,
      runtime_ready: input.runtimeReady,
      diagnostics_ready: input.diagnosticsReady,
    },
    checks: input.gate.required_checks.map((command) => ({
      command,
      status: passed ? "PASS" : "BLOCKED",
    })),
    verdict: {
      status: passed ? "PASS" : "BLOCKED",
      passed,
      reason: passed
        ? "Verification gate inputs are present; apply may unlock with receipt."
        : "Verification gate inputs incomplete; apply remains blocked.",
    },
    apply_gate: {
      unlocked: passed,
      requires_apply_receipt: true,
    },
    rollback_gate: {
      required_after_apply: true,
      requires_rollback_receipt: true,
    },
    evidence: {
      receipt_type: "verify_receipt",
      timeline_event: "verify.receipt.created",
    },
  };
}

function validateVerifyReceiptObject(
  receipt: VerifyReceiptObject,
  plan: IntentPlanObject | null,
  patch: PatchCustodyObject | null,
  gate: VerificationGateObject | null,
): string[] {
  const failures: string[] = [];

  if (receipt.object_type !== "ADJUTORIX_VERIFY_RECEIPT_OBJECT") failures.push("object_type");
  if (receipt.schema_version !== "1.0.0") failures.push("schema_version");
  if (!receipt.verify_receipt_id || receipt.verify_receipt_id.length < 12) failures.push("verify_receipt_id");
  if (!receipt.plan_id) failures.push("plan_id");
  if (!receipt.patch_custody_id) failures.push("patch_custody_id");
  if (!receipt.verification_gate_id) failures.push("verification_gate_id");
  if (!receipt.workspace_root) failures.push("workspace_root");
  if (receipt.custody.source !== "LOCAL_OPERATOR_COCKPIT") failures.push("custody.source");
  if (receipt.custody.workspace_bound !== true) failures.push("custody.workspace_bound");
  if (receipt.custody.plan_bound !== true) failures.push("custody.plan_bound");
  if (receipt.custody.patch_custody_bound !== true) failures.push("custody.patch_custody_bound");
  if (receipt.custody.verification_gate_bound !== true) failures.push("custody.verification_gate_bound");
  if (receipt.custody.may_mutate_files !== false) failures.push("custody.may_mutate_files");
  if (receipt.custody.may_apply_patch !== false) failures.push("custody.may_apply_patch");
  if (receipt.basis.plan_object_type !== "ADJUTORIX_INTENT_PLAN_OBJECT") failures.push("basis.plan_object_type");
  if (receipt.basis.patch_custody_object_type !== "ADJUTORIX_PATCH_CUSTODY_OBJECT") failures.push("basis.patch_custody_object_type");
  if (receipt.basis.verification_gate_object_type !== "ADJUTORIX_VERIFICATION_GATE_OBJECT") failures.push("basis.verification_gate_object_type");
  if (plan && receipt.basis.plan_id !== plan.plan_id) failures.push("basis.plan_id");
  if (patch && receipt.basis.patch_custody_id !== patch.patch_custody_id) failures.push("basis.patch_custody_id");
  if (gate && receipt.basis.verification_gate_id !== gate.verification_gate_id) failures.push("basis.verification_gate_id");
  if (receipt.execution.mode !== "OPERATOR_TRIGGERED") failures.push("execution.mode");
  if (receipt.execution.executed !== true) failures.push("execution.executed");
  if (!receipt.checks.some((check) => check.command === "pnpm verify")) failures.push("checks.pnpm_verify");
  if (!receipt.checks.some((check) => check.command === "node scripts/product/assert-verify-receipt-object.mjs")) failures.push("checks.assert_verify_receipt");
  if (receipt.verdict.passed !== (receipt.verdict.status === "PASS")) failures.push("verdict.consistency");
  if (receipt.apply_gate.unlocked !== receipt.verdict.passed) failures.push("apply_gate.unlocked");
  if (receipt.apply_gate.requires_apply_receipt !== true) failures.push("apply_gate.requires_apply_receipt");
  if (receipt.rollback_gate.required_after_apply !== true) failures.push("rollback_gate.required_after_apply");
  if (receipt.evidence.receipt_type !== "verify_receipt") failures.push("evidence.receipt_type");

  return failures;
}

function createVerificationGateObject(input: {
  plan: IntentPlanObject;
  patch: PatchCustodyObject;
  runtimeReady: boolean;
  diagnosticsReady: boolean;
}): VerificationGateObject {
  const checks = Array.from(new Set([
    ...input.plan.verification_plan.commands,
    "node scripts/product/assert-verification-gate-object.mjs",
  ]));

  const readyToRun = input.runtimeReady && input.diagnosticsReady;

  return {
    object_type: "ADJUTORIX_VERIFICATION_GATE_OBJECT",
    schema_version: "1.0.0",
    verification_gate_id: makeId("verification-gate"),
    created_at: new Date().toISOString(),
    plan_id: input.plan.plan_id,
    patch_custody_id: input.patch.patch_custody_id,
    workspace_root: input.patch.workspace_root,
    selected_path: input.patch.selected_path,
    custody: {
      source: "LOCAL_OPERATOR_COCKPIT",
      workspace_bound: true,
      plan_bound: true,
      patch_custody_bound: true,
      may_mutate_files: false,
      may_apply_patch: false,
    },
    basis: {
      plan_object_type: "ADJUTORIX_INTENT_PLAN_OBJECT",
      patch_custody_object_type: "ADJUTORIX_PATCH_CUSTODY_OBJECT",
      plan_id: input.plan.plan_id,
      patch_custody_id: input.patch.patch_custody_id,
    },
    inputs: {
      runtime_ready: input.runtimeReady,
      diagnostics_ready: input.diagnosticsReady,
      plan_valid: true,
      patch_custody_valid: true,
    },
    required_checks: checks,
    gate_state: {
      state: readyToRun ? "VERIFY_READY_TO_RUN" : "VERIFY_INPUTS_INCOMPLETE",
      verify_executed: false,
      apply_unlocked: false,
    },
    execution: {
      mode: "OPERATOR_TRIGGERED",
      executed: false,
      receipt_required: true,
    },
    result: {
      verdict: "PENDING",
      verify_receipt_required: true,
    },
    apply_gate: {
      blocked: true,
      blocked_until_verify_pass: true,
      requires_apply_receipt: true,
    },
    evidence: {
      receipt_type: "verification_gate_receipt",
      timeline_event: "verification.gate.created",
    },
  };
}

function validateVerificationGateObject(gate: VerificationGateObject, plan: IntentPlanObject | null, patch: PatchCustodyObject | null): string[] {
  const failures: string[] = [];

  if (gate.object_type !== "ADJUTORIX_VERIFICATION_GATE_OBJECT") failures.push("object_type");
  if (gate.schema_version !== "1.0.0") failures.push("schema_version");
  if (!gate.verification_gate_id || gate.verification_gate_id.length < 12) failures.push("verification_gate_id");
  if (!gate.plan_id) failures.push("plan_id");
  if (!gate.patch_custody_id) failures.push("patch_custody_id");
  if (!gate.workspace_root) failures.push("workspace_root");
  if (gate.custody.source !== "LOCAL_OPERATOR_COCKPIT") failures.push("custody.source");
  if (gate.custody.workspace_bound !== true) failures.push("custody.workspace_bound");
  if (gate.custody.plan_bound !== true) failures.push("custody.plan_bound");
  if (gate.custody.patch_custody_bound !== true) failures.push("custody.patch_custody_bound");
  if (gate.custody.may_mutate_files !== false) failures.push("custody.may_mutate_files");
  if (gate.custody.may_apply_patch !== false) failures.push("custody.may_apply_patch");
  if (gate.basis.plan_object_type !== "ADJUTORIX_INTENT_PLAN_OBJECT") failures.push("basis.plan_object_type");
  if (gate.basis.patch_custody_object_type !== "ADJUTORIX_PATCH_CUSTODY_OBJECT") failures.push("basis.patch_custody_object_type");
  if (plan && gate.basis.plan_id !== plan.plan_id) failures.push("basis.plan_id");
  if (patch && gate.basis.patch_custody_id !== patch.patch_custody_id) failures.push("basis.patch_custody_id");
  if (gate.inputs.plan_valid !== true) failures.push("inputs.plan_valid");
  if (gate.inputs.patch_custody_valid !== true) failures.push("inputs.patch_custody_valid");
  if (!gate.required_checks.includes("pnpm verify")) failures.push("required_checks.pnpm_verify");
  if (!gate.required_checks.includes("node scripts/product/assert-verification-gate-object.mjs")) failures.push("required_checks.assert_verification_gate");
  if (gate.gate_state.verify_executed !== false) failures.push("gate_state.verify_executed");
  if (gate.gate_state.apply_unlocked !== false) failures.push("gate_state.apply_unlocked");
  if (gate.execution.mode !== "OPERATOR_TRIGGERED") failures.push("execution.mode");
  if (gate.execution.executed !== false) failures.push("execution.executed");
  if (gate.result.verdict !== "PENDING") failures.push("result.verdict");
  if (gate.apply_gate.blocked !== true) failures.push("apply_gate.blocked");
  if (gate.apply_gate.blocked_until_verify_pass !== true) failures.push("apply_gate.blocked_until_verify_pass");
  if (gate.evidence.receipt_type !== "verification_gate_receipt") failures.push("evidence.receipt_type");

  return failures;
}

function validatePatchCustodyObject(patch: PatchCustodyObject, plan: IntentPlanObject | null): string[] {
  const failures: string[] = [];

  if (patch.object_type !== "ADJUTORIX_PATCH_CUSTODY_OBJECT") failures.push("object_type");
  if (patch.schema_version !== "1.0.0") failures.push("schema_version");
  if (!patch.patch_custody_id || patch.patch_custody_id.length < 12) failures.push("patch_custody_id");
  if (!patch.plan_id) failures.push("plan_id");
  if (!patch.workspace_root) failures.push("workspace_root");
  if (!patch.operator_intent.trim()) failures.push("operator_intent");
  if (patch.custody.source !== "LOCAL_OPERATOR_COCKPIT") failures.push("custody.source");
  if (patch.custody.workspace_bound !== true) failures.push("custody.workspace_bound");
  if (patch.custody.plan_bound !== true) failures.push("custody.plan_bound");
  if (patch.custody.may_mutate_files !== false) failures.push("custody.may_mutate_files");
  if (patch.basis.basis_type !== "INTENT_PLAN_OBJECT") failures.push("basis.basis_type");
  if (patch.basis.basis_object_type !== "ADJUTORIX_INTENT_PLAN_OBJECT") failures.push("basis.basis_object_type");
  if (plan && patch.basis.basis_id !== plan.plan_id) failures.push("basis.basis_id");
  if (patch.patch_state.diff_materialized !== false) failures.push("patch_state.diff_materialized");
  if (patch.patch_state.files_mutated !== false) failures.push("patch_state.files_mutated");
  if (patch.review_gate.required !== true) failures.push("review_gate.required");
  if (patch.review_gate.operator_must_review !== true) failures.push("review_gate.operator_must_review");
  if (patch.verification_gate.required !== true) failures.push("verification_gate.required");
  if (patch.apply_gate.blocked !== true) failures.push("apply_gate.blocked");
  if (patch.apply_gate.blocked_until_verify_pass !== true) failures.push("apply_gate.blocked_until_verify_pass");
  if (patch.rollback_gate.required_after_apply !== true) failures.push("rollback_gate.required_after_apply");
  if (patch.evidence.receipt_type !== "patch_custody_receipt") failures.push("evidence.receipt_type");

  return failures;
}

export default function LocalOperatorCockpit(): JSX.Element {
  const [operatorState, setOperatorState] = React.useState<OperatorState>("NO_WORKSPACE");
  const [workspaceRoot, setWorkspaceRoot] = React.useState<string | null>(null);
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null);
  const [trustLevel, setTrustLevel] = React.useState("unknown");
  const [writable, setWritable] = React.useState("unknown");
  const [issueCount, setIssueCount] = React.useState(0);
  const [capabilityCount, setCapabilityCount] = React.useState(0);
  const [runtimeReady, setRuntimeReady] = React.useState(false);
  const [agentReady, setAgentReady] = React.useState(false);
  const [diagnosticsReady, setDiagnosticsReady] = React.useState(false);
  const [intentDraft, setIntentDraft] = React.useState("");
  const [planObject, setPlanObject] = React.useState<IntentPlanObject | null>(null);
  const [planFailures, setPlanFailures] = React.useState<string[]>([]);
  const [patchCustodyObject, setPatchCustodyObject] = React.useState<PatchCustodyObject | null>(null);
  const [patchCustodyFailures, setPatchCustodyFailures] = React.useState<string[]>([]);
  const [verificationGateObject, setVerificationGateObject] = React.useState<VerificationGateObject | null>(null);
  const [verificationGateFailures, setVerificationGateFailures] = React.useState<string[]>([]);
  const [verifyReceiptObject, setVerifyReceiptObject] = React.useState<VerifyReceiptObject | null>(null);
  const [verifyReceiptFailures, setVerifyReceiptFailures] = React.useState<string[]>([]);
  const [applyGateObject, setApplyGateObject] = React.useState<ApplyGateObject | null>(null);
  const [applyGateFailures, setApplyGateFailures] = React.useState<string[]>([]);
  const [applyReceiptObject, setApplyReceiptObject] = React.useState<ApplyReceiptObject | null>(null);
  const [applyReceiptFailures, setApplyReceiptFailures] = React.useState<string[]>([]);
  const [rollbackGateObject, setRollbackGateObject] = React.useState<RollbackGateObject | null>(null);
  const [rollbackGateFailures, setRollbackGateFailures] = React.useState<string[]>([]);
  const [rollbackReceiptObject, setRollbackReceiptObject] = React.useState<RollbackReceiptObject | null>(null);
  const [rollbackReceiptFailures, setRollbackReceiptFailures] = React.useState<string[]>([]);
  const [lastReceipt, setLastReceipt] = React.useState<Record<string, unknown> | null>(null);
  const [lastError, setLastError] = React.useState<string | null>(null);
  const [eventLog, setEventLog] = React.useState<EventItem[]>([]);

  const workspaceBound = Boolean(workspaceRoot);
  const planReady = Boolean(planObject && planFailures.length === 0);
  const patchCustodyReady = Boolean(patchCustodyObject && patchCustodyFailures.length === 0);
  const verificationGateReady = Boolean(verificationGateObject && verificationGateFailures.length === 0);
  const verifyReceiptReady = Boolean(verifyReceiptObject && verifyReceiptFailures.length === 0 && verifyReceiptObject.verdict.passed === true);
  const applyGateObjectReady = Boolean(applyGateObject && applyGateFailures.length === 0 && applyGateObject.gate_state.apply_unlocked === true);
  const applyReceiptReady = Boolean(applyReceiptObject && applyReceiptFailures.length === 0 && applyReceiptObject.result.applied === true);
  const rollbackGateReady = Boolean(rollbackGateObject && rollbackGateFailures.length === 0 && rollbackGateObject.gate_state.rollback_unlocked === true);
  const rollbackReceiptReady = Boolean(rollbackReceiptObject && rollbackReceiptFailures.length === 0 && rollbackReceiptObject.finality.operator_loop_complete === true);
  const verificationReady = workspaceBound && planReady && patchCustodyReady && verificationGateReady && runtimeReady && diagnosticsReady;
  const applyGateReady = applyGateObjectReady && operatorState !== "VERIFY_FAILED";

  const record = React.useCallback((kind: string, detail: unknown) => {
    setEventLog((items) => [
      {
        at: new Date().toISOString(),
        kind,
        detail: safeJson(detail),
      },
      ...items,
    ].slice(0, 80));
  }, []);

  const refreshRuntime = React.useCallback(async () => {
    try {
      const api = bridge();
      const runtime = asRecord(api.runtime);
      const snapshotFn = runtime?.snapshot;

      if (typeof snapshotFn !== "function") {
        setRuntimeReady(false);
        record("runtime.unavailable", "runtime.snapshot bridge missing");
        return;
      }

      const result = await snapshotFn.call(runtime);
      const data = unwrapEnvelope(result);
      setRuntimeReady(true);
      record("runtime.snapshot", data);
    } catch (error) {
      setRuntimeReady(false);
      setLastError(error instanceof Error ? error.message : String(error));
      record("runtime.error", error instanceof Error ? error.message : String(error));
    }
  }, [record]);

  const refreshWorkspace = React.useCallback(async () => {
    try {
      const api = bridge();
      const workspace = asRecord(api.workspace);
      const healthFn = workspace?.health;

      if (typeof healthFn !== "function") {
        record("workspace.health.unavailable", "workspace.health bridge missing");
        return;
      }

      const result = unwrapEnvelope(await healthFn.call(workspace));
      const health = asRecord(result) ?? {};

      const root = deriveRoot(health);
      const selected = deriveSelectedPath(health);

      if (root) setWorkspaceRoot(root);
      if (selected) setSelectedPath(selected);
      if (root && operatorState === "NO_WORKSPACE") setOperatorState("WORKSPACE_UNTRUSTED");

      setTrustLevel(String(health.trustLevel ?? health.trust ?? "unknown"));
      setWritable(String(health.writable ?? "unknown"));
      setIssueCount(Array.isArray(health.issues) ? health.issues.length : 0);

      record("workspace.health", health);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
      record("workspace.error", error instanceof Error ? error.message : String(error));
    }
  }, [operatorState, record]);

  const refreshAgent = React.useCallback(async () => {
    try {
      const api = bridge();
      const agent = asRecord(api.agent);
      const healthFn = agent?.health;

      if (typeof healthFn !== "function") {
        setAgentReady(false);
        record("agent.unavailable", "agent.health bridge missing");
        return;
      }

      const result = await healthFn.call(agent);
      setAgentReady(true);
      record("agent.health", unwrapEnvelope(result));
    } catch (error) {
      setAgentReady(false);
      setLastError(error instanceof Error ? error.message : String(error));
      record("agent.error", error instanceof Error ? error.message : String(error));
    }
  }, [record]);

  const refreshDiagnostics = React.useCallback(async () => {
    try {
      const api = bridge();
      const diagnostics = asRecord(api.diagnostics);
      const runtimeFn = diagnostics?.runtime;

      if (typeof runtimeFn !== "function") {
        setDiagnosticsReady(false);
        record("diagnostics.unavailable", "diagnostics.runtime bridge missing");
        return;
      }

      const result = await runtimeFn.call(diagnostics);
      setDiagnosticsReady(true);
      record("diagnostics.runtime", unwrapEnvelope(result));
    } catch (error) {
      setDiagnosticsReady(false);
      setLastError(error instanceof Error ? error.message : String(error));
      record("diagnostics.error", error instanceof Error ? error.message : String(error));
    }
  }, [record]);

  const openWorkspace = React.useCallback(async () => {
    try {
      setLastError(null);
      setOperatorState("WORKSPACE_INDEXING");
      setPlanObject(null);
      setPlanFailures([]);
      setPatchCustodyObject(null);
      setPatchCustodyFailures([]);
      setVerificationGateObject(null);
      setVerificationGateFailures([]);
      setVerifyReceiptObject(null);
      setVerifyReceiptFailures([]);
      setApplyGateObject(null);
      setApplyGateFailures([]);
      setApplyReceiptObject(null);
      setApplyReceiptFailures([]);
      setRollbackGateObject(null);
      setRollbackGateFailures([]);
      setRollbackReceiptObject(null);
      setRollbackReceiptFailures([]);

      const api = bridge();
      const workspace = asRecord(api.workspace);
      const openFn = workspace?.open;
      const loadFn = workspace?.load;

      if (typeof openFn !== "function") {
        setOperatorState("NO_WORKSPACE");
        throw new Error("workspace.open bridge missing");
      }

      const opened = await openFn.call(workspace, {});
      const openedData = unwrapEnvelope(opened);

      const root = deriveRoot(openedData);
      const selected = deriveSelectedPath(openedData);

      if (root) setWorkspaceRoot(root);
      if (selected ?? root) setSelectedPath(selected ?? root);

      if (typeof loadFn === "function") {
        const loaded = await loadFn.call(workspace, root ? { rootPath: root, path: root } : {});
        const loadedData = unwrapEnvelope(loaded);
        const loadedRoot = deriveRoot(loadedData);
        const loadedSelected = deriveSelectedPath(loadedData);

        if (loadedRoot) setWorkspaceRoot(loadedRoot);
        if (loadedSelected ?? loadedRoot) setSelectedPath(loadedSelected ?? loadedRoot);
      }

      setOperatorState("WORKSPACE_UNTRUSTED");
      record("workspace.opened", { root: root ?? "unknown", selected: selected ?? null });

      await refreshWorkspace();
      await refreshRuntime();
      await refreshAgent();
      await refreshDiagnostics();

      setOperatorState("READY_FOR_INTENT");
    } catch (error) {
      setOperatorState("NO_WORKSPACE");
      setLastError(error instanceof Error ? error.message : String(error));
      record("workspace.open.error", error instanceof Error ? error.message : String(error));
    }
  }, [record, refreshAgent, refreshDiagnostics, refreshRuntime, refreshWorkspace]);

  React.useEffect(() => {
    const api = bridge();
    const manifest = asRecord(api.manifest);
    const capabilities = Array.isArray(manifest?.capabilities) ? manifest.capabilities.length : 0;
    setCapabilityCount(capabilities);

    void refreshRuntime();
    void refreshWorkspace();
    void refreshAgent();
    void refreshDiagnostics();
  }, [refreshAgent, refreshDiagnostics, refreshRuntime, refreshWorkspace]);

  const stageIntent = () => {
    if (!workspaceBound || !workspaceRoot || !intentDraft.trim()) return;

    setOperatorState("PLAN_PENDING");
    setPatchCustodyObject(null);
    setPatchCustodyFailures([]);
    setVerificationGateObject(null);
    setVerificationGateFailures([]);
    setVerifyReceiptObject(null);
    setVerifyReceiptFailures([]);
    setApplyGateObject(null);
    setApplyGateFailures([]);
    setApplyReceiptObject(null);
    setApplyReceiptFailures([]);
    setRollbackGateObject(null);
    setRollbackGateFailures([]);
    setRollbackReceiptObject(null);
    setRollbackReceiptFailures([]);

    const plan = createIntentPlanObject({
      workspaceRoot,
      selectedPath,
      intent: intentDraft,
      trustLevel,
      writable,
      issueCount,
    });

    const failures = validateIntentPlanObject(plan);

    setPlanObject(plan);
    setPlanFailures(failures);

    const receipt = {
      receipt_type: "plan_receipt",
      timestamp: new Date().toISOString(),
      plan_id: plan.plan_id,
      plan_valid: failures.length === 0,
      plan_failures: failures,
      workspace_root: workspaceRoot,
      selected_path: selectedPath,
      intent: intentDraft.trim(),
      next_state: failures.length === 0 ? "PATCH_CUSTODY_PENDING" : "READY_FOR_INTENT",
    };

    setLastReceipt(receipt);
    record("plan.object.created", plan);
    record("plan.receipt", receipt);

    setOperatorState(failures.length === 0 ? "PATCH_CUSTODY_PENDING" : "READY_FOR_INTENT");
  };

  const createPatchCustody = () => {
    if (!planObject || planFailures.length > 0) return;

    setOperatorState("PATCH_CUSTODY_PENDING");

    const patch = createPatchCustodyObject(planObject);
    const failures = validatePatchCustodyObject(patch, planObject);

    setPatchCustodyObject(patch);
    setPatchCustodyFailures(failures);
    setVerificationGateObject(null);
    setVerificationGateFailures([]);
    setVerifyReceiptObject(null);
    setVerifyReceiptFailures([]);
    setApplyGateObject(null);
    setApplyGateFailures([]);
    setApplyReceiptObject(null);
    setApplyReceiptFailures([]);
    setRollbackGateObject(null);
    setRollbackGateFailures([]);
    setRollbackReceiptObject(null);
    setRollbackReceiptFailures([]);

    const receipt = {
      receipt_type: "patch_custody_receipt",
      timestamp: new Date().toISOString(),
      plan_id: planObject.plan_id,
      patch_custody_id: patch.patch_custody_id,
      patch_custody_valid: failures.length === 0,
      patch_custody_failures: failures,
      workspace_root: patch.workspace_root,
      selected_path: patch.selected_path,
      diff_materialized: false,
      files_mutated: false,
      next_state: failures.length === 0 ? "PATCH_READY" : "PATCH_CUSTODY_PENDING",
    };

    setLastReceipt(receipt);
    record("patch.custody.created", patch);
    record("patch.custody.receipt", receipt);

    setOperatorState(failures.length === 0 ? "PATCH_READY" : "PATCH_CUSTODY_PENDING");
  };

  const createVerificationGate = () => {
    if (!planObject || !patchCustodyObject || planFailures.length > 0 || patchCustodyFailures.length > 0) return;

    setOperatorState("VERIFICATION_GATE_PENDING");

    const gate = createVerificationGateObject({
      plan: planObject,
      patch: patchCustodyObject,
      runtimeReady,
      diagnosticsReady,
    });

    const failures = validateVerificationGateObject(gate, planObject, patchCustodyObject);

    setVerificationGateObject(gate);
    setVerificationGateFailures(failures);
    setVerifyReceiptObject(null);
    setVerifyReceiptFailures([]);
    setApplyGateObject(null);
    setApplyGateFailures([]);
    setApplyReceiptObject(null);
    setApplyReceiptFailures([]);
    setRollbackGateObject(null);
    setRollbackGateFailures([]);
    setRollbackReceiptObject(null);
    setRollbackReceiptFailures([]);

    const receipt = {
      receipt_type: "verification_gate_receipt",
      timestamp: new Date().toISOString(),
      plan_id: planObject.plan_id,
      patch_custody_id: patchCustodyObject.patch_custody_id,
      verification_gate_id: gate.verification_gate_id,
      verification_gate_valid: failures.length === 0,
      verification_gate_failures: failures,
      runtime_ready: runtimeReady,
      diagnostics_ready: diagnosticsReady,
      apply_unlocked: false,
      next_state: failures.length === 0 ? "VERIFY_RUNNING" : "VERIFICATION_GATE_PENDING",
    };

    setLastReceipt(receipt);
    record("verification.gate.created", gate);
    record("verification.gate.receipt", receipt);

    setOperatorState(failures.length === 0 ? "VERIFY_RUNNING" : "VERIFICATION_GATE_PENDING");
  };

  const bindVerification = () => {
    if (!workspaceBound || !planObject || !patchCustodyObject || !verificationGateObject || !planReady || !patchCustodyReady || !verificationGateReady) return;

    setOperatorState("VERIFY_RUNNING");

    const receiptObject = createVerifyReceiptObject({
      plan: planObject,
      patch: patchCustodyObject,
      gate: verificationGateObject,
      runtimeReady,
      diagnosticsReady,
    });

    const failures = validateVerifyReceiptObject(receiptObject, planObject, patchCustodyObject, verificationGateObject);

    setVerifyReceiptObject(receiptObject);
    setVerifyReceiptFailures(failures);
    setApplyGateObject(null);
    setApplyGateFailures([]);
    setApplyReceiptObject(null);
    setApplyReceiptFailures([]);
    setRollbackGateObject(null);
    setRollbackGateFailures([]);
    setRollbackReceiptObject(null);
    setRollbackReceiptFailures([]);

    const receipt = {
      receipt_type: "verify_receipt",
      timestamp: new Date().toISOString(),
      verify_receipt_id: receiptObject.verify_receipt_id,
      plan_id: planObject.plan_id,
      patch_custody_id: patchCustodyObject.patch_custody_id,
      verification_gate_id: verificationGateObject.verification_gate_id,
      workspace_root: workspaceRoot,
      runtime_ready: runtimeReady,
      diagnostics_ready: diagnosticsReady,
      verify_receipt_valid: failures.length === 0,
      verify_receipt_failures: failures,
      verdict: receiptObject.verdict.status,
      apply_unlocked: failures.length === 0 && receiptObject.verdict.passed,
      next_state: failures.length === 0 && receiptObject.verdict.passed ? "READY_TO_APPLY" : "VERIFY_FAILED",
    };

    setLastReceipt(receipt);
    record("verify.receipt.created", receiptObject);
    record("verify.receipt", receipt);

    setOperatorState(failures.length === 0 && receiptObject.verdict.passed ? "READY_TO_APPLY" : "VERIFY_FAILED");
  };

  const createApplyGate = () => {
    if (!workspaceBound || !planObject || !patchCustodyObject || !verificationGateObject || !verifyReceiptObject || !verifyReceiptReady) return;

    const gate = createApplyGateObject({
      plan: planObject,
      patch: patchCustodyObject,
      gate: verificationGateObject,
      receipt: verifyReceiptObject,
    });

    const failures = validateApplyGateObject(gate, planObject, patchCustodyObject, verificationGateObject, verifyReceiptObject);

    setApplyGateObject(gate);
    setApplyGateFailures(failures);
    setApplyReceiptObject(null);
    setApplyReceiptFailures([]);
    setRollbackGateObject(null);
    setRollbackGateFailures([]);
    setRollbackReceiptObject(null);
    setRollbackReceiptFailures([]);

    const receipt = {
      receipt_type: "apply_gate_receipt",
      timestamp: new Date().toISOString(),
      apply_gate_id: gate.apply_gate_id,
      verify_receipt_id: verifyReceiptObject.verify_receipt_id,
      plan_id: planObject.plan_id,
      patch_custody_id: patchCustodyObject.patch_custody_id,
      verification_gate_id: verificationGateObject.verification_gate_id,
      workspace_root: workspaceRoot,
      apply_gate_valid: failures.length === 0,
      apply_gate_failures: failures,
      apply_unlocked: failures.length === 0,
      may_mutate_files: false,
      may_apply_patch: false,
      next_state: failures.length === 0 ? "READY_TO_APPLY" : "VERIFY_FAILED",
    };

    setLastReceipt(receipt);
    record("apply.gate.created", gate);
    record("apply.gate.receipt", receipt);

    setOperatorState(failures.length === 0 ? "READY_TO_APPLY" : "VERIFY_FAILED");
  };

  const issueApplyReceipt = () => {
    if (
      !applyGateReady ||
      !planObject ||
      !patchCustodyObject ||
      !verificationGateObject ||
      !verifyReceiptObject ||
      !applyGateObject
    ) return;

    const receiptObject = createApplyReceiptObject({
      plan: planObject,
      patch: patchCustodyObject,
      verificationGate: verificationGateObject,
      verifyReceipt: verifyReceiptObject,
      applyGate: applyGateObject,
    });

    const failures = validateApplyReceiptObject(
      receiptObject,
      planObject,
      patchCustodyObject,
      verificationGateObject,
      verifyReceiptObject,
      applyGateObject,
    );

    setApplyReceiptObject(receiptObject);
    setApplyReceiptFailures(failures);
    setRollbackGateObject(null);
    setRollbackGateFailures([]);
    setRollbackReceiptObject(null);
    setRollbackReceiptFailures([]);

    const receipt = {
      receipt_type: "apply_receipt",
      timestamp: new Date().toISOString(),
      apply_receipt_id: receiptObject.apply_receipt_id,
      plan_id: planObject.plan_id,
      patch_custody_id: patchCustodyObject.patch_custody_id,
      verification_gate_id: verificationGateObject.verification_gate_id,
      verify_receipt_id: verifyReceiptObject.verify_receipt_id,
      apply_gate_id: applyGateObject.apply_gate_id,
      workspace_root: workspaceRoot,
      selected_path: selectedPath,
      apply_receipt_valid: failures.length === 0,
      apply_receipt_failures: failures,
      applied: failures.length === 0,
      rollback_available: failures.length === 0,
      next_state: failures.length === 0 ? "ROLLBACK_AVAILABLE" : "READY_TO_APPLY",
    };

    setLastReceipt(receipt);
    record("apply.receipt.created", receiptObject);
    record("apply.receipt", receipt);

    setOperatorState(failures.length === 0 ? "APPLIED_WITH_RECEIPT" : "READY_TO_APPLY");
    if (failures.length === 0) setTimeout(() => setOperatorState("ROLLBACK_AVAILABLE"), 0);
  };

  const createRollbackGate = () => {
    if (
      !applyReceiptReady ||
      !planObject ||
      !patchCustodyObject ||
      !verificationGateObject ||
      !verifyReceiptObject ||
      !applyGateObject ||
      !applyReceiptObject
    ) return;

    const gate = createRollbackGateObject({
      plan: planObject,
      patch: patchCustodyObject,
      verificationGate: verificationGateObject,
      verifyReceipt: verifyReceiptObject,
      applyGate: applyGateObject,
      applyReceipt: applyReceiptObject,
    });

    const failures = validateRollbackGateObject(
      gate,
      planObject,
      patchCustodyObject,
      verificationGateObject,
      verifyReceiptObject,
      applyGateObject,
      applyReceiptObject,
    );

    setRollbackGateObject(gate);
    setRollbackGateFailures(failures);
    setRollbackReceiptObject(null);
    setRollbackReceiptFailures([]);

    const receipt = {
      receipt_type: "rollback_gate_receipt",
      timestamp: new Date().toISOString(),
      rollback_gate_id: gate.rollback_gate_id,
      apply_receipt_id: applyReceiptObject.apply_receipt_id,
      apply_gate_id: applyGateObject.apply_gate_id,
      verify_receipt_id: verifyReceiptObject.verify_receipt_id,
      verification_gate_id: verificationGateObject.verification_gate_id,
      patch_custody_id: patchCustodyObject.patch_custody_id,
      plan_id: planObject.plan_id,
      workspace_root: workspaceRoot,
      rollback_gate_valid: failures.length === 0,
      rollback_gate_failures: failures,
      rollback_unlocked: failures.length === 0,
      next_state: failures.length === 0 ? "ROLLBACK_AVAILABLE" : "APPLIED_WITH_RECEIPT",
    };

    setLastReceipt(receipt);
    record("rollback.gate.created", gate);
    record("rollback.gate.receipt", receipt);

    setOperatorState(failures.length === 0 ? "ROLLBACK_AVAILABLE" : "APPLIED_WITH_RECEIPT");
  };

  const issueRollbackReceipt = () => {
    if (
      !rollbackGateReady ||
      !planObject ||
      !patchCustodyObject ||
      !verificationGateObject ||
      !verifyReceiptObject ||
      !applyGateObject ||
      !applyReceiptObject ||
      !rollbackGateObject
    ) return;

    const receiptObject = createRollbackReceiptObject({
      plan: planObject,
      patch: patchCustodyObject,
      verificationGate: verificationGateObject,
      verifyReceipt: verifyReceiptObject,
      applyGate: applyGateObject,
      applyReceipt: applyReceiptObject,
      rollbackGate: rollbackGateObject,
    });

    const failures = validateRollbackReceiptObject(
      receiptObject,
      planObject,
      patchCustodyObject,
      verificationGateObject,
      verifyReceiptObject,
      applyGateObject,
      applyReceiptObject,
      rollbackGateObject,
    );

    setRollbackReceiptObject(receiptObject);
    setRollbackReceiptFailures(failures);

    const receipt = {
      receipt_type: "rollback_receipt",
      timestamp: new Date().toISOString(),
      rollback_receipt_id: receiptObject.rollback_receipt_id,
      rollback_gate_id: rollbackGateObject.rollback_gate_id,
      apply_receipt_id: applyReceiptObject.apply_receipt_id,
      apply_gate_id: applyGateObject.apply_gate_id,
      verify_receipt_id: verifyReceiptObject.verify_receipt_id,
      verification_gate_id: verificationGateObject.verification_gate_id,
      patch_custody_id: patchCustodyObject.patch_custody_id,
      plan_id: planObject.plan_id,
      workspace_root: workspaceRoot,
      selected_path: selectedPath,
      rollback_receipt_valid: failures.length === 0,
      rollback_receipt_failures: failures,
      rollback_complete: failures.length === 0,
      operator_loop_complete: failures.length === 0,
      terminal_state: failures.length === 0 ? "ROLLBACK_COMPLETE" : "ROLLBACK_AVAILABLE",
    };

    setLastReceipt(receipt);
    record("rollback.receipt.created", receiptObject);
    record("rollback.receipt", receipt);

    setOperatorState(failures.length === 0 ? "ROLLBACK_COMPLETE" : "ROLLBACK_AVAILABLE");
  };

  const steps = [
    ["Repo intake", workspaceBound ? "complete" : "blocked", workspaceBound ? "Repository is in local custody." : "Open a local repository."],
    ["Trust classification", workspaceBound ? "complete" : "blocked", `trust=${trustLevel}; writable=${writable}; issues=${issueCount}`],
    ["Intent capture", intentDraft.trim() ? "ready" : workspaceBound ? "pending" : "blocked", intentDraft.trim() ? "Intent staged." : "Awaiting bounded intent."],
    ["Plan object", planReady ? "complete" : operatorState === "PLAN_PENDING" ? "pending" : "blocked", planReady ? `Plan ${planObject?.plan_id} is valid.` : "Create a valid intent plan object."],
    ["Patch object custody", patchCustodyReady ? "complete" : planReady ? "ready" : "blocked", patchCustodyReady ? `Patch object custody ${patchCustodyObject?.patch_custody_id} is valid.` : "Create patch custody from the plan object."],
    ["Verification Gate object", verificationGateReady ? "complete" : patchCustodyReady ? "ready" : "blocked", verificationGateReady ? `Verification Gate object ${verificationGateObject?.verification_gate_id} is valid.` : "Create verification gate from patch custody."],
    ["Verification object", verificationReady ? "ready" : "blocked", verificationReady ? "Runtime, diagnostics, plan, patch custody, and verification gate evidence present." : "Requires plan, patch custody, verification gate, runtime, and diagnostics."],
    ["Verify receipt", verifyReceiptReady ? "complete" : verificationGateReady ? "ready" : "blocked", verifyReceiptReady ? `Verify receipt ${verifyReceiptObject?.verify_receipt_id} passed.` : "Create verify receipt from the verification gate."],
    ["Apply Gate object", applyGateObjectReady ? "complete" : verifyReceiptReady ? "ready" : "blocked", applyGateObjectReady ? `Apply Gate object ${applyGateObject?.apply_gate_id} unlocked.` : "Create apply gate from the passed verify receipt."],
    ["Apply Receipt object", applyReceiptReady ? "complete" : applyGateReady ? "ready" : "blocked", applyReceiptReady ? `Apply Receipt object ${applyReceiptObject?.apply_receipt_id} created.` : "Create apply receipt from the Apply Gate object."],
    ["Rollback Gate object", rollbackGateReady ? "complete" : applyReceiptReady ? "ready" : "blocked", rollbackGateReady ? `Rollback Gate object ${rollbackGateObject?.rollback_gate_id} unlocked.` : "Create rollback gate from the Apply Receipt object."],
    ["Rollback Receipt object", rollbackReceiptReady ? "complete" : rollbackGateReady ? "ready" : "blocked", rollbackReceiptReady ? `Rollback Receipt object ${rollbackReceiptObject?.rollback_receipt_id} completed.` : "Create rollback receipt from the Rollback Gate object."],
    ["Apply gate", applyGateReady ? "ready" : "blocked", applyGateReady ? "Apply receipt can be issued." : "Apply blocked until Apply Gate object exists."],
    ["Rollback receipt", rollbackReceiptReady ? "complete" : rollbackGateReady ? "ready" : "blocked", "Rollback is first-class evidence and requires rollback receipt."],
  ] as const;

  return (
    <div className="min-h-screen bg-zinc-950 p-6 text-zinc-100">
      <div className="mx-auto grid max-w-[1800px] gap-6">
        <pre data-testid="local-operator-control-invariants" className="sr-only">
          {JSON.stringify({ invariants: LOCAL_OPERATOR_CONTROL_INVARIANTS, phrases: LOCAL_OPERATOR_CONTROL_PHRASES })}
        </pre>
        <section className="rounded-3xl border border-zinc-800 bg-zinc-950/80 p-6 shadow-2xl">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
            <div>
              <div className="text-xs uppercase tracking-[0.28em] text-zinc-500">
                Local governed coding control plane
              </div>
              <h1 className="mt-3 text-4xl font-semibold tracking-tight text-zinc-50">
                ADJUTORIX Operator Cockpit
              </h1>
              <p className="mt-3 max-w-5xl text-sm leading-7 text-zinc-400">
                Repository custody, trust posture, intent staging, intent plan object, patch custody object, patch object, verification object, apply gate, rollback receipt, and evidence timeline are now the default renderer surface.
              </p>
            </div>

            <div className="grid min-w-[20rem] gap-2 rounded-2xl border border-zinc-800 bg-black/30 p-4 text-sm">
              <div className="flex items-center justify-between gap-4">
                <span className="text-zinc-500">operator state</span>
                <span className="font-mono text-zinc-100">{operatorState}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-zinc-500">workspace</span>
                <span className={workspaceBound ? "text-emerald-300" : "text-amber-300"}>
                  {workspaceBound ? "BOUND" : "NONE"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-zinc-500">plan</span>
                <span className={planReady ? "text-emerald-300" : "text-amber-300"}>
                  {planReady ? "VALID" : "MISSING"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-zinc-500">patch custody</span>
                <span className={patchCustodyReady ? "text-emerald-300" : "text-amber-300"}>
                  {patchCustodyReady ? "BOUND" : "MISSING"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-zinc-500">verification gate</span>
                <span className={verificationGateReady ? "text-emerald-300" : "text-amber-300"}>
                  {verificationGateReady ? "BOUND" : "MISSING"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-zinc-500">verify receipt</span>
                <span className={verifyReceiptReady ? "text-emerald-300" : "text-amber-300"}>
                  {verifyReceiptReady ? "PASS" : "MISSING"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-zinc-500">apply gate object</span>
                <span className={applyGateObjectReady ? "text-emerald-300" : "text-amber-300"}>
                  {applyGateObjectReady ? "READY" : "MISSING"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-zinc-500">apply receipt</span>
                <span className={applyReceiptReady ? "text-emerald-300" : "text-amber-300"}>
                  {applyReceiptReady ? "CREATED" : "MISSING"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-zinc-500">rollback gate</span>
                <span className={rollbackGateReady ? "text-emerald-300" : "text-amber-300"}>
                  {rollbackGateReady ? "READY" : "MISSING"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-zinc-500">rollback receipt</span>
                <span className={rollbackReceiptReady ? "text-emerald-300" : "text-amber-300"}>
                  {rollbackReceiptReady ? "COMPLETE" : "MISSING"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-zinc-500">apply gate</span>
                <span className={applyGateReady ? "text-emerald-300" : "text-amber-300"}>
                  {applyGateReady ? "READY" : "BLOCKED"}
                </span>
              </div>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <button type="button" onClick={() => void openWorkspace()} className="rounded-2xl border border-zinc-700 bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-white">
              Open repository
            </button>
            <button type="button" onClick={stageIntent} disabled={!workspaceBound || !intentDraft.trim()} className="rounded-2xl border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40">
              Create plan object
            </button>
            <button type="button" onClick={createPatchCustody} disabled={!planReady} className="rounded-2xl border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40">
              Create patch custody
            </button>
            <button type="button" onClick={createVerificationGate} disabled={!patchCustodyReady} className="rounded-2xl border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40">
              Create verification gate
            </button>
            <button type="button" onClick={bindVerification} disabled={!verificationGateReady} className="rounded-2xl border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40">
              Bind verification
            </button>
            <button type="button" onClick={createApplyGate} disabled={!verifyReceiptReady} className="rounded-2xl border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40">
              Create apply gate
            </button>
            <button type="button" aria-label="apply with receipt" onClick={issueApplyReceipt} disabled={!applyGateReady} className="rounded-2xl border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40">
              Apply with receipt
            </button>
            <button type="button" onClick={createRollbackGate} disabled={!applyReceiptReady} className="rounded-2xl border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40">
              Create rollback gate
            </button>
            <button type="button" aria-label="rollback with receipt" onClick={issueRollbackReceipt} disabled={!rollbackGateReady} className="rounded-2xl border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40">
              Rollback with receipt
            </button>
          </div>
        </section>

        {lastError ? (
          <section className="rounded-3xl border border-red-500/40 bg-red-950/30 p-5 text-red-100">
            <div className="text-xs uppercase tracking-[0.24em] text-red-300">Failure</div>
            <p className="mt-2 font-mono text-sm">{lastError}</p>
          </section>
        ) : null}

        {planFailures.length > 0 ? (
          <section className="rounded-3xl border border-red-500/40 bg-red-950/30 p-5 text-red-100">
            <div className="text-xs uppercase tracking-[0.24em] text-red-300">Plan object invalid</div>
            <pre className="mt-3 whitespace-pre-wrap text-sm">{JSON.stringify(planFailures, null, 2)}</pre>
          </section>
        ) : null}

        {patchCustodyFailures.length > 0 ? (
          <section className="rounded-3xl border border-red-500/40 bg-red-950/30 p-5 text-red-100">
            <div className="text-xs uppercase tracking-[0.24em] text-red-300">Patch custody invalid</div>
            <pre className="mt-3 whitespace-pre-wrap text-sm">{JSON.stringify(patchCustodyFailures, null, 2)}</pre>
          </section>
        ) : null}

        {verificationGateFailures.length > 0 ? (
          <section className="rounded-3xl border border-red-500/40 bg-red-950/30 p-5 text-red-100">
            <div className="text-xs uppercase tracking-[0.24em] text-red-300">Verification Gate object invalid</div>
            <pre className="mt-3 whitespace-pre-wrap text-sm">{JSON.stringify(verificationGateFailures, null, 2)}</pre>
          </section>
        ) : null}

        {verifyReceiptFailures.length > 0 ? (
          <section className="rounded-3xl border border-red-500/40 bg-red-950/30 p-5 text-red-100">
            <div className="text-xs uppercase tracking-[0.24em] text-red-300">Verify receipt object invalid</div>
            <pre className="mt-3 whitespace-pre-wrap text-sm">{JSON.stringify(verifyReceiptFailures, null, 2)}</pre>
          </section>
        ) : null}

        {applyGateFailures.length > 0 ? (
          <section className="rounded-3xl border border-red-500/40 bg-red-950/30 p-5 text-red-100">
            <div className="text-xs uppercase tracking-[0.24em] text-red-300">Apply Gate object invalid</div>
            <pre className="mt-3 whitespace-pre-wrap text-sm">{JSON.stringify(applyGateFailures, null, 2)}</pre>
          </section>
        ) : null}

        {applyReceiptFailures.length > 0 ? (
          <section className="rounded-3xl border border-red-500/40 bg-red-950/30 p-5 text-red-100">
            <div className="text-xs uppercase tracking-[0.24em] text-red-300">Apply Receipt object invalid</div>
            <pre className="mt-3 whitespace-pre-wrap text-sm">{JSON.stringify(applyReceiptFailures, null, 2)}</pre>
          </section>
        ) : null}

        {rollbackGateFailures.length > 0 ? (
          <section className="rounded-3xl border border-red-500/40 bg-red-950/30 p-5 text-red-100">
            <div className="text-xs uppercase tracking-[0.24em] text-red-300">Rollback Gate object invalid</div>
            <pre className="mt-3 whitespace-pre-wrap text-sm">{JSON.stringify(rollbackGateFailures, null, 2)}</pre>
          </section>
        ) : null}

        {rollbackReceiptFailures.length > 0 ? (
          <section className="rounded-3xl border border-red-500/40 bg-red-950/30 p-5 text-red-100">
            <div className="text-xs uppercase tracking-[0.24em] text-red-300">Rollback Receipt object invalid</div>
            <pre className="mt-3 whitespace-pre-wrap text-sm">{JSON.stringify(rollbackReceiptFailures, null, 2)}</pre>
          </section>
        ) : null}

        <section className="grid gap-4 xl:grid-cols-4">
          {steps.map(([label, state, description], index) => (
            <article key={label} className={cx("rounded-2xl border p-4", surfaceClass(state as any))}>
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-xs opacity-70">{String(index + 1).padStart(2, "0")}</span>
                <span className="rounded-full border border-current/20 px-2 py-1 text-[0.65rem] uppercase tracking-[0.18em] opacity-80">
                  {state}
                </span>
              </div>
              <h2 className="mt-3 text-base font-semibold">{label}</h2>
              <p className="mt-2 text-sm leading-6 opacity-75">{description}</p>
            </article>
          ))}
        </section>

        <section className="grid gap-6 2xl:grid-cols-[minmax(0,1.1fr)_minmax(24rem,0.9fr)]">
          <article className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-5">
            <div className="text-xs uppercase tracking-[0.24em] text-zinc-500">Intent capture</div>
            <h2 className="mt-2 text-xl font-semibold text-zinc-50">Bounded change request</h2>
            <p className="mt-2 text-sm leading-6 text-zinc-400">
              This creates an ADJUTORIX_INTENT_PLAN_OBJECT, then a non-mutating ADJUTORIX_PATCH_CUSTODY_OBJECT, then an ADJUTORIX_VERIFICATION_GATE_OBJECT, then an ADJUTORIX_VERIFY_RECEIPT_OBJECT, then an ADJUTORIX_APPLY_GATE_OBJECT, then an ADJUTORIX_APPLY_RECEIPT_OBJECT, then an ADJUTORIX_ROLLBACK_GATE_OBJECT, then an ADJUTORIX_ROLLBACK_RECEIPT_OBJECT. The terminal state is ROLLBACK_COMPLETE.
            </p>
            <textarea
              value={intentDraft}
              onChange={(event) => setIntentDraft(event.currentTarget.value)}
              disabled={!workspaceBound}
              placeholder={workspaceBound ? "Describe the governed repository change..." : "Open a repository before staging intent."}
              className="mt-4 min-h-[12rem] w-full resize-y rounded-2xl border border-zinc-800 bg-black/40 p-4 font-mono text-sm leading-6 text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </article>

          <article className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-5">
            <div className="text-xs uppercase tracking-[0.24em] text-zinc-500">Custody facts</div>
            <h2 className="mt-2 text-xl font-semibold text-zinc-50">Repository posture</h2>
            <dl className="mt-5 grid gap-3 text-sm">
              <div className="rounded-2xl border border-zinc-800 bg-black/30 p-3">
                <dt className="text-zinc-500">root</dt>
                <dd className="mt-1 break-all font-mono text-zinc-100">{workspaceRoot ?? "none"}</dd>
              </div>
              <div className="rounded-2xl border border-zinc-800 bg-black/30 p-3">
                <dt className="text-zinc-500">selected path</dt>
                <dd className="mt-1 break-all font-mono text-zinc-100">{selectedPath ?? "none"}</dd>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-2xl border border-zinc-800 bg-black/30 p-3">
                  <dt className="text-zinc-500">trust</dt>
                  <dd className="mt-1 font-mono text-zinc-100">{trustLevel}</dd>
                </div>
                <div className="rounded-2xl border border-zinc-800 bg-black/30 p-3">
                  <dt className="text-zinc-500">writable</dt>
                  <dd className="mt-1 font-mono text-zinc-100">{writable}</dd>
                </div>
                <div className="rounded-2xl border border-zinc-800 bg-black/30 p-3">
                  <dt className="text-zinc-500">issues</dt>
                  <dd className="mt-1 font-mono text-zinc-100">{issueCount}</dd>
                </div>
                <div className="rounded-2xl border border-zinc-800 bg-black/30 p-3">
                  <dt className="text-zinc-500">capabilities</dt>
                  <dd className="mt-1 font-mono text-zinc-100">{capabilityCount}</dd>
                </div>
              </div>
            </dl>
          </article>
        </section>

        <section className="grid gap-6 xl:grid-cols-3">
          <article className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-5">
            <div className="flex items-center gap-3">
              <span className={cx("h-2.5 w-2.5 rounded-full", dot(runtimeReady))} />
              <h2 className="text-lg font-semibold text-zinc-50">Runtime</h2>
            </div>
            <button type="button" onClick={() => void refreshRuntime()} className="mt-4 rounded-2xl border border-zinc-700 px-4 py-2 text-sm text-zinc-100">
              Refresh runtime
            </button>
          </article>

          <article className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-5">
            <div className="flex items-center gap-3">
              <span className={cx("h-2.5 w-2.5 rounded-full", dot(agentReady))} />
              <h2 className="text-lg font-semibold text-zinc-50">Agent</h2>
            </div>
            <button type="button" onClick={() => void refreshAgent()} className="mt-4 rounded-2xl border border-zinc-700 px-4 py-2 text-sm text-zinc-100">
              Refresh agent
            </button>
          </article>

          <article className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-5">
            <div className="flex items-center gap-3">
              <span className={cx("h-2.5 w-2.5 rounded-full", dot(diagnosticsReady))} />
              <h2 className="text-lg font-semibold text-zinc-50">Diagnostics</h2>
            </div>
            <button type="button" onClick={() => void refreshDiagnostics()} className="mt-4 rounded-2xl border border-zinc-700 px-4 py-2 text-sm text-zinc-100">
              Refresh diagnostics
            </button>
          </article>
        </section>

        <section className="grid gap-6 2xl:grid-cols-10">
          <article className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-5">
            <div className="text-xs uppercase tracking-[0.24em] text-zinc-500">Latest receipt</div>
            <pre className="mt-4 max-h-[24rem] overflow-auto rounded-2xl border border-zinc-800 bg-black/40 p-4 text-xs leading-6 text-zinc-300">
              {JSON.stringify(lastReceipt ?? { receipt: "none" }, null, 2)}
            </pre>
          </article>

          <article className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-5">
            <div className="text-xs uppercase tracking-[0.24em] text-zinc-500">Intent plan object</div>
            <pre className="mt-4 max-h-[24rem] overflow-auto rounded-2xl border border-zinc-800 bg-black/40 p-4 text-xs leading-6 text-zinc-300">
              {JSON.stringify(planObject ?? { plan_object: "none" }, null, 2)}
            </pre>
          </article>

          <article className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-5">
            <div className="text-xs uppercase tracking-[0.24em] text-zinc-500">Patch custody object</div>
            <pre className="mt-4 max-h-[24rem] overflow-auto rounded-2xl border border-zinc-800 bg-black/40 p-4 text-xs leading-6 text-zinc-300">
              {JSON.stringify(patchCustodyObject ?? { patch_custody_object: "none" }, null, 2)}
            </pre>
          </article>

          <article className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-5">
            <div className="text-xs uppercase tracking-[0.24em] text-zinc-500">Verification Gate object</div>
            <pre className="mt-4 max-h-[24rem] overflow-auto rounded-2xl border border-zinc-800 bg-black/40 p-4 text-xs leading-6 text-zinc-300">
              {JSON.stringify(verificationGateObject ?? { verification_gate_object: "none" }, null, 2)}
            </pre>
          </article>

          <article className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-5">
            <div className="text-xs uppercase tracking-[0.24em] text-zinc-500">Verify receipt object</div>
            <pre className="mt-4 max-h-[24rem] overflow-auto rounded-2xl border border-zinc-800 bg-black/40 p-4 text-xs leading-6 text-zinc-300">
              {JSON.stringify(verifyReceiptObject ?? { verify_receipt_object: "none" }, null, 2)}
            </pre>
          </article>

          <article className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-5">
            <div className="text-xs uppercase tracking-[0.24em] text-zinc-500">Apply Gate object</div>
            <pre className="mt-4 max-h-[24rem] overflow-auto rounded-2xl border border-zinc-800 bg-black/40 p-4 text-xs leading-6 text-zinc-300">
              {JSON.stringify(applyGateObject ?? { apply_gate_object: "none" }, null, 2)}
            </pre>
          </article>

          <article className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-5">
            <div className="text-xs uppercase tracking-[0.24em] text-zinc-500">Apply Receipt object</div>
            <pre className="mt-4 max-h-[24rem] overflow-auto rounded-2xl border border-zinc-800 bg-black/40 p-4 text-xs leading-6 text-zinc-300">
              {JSON.stringify(applyReceiptObject ?? { apply_receipt_object: "none" }, null, 2)}
            </pre>
          </article>

          <article className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-5">
            <div className="text-xs uppercase tracking-[0.24em] text-zinc-500">Rollback Gate object</div>
            <pre className="mt-4 max-h-[24rem] overflow-auto rounded-2xl border border-zinc-800 bg-black/40 p-4 text-xs leading-6 text-zinc-300">
              {JSON.stringify(rollbackGateObject ?? { rollback_gate_object: "none" }, null, 2)}
            </pre>
          </article>

          <article className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-5">
            <div className="text-xs uppercase tracking-[0.24em] text-zinc-500">Rollback Receipt object</div>
            <pre className="mt-4 max-h-[24rem] overflow-auto rounded-2xl border border-zinc-800 bg-black/40 p-4 text-xs leading-6 text-zinc-300">
              {JSON.stringify(rollbackReceiptObject ?? { rollback_receipt_object: "none" }, null, 2)}
            </pre>
          </article>

          <article className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-5">
            <div className="text-xs uppercase tracking-[0.24em] text-zinc-500">Evidence timeline</div>
            <div className="mt-4 max-h-[24rem] overflow-auto rounded-2xl border border-zinc-800 bg-black/40 p-4">
              {eventLog.length === 0 ? (
                <p className="text-sm text-zinc-500">No events recorded yet.</p>
              ) : (
                <ol className="grid gap-4">
                  {eventLog.map((event, index) => (
                    <li key={`${event.at}-${index}`} className="border-b border-zinc-900 pb-3 last:border-b-0">
                      <div className="font-mono text-xs text-zinc-500">{event.at}</div>
                      <div className="mt-1 text-sm font-semibold text-zinc-100">{event.kind}</div>
                      <pre className="mt-2 whitespace-pre-wrap text-xs leading-5 text-zinc-400">{event.detail}</pre>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </article>
        </section>

        <details className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-5">
          <summary className="cursor-pointer text-sm font-semibold uppercase tracking-[0.22em] text-zinc-400">
            Advanced surfaces
          </summary>
          <p className="mt-4 text-sm leading-6 text-zinc-400">
            Ledger, terminal, diagnostics internals, transaction graph, and raw provider state remain below the cockpit. They no longer own the default product surface.
          </p>
        </details>
      </div>
    </div>
  );
}
