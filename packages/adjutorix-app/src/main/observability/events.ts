export type AppEventCategory =
  | "app"
  | "agent"
  | "workspace"
  | "command"
  | "ledger"
  | "patch"
  | "verify";

export interface AppEventEnvelope<TPayload> {
  readonly id: string;
  readonly category: AppEventCategory;
  readonly name: string;
  readonly occurredAt: string;
  readonly payload: TPayload;
}

export interface AppBootPayload {
  readonly version: string;
  readonly platform: string;
  readonly mode: "development" | "production" | "test";
}

export interface AgentConnectionPayload {
  readonly connected: boolean;
  readonly endpoint: string;
  readonly transport: "ipc" | "http";
}

export interface WorkspacePayload {
  readonly rootPath: string;
  readonly trusted: boolean;
  readonly indexedFiles: number;
}

export interface CommandPayload {
  readonly command: string;
  readonly disposition: "allow" | "confirm" | "deny";
  readonly reasons: readonly string[];
}

export interface VerifyPayload {
  readonly transactionId: string;
  readonly ok: boolean;
  readonly blockingReasons: readonly string[];
}

function nextEventId(): string {
  const time = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `${time}-${random}`;
}

export function createEvent<TPayload>(
  category: AppEventCategory,
  name: string,
  payload: TPayload,
  occurredAt: string = new Date().toISOString()
): AppEventEnvelope<TPayload> {
  if (name.trim().length === 0) {
    throw new Error("event name must be non-empty");
  }

  return {
    id: nextEventId(),
    category,
    name,
    occurredAt,
    payload
  };
}

export function createAppBootEvent(payload: AppBootPayload): AppEventEnvelope<AppBootPayload> {
  return createEvent("app", "app.boot", payload);
}

export function createAgentConnectionEvent(
  payload: AgentConnectionPayload
): AppEventEnvelope<AgentConnectionPayload> {
  return createEvent("agent", "agent.connection", payload);
}

export function createWorkspaceIndexedEvent(
  payload: WorkspacePayload
): AppEventEnvelope<WorkspacePayload> {
  return createEvent("workspace", "workspace.indexed", payload);
}

export function createCommandEvaluatedEvent(
  payload: CommandPayload
): AppEventEnvelope<CommandPayload> {
  return createEvent("command", "command.evaluated", payload);
}

export function createVerifyCompletedEvent(
  payload: VerifyPayload
): AppEventEnvelope<VerifyPayload> {
  return createEvent("verify", "verify.completed", payload);
}
