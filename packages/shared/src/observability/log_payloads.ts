export type LogLevel = "debug" | "info" | "warning" | "error";

export interface LogPayload {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly component: string;
  readonly event: string;
  readonly message: string;
  readonly correlationId?: string;
  readonly transactionId?: string;
  readonly jobId?: string;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export function assertLogPayload(value: LogPayload): void {
  if (!["debug", "info", "warning", "error"].includes(value.level)) {
    throw new Error("logPayload.level is invalid");
  }
  if (value.timestamp.trim().length === 0) {
    throw new Error("logPayload.timestamp must be non-empty");
  }
  if (value.component.trim().length === 0) {
    throw new Error("logPayload.component must be non-empty");
  }
  if (value.event.trim().length === 0) {
    throw new Error("logPayload.event must be non-empty");
  }
  if (value.message.trim().length === 0) {
    throw new Error("logPayload.message must be non-empty");
  }
  if (value.attributes) {
    for (const [key, entry] of Object.entries(value.attributes)) {
      if (key.trim().length === 0) {
        throw new Error("logPayload.attributes keys must be non-empty");
      }
      if (!["string", "number", "boolean"].includes(typeof entry)) {
        throw new Error(`logPayload.attributes.${key} has unsupported type`);
      }
    }
  }
}

export function redactLogPayload(
  value: LogPayload,
  keysToRedact: readonly string[]
): LogPayload {
  if (!value.attributes) {
    return value;
  }

  const attributes: Record<string, string | number | boolean> = { ...value.attributes };
  for (const key of keysToRedact) {
    if (key in attributes) {
      attributes[key] = "[REDACTED]";
    }
  }

  return {
    ...value,
    attributes
  };
}
