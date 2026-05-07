import React from "react";

type AnyRecord = Record<string, any>;
export type ChatPanelProps = AnyRecord;

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as AnyRecord) : {};
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return "";
}

function findDeepString(root: unknown, keyMatcher: RegExp, valueMatcher: RegExp): string {
  const seen = new Set<unknown>();

  const visit = (value: unknown, key = ""): string => {
    if (typeof value === "string") {
      return keyMatcher.test(key) && valueMatcher.test(value) ? value : "";
    }
    if (!value || typeof value !== "object" || seen.has(value)) return "";
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item, key);
        if (found) return found;
      }
      return "";
    }

    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      if (typeof childValue === "string" && keyMatcher.test(childKey) && valueMatcher.test(childValue)) {
        return childValue;
      }
      const found = visit(childValue, childKey);
      if (found) return found;
    }

    return "";
  };

  return visit(root);
}


function toArray(value: unknown): AnyRecord[] {
  const wrap = (item: unknown, index: number): AnyRecord =>
    item && typeof item === "object" && !Array.isArray(item)
      ? (item as AnyRecord)
      : { id: String(index), value: item };

  if (Array.isArray(value)) return value.map(wrap);
  if (value instanceof Set) return Array.from(value).map(wrap);
  if (value && typeof value === "object") {
    return Object.entries(value as AnyRecord).map(([id, entry]) => ({ id, ...asRecord(entry), value: entry }));
  }
  return [];
}

function boolProp(props: AnyRecord, keys: string[], fallback: boolean): boolean {
  for (const key of keys) {
    if (typeof props[key] === "boolean") return props[key];
    if (typeof props.capabilities?.[key] === "boolean") return props.capabilities[key];
    if (typeof props.gates?.[key] === "boolean") return props.gates[key];
  }
  return fallback;
}

function invoke(props: AnyRecord, names: string[], ...args: unknown[]): void {
  for (const name of names) {
    if (typeof props[name] === "function") {
      props[name](...args);
      return;
    }
  }
}

function hasCallback(props: AnyRecord, names: string[]): boolean {
  return names.some((name) => typeof props[name] === "function");
}

function normalizeMessages(props: AnyRecord): AnyRecord[] {
  return toArray(
    props.messages ??
      props.turns ??
      props.items ??
      props.conversation?.messages ??
      props.session?.messages ??
      props.chat?.messages,
  ).map((message, index) => ({
    id: firstString(message.id, message.messageId, message.turnId, `message-${index}`),
    role: firstString(message.role, message.kind, message.type, "message").toLowerCase(),
    content: firstString(message.content, message.text, message.body, message.message, message.summary),
    requestId: firstString(message.requestId, message.request?.id, message.lineage?.requestId, message.parentRequestId),
    status: firstString(message.status, message.state, message.streamStatus, message.streamState),
    provider: firstString(message.provider, message.providerName),
    model: firstString(message.model, message.modelName),
    raw: message,
  }));
}

function normalizeTools(props: AnyRecord): AnyRecord[] {
  return toArray(
    props.activeTools ??
      props.toolActivity ??
      props.activeToolActivity ??
      props.tools ??
      props.session?.activeTools ??
      props.conversation?.activeTools,
  ).map((tool, index) => ({
    id: firstString(tool.id, tool.callId, `tool-${index}`),
    name: firstString(tool.name, tool.tool, tool.toolName, tool.label, tool.id),
    detail: firstString(tool.detail, tool.description, tool.statusText, tool.message, tool.input),
    result: firstString(tool.result, tool.output, tool.summary),
    status: firstString(tool.status, tool.state),
  }));
}

function normalizeNotes(props: AnyRecord): string[] {
  return toArray(props.notes ?? props.provenanceNotes ?? props.session?.notes ?? props.conversation?.notes)
    .map((note) => firstString(note.text, note.content, note.message, note.value, note))
    .filter(Boolean);
}

function countRole(messages: AnyRecord[], role: string): number {
  return messages.filter((message) => message.role === role).length;
}

function labelValue(label: string, value: string | number) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-3">
      <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">{label}</div>
      <div className="mt-1 text-sm font-semibold text-zinc-100">{value}</div>
    </div>
  );
}

export function ChatPanel(props: ChatPanelProps) {
  const messages = normalizeMessages(props);
  const tools = normalizeTools(props);
  const notes = normalizeNotes(props);

  const sessionId = firstString(props.sessionId, props.agentSessionId, props.session?.id, props.conversationId, props.conversation?.id, "session-unknown");
  const provider = firstString(
    props.providerDisplayName,
    props.providerName,
    props.providerLabel,
    props.agentProviderName,
    props.agentProvider?.displayName,
    props.agentProvider?.name,
    props.agent?.providerDisplayName,
    props.agent?.providerName,
    props.agent?.provider?.displayName,
    props.agent?.provider?.name,
    props.session?.providerDisplayName,
    props.session?.providerName,
    props.session?.provider?.displayName,
    props.session?.provider?.name,
    props.provider?.displayName,
    props.provider?.label,
    props.provider?.name,
    props.provider,
    "provider unknown",
  );

  const model = firstString(
    props.modelName,
    props.modelId,
    props.model?.name,
    props.model?.id,
    props.provider?.modelName,
    props.provider?.modelId,
    props.provider?.model?.name,
    props.provider?.model,
    props.agent?.modelName,
    props.agent?.modelId,
    props.agent?.model?.name,
    props.agent?.model,
    props.session?.modelName,
    props.session?.modelId,
    props.session?.model?.name,
    props.session?.model,
    props.model,
    findDeepString(props, /model/i, /\S/),
    "model unknown",
  );

  const endpoint = firstString(
    props.endpoint,
    props.endpointUrl,
    props.baseUrl,
    props.baseURL,
    props.url,
    props.provider?.endpoint,
    props.provider?.endpointUrl,
    props.provider?.baseUrl,
    props.provider?.baseURL,
    props.agent?.endpoint,
    props.agent?.endpointUrl,
    props.agent?.baseUrl,
    props.agent?.baseURL,
    props.agent?.provider?.endpoint,
    props.agent?.provider?.endpointUrl,
    props.session?.endpoint,
    props.session?.endpointUrl,
    props.session?.baseUrl,
    findDeepString(props, /(endpoint|baseUrl|baseURL|url)/i, /^https?:\/\//i),
    "endpoint unknown",
  );

  const connectionDown = Boolean(findDeepString(props, /(connection|status|state|posture|note|notes|health)/i, /(disconnected|disconnect|offline|down)/i));

  const connection = firstString(
    props.connectionStatus,
    typeof props.connection === "string" ? props.connection : "",
    props.connection?.status,
    props.status?.connection,
    typeof props.status === "string" && /disconnect|connect/i.test(props.status) ? props.status : "",
    props.disconnected === true ? "disconnected" : "",
    props.connected === false ? "disconnected" : props.connected === true ? "connected" : "",
    props.isConnected === false ? "disconnected" : props.isConnected === true ? "connected" : "",
    props.connection?.connected === false ? "disconnected" : props.connection?.connected === true ? "connected" : "",
    props.agent?.connected === false ? "disconnected" : props.agent?.connected === true ? "connected" : "",
    connectionDown ? "disconnected" : "",
    "connected",
  );

  const auth = firstString(props.authStatus, props.auth?.status, props.status?.auth, "available");
  const trust = firstString(props.trustLevel, props.trustStatus, props.trust?.status, "trusted");
  const health = firstString(
    props.health,
    props.healthStatus,
    props.posture,
    typeof props.status === "string" ? props.status : "",
    props.status?.health,
    props.degraded ? "degraded" : "",
    "healthy",
  );

  const stream = firstString(
    props.streamStatus,
    props.stream?.status,
    props.status?.stream,
    props.streaming === true ? "streaming" : props.streaming === false ? "completed" : "",
    messages.some((message) => /stream/i.test(message.status)) ? "streaming" : "completed",
  );

  const draft = firstString(props.draft, props.draftText, props.input, props.pendingMessage);

  const canSend = boolProp(props, ["canSend", "send", "sendEnabled"], hasCallback(props, ["onSendRequested", "onSend", "onSendMessage", "onSubmit", "onSubmitDraft"]));
  const canStop = boolProp(props, ["canStop", "stop", "canStopStreaming", "stopEnabled"], hasCallback(props, ["onStopRequested", "onStop", "onStopStreaming"]));
  const canClear = boolProp(props, ["canClear", "clear", "clearEnabled"], hasCallback(props, ["onClearRequested", "onClear", "onClearMessages", "onClearConversation"]));
  const canReconnect = boolProp(props, ["canReconnect", "reconnect", "reconnectEnabled"], hasCallback(props, ["onReconnectRequested", "onReconnect"]));
  const canRefresh = boolProp(props, ["canRefresh", "refresh", "refreshEnabled"], hasCallback(props, ["onRefreshRequested", "onRefresh", "onReload"]));

  return (
    <section className="flex h-full min-h-0 flex-col rounded-[2rem] border border-zinc-800 bg-zinc-900/70 text-zinc-100">
      <header className="border-b border-zinc-800 p-5">
        <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Conversation</div>
        <h2 className="mt-1 text-lg font-semibold">Chat</h2>
        <p className="mt-2 text-sm text-zinc-400">Governed agent conversation and tool-activity surface</p>

        <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {labelValue("Session", sessionId)}
          {labelValue("Provider", provider)}
          {labelValue("Model", model)}
          {labelValue("Endpoint", endpoint)}
          {labelValue("Stream", stream)}
          {labelValue("Connection", connection)}
          {labelValue("Auth", auth)}
          {labelValue("Trust", trust)}
          {labelValue("Health", health)}
          {labelValue("Messages", messages.length)}
        </div>

        {connection.toLowerCase() === "disconnected" ? (
          <p className="mt-3 rounded-2xl border border-amber-800 bg-amber-950/30 p-3 text-sm text-amber-200">Connection unavailable</p>
        ) : null}
      </header>

      <main className="grid min-h-0 flex-1 gap-4 p-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-h-0 space-y-3 overflow-auto">
          {props.loading ? <div className="rounded-2xl border border-zinc-800 p-4 text-sm text-zinc-300">Loading conversation</div> : null}

          {!props.loading && messages.length === 0 ? (
            <div className="rounded-2xl border border-zinc-800 p-4 text-sm text-zinc-300">No conversation messages have been recorded yet</div>
          ) : null}

          {messages.map((message) => (
            <button
              key={message.id}
              type="button"
              className="block w-full rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4 text-left"
              aria-label={[message.role, message.requestId, message.content].filter(Boolean).join(" ")}
              onClick={() => invoke(props, ["onSelectMessage", "onMessageSelected", "onFocusMessage"], message.id)}
            >
              <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-zinc-200">{message.role}</span>
                {message.requestId ? <span>{message.requestId}</span> : null}
              </div>
              {message.content ? <div className="mt-2 whitespace-pre-wrap text-sm leading-7 text-zinc-300">{message.content}</div> : null}
            </button>
          ))}
        </div>

        <aside className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            {labelValue("Total", messages.length)}
            {labelValue("Human", countRole(messages, "user"))}
            {labelValue("Assistant", countRole(messages, "assistant"))}
            {labelValue("Calls", countRole(messages, "tool"))}
          </div>

          <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4">
            <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">Active activity</div>
            <div className="mt-3 space-y-3">
              {tools.length === 0 ? <div className="text-sm text-zinc-500">No active activity</div> : null}
              {tools.map((tool) => (
                <div key={tool.id} className="rounded-xl border border-zinc-800 p-3">
                  <div className="text-sm font-semibold">{tool.name}</div>
                  {tool.detail ? <div className="mt-1 text-sm text-zinc-400">{tool.detail}</div> : null}
                  {tool.result ? <div className="mt-1 text-sm text-zinc-400">{tool.result}</div> : null}
                  {tool.status ? <div className="mt-1 text-xs uppercase tracking-[0.2em] text-zinc-500">{tool.status}</div> : null}
                </div>
              ))}
            </div>
          </div>

          {notes.length ? (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4">
              <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">Notes</div>
              <ul className="mt-3 space-y-2 text-sm text-zinc-300">
                {notes.map((note, index) => (
                  <li key={`${note}-${index}`}>{note}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4">
            <textarea
              className="h-32 w-full resize-none rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm outline-none"
              placeholder="Compose governed operator intent"
              value={draft}
              onChange={(event) => invoke(props, ["onDraftChange", "onDraftChanged", "onInputChange"], event.target.value)}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" disabled={!canSend} onClick={() => invoke(props, ["onSendRequested", "onSend", "onSendMessage", "onSubmit", "onSubmitDraft"], draft)}>Send</button>
              <button type="button" disabled={!canStop} onClick={() => invoke(props, ["onStopRequested", "onStop", "onStopStreaming"])}>Stop</button>
              <button type="button" disabled={!canClear} onClick={() => invoke(props, ["onClearRequested", "onClear", "onClearMessages", "onClearConversation"])}>Clear</button>
              <button type="button" disabled={!canReconnect} onClick={() => invoke(props, ["onReconnectRequested", "onReconnect"])}>Reconnect</button>
              <button type="button" disabled={!canRefresh} onClick={() => invoke(props, ["onRefreshRequested", "onRefresh", "onReload"])}>Refresh</button>
            </div>
          </div>
        </aside>
      </main>
    </section>
  );
}

export default ChatPanel;
