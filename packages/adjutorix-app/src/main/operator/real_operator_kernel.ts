import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export type OperatorKernelMode = "DRY_RUN" | "APPLY_REQUEST_BLOCKED" | "ROLLBACK_REQUEST_BLOCKED";
export type OperatorKernelOperationKind = "PLAN" | "PATCH_PREVIEW" | "VERIFY" | "APPLY" | "ROLLBACK";

export type OperatorKernelInput = {
  workspaceRoot: string;
  workspaceTrusted: boolean;
  workspaceWritable: boolean;
  intentText: string;
  operationKind: OperatorKernelOperationKind;
  paths: string[];
  diffText?: string;
  verificationPassed: boolean;
  verificationCommands: string[];
  previousHash?: string | null;
};

export type OperatorKernelReceipt = {
  object_type: "ADJUTORIX_OPERATOR_KERNEL_RECEIPT";
  schema_version: "1.0.0";
  receipt_id: string;
  created_at: string;
  kernel: {
    name: "ADJUTORIX_REAL_OPERATOR_KERNEL";
    mode: OperatorKernelMode;
    version: "0.3.0";
  };
  workspace: {
    root: string;
    trusted: boolean;
    writable: boolean;
  };
  intent: {
    text: string;
    bounded: true;
  };
  operation: {
    kind: OperatorKernelOperationKind;
    paths: string[];
    diff_sha256: string;
  };
  mutation_boundary: {
    renderer_may_mutate: false;
    kernel_may_mutate_without_verify: false;
    apply_requires_verify_pass: true;
    rollback_requires_apply_receipt: true;
    append_only_evidence: true;
  };
  verification: {
    required: true;
    passed: boolean;
    commands: string[];
  };
  evidence: {
    previous_hash: string | null;
    canonical_payload_sha256: string;
  };
  hash: string;
};

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deriveMode(input: OperatorKernelInput): OperatorKernelMode {
  if (input.operationKind === "APPLY" && input.verificationPassed !== true) return "APPLY_REQUEST_BLOCKED";
  if (input.operationKind === "ROLLBACK") return "ROLLBACK_REQUEST_BLOCKED";
  return "DRY_RUN";
}

export function createOperatorKernelReceipt(input: OperatorKernelInput): OperatorKernelReceipt {
  if (!input.workspaceRoot.trim()) throw new Error("workspaceRoot is required");
  if (!input.intentText.trim()) throw new Error("intentText is required");
  if (input.verificationCommands.length === 0) throw new Error("verificationCommands are required");

  const diffSha256 = sha256(input.diffText ?? "");
  const base = {
    object_type: "ADJUTORIX_OPERATOR_KERNEL_RECEIPT" as const,
    schema_version: "1.0.0" as const,
    receipt_id: `operator-kernel-${randomUUID()}`,
    created_at: new Date().toISOString(),
    kernel: {
      name: "ADJUTORIX_REAL_OPERATOR_KERNEL" as const,
      mode: deriveMode(input),
      version: "0.3.0" as const,
    },
    workspace: {
      root: input.workspaceRoot,
      trusted: input.workspaceTrusted,
      writable: input.workspaceWritable,
    },
    intent: {
      text: input.intentText.trim(),
      bounded: true as const,
    },
    operation: {
      kind: input.operationKind,
      paths: [...input.paths].sort(),
      diff_sha256: diffSha256,
    },
    mutation_boundary: {
      renderer_may_mutate: false as const,
      kernel_may_mutate_without_verify: false as const,
      apply_requires_verify_pass: true as const,
      rollback_requires_apply_receipt: true as const,
      append_only_evidence: true as const,
    },
    verification: {
      required: true as const,
      passed: input.verificationPassed,
      commands: [...input.verificationCommands],
    },
    evidence: {
      previous_hash: input.previousHash ?? null,
      canonical_payload_sha256: "",
    },
    hash: "",
  };

  const canonicalPayloadSha256 = sha256(stableJson({ ...base, evidence: { ...base.evidence, canonical_payload_sha256: "" }, hash: "" }));
  const withEvidence = {
    ...base,
    evidence: {
      ...base.evidence,
      canonical_payload_sha256: canonicalPayloadSha256,
    },
  };

  return {
    ...withEvidence,
    hash: sha256(stableJson({ ...withEvidence, hash: "" })),
  };
}

export function verifyOperatorKernelReceipt(receipt: OperatorKernelReceipt): string[] {
  const failures: string[] = [];

  if (receipt.object_type !== "ADJUTORIX_OPERATOR_KERNEL_RECEIPT") failures.push("object_type");
  if (receipt.schema_version !== "1.0.0") failures.push("schema_version");
  if (receipt.kernel.name !== "ADJUTORIX_REAL_OPERATOR_KERNEL") failures.push("kernel.name");
  if (receipt.kernel.version !== "0.3.0") failures.push("kernel.version");
  if (!receipt.workspace.root) failures.push("workspace.root");
  if (receipt.intent.bounded !== true) failures.push("intent.bounded");
  if (receipt.mutation_boundary.renderer_may_mutate !== false) failures.push("mutation_boundary.renderer_may_mutate");
  if (receipt.mutation_boundary.kernel_may_mutate_without_verify !== false) failures.push("mutation_boundary.kernel_may_mutate_without_verify");
  if (receipt.mutation_boundary.apply_requires_verify_pass !== true) failures.push("mutation_boundary.apply_requires_verify_pass");
  if (receipt.mutation_boundary.rollback_requires_apply_receipt !== true) failures.push("mutation_boundary.rollback_requires_apply_receipt");
  if (receipt.mutation_boundary.append_only_evidence !== true) failures.push("mutation_boundary.append_only_evidence");
  if (receipt.verification.required !== true) failures.push("verification.required");
  if (receipt.verification.commands.length === 0) failures.push("verification.commands");
  if (receipt.operation.kind === "APPLY" && receipt.verification.passed !== true && receipt.kernel.mode !== "APPLY_REQUEST_BLOCKED") {
    failures.push("apply_without_verify_not_blocked");
  }
  if (receipt.operation.kind === "ROLLBACK" && receipt.kernel.mode !== "ROLLBACK_REQUEST_BLOCKED") {
    failures.push("rollback_without_apply_receipt_not_blocked");
  }

  const expectedPayload = sha256(stableJson({
    ...receipt,
    evidence: { ...receipt.evidence, canonical_payload_sha256: "" },
    hash: "",
  }));

  if (receipt.evidence.canonical_payload_sha256 !== expectedPayload) failures.push("evidence.canonical_payload_sha256");

  const expectedHash = sha256(stableJson({ ...receipt, hash: "" }));
  if (receipt.hash !== expectedHash) failures.push("hash");

  return failures;
}

export function appendOperatorKernelReceipt(logPath: string, receipt: OperatorKernelReceipt): void {
  const failures = verifyOperatorKernelReceipt(receipt);
  if (failures.length > 0) {
    throw new Error(`invalid operator kernel receipt: ${failures.join(",")}`);
  }

  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(receipt)}\n`, { encoding: "utf8", flag: "a" });
}

export function readLastOperatorKernelHash(logPath: string): string | null {
  if (!existsSync(logPath)) return null;

  const lines = readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean);
  const lastLine = lines.at(-1);

  if (lastLine === undefined) return null;

  const last = JSON.parse(lastLine) as OperatorKernelReceipt;
  return last.hash;
}
