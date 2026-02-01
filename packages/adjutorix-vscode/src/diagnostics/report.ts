/**
 * Builds a diagnostics report for incident debugging.
 */

import * as vscode from "vscode";
import { Settings } from "../config/settings";
import { readAdjutorixToken } from "../client/token";
import type { AgentProcessStatus } from "../agent/processManager";

export interface DiagnosticsReport {
  appName: string;
  uriScheme: string;
  extensionVersion: string;
  agentEndpoint: string;
  lastPingAt: number | undefined;
  lastError: string | undefined;
  lastErrorRaw: string | undefined;
  agentState: string;
  agentOwnership: string;
  tokenPresent: boolean;
  workspaceRoot: string | undefined;
}

export async function buildDiagnosticsReport(
  agentStatus: AgentProcessStatus | null,
  extensionVersion?: string
): Promise<DiagnosticsReport> {
  const token = await readAdjutorixToken();
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  return {
    appName: vscode.env.appName ?? "",
    uriScheme: vscode.env.uriScheme ?? "",
    extensionVersion: extensionVersion ?? "0.0.0",
    agentEndpoint: Settings.getAgentEndpoint(),
    lastPingAt: agentStatus?.lastPingAt,
    lastError: agentStatus?.lastError,
    lastErrorRaw: agentStatus?.lastErrorRaw,
    agentState: agentStatus?.state ?? "unknown",
    agentOwnership: agentStatus?.ownership ?? "unknown",
    tokenPresent: !!token,
    workspaceRoot,
  };
}

export function formatDiagnosticsReport(report: DiagnosticsReport): string {
  const lines = [
    "--- Adjutorix Diagnostics ---",
    `appName: ${report.appName}`,
    `uriScheme: ${report.uriScheme}`,
    `extensionVersion: ${report.extensionVersion}`,
    `agentEndpoint: ${report.agentEndpoint}`,
    `agentState: ${report.agentState}`,
    `agentOwnership: ${report.agentOwnership}`,
    `lastPingAt: ${report.lastPingAt != null ? new Date(report.lastPingAt).toISOString() : "never"}`,
    `lastError: ${report.lastError ?? "none"}`,
    `lastErrorRaw: ${report.lastErrorRaw ?? "none"}`,
    `tokenPresent: ${report.tokenPresent ? "yes" : "no"}`,
    `workspaceRoot: ${report.workspaceRoot ?? "none"}`,
    "-----------------------------",
  ];
  return lines.join("\n");
}
