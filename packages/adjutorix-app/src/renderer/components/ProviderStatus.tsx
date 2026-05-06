export type ProviderStatusProps = Record<string, any>;
export type ProviderState = Record<string, any>;
export type ProviderStatusView = Record<string, any>;

function readPath(obj: any, path: string | string[]) {
  if (!obj || typeof obj !== "object") return undefined;
  if (typeof path === "string") return obj[path];

  let cursor = obj;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

function at(obj: any, keys: Array<string | string[]>, fallback: any) {
  for (const key of keys) {
    const value = readPath(obj, key);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return fallback;
}

function lowerJson(value: any) {
  try {
    return JSON.stringify(value ?? {}).toLowerCase();
  } catch {
    return "";
  }
}

function selectProvider(props: ProviderStatusProps) {
  const explicit = props.provider ?? props.status ?? props.state;
  if (explicit && typeof explicit === "object" && !Array.isArray(explicit)) return explicit;

  const providers = Array.isArray(props.providers) ? props.providers : [];
  return (
    providers.find((entry: any) => {
      const id = String(entry?.id ?? entry?.kind ?? entry?.label ?? entry?.name ?? "").toLowerCase();
      return id === "agent" || id.includes("agent");
    }) ??
    providers[0] ??
    props
  );
}

function isHealthyProvider(provider: any) {
  const text = lowerJson(provider);
  const ok = at(provider, ["ok", "healthy", ["detail", "ok"], ["detail", "healthy"]], null);
  const posture = String(at(provider, ["health", "status", "state", "connectivity", "connection", ["detail", "status"]], "")).toLowerCase();

  if (ok === false) return false;
  if (text.includes('"ok":false') || text.includes('"healthy":false')) return false;
  if (["unhealthy", "failed", "failure", "down", "disconnected", "unavailable", "error"].includes(posture)) return false;

  return ok === true || ["healthy", "ready", "connected", "ok"].includes(posture);
}

function isUnhealthyProvider(provider: any) {
  const text = lowerJson(provider);
  const ok = at(provider, ["ok", "healthy", ["detail", "ok"], ["detail", "healthy"]], null);
  const posture = String(at(provider, ["health", "status", "state", "connectivity", "connection", ["detail", "status"]], "")).toLowerCase();

  return (
    ok === false ||
    text.includes('"ok":false') ||
    text.includes('"healthy":false') ||
    ["unhealthy", "failed", "failure", "down", "disconnected", "unavailable", "error"].includes(posture)
  );
}

function authLabel(provider: any) {
  const text = lowerJson(provider);
  if (text.includes('"authenticated":true') || text.includes('"auth":"valid"') || text.includes('"authstatus":"valid"')) return "auth valid";
  if (/invalid[_-]?auth/.test(text) || /auth[^a-z0-9]+invalid/.test(text)) return "auth invalid";
  if (/missing[_-]?auth/.test(text) || /auth[^a-z0-9]+missing/.test(text) || text.includes('"auth":"missing"')) return "auth missing";
  if (/restricted[_-]?auth/.test(text) || /auth[^a-z0-9]+restricted/.test(text) || text.includes('"auth":"restricted"')) return "auth restricted";
  return "auth unknown";
}

export function ProviderStatus(props: ProviderStatusProps) {
  const providerState = selectProvider(props);

  const provider = String(at(providerState, ["provider", "providerName", "label", "name", "id"], "provider unknown"));
  const model = at(providerState, ["model", "modelName", ["detail", "model"], ["detail", "modelName"]], null);
  const endpoint = String(
    at(providerState, ["endpoint", "endpointUrl", "url", "endpointLabel", "subtitle", ["detail", "url"], ["detail", "endpoint"]], "endpoint unknown"),
  );
  const session = at(providerState, ["sessionId", "session", ["detail", "sessionId"], ["detail", "session"]], null);

  const healthy = isHealthyProvider(providerState);
  const unhealthy = isUnhealthyProvider(providerState);
  const transport = healthy ? "transport healthy" : unhealthy ? "transport unavailable" : "transport unknown";

  const pending = at(providerState, ["pendingRequests", "pendingRequestCount", "pending", ["detail", "pendingRequests"]], 0);
  const latency = at(providerState, ["latencyMs", "latency", ["detail", "latencyMs"], ["detail", "latency"]], null);
  const protocol = at(providerState, ["protocolVersion", "protocol", ["detail", "protocolVersion"], ["detail", "protocol"]], null);

  const reconnects = at(providerState, ["reconnects", "reconnectCount", ["detail", "reconnects"], ["detail", "reconnectCount"]], 0);
  const successful = at(providerState, ["successful", "successfulRequests", "successCount", ["detail", "successfulRequests"], ["detail", "successCount"]], 0);
  const failed = at(providerState, ["failed", "failedRequests", "failureCount", ["detail", "failedRequests"], ["detail", "failureCount"]], 0);

  const disabledReconnect = props.canReconnect === false || props.reconnectEnabled === false || props.capabilities?.reconnect === false;
  const disabledRefresh = props.canRefresh === false || props.refreshEnabled === false || props.capabilities?.refresh === false;

  const call = (fn: unknown) => {
    if (typeof fn === "function") fn(providerState);
  };

  const message = healthy
    ? "Selected provider transport is healthy; endpoint identity and pending request count remain visible."
    : unhealthy
      ? "Selected provider transport is unavailable; endpoint identity and pending request count remain visible."
      : "Selected provider transport is unknown; endpoint identity and pending request count remain visible.";

  return (
    <section className="flex h-full min-h-0 flex-col rounded-[2rem] border border-zinc-800 bg-zinc-900/70 shadow-xl">
      <header className="border-b border-zinc-800 px-5 py-4">
        <div>
          <div>Providers</div>
          <h2>Provider status</h2>
          <p>Governed provider, model, auth, and endpoint health surface</p>

          <div>{provider}</div>
          {model ? <div>{String(model)}</div> : null}
          <div>{endpoint}</div>
          {session ? <div>{String(session)}</div> : null}

          <div>
            <span>{transport}</span>
            <span>{authLabel(providerState)}</span>
          </div>

          <div>{message}</div>

          <div>
            {protocol ? <span>protocol {String(protocol)}</span> : null}
            {latency !== null ? <span>{String(latency)}</span> : null}
            <span>{String(pending)}</span>
          </div>
        </div>

        <div>
          <button type="button" aria-label="Reconnect provider" disabled={disabledReconnect} onClick={() => call(props.onReconnectRequested)}>
            Reconnect
          </button>
          <button type="button" aria-label="Refresh provider" disabled={disabledRefresh} onClick={() => call(props.onRefreshRequested)}>
            Refresh
          </button>
        </div>

        <div>
          <div>reconnects {String(reconnects)}</div>
          <div>successful {String(successful)}</div>
          <div>failed {String(failed)}</div>
          <div>pending requests {String(pending)}</div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-5 py-5" />
    </section>
  );
}

export default ProviderStatus;
