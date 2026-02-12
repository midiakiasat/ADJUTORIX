import * as vscode from "vscode";
import { RpcClient } from "../client/rpc";
import { RpcError } from "../client/types";
import type { JobStatus } from "../types/engineProtocol";
import { ENGINE_PROTOCOL_VERSION } from "../types/engineProtocol";
import type { AgentProcessManager, AgentProcessStatus } from "../agent/processManager";
import { classifyError } from "../agent/processManager";

const PING_INTERVAL_MS = 3_000;
const PING_BACKOFF_INITIAL_MS = 2_000;
const PING_BACKOFF_MAX_MS = 30_000;
const TRANSCRIPT_KEY = "adjutorix.transcript.v2";
const MAX_TRANSCRIPT_ENTRIES = 100;
/** Use single source of truth; prevents drift from agent protocol. */
const PROTOCOL_VERSION = ENGINE_PROTOCOL_VERSION;
const JOB_POLL_MS = 500;

// ─────────────────────────────────────────────────────────────────────────────
// v3 WIRE + WORKFLOW (single source of truth)
// ─────────────────────────────────────────────────────────────────────────────
type WorkflowState =
  | "IDLE"
  | "INTAKE"
  | "PLAN_DRAFT"
  | "PLAN_SELECTED"
  | "PATCH_PROPOSED"
  | "REVIEW_REQUIRED"
  | "APPLY_ARMED"
  | "APPLIED"
  | "RUNNING"
  | "RESULT_READY"
  | "DONE"
  | "FAILED"
  | "ABORTED";

type WorkflowSnapshot = {
  workflow_id: string;
  state: WorkflowState;
  prompt?: string;
  context_snapshot?: { id: string; cwd: string; base_rev?: string; files_hash?: string };
  plans: Array<{ plan_id: string; text: string; created_at_ms: number }>;
  selected_plan_id?: string;
  success_criteria?: string[];
  patch?: {
    patch_id: string;
    summary: string;
    files_touched: string[];
    status: "proposed" | "accepted" | "applied" | "rejected";
  };
  review?: {
    risk: "low" | "med" | "high";
    blast_radius: string[];
    rollback_plan: string;
    verification_plan: string[];
    approved: boolean;
  };
  armed?: { consent_token: string; armed_at_ms: number };
  jobs?: Array<{ job_id: string; kind: string; state: "queued" | "running" | "success" | "failed"; summary?: string }>;
  result?: { summary: string; evidence_refs: string[]; regression: "pass" | "fail" };
  failure?: { code: string; message: string; at_state: WorkflowState };
};

type ClientIntent =
  | { intent_id: string; kind: "workflow.new"; prompt: string; cwd: string }
  | { intent_id: string; kind: "workflow.freeze_context" }
  | { intent_id: string; kind: "plan.generate"; n?: number }
  | { intent_id: string; kind: "plan.select"; plan_id: string; success_criteria?: string[] }
  | { intent_id: string; kind: "patch.generate" }
  | { intent_id: string; kind: "patch.review_complete"; review: NonNullable<WorkflowSnapshot["review"]> }
  | { intent_id: string; kind: "apply.arm" }
  | { intent_id: string; kind: "apply.confirm"; consent_token: string }
  | { intent_id: string; kind: "run.request"; kind_run: "check" | "verify" | "deploy" | "custom"; commands?: string[] }
  | { intent_id: string; kind: "result.ack" }
  | { intent_id: string; kind: "workflow.cancel" }
  | { intent_id: string; kind: "workflow.reset" };

type ServerEvent =
  | { kind: "snapshot"; snapshot: WorkflowSnapshot }
  | { kind: "log"; scope: "engine" | "workflow" | "job"; text: string }
  | { kind: "toast"; level: "info" | "warn" | "error"; text: string }
  | { kind: "capabilities"; caps: { job_run: boolean; patch: boolean; authority: boolean } }
  | { kind: "authority"; authority: { writes_allowed: boolean; writes_note?: string; actions_allowed: string[] } };

type WireMsg =
  | { protocol: 3; type: "hello"; ui_session: string; client: "webview" }
  | { protocol: 3; type: "ready"; ui_session: string; last_seq?: number }
  | { protocol: 3; type: "intent"; intent: ClientIntent }
  | { protocol: 3; type: "ack"; ack_seq: number }
  | { protocol: 3; type: "event"; seq: number; ts_ms: number; payload: ServerEvent }
  | { protocol: 3; type: "error"; error: { code: string; message: string; detail?: unknown } };

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

function nowMs(): number {
  return Date.now();
}

class WorkflowStore {
  private snap: WorkflowSnapshot = {
    workflow_id: randomId("wf"),
    state: "IDLE",
    plans: [],
    jobs: [],
  };
  private processed = new Set<string>();
  getSnapshot(): WorkflowSnapshot {
    return this.snap;
  }
  seen(intent_id: string): boolean {
    return this.processed.has(intent_id);
  }
  mark(intent_id: string): void {
    this.processed.add(intent_id);
  }
  reset(): void {
    this.snap = { workflow_id: randomId("wf"), state: "IDLE", plans: [], jobs: [] };
  }
  patch(next: Partial<WorkflowSnapshot>): WorkflowSnapshot {
    this.snap = { ...this.snap, ...next };
    return this.snap;
  }
  fail(code: string, message: string): WorkflowSnapshot {
    const at_state = this.snap.state;
    this.snap = { ...this.snap, state: "FAILED", failure: { code, message, at_state } };
    return this.snap;
  }
  upsertJob(job: {
    job_id: string;
    kind: string;
    state: "queued" | "running" | "success" | "failed";
    summary?: string;
  }): WorkflowSnapshot {
    const jobs = Array.isArray(this.snap.jobs) ? this.snap.jobs.slice() : [];
    const i = jobs.findIndex((j) => j.job_id === job.job_id);
    if (i >= 0) jobs[i] = { ...jobs[i], ...job };
    else jobs.push(job);
    this.snap = { ...this.snap, jobs };
    return this.snap;
  }
}

export interface TranscriptEntry {
  role: "user" | "assistant" | "system";
  text: string;
  engine?: string;
  /** When intent is propose_job, webview renders commands as buttons. */
  meta?: { intent?: string; commands?: string[] };
}

/** Chat RPC returns envelope only. intent is one of: no_action, propose_patch, propose_job. */
export interface ChatEnvelope {
  type: string;
  trace_id?: string;
  engine?: string;
  intent?: "no_action" | "propose_patch" | "propose_job";
  analysis?: string;
  payload?: {
    code?: string;
    message?: string;
    text?: string;
    suggested?: string[];
    goal?: string;
    steps?: { id?: string; action?: string; tool?: string }[];
    commands?: string[];
  };
}

function formatEnvelope(env: ChatEnvelope): string {
  const t = env?.type || "unknown";
  const p = env?.payload || {};
  const intent = env?.intent || "no_action";
  const analysis = env?.analysis ?? "";
  if (t === "reject") return `Rejected: ${p.message ?? "Unknown"}`;
  if (t === "chat_response") {
    const lines = [analysis ? `[${intent}] ${analysis}` : `[${intent}]`];
    if (p.message) lines.push(p.message);
    if (intent === "no_action" && Array.isArray(p.suggested) && p.suggested.length) lines.push("\n- " + p.suggested.join("\n- "));
    if (p.goal) lines.push("\nGoal: " + p.goal);
    if (Array.isArray(p.commands) && p.commands.length) lines.push("Commands: " + p.commands.join(", "));
    return lines.join("\n");
  }
  if (t === "questions_needed") {
    const suggested = Array.isArray(p.suggested) ? p.suggested : [];
    const s = suggested.length ? "\n- " + suggested.join("\n- ") : "";
    return `${p.message ?? "Questions needed."}${s}`;
  }
  if (t === "plan") {
    const steps = Array.isArray(p.steps) ? p.steps : [];
    const cmds = Array.isArray(p.commands) ? p.commands : [];
    const stepLines = steps.length
      ? "\n" + steps.map((x) => `- [${x.id ?? "?"}] ${x.action}${x.tool ? ` (${x.tool})` : ""}`).join("\n")
      : "";
    const cmdLine = cmds.length ? `\n\nCommands: ${cmds.join(" ")}` : "";
    return `Plan: ${p.goal ?? "—"}${stepLines}${cmdLine}`;
  }
  if (t === "report") return p.text ?? "Report ready.";
  return JSON.stringify(env, null, 2);
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
  private lastPingLoggedAt = 0;
  private lastPingWasOk: boolean | null = null;

  /** Ready-gated queue: no postMessage before webview JS has installed its message handler. */
  private webviewReady = false;
  private pendingWebviewMsgs: unknown[] = [];

  // v3 seq/ack + replay buffer
  private seq = 0;
  private lastAckedSeq = 0;
  private readonly eventRing: Array<WireMsg & { type: "event" }> = [];
  private readonly EVENT_RING_MAX = 200;

  private readonly workflow = new WorkflowStore();
  private _knownPatchIds = new Set<string>();

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
    this.webviewReady = false;
    this.pendingWebviewMsgs = [];
    this.seq = 0;
    this.lastAckedSeq = 0;
    this.eventRing.length = 0;
    this._knownPatchIds = new Set<string>();

    const entries = this.getTranscript();
    const hasRawJson = entries.some((e) => e.text.trim().startsWith('{"type":'));
    if (hasRawJson) {
      void this.clearTranscript().then(() => this.safeSendTranscript());
    }

    const uiSession = Math.random().toString(16).slice(2);
    this.out.appendLine(`[ui] session=${uiSession}`);

    webviewView.onDidDispose(() => {
      this.out.appendLine(`[ui] disposed session=${uiSession}`);
      this.webviewReady = false;
      this.pendingWebviewMsgs = [];
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
    webviewView.webview.html = this.getHtml(webviewView.webview, uiSession);

    if (this.agentProcessManager) {
      const pushStatus = (status: AgentProcessStatus) => {
        this.postStatus(status);
      };
      pushStatus(this.agentProcessManager.getStatus());
      this.statusSubscription = this.agentProcessManager.onStatusChange(pushStatus);

      // VSC-only controller: start when view resolves unless mode is external or managed-policy mismatch.
      const st = this.agentProcessManager.getStatus();
      const isManagedPolicyMismatch =
        st.mode === "managed" &&
        st.warningRaw?.startsWith("managed policy:");
      // Auto-start only in Managed mode. External = no lifecycle; Auto = no auto-start (user picks Managed or runs agent manually).
      if (
        st.mode === "managed" &&
        (st.state === "stopped" || st.state === "failed") &&
        !isManagedPolicyMismatch
      ) {
        this.agentProcessManager.start().catch((e) => {
          this.out.appendLine(`[view] start failed: ${e}`);
        });
      }

      this.schedulePing();
    } else {
      this.pingAndUpdateStatus();
    }

    webviewView.webview.onDidReceiveMessage(async (msg: { type: string; payload?: unknown }) => {
      if (msg.type !== "setMode") this.out.appendLine(`[view] msg: ${JSON.stringify(msg)}`);
      switch (msg.type) {
        case "log":
          this.out.appendLine(`[view] ${String((msg as { payload?: unknown }).payload ?? "")}`);
          break;
        case "ready":
          this.webviewReady = true;
          this.flushWebviewQueue();

          if (this.agentProcessManager) {
            this.postStatus(this.agentProcessManager.getStatus());
            void this.agentProcessManager.ping().then(() => {
              if (this.agentProcessManager) this.postStatus(this.agentProcessManager.getStatus());
            });
          } else {
            await this.pingAndUpdateStatus();
          }
          this.safeSendTranscript();
          this.emitSnapshot();
          break;
        case "action": {
          const p = msg.payload as { action?: string; confirm?: boolean };
          const action = typeof p === "string" ? p : (p?.action ?? "check");
          const confirm = typeof p === "object" && p?.confirm === true;
          await this.runAction(webviewView, action, { confirm });
          break;
        }
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
        case "patchList":
          await this.handlePatchList();
          break;
        case "patchGet": {
          const patchId = (msg.payload as { patch_id?: string })?.patch_id;
          if (patchId) await this.handlePatchGet(webviewView, patchId);
          break;
        }
        case "patchAccept": {
          const patchId = (msg.payload as { patch_id?: string })?.patch_id;
          if (patchId) await this.handlePatchAccept(webviewView, patchId);
          break;
        }
        case "patchReject": {
          const patchId = (msg.payload as { patch_id?: string })?.patch_id;
          if (patchId) await this.handlePatchReject(webviewView, patchId);
          break;
        }
        case "patchApply": {
          const patchId = (msg.payload as { patch_id?: string })?.patch_id;
          if (patchId) await this.handlePatchApply(webviewView, patchId);
          break;
        }
        case "setMode": {
          const mode = (msg.payload as { mode?: string })?.mode;
          if (
            this.agentProcessManager &&
            (mode === "auto" || mode === "managed" || mode === "external")
          ) {
            this.agentProcessManager.setMode(mode);
            this.postStatus(this.agentProcessManager.getStatus());
            // Only start (spawn) in Managed mode. External = connect only; Auto = no lifecycle.
            if (mode === "managed") {
              this.agentProcessManager.start().catch((e) =>
                this.out.appendLine(`[mode] start failed: ${e}`)
              );
            }
          }
          break;
        }
        default:
          break;
      }
    });

    // v3 WIRE entrypoint (separate from legacy msg types)
    webviewView.webview.onDidReceiveMessage(async (raw: unknown) => {
      if (!raw || typeof raw !== "object") return;
      const m = raw as Record<string, unknown>;
      if (m.protocol !== 3) return;
      if (m.type === "hello") {
        this.out.appendLine(`[wire] hello ui_session=${String(m.ui_session ?? "")}`);
        this.emitSnapshot();
        return;
      }
      if (m.type === "ready") {
        const last = typeof m.last_seq === "number" ? m.last_seq : 0;
        this.out.appendLine(`[wire] ready last_seq=${last}`);
        this.resendFrom(last);
        this.emitSnapshot();
        return;
      }
      if (m.type === "ack") {
        const ackSeq = typeof (m as { ack_seq?: number }).ack_seq === "number" ? (m as { ack_seq: number }).ack_seq : 0;
        this.lastAckedSeq = Math.max(this.lastAckedSeq, ackSeq);
        return;
      }
      if (m.type === "intent" && m.intent && typeof m.intent === "object") {
        await this.handleIntent(m.intent as ClientIntent);
      }
    });
  }

  private clearPingTimer(): void {
    if (this.pingTimeout != null) {
      clearTimeout(this.pingTimeout);
      this.pingTimeout = null;
    }
  }

  private schedulePing(): void {
    this.clearPingTimer();
    if (!this.agentProcessManager || !this.currentView) return;

    const state = this.agentProcessManager.getStatus().state;
    if (state === "stopping" || state === "starting") {
      this.pingTimeout = setTimeout(() => {
        this.pingTimeout = null;
        this.schedulePing();
      }, 1000);
      return;
    }

    this.pingTimeout = setTimeout(async () => {
      this.pingTimeout = null;
      if (!this.currentView || !this.agentProcessManager) return;
      const ok = await this.agentProcessManager.ping();
      const status = this.agentProcessManager.getStatus();
      // "ok" for UI/backoff/logging must match what the UI will show (sticky FAILED = not connected).
      const effectiveOk = ok && status.state === "connected" && !status.lastError;
      this.postStatus(status);
      const now = Date.now();
      if (effectiveOk) {
        this.pingBackoffMs = PING_INTERVAL_MS;
        const shouldLogOk =
          this.lastPingWasOk !== true || now - this.lastPingLoggedAt > 30_000;
        if (shouldLogOk) {
          this.out.appendLine(`[ping] ok (${status.baseUrl})`);
          this.lastPingLoggedAt = now;
        }
        this.lastPingWasOk = true;
      } else {
        this.pingBackoffMs = Math.min(
          this.pingBackoffMs * 2 || PING_BACKOFF_INITIAL_MS,
          PING_BACKOFF_MAX_MS
        );
        const shouldLogFail =
          this.lastPingWasOk !== false || now - this.lastPingLoggedAt > 30_000;
        if (shouldLogFail) {
          this.out.appendLine(`[ping] fail: ${status.lastError ?? "unknown"}`);
          this.lastPingLoggedAt = now;
        }
        this.lastPingWasOk = false;
      }
      this.schedulePing();
    }, this.pingBackoffMs);
  }

  private async handleRetry(_webviewView: vscode.WebviewView): Promise<void> {
    if (!this.agentProcessManager) {
      await this.pingAndUpdateStatus();
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
      this.postStatus(this.agentProcessManager.getStatus());
    }
  }

  /** Single place to sync transport (endpoint + auth) from status. */
  private configureTransport(status: AgentProcessStatus): void {
    this.rpcClient.setEndpoint(`${status.baseUrl}/rpc`);
  }

  /** Single delivery path: queue if webview not ready, else post now. */
  private postToWebview(msg: unknown): void {
    const view = this.currentView;
    if (!view) return;
    if (!this.webviewReady) {
      this.pendingWebviewMsgs.push(msg);
      return;
    }
    void view.webview.postMessage(msg);
  }

  private flushWebviewQueue(): void {
    const view = this.currentView;
    if (!view) return;
    const q = this.pendingWebviewMsgs.splice(0);
    for (const m of q) void view.webview.postMessage(m);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // v3 emit/replay
  // ───────────────────────────────────────────────────────────────────────────
  private emitEvent(payload: ServerEvent): void {
    const ev: WireMsg & { type: "event" } = {
      protocol: 3,
      type: "event",
      seq: ++this.seq,
      ts_ms: nowMs(),
      payload,
    };
    this.eventRing.push(ev);
    if (this.eventRing.length > this.EVENT_RING_MAX) this.eventRing.shift();
    this.postToWebview(ev);
  }

  private emitSnapshot(): void {
    this.emitEvent({ kind: "snapshot", snapshot: this.workflow.getSnapshot() });
  }

  private resendFrom(lastSeq: number): void {
    const start = lastSeq + 1;
    const toSend = this.eventRing.filter((e) => e.seq >= start);
    for (const ev of toSend) this.postToWebview(ev);
  }

  private async listPatches(
    limit = 200
  ): Promise<Array<{ patch_id: string; status: string; created_at_ms: number; summary: string }>> {
    const res = await this.rpcClient.call<{
      patches?: Array<{ patch_id: string; status: string; created_at_ms: number; summary: string }>;
    }>("patch.list", { limit });
    return Array.isArray(res?.patches) ? res.patches : [];
  }

  private pickNewPatch(
    before: Set<string>,
    after: Array<{ patch_id: string; created_at_ms: number }>
  ): string | undefined {
    const delta = after.filter((p) => p.patch_id && !before.has(p.patch_id));
    if (delta.length > 0) {
      delta.sort((a, b) => (b.created_at_ms || 0) - (a.created_at_ms || 0));
      return delta[0].patch_id;
    }
    const sorted = after.slice().sort((a, b) => (b.created_at_ms || 0) - (a.created_at_ms || 0));
    return sorted[0]?.patch_id;
  }

  private async fetchCapabilitiesAndNotify(): Promise<void> {
    try {
      const cap = await this.rpcClient.call<{
        protocol?: number | string;
        methods?: string[];
        build_fingerprint?: string;
      }>("capabilities", {});
      const rawProtocol = cap?.protocol;
      const protocol =
        typeof rawProtocol === "number"
          ? rawProtocol
          : typeof rawProtocol === "string"
            ? parseInt(rawProtocol, 10)
            : undefined;
      const methods = Array.isArray(cap?.methods) ? cap.methods : [];
      const jobProtocolOk =
        protocol === PROTOCOL_VERSION && methods.includes("job.run");
      const mismatchMessage = !jobProtocolOk
        ? protocol !== PROTOCOL_VERSION
          ? `Protocol mismatch: expected ${PROTOCOL_VERSION}, got ${rawProtocol ?? "?"}`
          : !methods.includes("job.run")
          ? "Missing method: job.run"
          : "Capabilities check failed"
        : undefined;
      this.postToWebview({
        type: "capabilities",
        jobProtocolOk,
        protocol,
        methods,
        mismatchMessage,
      });
      this.emitEvent({
        kind: "capabilities",
        caps: { job_run: jobProtocolOk, patch: methods.includes("patch.list"), authority: true },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.postToWebview({
        type: "capabilities",
        jobProtocolOk: false,
        mismatchMessage: msg,
      });
      this.emitEvent({ kind: "toast", level: "error", text: `capabilities failed: ${msg}` });
    }
  }

  /** Post status to current view only; bails if no active view (avoids stale captured webview). */
  private postStatus(status: AgentProcessStatus): void {
    if (!this.currentView) return;

    this.configureTransport(status);

    if (status.state === "connected") {
      void this.fetchCapabilitiesAndNotify();
    } else {
      this.postToWebview({
        type: "capabilities",
        jobProtocolOk: false,
        mismatchMessage: "Not connected",
      });
    }

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

this.postToWebview({
  type: "status",
  status: statusLabel,
  state: status.state,
  mode: status.mode,
  ownership: status.ownership,
  error: status.lastError,
  warning: status.warning,
  version: status.version,
  lastPingAt: status.lastPingAt,
  baseUrl: status.baseUrl,
});

    if (status.state === "connected") {
      void this._fetchAndPostAuthority();
    }
  }

  private async _fetchAndPostAuthority(): Promise<void> {
    try {
      const authority = await this.rpcClient.call<{
        writes_allowed?: boolean;
        writes_note?: string;
        actions_allowed?: string[];
        sandbox_enforced?: boolean;
        ledger_state?: string;
        pending_patches?: number;
        pending_jobs?: number;
      }>("authority", {});
      this.postToWebview({ type: "authority", payload: authority });
      this.emitEvent({
        kind: "authority",
        authority: {
          writes_allowed: authority?.writes_allowed === true,
          writes_note: authority?.writes_note,
          actions_allowed: Array.isArray(authority?.actions_allowed) ? authority.actions_allowed : [],
        },
      });
    } catch {
      this.postToWebview({
        type: "authority",
        payload: {
          writes_allowed: false,
          writes_note: "patch-only",
          actions_allowed: ["check", "verify"],
          sandbox_enforced: true,
          ledger_state: "unknown",
          pending_patches: 0,
          pending_jobs: 0,
        },
      });
      this.emitEvent({
        kind: "authority",
        authority: { writes_allowed: false, writes_note: "patch-only", actions_allowed: ["check", "verify"] },
      });
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // v3 intent handler (state machine + effects)
  // ───────────────────────────────────────────────────────────────────────────
  private async handleIntent(intent: ClientIntent): Promise<void> {
    if (!intent || typeof intent !== "object") return;
    if (this.workflow.seen(intent.intent_id)) {
      this.emitEvent({ kind: "log", scope: "workflow", text: `dedupe intent ${intent.intent_id}` });
      return;
    }
    this.workflow.mark(intent.intent_id);
    this.emitEvent({ kind: "log", scope: "workflow", text: `intent ${intent.kind}` });

    const snap = this.workflow.getSnapshot();
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";

    try {
      switch (intent.kind) {
        case "workflow.reset": {
          this.workflow.reset();
          this.emitSnapshot();
          return;
        }
        case "workflow.cancel": {
          this.workflow.patch({ state: "ABORTED" });
          this.emitSnapshot();
          return;
        }
        case "workflow.new": {
          this.workflow.patch({
            state: "INTAKE",
            prompt: intent.prompt,
            context_snapshot: { id: randomId("ctx"), cwd: intent.cwd || cwd },
            plans: [],
            selected_plan_id: undefined,
            patch: undefined,
            review: undefined,
            armed: undefined,
            jobs: [],
            result: undefined,
            failure: undefined,
          });
          this.emitSnapshot();
          this.workflow.patch({ state: "PLAN_DRAFT" });
          this.emitSnapshot();
          return;
        }
        case "workflow.freeze_context": {
          this.workflow.patch({
            context_snapshot: { ...(snap.context_snapshot ?? { id: randomId("ctx"), cwd }), cwd },
          });
          this.emitSnapshot();
          return;
        }
        case "plan.generate": {
          if (!snap.prompt) throw new Error("No prompt; start workflow first.");
          this.workflow.patch({ state: "PLAN_DRAFT" });
          this.emitSnapshot();
          const n = intent.n ?? 3;
          const transcript = [
            {
              role: "user" as const,
              content: `Generate ${n} implementation plans. Return each as:\nPLAN: <title>\n- steps...\n---\nNo code. No patch. No tools.`,
            },
          ];
          const env = await this.rpcClient.call<ChatEnvelope>("chat", { messages: transcript });
          const text = (env?.payload?.message ?? env?.payload?.text ?? "").trim();
          const blocks = text ? text.split(/\n---\n/g).slice(0, n) : [];
          const plans = blocks.map((b, i) => ({
            plan_id: randomId(`plan${i + 1}`),
            text: b.trim() || `Plan ${i + 1}: (empty)`,
            created_at_ms: nowMs(),
          }));
          this.workflow.patch({ plans });
          this.emitSnapshot();
          return;
        }
        case "plan.select": {
          const exists = snap.plans.some((p) => p.plan_id === intent.plan_id);
          if (!exists) throw new Error("Unknown plan_id.");
          this.workflow.patch({
            state: "PLAN_SELECTED",
            selected_plan_id: intent.plan_id,
            success_criteria: intent.success_criteria ?? snap.success_criteria,
          });
          this.emitSnapshot();
          return;
        }
        case "patch.generate": {
          if (snap.state !== "PLAN_SELECTED" && snap.state !== "PLAN_DRAFT") {
            throw new Error(`patch.generate not allowed from ${snap.state}`);
          }
          const beforeList = await this.listPatches(200);
          const before = new Set(beforeList.map((p) => p.patch_id));

          this.workflow.patch({ state: "PATCH_PROPOSED" });
          this.emitSnapshot();

          if (!this.currentView) throw new Error("No active view.");
          await this.runAction(this.currentView, "fix", { confirm: false });

          const afterList = await this.listPatches(200);
          const picked = this.pickNewPatch(before, afterList);
          const latest = picked ? afterList.find((p) => p.patch_id === picked) : afterList[0];

          if (latest?.patch_id) {
            this.workflow.patch({
              patch: {
                patch_id: latest.patch_id,
                summary: latest.summary ?? "",
                files_touched: [],
                status: (latest.status as "proposed" | "accepted" | "applied" | "rejected") ?? "proposed",
              },
              state: "REVIEW_REQUIRED",
            });
          } else {
            this.workflow.patch({ state: "REVIEW_REQUIRED" });
          }
          this.emitSnapshot();
          return;
        }
        case "patch.review_complete": {
          if (snap.state !== "REVIEW_REQUIRED" && snap.state !== "PATCH_PROPOSED") {
            throw new Error(`review not allowed from ${snap.state}`);
          }
          this.workflow.patch({ review: intent.review });
          if (intent.review.approved) {
            this.workflow.patch({ state: "APPLY_ARMED" });
          } else {
            this.workflow.patch({ state: "REVIEW_REQUIRED" });
          }
          this.emitSnapshot();
          return;
        }
        case "apply.arm": {
          if (snap.state !== "REVIEW_REQUIRED" && snap.state !== "APPLY_ARMED") {
            throw new Error(`apply.arm not allowed from ${snap.state}`);
          }
          if (!snap.review?.approved) throw new Error("Review not approved.");
          const token = randomId("consent");
          this.workflow.patch({ state: "APPLY_ARMED", armed: { consent_token: token, armed_at_ms: nowMs() } });
          this.emitSnapshot();
          return;
        }
        case "apply.confirm": {
          if (snap.state !== "APPLY_ARMED") throw new Error(`apply.confirm not allowed from ${snap.state}`);
          if (!snap.armed?.consent_token || intent.consent_token !== snap.armed.consent_token) {
            throw new Error("Bad consent token.");
          }
          if (!snap.patch?.patch_id) throw new Error("No patch_id to apply.");

          const applied = await this.rpcClient.call<{ ok?: boolean; error?: string }>("patch.apply", {
            patch_id: snap.patch.patch_id,
          });
          if (!applied?.ok) throw new Error(applied?.error || "patch.apply failed");

          this.workflow.patch({ state: "APPLIED", patch: { ...snap.patch, status: "applied" } });
          this.emitSnapshot();

          if (!this.currentView) throw new Error("No active view.");
          this.workflow.patch({ state: "RUNNING" });
          this.emitSnapshot();
          await this.runAction(this.currentView, "verify", { confirm: false });

          const s2 = this.workflow.getSnapshot();
          const v = (s2.jobs || []).slice().reverse().find((j) => j.kind === "verify");
          const ok = v?.state === "success";
          this.workflow.patch({
            state: "RESULT_READY",
            result: {
              summary: ok ? "Verify PASS after apply." : "Verify FAIL after apply.",
              evidence_refs: [],
              regression: ok ? "pass" : "fail",
            },
          });
          this.emitSnapshot();
          return;
        }
        case "run.request": {
          if (
            snap.state !== "APPLIED" &&
            snap.state !== "RESULT_READY" &&
            snap.state !== "PLAN_SELECTED" &&
            snap.state !== "DONE"
          ) {
            throw new Error(`run.request not allowed from ${snap.state}`);
          }
          const kind = intent.kind_run;
          const action = kind === "custom" ? "check" : kind;
          if (action === "deploy") {
            const pass = snap.result?.regression === "pass";
            if (!pass) throw new Error("Deploy blocked: no passing verify result.");
          }
          this.workflow.patch({ state: "RUNNING" });
          this.emitSnapshot();

          if (!this.currentView) throw new Error("No active view.");
          await this.runAction(this.currentView, action, { confirm: action === "deploy" });

          this.workflow.patch({
            state: "RESULT_READY",
            result: {
              summary: `Run ${action} finished. See logs/transcript.`,
              evidence_refs: [],
              regression: "pass",
            },
          });
          this.emitSnapshot();
          return;
        }
        case "result.ack": {
          if (snap.state !== "RESULT_READY") return;
          this.workflow.patch({ state: "DONE" });
          this.emitSnapshot();
          return;
        }
        default:
          return;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.workflow.fail("INTENT_FAILED", msg);
      this.emitSnapshot();
      this.emitEvent({ kind: "toast", level: "error", text: msg });
    }
  }

  private getTranscript(): TranscriptEntry[] {
    const raw = this.workspaceState.get<TranscriptEntry[]>(TRANSCRIPT_KEY);
    return Array.isArray(raw) ? raw : [];
  }

  private async saveTranscript(entries: TranscriptEntry[]): Promise<void> {
    await this.workspaceState.update(TRANSCRIPT_KEY, entries);
  }

  private async appendToTranscript(
    role: TranscriptEntry["role"],
    text: string,
    engine?: string,
    meta?: TranscriptEntry["meta"]
  ): Promise<void> {
    const entries = this.getTranscript();
    entries.push({ role, text, ...(engine !== undefined ? { engine } : {}), ...(meta ? { meta } : {}) });
    const trimmed = entries.slice(-MAX_TRANSCRIPT_ENTRIES);
    await this.saveTranscript(trimmed);
  }

  private async clearTranscript(): Promise<void> {
    await this.saveTranscript([]);
  }

  /** Send transcript to current view if still attached; avoids noise if webview was disposed. */
  private safeSendTranscript(): void {
    this.postToWebview({ type: "transcript", payload: this.getTranscript() });
  }

  private async pingAndUpdateStatus(): Promise<void> {
    if (!this.currentView) return;
    try {
      const ping = await this.rpcClient.call<{ ok: true; engine?: { fingerprint?: string; version?: string } }>("ping", {});
      const baseUrl = this.rpcClient.getEndpoint()?.replace(/\/rpc$/, "") ?? undefined;
      this.postToWebview({
        type: "status",
        status: "connected",
        state: "connected",
        mode: "external",
        ownership: "external",
        baseUrl,
        version: ping?.engine?.fingerprint ?? ping?.engine?.version ?? undefined,
      });
      await this._fetchAndPostAuthority();
    } catch (err: unknown) {
      this.postToWebview({
        type: "status",
        status: "disconnected",
        state: "disconnected",
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
    const confirm = (context as { confirm?: boolean })?.confirm === true;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";

    try {
      let jobId: string | undefined;
      try {
        const runRes = await this.rpcClient.call<{ job_id?: string }>("job.run", {
          kind: action,
          cwd: workspaceRoot,
          confirm,
        });
        jobId = runRes?.job_id;
      } catch (jobErr: unknown) {
        const isMethodNotFound =
          jobErr instanceof RpcError && (jobErr.code === "METHOD_NOT_FOUND" || jobErr.message?.includes("Unknown method"));
        if (isMethodNotFound) {
          await this.runActionLegacy(webviewView, action, context);
          return;
        }
        throw jobErr;
      }

      if (!jobId) {
        throw new Error("job.run did not return job_id");
      }

      this.postToWebview({
        type: "job",
        phase: "started",
        action,
        jobId,
      });
      this.workflow.upsertJob({ job_id: jobId, kind: action, state: "running" });
      this.emitSnapshot();
      this.emitEvent({ kind: "log", scope: "job", text: `[${action}] started ${jobId}` });

      let lastLogSeq = 0;
      const terminal = new Set<JobStatus>(["success", "failed", "canceled", "aborted"]);
      for (;;) {
        const status = await this.rpcClient.call<{
          state?: string;
          summary?: string;
          report?: Record<string, unknown>;
          exit_code?: number;
        }>("job.status", { id: jobId });
        const state = status?.state ?? "unknown";

        const logsRes = await this.rpcClient.call<{ lines?: { seq: number; line: string }[]; next_seq?: number; done?: boolean }>("job.logs", {
          id: jobId,
          since_seq: lastLogSeq,
        });
        if (Array.isArray(logsRes?.lines) && logsRes.lines.length > 0) {
          const events = logsRes.lines.map(({ seq, line }) => ({
            id: seq,
            type: "step.log",
            ts_ms: Date.now(),
            payload: { text: line },
          }));
          for (const { line } of logsRes.lines) {
            this.out.appendLine(`[job] ${line}`);
            this.emitEvent({ kind: "log", scope: "job", text: `[${action}] ${line}` });
          }
          this.postToWebview({
            type: "job",
            phase: "events",
            action,
            jobId,
            events,
          });
          lastLogSeq = logsRes?.next_seq ?? lastLogSeq;
        }

        if (terminal.has(state as JobStatus)) {
          const summary = status?.summary ?? state;
          const report = status?.report ?? {};
          const protocolState = (state === "succeeded" ? "success" : state) as JobStatus;
          this.postToWebview({
            type: "job",
            phase: "finished",
            action,
            jobId,
            status: protocolState,
            error: state === "failed" ? summary : undefined,
            result: report,
          });
          this.postToWebview({
            type: "actionResult",
            action,
            result: report,
            jobState: state,
            summary,
          });
          const finalState =
            protocolState === "success"
              ? "success"
              : protocolState === "failed"
                ? "failed"
                : protocolState === "canceled" || protocolState === "aborted"
                  ? "failed"
                  : "failed";
          this.workflow.upsertJob({
            job_id: jobId,
            kind: action,
            state: finalState as "queued" | "running" | "success" | "failed",
            summary,
          });
          this.emitSnapshot();
          this.emitEvent({
            kind: "log",
            scope: "job",
            text: `[${action}] ${finalState} ${jobId} :: ${summary}`,
          });
          this.out.appendLine(`[action] ${action} ${state}`);
          await this.appendToTranscript("system", `${action}: ${summary}`);
          this.safeSendTranscript();
          return;
        }

        await new Promise((r) => setTimeout(r, JOB_POLL_MS));
      }
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
      this.postToWebview({ type: "actionResult", action, error: msg });
      this.out.appendLine(`[action] ${action} failed: ${msg}`);
      await this.appendToTranscript("system", summary);
      this.safeSendTranscript();
    }
  }

  private async runActionLegacy(
    _webviewView: vscode.WebviewView,
    action: string,
    context?: unknown
  ): Promise<void> {
    const confirm = (context as { confirm?: boolean })?.confirm === true;
    try {
      const env = await this.rpcClient.call<{ type: string; payload?: { action?: string; result?: any; blocked?: boolean; message?: string } }>("run", {
        job_name: "sidebar",
        action,
        confirm,
        allow_override: false,
      });
      if (!env || env.type !== "report") {
        throw new Error("Invalid run response");
      }
      const payload = env.payload || {};
      const result = payload.result;
      const report = result;
      const duration = typeof report?.duration === "number" ? report.duration : 0;
      const failedCount = report?.results?.filter((r: { return_code?: number }) => r.return_code !== 0).length ?? 0;
      const summary =
        payload.blocked
          ? `${action} blocked · ${payload.message ?? ""}`
          : report?.status === "success"
          ? `${action} OK · ${duration.toFixed(1)}s · ${failedCount} failed`
          : `${action} failed · ${(report?.message ?? "").split(/\n/)[0]?.trim() || "see logs"}`;
      this.postToWebview({ type: "actionResult", action, result: report });
      this.out.appendLine(`[action] ${action} ${report?.status === "success" ? "ok" : "failed"}`);
      await this.appendToTranscript("system", summary);
      this.safeSendTranscript();
    } catch (err: unknown) {
      let msg = err instanceof Error ? err.message : String(err);
      const firstLine = msg.split(/\n/)[0]?.trim() ?? msg;
      await this.appendToTranscript("system", `${action} failed · ${firstLine}`);
      this.safeSendTranscript();
    }
  }

  private async handlePatchGet(_webviewView: vscode.WebviewView, patchId: string): Promise<void> {
    try {
      const res = await this.rpcClient.call<{
        patch_id?: string;
        patch_format?: string;
        patch_text?: string;
        summary?: string;
        status?: string;
        base_rev?: string;
        review_ops?: Array<{
          path: string;
          op: string;
          new_content_b64?: string;
          base_content_b64?: string;
          base_mismatch: boolean;
        }>;
      }>("patch.get", { patch_id: patchId, include_review: true });
      this.postToWebview({
        type: "patchGetResult",
        patch_id: patchId,
        patch_format: res?.patch_format,
        patch_text: res?.patch_text ?? "",
        summary: res?.summary ?? "",
        status: res?.status,
        base_rev: res?.base_rev,
        review_ops: res?.review_ops ?? undefined,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.postToWebview({
        type: "patchGetResult",
        patch_id: patchId,
        error: msg,
      });
    }
  }

  private async handlePatchList(): Promise<void> {
    try {
      const res = await this.rpcClient.call<{ patches?: Array<{ patch_id: string; job_id: string; status: string; created_at_ms: number; summary: string }> }>("patch.list", { limit: 50 });
      this.postToWebview({ type: "patchListResult", patches: res?.patches ?? [] });
      void this._fetchAndPostAuthority();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.postToWebview({ type: "patchListResult", patches: [], error: msg });
    }
  }

  private async handlePatchAccept(_webviewView: vscode.WebviewView, patchId: string): Promise<void> {
    try {
      const res = await this.rpcClient.call<{ ok?: boolean }>("patch.accept", { patch_id: patchId });
      this.postToWebview({ type: "patchActionResult", patch_id: patchId, action: "accept", ok: res?.ok ?? false });
      await this.handlePatchList();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.postToWebview({ type: "patchActionResult", patch_id: patchId, action: "accept", ok: false, error: msg });
    }
  }

  private async handlePatchReject(_webviewView: vscode.WebviewView, patchId: string): Promise<void> {
    try {
      const res = await this.rpcClient.call<{ ok?: boolean }>("patch.reject", { patch_id: patchId });
      this.postToWebview({ type: "patchActionResult", patch_id: patchId, action: "reject", ok: res?.ok ?? false });
      await this.handlePatchList();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.postToWebview({ type: "patchActionResult", patch_id: patchId, action: "reject", ok: false, error: msg });
    }
  }

  private async handlePatchApply(_webviewView: vscode.WebviewView, patchId: string): Promise<void> {
    try {
      const res = await this.rpcClient.call<{ ok?: boolean; error?: string; conflict_files?: string[] }>("patch.apply", { patch_id: patchId });
      this.postToWebview({
        type: "patchActionResult",
        patch_id: patchId,
        action: "apply",
        ok: res?.ok ?? false,
        error: res?.error,
        conflict_files: res?.conflict_files,
      });
      await this.handlePatchList();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.postToWebview({ type: "patchActionResult", patch_id: patchId, action: "apply", ok: false, error: msg });
    }
  }

  private async runChat(
    webviewView: vscode.WebviewView,
    payload: { message: string; context?: unknown }
  ): Promise<void> {
    const { message } = payload;
    const raw = message.trim();
    this.out.appendLine(`[chat] ${raw.slice(0, 80)}…`);
    await this.appendToTranscript("user", message);
    this.safeSendTranscript();

    // Slash commands: route to RPC or actions (controller UX)
    const cmd = raw.startsWith("/") ? raw.slice(1).split(/\s+/)[0] : null;
    if (cmd) {
      const map: Record<string, string> = {
        check: "check",
        fix: "fix",
        verify: "verify",
        deploy: "deploy",
        status: "status",
        cap: "capabilities",
      };
      const m = map[cmd];
      if (!m) {
        const msg = `Unknown command: /${cmd} (try /cap)`;
        await this.appendToTranscript("assistant", msg);
        this.safeSendTranscript();
        return;
      }
      if (m === "status" || m === "capabilities") {
        try {
          const res = await this.rpcClient.call<unknown>(m, {});
          await this.appendToTranscript("assistant", JSON.stringify(res, null, 2));
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          await this.appendToTranscript("assistant", `Error: ${msg}`);
        }
        this.safeSendTranscript();
        return;
      }
      await this.runAction(webviewView, m, { confirm: m === "deploy" });
      return;
    }

    try {
      const transcript = this.getTranscript()
        .filter((e) => e.role === "user" || e.role === "assistant")
        .slice(-20)
        .map((e) => ({ role: e.role, content: e.text }));
      const env = await this.rpcClient.call<ChatEnvelope>("chat", { messages: transcript });
      if (!env || typeof env !== "object") {
        this.out.appendLine("[chat] invalid envelope (not object)");
        await this.appendToTranscript("assistant", "Invalid response (no envelope).", undefined, undefined);
        this.safeSendTranscript();
        return;
      }
      if (env.type === "reject") {
        await this.appendToTranscript("assistant", formatEnvelope(env), undefined, undefined);
        this.safeSendTranscript();
        return;
      }
      const intent = env.intent ?? "no_action";
      const commands = (env.payload?.commands ?? []) as string[];
      await this.appendToTranscript("assistant", formatEnvelope(env), undefined, intent === "propose_job" && commands.length ? { intent, commands } : undefined);
      this.safeSendTranscript();
    } catch (err: unknown) {
      let msg = err instanceof Error ? err.message : String(err);
      if (msg === "Internal error" || msg === "Internal Error") {
        const hint = "Restart agent (run_agent.sh) and see Output → Adjutorix for details.";
        const extra = err instanceof RpcError && err.data ? ` ${JSON.stringify(err.data)}` : "";
        msg = `${hint}${extra}`;
      }
      const firstLine = msg.split(/\n/)[0]?.trim() ?? msg;
      this.postToWebview({ type: "chatResult", error: msg });
      this.out.appendLine(`[chat] failed: ${firstLine}`);
      await this.appendToTranscript("assistant", `Error: ${firstLine}`, "error");
      this.safeSendTranscript();
    }
  }

  private getHtml(webview: vscode.Webview, uiSession: string): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Adjutorix</title>
  <style>
    :root { --r: 12px; }
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); padding: 10px; margin: 0; color: var(--vscode-foreground); }
    * { box-sizing: border-box; }

    .row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .status { display:inline-block; padding:2px 8px; border-radius: 6px; font-size: 12px; margin-bottom: 8px; }
    .status.connected { background: var(--vscode-inputValidation-infoBackground); color: var(--vscode-inputValidation-infoBorder); }
    .status.starting, .status.stopping { background: var(--vscode-editorWarning-foreground); color: var(--vscode-editor-background); }
    .status.failed, .status.disconnected { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorBorder); }
    .status-detail { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 0 0 10px; }

    .indicators { display: flex; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
    .indicator { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; }
    .indicator .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-inputValidation-errorBackground); }
    .indicator.green .dot { background: #16825d; box-shadow: 0 0 6px rgba(22,130,93,0.6); }
    .indicator.green { color: #16825d; }
    .indicator:not(.green) { color: var(--vscode-descriptionForeground); }

    .mode-selector { display:flex; border: 1px solid var(--vscode-input-border); border-radius: 8px; overflow:hidden; margin-bottom: 10px; }
    .mode-selector button { flex:1; padding: 6px 8px; border:none; background: var(--vscode-input-background); color: var(--vscode-foreground); font-size: 11px; cursor: pointer; }
    .mode-selector button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .mode-selector button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .controller-banner { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 8px; padding: 6px 8px; border-radius: 6px; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); }
    .managed-failure-banner { font-size: 11px; color: var(--vscode-inputValidation-errorBorder); margin-bottom: 8px; padding: 6px 8px; border-radius: 6px; background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); }

    .transcript-wrap { margin-bottom: 10px; }
    .transcript { min-height: 72px; max-height: 200px; overflow:auto; border: 1px solid var(--vscode-input-border); border-radius: var(--r); padding: 8px; background: var(--vscode-input-background); font-size: 12px; }
    .transcript-entry { margin: 6px 0; white-space: pre-wrap; word-break: break-word; }
    .transcript-entry.user { color: var(--vscode-textLink-foreground); }
    .transcript-entry.assistant { color: var(--vscode-foreground); }
    .transcript-entry.system { color: var(--vscode-descriptionForeground); font-style: italic; }
    .clear-btn { margin-top: 6px; padding: 4px 8px; font-size: 11px; cursor: pointer; }

    /* --- SURFACE COMPOSER --- */
    .composer { border: 1px solid var(--vscode-input-border); border-radius: 14px; background: var(--vscode-input-background); overflow:hidden; margin-bottom: 8px; }
    .composer textarea {
      width: 100%;
      min-height: 72px;
      padding: 10px 12px;
      border: none;
      outline: none;
      resize: none;
      background: transparent;
      color: var(--vscode-foreground);
      font: inherit;
    }
    .composer textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
    .composer-footer {
      display:flex;
      align-items:center;
      justify-content: space-between;
      padding: 6px 10px;
      border-top: 1px solid var(--vscode-input-border);
    }
    .composer-left { display:flex; align-items:center; gap: 8px; }
    .icon-btn {
      border:none;
      background: transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 8px;
      font-size: 12px;
    }
    .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
    .mode-pill { display:flex; align-items:center; gap: 6px; }

    .context-line { display:flex; align-items:center; gap: 6px; font-size: 11px; color: var(--vscode-descriptionForeground); margin: 4px 0 10px; }
    .context-line .pill { padding: 2px 8px; border: 1px solid var(--vscode-input-border); border-radius: 999px; }

    .actions { display:flex; flex-wrap: wrap; gap: 6px; }
    .actions button { padding: 6px 10px; font-size: 12px; cursor:pointer; }
    .actions button:disabled { opacity: .6; cursor:not-allowed; }
  </style>
</head>
<body>
  <div style="font-weight:700; font-size:11px; margin-bottom:6px; line-height:1.3;">Governed execution engine. Nothing touches disk, runs code, or changes state without being recorded, reviewed, and replayable.</div>
  <div class="indicators">
    <div id="indicatorSystem" class="indicator green"><span class="dot"></span><span>System</span></div>
    <div id="indicatorEngine" class="indicator"><span class="dot"></span><span>Engine</span></div>
    <div id="indicatorChat" class="indicator"><span class="dot"></span><span>Chat</span></div>
  </div>
  <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
    <span id="engineLine" class="status disconnected">ENGINE: Disconnected</span>
    <button type="button" id="engineRetry" class="icon-btn" style="display:none;">Retry</button>
  </div>
  <div id="engineState" class="status-detail">Engine state: —</div>
  <div id="authorityPanel" style="font-size:10px; margin:8px 0; padding:8px; border:1px solid var(--vscode-input-border); border-radius:6px; background:var(--vscode-input-background); font-family:var(--vscode-editor-font-family); white-space:pre-wrap;">ENGINE AUTHORITY
────────────────────────
Writes allowed: — (loading…)
Actions allowed: —
Sandbox: —
Ledger state: —
Pending patches: —
Pending jobs: —</div>
  <div id="controllerBanner" class="controller-banner" style="display:none;"></div>
  <div id="managedFailureBanner" class="managed-failure-banner" style="display:none;"></div>

  <div class="patches-section" style="margin-top:8px;">
    <div style="font-weight:600; font-size:11px; margin-bottom:6px;">Patches (default view)</div>
    <button type="button" id="refreshPatches" class="icon-btn" style="margin-bottom:6px;">Refresh</button>
    <div id="patchList" style="font-size:11px;"></div>
    <div id="patchDiffView" style="display:none; margin-top:8px; border:1px solid var(--vscode-input-border); border-radius:4px; padding:8px;">
      <div id="patchApplyBanner" style="display:none; font-size:11px; font-weight:700; color:var(--vscode-errorForeground); background:var(--vscode-inputValidation-errorBackground); border:1px solid var(--vscode-inputValidation-errorBorder); padding:8px; margin-bottom:8px; border-radius:4px;">APPLY WILL MUTATE DISK · RECORDED · IRREVERSIBLE</div>
      <div style="font-weight:600; font-size:11px; margin-bottom:4px;">Review (full diff)</div>
      <pre id="patchDiffContent" style="font-size:10px; white-space:pre-wrap; word-break:break-all; margin:0; max-height:280px; overflow:auto;"></pre>
      <div style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap;">
        <span id="patchAcceptRejectRow"></span>
        <span style="border-left:1px solid var(--vscode-input-border); padding-left:8px;" id="patchApplyRow"></span>
      </div>
      <button type="button" id="patchDiffClose" class="icon-btn" style="margin-top:8px;">Close</button>
    </div>
  </div>

  <!-- WORKFLOW RAIL (v3 authoritative) -->
  <div style="margin-top:10px; border:1px solid var(--vscode-input-border); border-radius:12px; padding:10px; background:var(--vscode-input-background);">
    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
      <div style="font-weight:700; font-size:11px;">WORKFLOW</div>
      <div id="wfState" style="font-size:11px; font-weight:700; opacity:.85;">STATE: —</div>
    </div>
    <div id="wfPrompt" style="margin-top:6px; font-size:11px; white-space:pre-wrap; opacity:.9;"></div>
    <div style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap;">
      <button type="button" class="icon-btn" id="wfNew">New</button>
      <button type="button" class="icon-btn" id="wfFreeze">Freeze context</button>
      <button type="button" class="icon-btn" id="wfPlans">Generate plans</button>
      <button type="button" class="icon-btn" id="wfPatch">Generate patch</button>
      <button type="button" class="icon-btn" id="wfArm">Arm apply</button>
      <button type="button" class="icon-btn" id="wfApply">Confirm apply</button>
      <button type="button" class="icon-btn" id="wfRun">Run verify</button>
      <button type="button" class="icon-btn" id="wfDone">Acknowledge result</button>
      <button type="button" class="icon-btn" id="wfReset">Reset</button>
    </div>
    <div id="wfPlansList" style="margin-top:10px; font-size:11px;"></div>
    <div id="wfPatchInfo" style="margin-top:10px; font-size:11px; white-space:pre-wrap;"></div>
    <div id="wfReview" style="margin-top:10px; font-size:11px;"></div>
    <div id="wfResult" style="margin-top:10px; font-size:11px; white-space:pre-wrap;"></div>
  </div>

  <div class="mode-selector" id="modeSelector" style="margin-top:10px;">
    <button type="button" data-mode="auto">Planner (suggest only)</button>
    <button type="button" data-mode="managed">Managed</button>
    <button type="button" data-mode="external">External</button>
  </div>

  <div class="transcript-wrap">
    <div class="transcript" id="transcript"></div>
    <button id="clearTranscript" class="clear-btn">Clear</button>
  </div>

  <div class="composer">
    <textarea id="composerInput" placeholder="Chat cannot act. Use Check/Verify or propose patch." rows="3"></textarea>
    <div class="composer-footer">
      <div class="composer-left">
        <button type="button" id="composerAttach" class="icon-btn" title="Attach">∞</button>
        <button type="button" id="composerMode" class="icon-btn mode-pill" title="Mode">
          <span id="composerModeLabel">Planner</span><span>▾</span>
        </button>
      </div>
      <button type="button" id="composerMic" class="icon-btn" title="Voice">🎙</button>
    </div>
  </div>

  <div class="context-line">
    <span class="pill" id="contextLabel">Local</span><span>▾</span>
  </div>

  <div id="jobState" style="font-size:10px; margin:4px 0; color:var(--vscode-descriptionForeground);">Job state: —</div>
  <div class="actions">
    <button data-action="check">Check</button>
    <button data-action="fix">Generate patch (no apply)</button>
    <button data-action="verify">Verify</button>
    <button data-action="deploy">Deploy</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    vscode.postMessage({ type: 'log', payload: 'ui_session=' + ${JSON.stringify(uiSession)} });

    let lastSeq = 0;
    function sendWire(x) { vscode.postMessage(x); }
    function intent(kind, extra) {
      const id = 'i_' + Math.random().toString(16).slice(2) + '_' + Date.now().toString(16);
      sendWire({ protocol: 3, type: 'intent', intent: Object.assign({ intent_id: id, kind }, extra || {}) });
    }
    sendWire({ protocol: 3, type: 'hello', ui_session: ${JSON.stringify(uiSession)}, client: 'webview' });
    sendWire({ protocol: 3, type: 'ready', ui_session: ${JSON.stringify(uiSession)}, last_seq: lastSeq });

    const engineLineEl = document.getElementById('engineLine');
    const engineStateEl = document.getElementById('engineState');
    const transcriptEl = document.getElementById('transcript');
    const modeSelectorEl = document.getElementById('modeSelector');
    const composerInput = document.getElementById('composerInput');
    const composerModeLabel = document.getElementById('composerModeLabel');
    const actionBtns = document.querySelectorAll('.actions button');
    const controllerBannerEl = document.getElementById('controllerBanner');
    const managedFailureBannerEl = document.getElementById('managedFailureBanner');

    let connected = false;
    let currentMode = 'auto';
    let controllerMode = false;
    let jobProtocolOk = true;
    let activeJob = null;

    const wfStateEl = document.getElementById('wfState');
    const wfPromptEl = document.getElementById('wfPrompt');
    const wfPlansListEl = document.getElementById('wfPlansList');
    const wfPatchInfoEl = document.getElementById('wfPatchInfo');
    const wfReviewEl = document.getElementById('wfReview');
    const wfResultEl = document.getElementById('wfResult');
    let snapshot = null;

    function setBtn(id, enabled) {
      const b = document.getElementById(id);
      if (b) b.disabled = !enabled;
    }

    function renderSnapshot(s) {
      snapshot = s;
      if (wfStateEl) wfStateEl.textContent = 'STATE: ' + (s.state || '—');
      if (wfPromptEl) wfPromptEl.textContent = s.prompt ? ('Prompt: ' + s.prompt) : 'Prompt: —';
      if (wfPlansListEl) {
        if (!s.plans || s.plans.length === 0) {
          wfPlansListEl.innerHTML = '<div style="opacity:.7;">Plans: —</div>';
        } else {
          wfPlansListEl.innerHTML = '<div style="font-weight:700; margin-bottom:6px;">Plans</div>' +
            s.plans.map(p => {
              const active = s.selected_plan_id === p.plan_id;
              const btn = '<button type="button" class="icon-btn" data-plan="' + p.plan_id + '">' + (active ? 'Selected' : 'Select') + '</button>';
              return '<div style="border:1px solid var(--vscode-input-border); border-radius:8px; padding:8px; margin:6px 0;">' +
                '<div style="display:flex; justify-content:space-between; gap:8px; align-items:center;">' +
                '<div style="font-weight:700;">' + p.plan_id.slice(0,8) + '</div>' + btn + '</div>' +
                '<div style="margin-top:6px; white-space:pre-wrap; opacity:.9;">' + (p.text || '') + '</div></div>';
            }).join('');
          wfPlansListEl.querySelectorAll('button[data-plan]').forEach(b => {
            b.addEventListener('click', () => intent('plan.select', { plan_id: b.dataset.plan }));
          });
        }
      }
      if (wfPatchInfoEl) {
        if (!s.patch) wfPatchInfoEl.textContent = 'Patch: —';
        else wfPatchInfoEl.textContent = 'Patch: ' + s.patch.patch_id + '\\nStatus: ' + s.patch.status + '\\nSummary: ' + (s.patch.summary || '');
      }
      if (wfReviewEl) {
        if (s.state === 'REVIEW_REQUIRED' || s.state === 'APPLY_ARMED') {
          const approved = !!(s.review && s.review.approved);
          wfReviewEl.innerHTML = '<div style="font-weight:700; margin-bottom:6px;">Review</div>' +
            '<label style="display:flex; gap:8px; align-items:center;">' +
            '<input type="checkbox" id="wfApprove" ' + (approved ? 'checked' : '') + ' />' +
            '<span>Approved (required before apply)</span></label>' +
            '<div style="margin-top:6px; opacity:.8;">Risk:</div>' +
            '<select id="wfRisk" class="icon-btn"><option value="low">low</option><option value="med">med</option><option value="high">high</option></select>' +
            '<div style="margin-top:6px; opacity:.8;">Rollback plan:</div>' +
            '<textarea id="wfRollback" style="width:100%; min-height:50px; border:1px solid var(--vscode-input-border); border-radius:8px; background:transparent; color:var(--vscode-foreground); padding:8px;"></textarea>' +
            '<div style="margin-top:6px; opacity:.8;">Verification plan (one per line):</div>' +
            '<textarea id="wfVerifyPlan" style="width:100%; min-height:50px; border:1px solid var(--vscode-input-border); border-radius:8px; background:transparent; color:var(--vscode-foreground); padding:8px;"></textarea>' +
            '<div style="margin-top:8px;"><button type="button" class="icon-btn" id="wfReviewSubmit">Submit review</button></div>';
          const riskEl = document.getElementById('wfRisk');
          if (riskEl && s.review && s.review.risk) riskEl.value = s.review.risk;
          const rb = document.getElementById('wfRollback');
          if (rb && s.review && s.review.rollback_plan) rb.value = s.review.rollback_plan;
          const vp = document.getElementById('wfVerifyPlan');
          if (vp && s.review && Array.isArray(s.review.verification_plan)) vp.value = s.review.verification_plan.join('\\n');
          const sub = document.getElementById('wfReviewSubmit');
          if (sub) sub.addEventListener('click', () => {
            const approvedNow = !!document.getElementById('wfApprove').checked;
            const risk = document.getElementById('wfRisk').value || 'med';
            const rollback_plan = (document.getElementById('wfRollback').value || '').trim();
            const verification_plan = (document.getElementById('wfVerifyPlan').value || '').split(/\\r?\\n/).map(x => x.trim()).filter(Boolean);
            intent('patch.review_complete', { review: { risk, blast_radius: [], rollback_plan, verification_plan, approved: approvedNow } });
          });
        } else { wfReviewEl.innerHTML = ''; }
      }
      if (wfResultEl) {
        if (s.state === 'RESULT_READY' && s.result) {
          wfResultEl.textContent = 'Result: ' + (s.result.summary || '') + '\\nRegression: ' + s.result.regression;
        } else { wfResultEl.textContent = ''; }
      }
      setBtn('wfNew', true);
      setBtn('wfFreeze', s.state === 'INTAKE' || s.state === 'PLAN_DRAFT' || s.state === 'PLAN_SELECTED');
      setBtn('wfPlans', s.state === 'PLAN_DRAFT' || s.state === 'PLAN_SELECTED');
      setBtn('wfPatch', s.state === 'PLAN_SELECTED' || s.state === 'PLAN_DRAFT');
      setBtn('wfArm', (s.state === 'REVIEW_REQUIRED' || s.state === 'APPLY_ARMED') && !!(s.review && s.review.approved));
      setBtn('wfApply', s.state === 'APPLY_ARMED' && !!(s.armed && s.armed.consent_token));
      setBtn('wfRun', s.state === 'APPLIED' || s.state === 'PLAN_SELECTED');
      setBtn('wfDone', s.state === 'RESULT_READY');
      setBtn('wfReset', true);
    }

    document.getElementById('wfNew').addEventListener('click', () => {
      const p = prompt('Prompt (workflow.new):') || '';
      if (!p.trim()) return;
      intent('workflow.new', { prompt: p.trim(), cwd: '' });
    });
    document.getElementById('wfFreeze').addEventListener('click', () => intent('workflow.freeze_context'));
    document.getElementById('wfPlans').addEventListener('click', () => intent('plan.generate', { n: 3 }));
    document.getElementById('wfPatch').addEventListener('click', () => intent('patch.generate'));
    document.getElementById('wfArm').addEventListener('click', () => intent('apply.arm'));
    document.getElementById('wfApply').addEventListener('click', () => {
      if (!snapshot || !snapshot.armed || !snapshot.armed.consent_token) return;
      const typed = prompt('TYPE APPLY to confirm disk mutation:') || '';
      if (typed.trim() !== 'APPLY') return;
      intent('apply.confirm', { consent_token: snapshot.armed.consent_token });
    });
    document.getElementById('wfRun').addEventListener('click', () => intent('run.request', { kind_run: 'verify' }));
    document.getElementById('wfDone').addEventListener('click', () => intent('result.ack'));
    document.getElementById('wfReset').addEventListener('click', () => intent('workflow.reset'));

    function jobLine(s) {
      const el = document.createElement('div');
      el.className = 'transcript-entry system';
      el.textContent = 'System: ' + s;
      transcriptEl.appendChild(el);
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
    }

    function applyActionEnablement() {
      actionBtns.forEach(b => {
        const a = b.dataset.action;
        if (!jobProtocolOk || !connected) { b.disabled = true; return; }
        if (a === 'deploy') { b.disabled = (currentMode !== 'managed'); return; }
        b.disabled = false;
      });
    }

    function setConnected(c) {
      connected = c;
      composerInput.disabled = !c;
      updateComposerPlaceholder();
      applyActionEnablement();
    }

    function updateComposerPlaceholder() {
      if (!jobProtocolOk) {
        composerInput.placeholder = 'Controller disabled. Fix protocol or agent; see banner.';
        return;
      }
      if (controllerMode) {
        composerInput.placeholder = 'Chat cannot act. Use Check/Verify or propose patch.';
        return;
      }
      composerInput.placeholder = 'Chat cannot act. Use Check/Verify or propose patch.';
    }

    function setModeActive(mode) {
      currentMode = mode;
      modeSelectorEl.querySelectorAll('button').forEach(b => {
        b.classList.toggle('active', b.dataset.mode === mode);
      });
      composerModeLabel.textContent = mode === 'auto' ? 'Planner' : mode === 'managed' ? 'Managed' : 'External';
      applyActionEnablement();
    }

    modeSelectorEl.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        vscode.postMessage({ type: 'setMode', payload: { mode } });
      });
    });

    function formatDetail(m) {
      const parts = [];
      if (m.mode) parts.push('Mode: ' + (m.mode.charAt(0).toUpperCase() + m.mode.slice(1)));
      if (m.ownership) parts.push('Ownership: ' + (m.ownership === 'unknown' ? 'Unknown' : m.ownership.charAt(0).toUpperCase() + m.ownership.slice(1)));
      if (m.baseUrl && (m.status === 'connected' || m.status === 'failed')) parts.push('Endpoint: ' + m.baseUrl);
      if (m.version) parts.push('v' + m.version);
      if (m.error) parts.push(m.error);
      return parts.join(' · ');
    }

    function setTranscript(entries) {
      transcriptEl.innerHTML = '';
      (entries || []).forEach(entry => {
        const wrap = document.createElement('div');
        const el = document.createElement('div');
        el.className = 'transcript-entry ' + entry.role;
        const prefix = entry.role === 'user' ? 'You: ' : entry.role === 'assistant' ? 'Adjutorix: ' : 'System: ';
        el.textContent = prefix + entry.text;
        wrap.appendChild(el);
        if (entry.meta && entry.meta.intent === 'propose_job' && Array.isArray(entry.meta.commands) && entry.meta.commands.length) {
          const row = document.createElement('div');
          row.style.marginTop = '4px';
          entry.meta.commands.forEach(cmd => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'icon-btn';
            b.textContent = cmd;
            b.addEventListener('click', () => vscode.postMessage({ type: 'action', payload: { action: cmd } }));
            row.appendChild(b);
          });
          wrap.appendChild(row);
        }
        transcriptEl.appendChild(wrap);
      });
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
    }

    function setIndicators(engineGreen, chatGreen) {
      document.getElementById('indicatorSystem').classList.toggle('green', true);
      document.getElementById('indicatorEngine').classList.toggle('green', engineGreen);
      document.getElementById('indicatorChat').classList.toggle('green', chatGreen);
    }

    window.addEventListener('message', e => {
      const m = e.data;
      if (m && m.protocol === 3 && m.type === 'event') {
        if (typeof m.seq === 'number') {
          if (m.seq > lastSeq) lastSeq = m.seq;
          sendWire({ protocol: 3, type: 'ack', ack_seq: lastSeq });
        }
        const p = m.payload || {};
        if (p.kind === 'snapshot' && p.snapshot) renderSnapshot(p.snapshot);
        if (p.kind === 'toast') vscode.postMessage({ type: 'log', payload: '[toast] ' + p.level + ': ' + p.text });
        if (p.kind === 'log') vscode.postMessage({ type: 'log', payload: '[wirelog] ' + p.scope + ': ' + p.text });
        return;
      }
      if (m.type === 'job') {
        const jobStateEl = document.getElementById('jobState');
        if (m.phase === 'started') {
          activeJob = { jobId: m.jobId, action: m.action };
          if (jobStateEl) jobStateEl.textContent = 'Job ' + (m.jobId || '').slice(0, 8) + ': RUNNING';
          jobLine('[' + m.action + '] started (job ' + m.jobId + ')');
          return;
        }
        if (m.phase === 'events') {
          const events = Array.isArray(m.events) ? m.events : [];
          for (const ev of events) {
            const t = ev && typeof ev === 'object' ? (ev.type || 'event') : 'event';
            const p = ev && typeof ev === 'object' ? ev.payload : undefined;
            const msg = p && typeof p === 'object' && typeof p.text === 'string' ? p.text :
              p && typeof p === 'object' && typeof p.message === 'string' ? p.message :
              p && typeof p === 'string' ? p : p != null ? JSON.stringify(p) : '';
            jobLine('[' + m.action + '] ' + t + (msg ? ' · ' + msg : ''));
          }
          return;
        }
        if (m.phase === 'finished') {
          const st = (m.status || 'failed').toUpperCase();
          if (jobStateEl) jobStateEl.textContent = 'Job ' + (m.jobId || '').slice(0, 8) + ': ' + st;
          const err = m.error ? (' · ' + m.error) : '';
          jobLine('[' + m.action + '] ' + st.toLowerCase() + ' (job ' + m.jobId + ')' + err);
          activeJob = null;
          setTimeout(function() {
            const js = document.getElementById('jobState');
            if (js) js.textContent = 'Job state: —';
          }, 2000);
          return;
        }
        return;
      }
      if (m.type === 'authority' && m.payload) {
        const a = m.payload;
        const w = a.writes_allowed === true ? '✅' : '❌';
        const wNote = a.writes_note || (a.writes_allowed ? 'yes' : 'patch-only');
        const acts = Array.isArray(a.actions_allowed) ? a.actions_allowed.join(', ') : '—';
        const sand = a.sandbox_enforced === true ? '✅ enforced' : a.sandbox_enforced === false ? '❌ off' : '—';
        const led = a.ledger_state || '—';
        const pp = typeof a.pending_patches === 'number' ? String(a.pending_patches) : '—';
        const pj = typeof a.pending_jobs === 'number' ? String(a.pending_jobs) : '—';
        const el = document.getElementById('authorityPanel');
        if (el) el.textContent = 'ENGINE AUTHORITY\n────────────────────────\nWrites allowed: ' + w + ' (' + wNote + ')\nActions allowed: ' + acts + '\nSandbox: ' + sand + '\nLedger state: ' + led + '\nPending patches: ' + pp + '\nPending jobs: ' + pj;
        if (engineStateEl) {
          const running = activeJob != null;
          const pending = typeof a.pending_jobs === 'number' ? a.pending_jobs : 0;
          engineStateEl.textContent = running ? 'Engine state: running' : (pending > 0 ? 'Engine state: ' + pending + ' pending' : 'Engine state: idle');
        }
      }
      if (m.type === 'status') {
        vscode.postMessage({ type: 'log', payload: 'status_received=' + JSON.stringify({ status: m.status, state: m.state, mode: m.mode, ownership: m.ownership }) });
        const s = m.status;
        const mode = m.mode || currentMode;
        const ownership = m.ownership || 'unknown';
        if (engineLineEl) {
          if (s !== 'connected') {
            engineLineEl.textContent = s === 'starting' ? 'ENGINE: Managed (starting…)' : s === 'stopping' ? 'ENGINE: Managed (stopping…)' : s === 'failed' ? 'ENGINE: Disconnected (FAILED — use Retry)' : 'ENGINE: Disconnected';
          } else {
            engineLineEl.textContent = (mode === 'managed' && ownership === 'managed') ? 'ENGINE: Managed (extension-owned)' : mode === 'external' ? 'ENGINE: External (read-only / advisory)' : 'ENGINE: External (read-only / advisory)';
          }
          engineLineEl.className = 'status ' + (s === 'connected' ? 'connected' : s === 'failed' ? 'failed' : s === 'starting' || s === 'stopping' ? 'starting' : 'disconnected');
        }
        setConnected(s === 'connected');
        setIndicators(s === 'connected', s === 'connected');
        if (m.mode) setModeActive(m.mode);
        if (engineStateEl && s !== 'connected') engineStateEl.textContent = s === 'failed' ? 'Engine state: FAILED — click Retry' : (m.mode === 'managed' && m.state === 'stopped') ? 'Engine state: click Retry to start agent' : s === 'starting' || s === 'stopping' ? 'Engine state: …' : 'Engine state: —';
        const retryEl = document.getElementById('engineRetry');
        const showRetry = s === 'failed' || (m.mode === 'managed' && m.state === 'stopped' && !m.warning);
        if (retryEl) retryEl.style.display = showRetry ? 'inline-block' : 'none';
        controllerMode = (m.version === 'reject_only_v2');
        if (controllerBannerEl) {
          if (controllerMode) {
            controllerBannerEl.textContent = 'Chat cannot act. Use Check/Verify or propose patch.';
            controllerBannerEl.style.display = 'block';
          } else {
            controllerBannerEl.style.display = 'none';
          }
        }
        if (managedFailureBannerEl) {
          const showManagedWarning =
            m.mode === 'managed' &&
            m.state === 'connected' &&
            m.ownership === 'external';
          if (showManagedWarning) {
            managedFailureBannerEl.textContent = 
              'Managed mode policy: external agent detected. Switch to External/Auto or Retry to take over.';
            managedFailureBannerEl.style.display = 'block';
          } else {
            managedFailureBannerEl.style.display = 'none';
          }
        }
        updateComposerPlaceholder();
      } else if (m.type === 'capabilities') {
        jobProtocolOk = m.jobProtocolOk === true;
        if (controllerBannerEl) {
          if (!jobProtocolOk && m.mismatchMessage) {
            controllerBannerEl.textContent = 'Controller disabled: ' + m.mismatchMessage;
            controllerBannerEl.style.display = 'block';
          } else if (controllerMode) {
            controllerBannerEl.textContent = 'Chat cannot act. Use Check/Verify or propose patch.';
            controllerBannerEl.style.display = 'block';
          } else if (!jobProtocolOk) {
            controllerBannerEl.textContent = 'Controller disabled: protocol or job.run not available.';
            controllerBannerEl.style.display = 'block';
          } else {
            controllerBannerEl.style.display = 'none';
          }
        }
        updateComposerPlaceholder();
        applyActionEnablement();
      } else if (m.type === 'transcript') {
        setTranscript(m.payload || []);
      }
    });

    // Send chat on Enter; only requires connected (chat works even when job.run / controller is missing)
    composerInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const msg = composerInput.value.trim();
        if (!msg || !connected) return;
        composerInput.value = '';
        vscode.postMessage({ type: 'chat', payload: { message: msg } });
      }
    });

    // Actions (Managed mode only); deploy requires confirm
    document.querySelectorAll('.actions button').forEach(b => {
      b.addEventListener('click', () => {
        if (b.disabled) return;
        const action = b.dataset.action || 'check';
        if (action === 'deploy') {
          const ok = confirm('Deploy is blocked by default. Proceed?');
          if (!ok) return;
          vscode.postMessage({ type: 'action', payload: { action: 'deploy', confirm: true } });
          return;
        }
        vscode.postMessage({ type: 'action', payload: { action, confirm: false } });
      });
    });

    document.getElementById('composerAttach').addEventListener('click', () => {});
    document.getElementById('composerMic').addEventListener('click', () => {});
    document.getElementById('composerMode').addEventListener('click', () => {});

    document.getElementById('clearTranscript').addEventListener('click', () => {
      vscode.postMessage({ type: 'clearTranscript' });
    });

    vscode.postMessage({ type: 'ready' });
    vscode.postMessage({ type: 'patchList' });
    document.getElementById('refreshPatches').addEventListener('click', () => { vscode.postMessage({ type: 'patchList' }); });
    document.getElementById('engineRetry').addEventListener('click', () => { vscode.postMessage({ type: 'retry' }); });

    function renderPatches(patches, err) {
      const el = document.getElementById('patchList');
      if (err) { el.innerHTML = '<div style="color:var(--vscode-errorForeground);">' + err + '</div>'; return; }
      if (!patches || patches.length === 0) { el.innerHTML = '<div class="description">No patches.</div>'; return; }
      el.innerHTML = patches.map(p => {
        const id = p.patch_id || '';
        const summary = (p.summary || '').slice(0, 60);
        const status = p.status || '?';
        let btns = '<button type="button" class="icon-btn patch-review" data-patch-id="' + id + '">Review</button>';
        if (status === 'proposed') btns += '<button type="button" class="icon-btn patch-accept" data-patch-id="' + id + '">Accept</button><button type="button" class="icon-btn patch-reject" data-patch-id="' + id + '">Reject</button>';
        else if (status === 'accepted') btns += '<button type="button" class="icon-btn patch-apply" data-patch-id="' + id + '">Apply</button>';
        return '<div class="patch-item" style="margin:4px 0; padding:4px; border:1px solid var(--vscode-input-border); border-radius:4px;">' +
          '<span>' + (id ? id.slice(0,8) : '?') + '</span> ' + status + ' · ' + summary + ' ' + btns + '</div>';
      }).join('');
      el.querySelectorAll('.patch-review').forEach(b => b.addEventListener('click', () => { vscode.postMessage({ type: 'patchGet', payload: { patch_id: b.dataset.patchId } }); }));
      el.querySelectorAll('.patch-accept').forEach(b => b.addEventListener('click', () => { vscode.postMessage({ type: 'patchAccept', payload: { patch_id: b.dataset.patchId } }); }));
      el.querySelectorAll('.patch-reject').forEach(b => b.addEventListener('click', () => { vscode.postMessage({ type: 'patchReject', payload: { patch_id: b.dataset.patchId } }); }));
      el.querySelectorAll('.patch-apply').forEach(b => b.addEventListener('click', () => {
        if (!confirm('This WILL change disk. Apply is irreversible. Proceed?')) return;
        vscode.postMessage({ type: 'patchApply', payload: { patch_id: b.dataset.patchId } });
      }));
    }

    document.getElementById('patchDiffClose').addEventListener('click', () => {
      document.getElementById('patchDiffView').style.display = 'none';
    });

    function b64ToUtf8(b64) {
      try {
        const bin = atob(b64 || '');
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch (e) { return null; }
    }
    function simpleUnifiedDiff(path, oldStr, newStr) {
      const ol = (oldStr || '').split(/\\r?\\n/);
      const nl = (newStr || '').split(/\\r?\\n/);
      let i = 0;
      while (i < ol.length && i < nl.length && ol[i] === nl[i]) i++;
      let jo = ol.length, jn = nl.length;
      while (jo > i && jn > i && ol[jo - 1] === nl[jn - 1]) { jo--; jn--; }
      let out = '--- a/' + path + '\\n+++ b/' + path + '\\n';
      for (let k = 0; k < i; k++) out += '  ' + ol[k] + '\\n';
      for (let k = i; k < jo; k++) out += '- ' + ol[k] + '\\n';
      for (let k = i; k < jn; k++) out += '+ ' + nl[k] + '\\n';
      for (let k = jn; k < nl.length; k++) out += '  ' + nl[k] + '\\n';
      return out;
    }
    function renderDiff(payload) {
      const view = document.getElementById('patchDiffView');
      const pre = document.getElementById('patchDiffContent');
      if (payload.error) {
        pre.textContent = 'Error: ' + payload.error;
      } else if (payload.patch_format === 'file_ops' && Array.isArray(payload.review_ops) && payload.review_ops.length > 0) {
        const parts = [payload.summary ? payload.summary + '\n\n' : ''];
        for (const ro of payload.review_ops) {
          const path = ro.path || '?';
          parts.push('=== ' + ro.op + ' ' + path + ' ===');
          if (ro.base_mismatch) {
            parts.push('[base mismatch; diff unreliable]');
            continue;
          }
          if (ro.op === 'write') {
            const newStr = b64ToUtf8(ro.new_content_b64);
            const baseStr = b64ToUtf8(ro.base_content_b64 || '');
            if (newStr === null || (ro.base_content_b64 && baseStr === null)) {
              parts.push('[binary changed]');
            } else if (!ro.base_content_b64 || ro.base_content_b64.length === 0) {
              parts.push('+ new file');
              parts.push((newStr || '').slice(0, 2000) + (newStr && newStr.length > 2000 ? '...' : ''));
            } else {
              parts.push(simpleUnifiedDiff(path, baseStr, newStr));
            }
          } else if (ro.op === 'delete') {
            parts.push('file deleted');
            const baseStr = b64ToUtf8(ro.base_content_b64 || '');
            if (baseStr !== null && baseStr.length > 0)
              parts.push((baseStr || '').slice(0, 800) + (baseStr.length > 800 ? '...' : ''));
          }
          parts.push('');
        }
        pre.textContent = parts.join('\n');
      } else if (payload.patch_format === 'file_ops') {
        try {
          const ops = JSON.parse(payload.patch_text || '[]');
          const lines = (ops || []).map((o, i) => {
            const path = o.path || o.from || '?';
            const op = o.op || '?';
            let extra = '';
            if (o.new_content_b64) extra = ' (+' + (o.new_content_b64.length) + ' b64)';
            if (o.base_sha) extra += ' base=' + (o.base_sha === '0'.repeat(64) ? 'empty' : String(o.base_sha).slice(0,8));
            return (i+1) + '. ' + op + ' ' + path + extra;
          });
          pre.textContent = (payload.summary ? payload.summary + '\n\n' : '') + lines.join('\n');
        } catch (e) {
          pre.textContent = payload.patch_text ? payload.patch_text.slice(0, 2000) : 'No content';
        }
      } else {
        pre.textContent = (payload.summary ? payload.summary + '\n\n' : '') + (payload.patch_text || '');
      }
      view.style.display = 'block';
      const pid = payload.patch_id || '';
      const banner = document.getElementById('patchApplyBanner');
      const acceptRejectRow = document.getElementById('patchAcceptRejectRow');
      const applyRow = document.getElementById('patchApplyRow');
      if (banner) banner.style.display = (payload.status === 'accepted' ? 'block' : 'none');
      if (acceptRejectRow) {
        if (payload.status === 'proposed') {
          acceptRejectRow.innerHTML = '<button type="button" class="icon-btn patch-accept-in-modal" data-patch-id="' + pid + '">Accept</button> <button type="button" class="icon-btn patch-reject-in-modal" data-patch-id="' + pid + '">Reject</button>';
          acceptRejectRow.querySelectorAll('.patch-accept-in-modal').forEach(b => b.addEventListener('click', () => { vscode.postMessage({ type: 'patchAccept', payload: { patch_id: b.dataset.patchId } }); }));
          acceptRejectRow.querySelectorAll('.patch-reject-in-modal').forEach(b => b.addEventListener('click', () => { vscode.postMessage({ type: 'patchReject', payload: { patch_id: b.dataset.patchId } }); }));
        } else { acceptRejectRow.innerHTML = ''; }
      }
      if (applyRow) {
        if (payload.status === 'accepted') {
          applyRow.innerHTML = '<button type="button" class="icon-btn patch-apply-in-modal" data-patch-id="' + pid + '">Apply</button>';
          applyRow.querySelectorAll('.patch-apply-in-modal').forEach(b => b.addEventListener('click', () => {
            if (!confirm('This WILL change disk. Apply is irreversible. Proceed?')) return;
            vscode.postMessage({ type: 'patchApply', payload: { patch_id: b.dataset.patchId } });
          }));
        } else { applyRow.innerHTML = ''; }
      }
    }

    window.addEventListener('message', e => {
      const m = e.data;
      if (m.type === 'patchListResult') {
        renderPatches(m.patches, m.error);
        return;
      }
      if (m.type === 'patchGetResult') {
        renderDiff(m);
        return;
      }
      if (m.type === 'patchActionResult' && m.error) {
        const el = document.getElementById('patchList');
        const prev = el.innerHTML;
        el.innerHTML = '<div style="color:var(--vscode-errorForeground); margin-bottom:6px;">' + m.action + ': ' + m.error + '</div>' + prev;
      }
    });
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
