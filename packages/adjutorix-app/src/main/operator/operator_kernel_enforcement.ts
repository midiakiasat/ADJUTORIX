export type OperatorKernelGatePayload = {
  operatorKernelReceiptId?: unknown;
  operatorKernelHash?: unknown;
  operatorKernel?: unknown;
};

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasOperatorKernelObject(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    hasNonEmptyString(record.receiptId) ||
    hasNonEmptyString(record.receiptHash) ||
    hasNonEmptyString(record.kernelHash) ||
    hasNonEmptyString(record.previousKernelHash)
  );
}

export function assertMandatoryOperatorKernelGate(payload: OperatorKernelGatePayload): void {
  const hasReceiptId = hasNonEmptyString(payload.operatorKernelReceiptId);
  const hasKernelHash = hasNonEmptyString(payload.operatorKernelHash);
  const hasKernelObject = hasOperatorKernelObject(payload.operatorKernel);

  if (!hasReceiptId && !hasKernelHash && !hasKernelObject) {
    throw new Error(
      "ADJUTORIX_OPERATOR_KERNEL_GATE_REQUIRED: apply authority requires an operator kernel receipt or kernel hash",
    );
  }
}
