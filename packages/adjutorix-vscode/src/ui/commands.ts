/**
 * VS Code command bindings for Adjutorix Agent.
 */

import * as vscode from "vscode";
import { RpcClient } from "../client/rpc";
import { AgentState } from "./state";

/** Stub for panel webview message handlers; extend as needed. */
export function registerUiCommands(
  _panel: vscode.WebviewPanel,
  _state: AgentState
): void {}

export class AgentCommands {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly rpc: RpcClient,
    private readonly state: AgentState
  ) {}

  registerAll() {
    this.register("adjutorix.check", this.check.bind(this));
    this.register("adjutorix.fix", this.fix.bind(this));
    this.register("adjutorix.apply", this.apply.bind(this));
    this.register("adjutorix.verify", this.verify.bind(this));
    this.register("adjutorix.deploy", this.deploy.bind(this));
    this.register("adjutorix.stop", this.stop.bind(this));
  }

  private register(name: string, fn: () => Promise<void>) {
    const cmd = vscode.commands.registerCommand(name, fn);
    this.context.subscriptions.push(cmd);
  }

  /* -------------------------
   * Core Commands
   * ------------------------- */

  private async check() {
    await this.runJob("check", "Run verification and diagnostics");
  }

  private async fix() {
    await this.runJob("fix", "Fix failing tests / lint / type errors");
  }

  private async apply() {
    await this.runJob("apply", "Apply generated patch");
  }

  private async verify() {
    await this.runJob("verify", "Run full verification suite");
  }

  private async deploy() {
    await this.runJob("deploy", "Deploy via configured pipeline");
  }

  private async stop() {
    try {
      await this.rpc.call("job.stop", {});
      this.state.warn("Active job stopped");
    } catch (err: any) {
      this.state.error(`Stop failed: ${err?.message || err}`);
      vscode.window.showErrorMessage("Failed to stop agent job");
    }
  }

  /* -------------------------
   * Internals
   * ------------------------- */

  private async runJob(kind: string, description: string) {
    const workspace = vscode.workspace.workspaceFolders?.[0];

    if (!workspace) {
      vscode.window.showWarningMessage("No workspace opened");
      return;
    }

    const jobId = `${kind}-${Date.now()}`;

    this.state.addJob({
      id: jobId,
      status: "running",
      objective: description,
      startedAt: Date.now(),
    });

    this.state.setActiveJob(jobId);
    this.state.info(`Starting job: ${kind}`);

    try {
      await this.rpc.call("job.run", {
        id: jobId,
        kind,
        root: workspace.uri.fsPath,
      });

      this.state.updateJob(jobId, {
        status: "success",
        finishedAt: Date.now(),
      });

      this.state.info(`Job finished: ${kind}`);
      vscode.window.showInformationMessage(`Adjutorix: ${kind} completed`);
    } catch (err: any) {
      this.state.updateJob(jobId, {
        status: "error",
        finishedAt: Date.now(),
      });

      const msg = err?.message || String(err);

      this.state.error(`Job failed (${kind}): ${msg}`);
      vscode.window.showErrorMessage(`Adjutorix ${kind} failed: ${msg}`);
    }
  }
}
