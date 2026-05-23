import { ipcMain } from "electron";
import {
  createOperatorKernelReceipt,
  readLastOperatorKernelHash,
} from "../operator/real_operator_kernel";

type OperatorKernelReceiptInput = Parameters<typeof createOperatorKernelReceipt>[0];

const CHANNEL_CREATE = "adjutorix:operatorKernel:createReceipt";
const CHANNEL_LAST_HASH = "adjutorix:operatorKernel:lastHash";

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`operator kernel input missing required string: ${key}`);
  }
  return value.trim();
}

function optionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function optionalStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseInput(value: unknown): OperatorKernelReceiptInput {
  const record = asRecord(value);

  return {
    workspaceRoot: requireString(record, "workspaceRoot"),
    selectedPath: optionalString(record, "selectedPath"),
    operatorIntent: requireString(record, "operatorIntent"),
    planId: optionalString(record, "planId"),
    patchCustodyId: optionalString(record, "patchCustodyId"),
    verificationGateId: optionalString(record, "verificationGateId"),
    verifyReceiptId: optionalString(record, "verifyReceiptId"),
    applyGateId: optionalString(record, "applyGateId"),
    applyReceiptId: optionalString(record, "applyReceiptId"),
    rollbackGateId: optionalString(record, "rollbackGateId"),
    rollbackReceiptId: optionalString(record, "rollbackReceiptId"),
    commands: optionalStringArray(record, "commands"),
    previousKernelHash: optionalString(record, "previousKernelHash"),
  } as unknown as OperatorKernelReceiptInput;
}

export function registerOperatorKernelIpc(): void {
  ipcMain.handle(CHANNEL_CREATE, async (_event, payload: unknown) => {
    return {
      ok: true,
      data: createOperatorKernelReceipt(parseInput(payload)),
    };
  });

  ipcMain.handle(CHANNEL_LAST_HASH, async (_event, payload?: unknown) => {
    const record = asRecord(payload);
    const workspaceRoot = optionalString(record, "workspaceRoot");

    return {
      ok: true,
      data: {
        previousKernelHash: workspaceRoot ? readLastOperatorKernelHash(workspaceRoot) : null,
      },
    };
  });
}

export const operatorKernelIpcChannels = Object.freeze({
  createReceipt: CHANNEL_CREATE,
  lastHash: CHANNEL_LAST_HASH,
});
