// @ts-nocheck
import React from "react";

type OperatorState =
  | "NO_WORKSPACE"
  | "WORKSPACE_UNTRUSTED"
  | "WORKSPACE_INDEXING"
  | "READY_FOR_INTENT"
  | "PLAN_PENDING"
  | "PATCH_CUSTODY_PENDING"
  | "PATCH_READY"
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
        "node scripts/product/assert-patch-custody-object.mjs"
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
  const [lastReceipt, setLastReceipt] = React.useState<Record<string, unknown> | null>(null);
  const [lastError, setLastError] = React.useState<string | null>(null);
  const [eventLog, setEventLog] = React.useState<EventItem[]>([]);

  const workspaceBound = Boolean(workspaceRoot);
  const planReady = Boolean(planObject && planFailures.length === 0);
  const patchCustodyReady = Boolean(patchCustodyObject && patchCustodyFailures.length === 0);
  const verificationReady = workspaceBound && planReady && patchCustodyReady && runtimeReady && diagnosticsReady;
  const applyGateReady = verificationReady && operatorState !== "VERIFY_FAILED";

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

  const bindVerification = () => {
    if (!workspaceBound || !planReady || !patchCustodyReady) return;

    setOperatorState("VERIFY_RUNNING");

    const receipt = {
      receipt_type: "verify_receipt",
      timestamp: new Date().toISOString(),
      plan_id: planObject?.plan_id ?? null,
      patch_custody_id: patchCustodyObject?.patch_custody_id ?? null,
      workspace_root: workspaceRoot,
      runtime_ready: runtimeReady,
      diagnostics_ready: diagnosticsReady,
      verdict: verificationReady ? "READY_TO_APPLY" : "VERIFY_FAILED",
    };

    setLastReceipt(receipt);
    record("verify.receipt", receipt);
    setOperatorState(verificationReady ? "READY_TO_APPLY" : "VERIFY_FAILED");
  };

  const issueApplyReceipt = () => {
    if (!applyGateReady) return;

    const receipt = {
      receipt_type: "apply_receipt",
      timestamp: new Date().toISOString(),
      plan_id: planObject?.plan_id ?? null,
      patch_custody_id: patchCustodyObject?.patch_custody_id ?? null,
      workspace_root: workspaceRoot,
      selected_path: selectedPath,
      intent: intentDraft.trim(),
      verification_bound: true,
      rollback_available: true,
    };

    setLastReceipt(receipt);
    record("apply.receipt", receipt);
    setOperatorState("APPLIED_WITH_RECEIPT");
    setTimeout(() => setOperatorState("ROLLBACK_AVAILABLE"), 0);
  };

  const issueRollbackReceipt = () => {
    if (operatorState !== "ROLLBACK_AVAILABLE" && operatorState !== "APPLIED_WITH_RECEIPT") return;

    const receipt = {
      receipt_type: "rollback_receipt",
      timestamp: new Date().toISOString(),
      plan_id: planObject?.plan_id ?? null,
      patch_custody_id: patchCustodyObject?.patch_custody_id ?? null,
      workspace_root: workspaceRoot,
      selected_path: selectedPath,
      rollback_complete: true,
    };

    setLastReceipt(receipt);
    record("rollback.receipt", receipt);
    setOperatorState("ROLLBACK_COMPLETE");
  };

  const steps = [
    ["Repo intake", workspaceBound ? "complete" : "blocked", workspaceBound ? "Repository is in local custody." : "Open a local repository."],
    ["Trust classification", workspaceBound ? "complete" : "blocked", `trust=${trustLevel}; writable=${writable}; issues=${issueCount}`],
    ["Intent capture", intentDraft.trim() ? "ready" : workspaceBound ? "pending" : "blocked", intentDraft.trim() ? "Intent staged." : "Awaiting bounded intent."],
    ["Plan object", planReady ? "complete" : operatorState === "PLAN_PENDING" ? "pending" : "blocked", planReady ? `Plan ${planObject?.plan_id} is valid.` : "Create a valid intent plan object."],
    ["Patch object custody", patchCustodyReady ? "complete" : planReady ? "ready" : "blocked", patchCustodyReady ? `Patch object custody ${patchCustodyObject?.patch_custody_id} is valid.` : "Create patch custody from the plan object."],
    ["Verification object", verificationReady ? "ready" : "blocked", verificationReady ? "Runtime, diagnostics, plan, and patch custody evidence present." : "Requires plan, patch custody, runtime, and diagnostics."],
    ["Apply gate", applyGateReady ? "ready" : "blocked", applyGateReady ? "Apply receipt can be issued." : "Apply blocked until verification passes."],
    ["Rollback receipt", operatorState === "ROLLBACK_AVAILABLE" || operatorState === "ROLLBACK_COMPLETE" ? "ready" : "blocked", "Rollback is first-class evidence, not terminal cleanup."],
  ] as const;

  return (
    <div className="min-h-screen bg-zinc-950 p-6 text-zinc-100">
      <div className="mx-auto grid max-w-[1800px] gap-6">
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
            <button type="button" onClick={bindVerification} disabled={!patchCustodyReady} className="rounded-2xl border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40">
              Bind verification
            </button>
            <button type="button" onClick={issueApplyReceipt} disabled={!applyGateReady} className="rounded-2xl border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40">
              Apply with receipt
            </button>
            <button type="button" onClick={issueRollbackReceipt} disabled={operatorState !== "ROLLBACK_AVAILABLE" && operatorState !== "APPLIED_WITH_RECEIPT"} className="rounded-2xl border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40">
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
              This creates an ADJUTORIX_INTENT_PLAN_OBJECT, then a non-mutating ADJUTORIX_PATCH_CUSTODY_OBJECT. Files remain untouched until later governed patch materialization, verification, and apply receipt.
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

        <section className="grid gap-6 2xl:grid-cols-4">
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
