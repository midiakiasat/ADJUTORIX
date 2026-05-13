export type ProviderStatusProps = {
  title?: string;
  subtitle?: string;
  loading?: boolean;
  health?: string;
  connectionState?: string;
  authState?: string;
  trustLevel?: string;
  providerLabel?: string;
  modelLabel?: string;
  endpointLabel?: string;
  protocolVersion?: string | number;
  sessionId?: string;
  latencyMs?: number | string | null;
  pendingRequestCount?: number | string;
  notes?: string[];
  metrics?: {
    reconnectAttempts?: number;
    successfulRequests?: number;
    failedRequests?: number;
    pendingRequests?: number;
  };
  canReconnect?: boolean;
  canRefresh?: boolean;
  onReconnectRequested?: () => void;
  onRefreshRequested?: () => void;
  [key: string]: any;
};

export type ProviderState = ProviderStatusProps;
export type ProviderStatusView = ProviderStatusProps;

function value(...values: unknown[]) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

export function ProviderStatus(props: ProviderStatusProps) {
  const title = String(value(props.title, "Provider status"));
  const subtitle = String(value(props.subtitle, "Governed provider, model, auth, and endpoint health surface"));

  const provider = String(value(props.providerLabel, props.provider, props.providerName, props.label, props.name, "provider unknown"));
  const model = value(props.modelLabel, props.model, props.modelName);
  const endpoint = String(value(props.endpointLabel, props.endpoint, props.endpointUrl, props.url, "endpoint unknown"));
  const session = value(props.sessionId, props.session);

  const connection = String(value(props.connectionState, props.connection, props.connectivity, "unknown"));
  const auth = String(value(props.authState, props.auth, "unknown"));
  const trust = String(value(props.trustLevel, props.trust, "unknown"));
  const health = String(value(props.health, props.status, "unknown"));

  const protocol = value(props.protocolVersion, props.protocol);
  const latency = value(props.latencyMs, props.latency);
  const pending = value(props.pendingRequestCount, props.metrics?.pendingRequests, props.pendingRequests, props.pending, 0);

  const attempts = value(props.metrics?.reconnectAttempts, props.reconnectAttempts, 0);
  const successful = value(props.metrics?.successfulRequests, props.successfulRequests, 0);
  const failed = value(props.metrics?.failedRequests, props.failedRequests, 0);

  const notes =
    Array.isArray(props.notes) && props.notes.length > 0
      ? props.notes
      : [`Provider is ${connection} with ${auth} auth and ${trust} endpoint identity.`];

  return (
    <section className="flex h-full min-h-0 flex-col rounded-[2rem] border border-zinc-800 bg-zinc-900/70 shadow-xl">
      <header className="border-b border-zinc-800 px-5 py-4">
        <div>
          <div>Providers</div>
          <h2>{title}</h2>
          <p>{subtitle}</p>

          {props.loading ? <div>Loading provider status</div> : null}

          <div>{provider}</div>
          {model ? <div>{String(model)}</div> : null}
          <div>{endpoint}</div>
          {session ? <div>{String(session)}</div> : null}

          <div>
            <span>{connection}</span>
            <span>{auth}</span>
            <span>{trust}</span>
            <span>{health}</span>
          </div>

          <div>
            {protocol !== undefined ? <span>{String(protocol)}</span> : null}
            {latency !== undefined && latency !== null ? <span>{String(latency)}</span> : null}
            <span>{String(pending)}</span>
          </div>

          <div>
            {notes.map((note, index) => (
              <p key={`${index}:${note}`}>{note}</p>
            ))}
          </div>
        </div>

        <div>
          <button
            type="button"
            aria-label="Reconnect provider"
            disabled={props.canReconnect === false}
            onClick={props.onReconnectRequested}
          >
            Reconnect
          </button>
          <button
            type="button"
            aria-label="Refresh provider"
            disabled={props.canRefresh === false}
            onClick={props.onRefreshRequested}
          >
            Refresh
          </button>
        </div>

        <div>
          <div>attempts {String(attempts)}</div>
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
