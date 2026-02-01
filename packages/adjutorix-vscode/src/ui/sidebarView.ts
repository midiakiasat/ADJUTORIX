import * as vscode from "vscode";
import { RpcClient } from "../client/rpc";
import { RpcError } from "../client/types";
import { Settings } from "../config/settings";
import type { AgentProcessManager, AgentProcessStatus } from "../agent/processManager";
import { classifyError } from "../agent/processManager";

const PING_INTERVAL_MS = 3_000;
const PING_BACKOFF_INITIAL_MS = 2_000;
const PING_BACKOFF_MAX_MS = 30_000;
const TRANSCRIPT_KEY = "adjutorix.transcript";
const MAX_TRANSCRIPT_ENTRIES = 100;

export interface TranscriptEntry {
  role: "user" | "assistant" | "system";
  text: string;
}

/**
 * Webview view provider for the ADJUTORIX sidebar.
 * Renders Chat + Actions: status, transcript, input, Check/Fix/Verify/Deploy.
 * When AgentProcessManager is provided, owns lifecycle (auto-start, status, Retry/Open Logs, periodic ping + backoff).
 * Transcript is persisted in workspaceState; Clear resets it.
 */
export class AdjutorixViewProvider implements vscode.WebviewViewProvider {
  private currentView: vscode.WebviewView | null = null;
  private statusSubscription: vscode.Disposable | null = null;
  private pingTimeout: ReturnType<typeof setTimeout> | null = null;
  private pingBackoffMs = PING_INTERVAL_MS;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly rpcClient: RpcClient,
    private readonly out: vscode.OutputChannel,
    private readonly agentProcessManager: AgentProcessManager | null,
    private readonly workspaceState: vscode.Memento
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void | Promise<void> {
    this.out.appendLine("[view] resolveWebviewView()");
    this.currentView = webviewView;
    webviewView.onDidDispose(() => {
      this.out.appendLine("[view] disposed");
      this.clearPingTimer();
      if (this.statusSubscription) {
        this.statusSubscription.dispose();
        this.statusSubscription = null;
      }
      this.currentView = null;
    });

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    if (this.agentProcessManager) {
      const pushStatus = (status: AgentProcessStatus) => {
        this.postStatus(webviewView, status);
      };
      pushStatus(this.agentProcessManager.getStatus());
      this.statusSubscription = this.agentProcessManager.onStatusChange(pushStatus);

      const settings = Settings.get();
      if (settings.autoStartAgent) {
        const st = this.agentProcessManager.getStatus();
        if (st.state === "stopped" || st.state === "failed") {
          this.agentProcessManager.start().catch((e) => {
            this.out.appendLine(`[view] autoStart failed: ${e}`);
          });
        }
      }

      this.schedulePing(webviewView);
    } else {
      this.pingAndUpdateStatus(webviewView);
    }

    webviewView.webview.onDidReceiveMessage(async (msg: { type: string; payload?: unknown }) => {
      this.out.appendLine(`[view] msg: ${JSON.stringify(msg)}`);
      switch (msg.type) {
        case "log":
          this.out.appendLine(`[view] ${String((msg as { payload?: unknown }).payload ?? "")}`);
          break;
        case "ready":
          if (this.agentProcessManager) {
            this.postStatus(webviewView, this.agentProcessManager.getStatus());
          } else {
            await this.pingAndUpdateStatus(webviewView);
          }
          this.safeSendTranscript();
          break;
        case "action":
          await this.runAction(webviewView, msg.payload as string, undefined);
          break;
        case "chat":
          await this.runChat(webviewView, msg.payload as { message: string; context?: unknown });
          break;
        case "retry":
          await this.handleRetry(webviewView);
          break;
        case "openLogs":
          this.out.show(true);
          break;
        case "clearTranscript":
          this.clearTranscript();
          this.safeSendTranscript();
          break;
        case "setMode": {
          const mode = (msg.payload as string) as "auto" | "managed" | "external";
          if (mode !== "auto" && mode !== "managed" && mode !== "external") break;
          void Settings.set("agentMode", mode);
          if (this.agentProcessManager) {
            this.agentProcessManager.setMode(mode);
            this.postStatus(webviewView, this.agentProcessManager.getStatus());
          }
          break;
        }
        default:
          break;
      }
    });
  }

  private clearPingTimer(): void {
    if (this.pingTimeout != null) {
      clearTimeout(this.pingTimeout);
      this.pingTimeout = null;
    }
  }

  private schedulePing(webviewView: vscode.WebviewView): void {
    this.clearPingTimer();
    if (!this.agentProcessManager || !this.currentView) return;

    const state = this.agentProcessManager.getStatus().state;
    if (state === "stopping" || state === "starting") {
      this.pingTimeout = setTimeout(() => {
        this.pingTimeout = null;
        this.schedulePing(webviewView);
      }, 1000);
      return;
    }

    this.pingTimeout = setTimeout(async () => {
      this.pingTimeout = null;
      if (!this.currentView || !this.agentProcessManager) return;
      const ok = await this.agentProcessManager.ping();
      if (ok) {
        this.pingBackoffMs = PING_INTERVAL_MS;
      } else {
        this.pingBackoffMs = Math.min(
          this.pingBackoffMs * 2 || PING_BACKOFF_INITIAL_MS,
          PING_BACKOFF_MAX_MS
        );
      }
      this.schedulePing(webviewView);
    }, this.pingBackoffMs);
  }

  private async handleRetry(webviewView: vscode.WebviewView): Promise<void> {
    if (!this.agentProcessManager) {
      await this.pingAndUpdateStatus(webviewView);
      return;
    }
    const st = this.agentProcessManager.getStatus();
    if (st.state === "starting" || st.state === "stopping") {
      return;
    }
    if (st.state === "failed" || st.state === "stopped") {
      this.agentProcessManager.start().catch((e) => {
        this.out.appendLine(`[view] retry start failed: ${e}`);
      });
      return;
    }
    if (st.state === "connected") {
      await this.agentProcessManager.ping();
      this.postStatus(webviewView, this.agentProcessManager.getStatus());
    }
  }

  private postStatus(webviewView: vscode.WebviewView, status: AgentProcessStatus): void {
    const statusLabel =
      status.state === "connected"
        ? "connected"
        : status.state === "starting"
        ? "starting"
        : status.state === "stopping"
        ? "stopping"
        : status.state === "failed"
        ? "failed"
        : "disconnected";
    webviewView.webview.postMessage({
      type: "status",
      status: statusLabel,
      state: status.state,
      mode: status.mode,
      ownership: status.ownership,
      error: status.lastError,
      version: status.version,
      lastPingAt: status.lastPingAt,
      baseUrl: status.baseUrl,
    });
  }

  private getTranscript(): TranscriptEntry[] {
    const raw = this.workspaceState.get<TranscriptEntry[]>(TRANSCRIPT_KEY);
    return Array.isArray(raw) ? raw : [];
  }

  private async saveTranscript(entries: TranscriptEntry[]): Promise<void> {
    await this.workspaceState.update(TRANSCRIPT_KEY, entries);
  }

  private async appendToTranscript(role: TranscriptEntry["role"], text: string): Promise<void> {
    const entries = this.getTranscript();
    entries.push({ role, text });
    const trimmed = entries.slice(-MAX_TRANSCRIPT_ENTRIES);
    await this.saveTranscript(trimmed);
  }

  private async clearTranscript(): Promise<void> {
    await this.saveTranscript([]);
  }

  /** Send transcript to current view if still attached; avoids noise if webview was disposed. */
  private safeSendTranscript(): void {
    if (!this.currentView) return;
    this.currentView.webview.postMessage({ type: "transcript", payload: this.getTranscript() });
  }

  private async pingAndUpdateStatus(webviewView: vscode.WebviewView): Promise<void> {
    try {
      await this.rpcClient.call("ping", {});
      webviewView.webview.postMessage({
        type: "status",
        status: "connected",
        version: undefined,
      });
    } catch (err: unknown) {
      webviewView.webview.postMessage({
        type: "status",
        status: "disconnected",
        error: classifyError(err),
      });
    }
  }

  private async runAction(
    webviewView: vscode.WebviewView,
    action: string,
    context?: unknown
  ): Promise<void> {
    this.out.appendLine(`[action] ${action}`);
    try {
      const res = await this.rpcClient.call<{ ok: boolean; result?: { status?: string; duration?: number; results?: { return_code?: number }[]; message?: string } }>("run", {
        job_name: "sidebar",
        action,
        allow_override: false,
        ...(context ? { context } : {}),
      });
      const report = res?.result;
      const duration = typeof report?.duration === "number" ? report.duration : 0;
      const failedCount = report?.results?.filter((r) => r.return_code !== 0).length ?? 0;
      const summary =
        report?.status === "success"
          ? `${action} OK · ${duration.toFixed(1)}s · ${failedCount} failed`
          : `${action} failed · ${(report?.message ?? "").split(/\n/)[0]?.trim() || "see logs"}`;
      webviewView.webview.postMessage({ type: "actionResult", action, result: report });
      this.out.appendLine(`[action] ${action} ${report?.status === "success" ? "ok" : "failed"}`);
      await this.appendToTranscript("system", summary);
      this.safeSendTranscript();
    } catch (err: unknown) {
      this.out.appendLine(`[action] raw error: ${JSON.stringify(err, Object.getOwnPropertyNames(err))}`);
      let msg = err instanceof Error ? err.message : String(err);
      if (msg === "Internal error" || msg === "Internal Error") {
        const hint = "Restart agent (run_agent.sh) and see Output → Adjutorix for details.";
        const extra = err instanceof RpcError && err.data ? ` ${JSON.stringify(err.data)}` : "";
        msg = `${hint}${extra}`;
      }
      const firstLine = msg.split(/\n/)[0]?.trim() ?? msg;
      const summary = `${action} failed · ${firstLine}`;
      webviewView.webview.postMessage({ type: "actionResult", action, error: msg });
      this.out.appendLine(`[action] ${action} failed: ${msg}`);
      await this.appendToTranscript("system", summary);
      this.safeSendTranscript();
    }
  }

  private async runChat(
    webviewView: vscode.WebviewView,
    payload: { message: string; context?: unknown }
  ): Promise<void> {
    const { message, context } = payload;
    this.out.appendLine(`[chat] ${message.slice(0, 80)}…`);
    await this.appendToTranscript("user", message);
    this.safeSendTranscript();
    try {
      const result = await this.rpcClient.call("run", {
        job_name: "sidebar",
        action: "chat",
        allow_override: false,
        message,
        ...(context ? { context } : {}),
      });
      const assistantText =
        typeof result === "string"
          ? result
          : (result as { message?: string; text?: string })?.message ??
            (result as { message?: string; text?: string })?.text ??
            JSON.stringify(result);
      webviewView.webview.postMessage({ type: "chatResult", result });
      this.out.appendLine("[chat] ok");
      await this.appendToTranscript("assistant", assistantText);
      this.safeSendTranscript();
    } catch (err: unknown) {
      this.out.appendLine(`[chat] raw error: ${JSON.stringify(err, Object.getOwnPropertyNames(err))}`);
      let msg = err instanceof Error ? err.message : String(err);
      if (msg === "Internal error" || msg === "Internal Error") {
        const hint = "Restart agent (run_agent.sh) and see Output → Adjutorix for details.";
        const extra = err instanceof RpcError && err.data ? ` ${JSON.stringify(err.data)}` : "";
        msg = `${hint}${extra}`;
      }
      const firstLine = msg.split(/\n/)[0]?.trim() ?? msg;
      webviewView.webview.postMessage({ type: "chatResult", error: msg });
      this.out.appendLine(`[chat] failed: ${msg}`);
      await this.appendToTranscript("assistant", `Error: ${firstLine}`);
      this.safeSendTranscript();
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Adjutorix</title>
  <style>
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); padding: 8px; margin: 0; color: var(--vscode-foreground); box-sizing: border-box; }
    * { box-sizing: border-box; }
    .status { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; margin-bottom: 6px; }
    .status.connected { background: var(--vscode-inputValidation-infoBackground); color: var(--vscode-inputValidation-infoBorder); }
    .status.starting, .status.stopping { background: var(--vscode-editorWarning-foreground); color: var(--vscode-editor-background); }
    .status.failed, .status.disconnected { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorBorder); }
    .status-detail { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 6px; }
    .mode-selector { display: flex; gap: 0; margin-bottom: 8px; border: 1px solid var(--vscode-input-border); border-radius: 4px; overflow: hidden; font-size: 11px; }
    .mode-selector button { flex: 1; padding: 4px 6px; border: none; background: var(--vscode-input-background); color: var(--vscode-foreground); cursor: pointer; }
    .mode-selector button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .mode-selector button:hover:not(.active) { background: var(--vscode-input-background); }
    .status-actions { display: flex; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
    .status-actions button { padding: 4px 8px; font-size: 11px; cursor: pointer; }
    .transcript-section { margin-bottom: 8px; }
    .transcript { min-height: 60px; max-height: 180px; overflow-y: auto; border: 1px solid var(--vscode-input-border); border-radius: 6px; padding: 6px; background: var(--vscode-input-background); font-size: 12px; }
    .transcript-entry { margin: 4px 0; }
    .transcript-entry.user { color: var(--vscode-textLink-foreground); }
    .transcript-entry.assistant { color: var(--vscode-foreground); }
    .transcript-entry.system { color: var(--vscode-descriptionForeground); font-style: italic; }
    .transcript-section .clear-btn { margin-top: 4px; padding: 4px 8px; font-size: 11px; cursor: pointer; }
    .composer { border: 1px solid var(--vscode-input-border); border-radius: 12px; background: var(--vscode-input-background); overflow: hidden; margin-bottom: 8px; }
    .composer-input { width: 100%; min-height: 72px; padding: 10px 12px; border: none; background: transparent; color: var(--vscode-foreground); font: inherit; resize: none; outline: none; }
    .composer-input::placeholder { color: var(--vscode-input-placeholderForeground); }
    .composer-footer { display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; border-top: 1px solid var(--vscode-input-border); }
    .composer-footer-left { display: flex; align-items: center; gap: 6px; }
    .composer-attach, .composer-mode, .composer-mic { padding: 4px 8px; font-size: 11px; border: none; background: transparent; color: var(--vscode-foreground); cursor: pointer; border-radius: 4px; }
    .composer-attach:hover, .composer-mode:hover, .composer-mic:hover { background: var(--vscode-toolbar-hoverBackground); }
    .composer-mode { display: flex; align-items: center; gap: 4px; }
    .context-line { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
    .context-line select, .context-line button { background: transparent; border: none; color: inherit; cursor: pointer; padding: 0 4px; }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
    .actions button { padding: 6px 10px; cursor: pointer; font-size: 12px; }
    .actions button:disabled { opacity: 0.6; cursor: not-allowed; }
  </style>
</head>
<body>
  <div id="status" class="status disconnected">Checking…</div>
  <div class="mode-selector" id="modeSelector">
    <button type="button" data-mode="auto" title="Try managed, allow external">Auto</button>
    <button type="button" data-mode="managed" title="Extension spawns/kills process">Managed</button>
    <button type="button" data-mode="external" title="Health-check only, no spawn">External</button>
  </div>
  <div id="statusDetail" class="status-detail"></div>
  <div id="statusActions" class="status-actions" style="display:none;"></div>
  <div class="transcript-section">
    <div class="transcript" id="transcript"></div>
    <button id="clearTranscript" class="clear-btn" title="Clear transcript">Clear</button>
  </div>
  <div class="composer">
    <textarea id="composerInput" class="composer-input" placeholder="Plan, @ for context, / for commands" rows="3"></textarea>
    <div class="composer-footer">
      <div class="composer-footer-left">
        <button type="button" id="composerAttach" class="composer-attach" title="Attach">&#8734;</button>
        <button type="button" id="composerMode" class="composer-mode" title="Mode">Auto &#9660;</button>
      </div>
      <button type="button" id="composerMic" class="composer-mic" title="Voice">&#127908;</button>
    </div>
  </div>
  <div class="context-line"><span id="contextLabel">Local</span> &#9660;</div>
  <div class="actions">
    <button data-action="check">Check</button>
    <button data-action="fix">Fix</button>
    <button data-action="verify">Verify</button>
    <button data-action="deploy">Deploy</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    vscode.postMessage({ type: "log", payload: "webview boot" });
    const statusEl = document.getElementById('status');
    const statusDetailEl = document.getElementById('statusDetail');
    const statusActionsEl = document.getElementById('statusActions');
    const transcriptEl = document.getElementById('transcript');
    const composerInput = document.getElementById('composerInput');
    const modeSelectorEl = document.getElementById('modeSelector');
    const actionBtns = document.querySelectorAll('.actions button');
    let connected = false;

    function setModeActive(mode) {
      modeSelectorEl.querySelectorAll('button').forEach(function(b) {
        b.classList.toggle('active', b.dataset.mode === mode);
      });
    }

    function formatDetail(m) {
      var parts = [];
      if (m.mode) parts.push('Mode: ' + m.mode.charAt(0).toUpperCase() + m.mode.slice(1));
      if (m.ownership) parts.push('Ownership: ' + (m.ownership === 'unknown' ? 'Unknown' : m.ownership.charAt(0).toUpperCase() + m.ownership.slice(1)));
      if (m.baseUrl && (m.status === 'connected' || m.status === 'failed')) parts.push('Endpoint: ' + m.baseUrl);
      if (m.version) parts.push('v' + m.version);
      if (m.error) parts.push(m.error);
      return parts.length ? parts.join(' · ') : '';
    }

    function setConnected(c) {
      connected = c;
      actionBtns.forEach(b => { b.disabled = !c; });
      composerInput.disabled = !c;
    }

    function renderStatusActions(status) {
      if (status !== 'failed' && status !== 'disconnected' && status !== 'stopping') {
        statusActionsEl.style.display = 'none';
        statusActionsEl.innerHTML = '';
        return;
      }
      statusActionsEl.style.display = 'flex';
      var retryDisabled = status === 'stopping';
      statusActionsEl.innerHTML = '<button id="btnRetry" ' + (retryDisabled ? 'disabled' : '') + '>Retry</button><button id="btnOpenLogs">Open Logs</button>';
      document.getElementById('btnRetry').onclick = () => { if (!retryDisabled) vscode.postMessage({ type: 'retry' }); };
      document.getElementById('btnOpenLogs').onclick = () => vscode.postMessage({ type: 'openLogs' });
    }

    function setTranscript(entries) {
      transcriptEl.innerHTML = '';
      (entries || []).forEach(function(entry) {
        var el = document.createElement('div');
        el.className = 'transcript-entry ' + entry.role;
        el.textContent = (entry.role === 'user' ? 'You: ' : entry.role === 'assistant' ? 'Agent: ' : entry.role === 'system' ? 'System: ' : '') + entry.text;
        transcriptEl.appendChild(el);
      });
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
    }

    window.addEventListener('message', e => {
      const m = e.data;
      if (m.type === 'status') {
        statusEl.textContent = m.status === 'connected' ? 'Connected' : m.status === 'starting' ? 'Starting…' : m.status === 'stopping' ? 'Stopping…' : m.status === 'failed' ? 'Failed' : 'Disconnected';
        statusEl.className = 'status ' + m.status;
        setConnected(m.status === 'connected');
        if (m.mode) setModeActive(m.mode);
        statusDetailEl.textContent = formatDetail(m);
        renderStatusActions(m.status);
      } else if (m.type === 'transcript') {
        setTranscript(m.payload || []);
      } else if (m.type === 'actionResult' || m.type === 'chatResult') {
        /* Summary shown in transcript from host */
      }
    });

    composerInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        var msg = composerInput.value.trim();
        if (msg && connected) {
          composerInput.value = '';
          vscode.postMessage({ type: 'chat', payload: { message: msg } });
        }
      }
    });

    document.getElementById('composerAttach').addEventListener('click', () => { /* attach */ });
    document.getElementById('composerMode').addEventListener('click', () => { modeSelectorEl.querySelector('[data-mode="auto"]').click(); });
    document.getElementById('composerMic').addEventListener('click', () => { /* voice */ });

    document.querySelectorAll('.actions button').forEach(b => {
      b.addEventListener('click', () => { if (!b.disabled) vscode.postMessage({ type: 'action', payload: b.dataset.action }); });
    });
    document.getElementById('clearTranscript').addEventListener('click', () => vscode.postMessage({ type: 'clearTranscript' }));
    modeSelectorEl.querySelectorAll('button').forEach(function(b) {
      b.addEventListener('click', function() {
        var mode = b.dataset.mode;
        if (mode) vscode.postMessage({ type: 'setMode', payload: mode });
      });
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}
