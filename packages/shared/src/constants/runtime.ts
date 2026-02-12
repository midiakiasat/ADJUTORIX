/**
 * Canonical runtime layout (single source of truth for path segments).
 * Must stay in sync with agent-side runtime_paths.py.
 */

export const RUNTIME_DIR = "runtime";
export const SESSIONS_DIR = "sessions";
export const UI_DIR = "ui";
export const AGENT_DIR = "agent";

export function sessionBase(sessionId: string): string {
  return `${RUNTIME_DIR}/${SESSIONS_DIR}/${sessionId}`;
}

export function sessionUiDir(sessionId: string): string {
  return `${sessionBase(sessionId)}/${UI_DIR}`;
}

export function sessionAgentDir(sessionId: string): string {
  return `${sessionBase(sessionId)}/${AGENT_DIR}`;
}
