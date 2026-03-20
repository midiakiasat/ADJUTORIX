import * as path from "path";
import { RUNTIME_DIR, SESSIONS_DIR, UI_DIR, AGENT_DIR } from "@adjutorix/shared/dist/constants/runtime";

/**
 * VS Code side runtime path helpers.
 * Never writes directly — only used for display / diagnostics.
 */

export function runtimeRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, RUNTIME_DIR);
}

export function sessionsRoot(workspaceRoot: string): string {
  return path.join(runtimeRoot(workspaceRoot), SESSIONS_DIR);
}

export function sessionBase(workspaceRoot: string, sessionId: string): string {
  return path.join(sessionsRoot(workspaceRoot), sessionId);
}

export function sessionUiDir(workspaceRoot: string, sessionId: string): string {
  return path.join(sessionBase(workspaceRoot, sessionId), UI_DIR);
}

export function sessionAgentDir(workspaceRoot: string, sessionId: string): string {
  return path.join(sessionBase(workspaceRoot, sessionId), AGENT_DIR);
}
