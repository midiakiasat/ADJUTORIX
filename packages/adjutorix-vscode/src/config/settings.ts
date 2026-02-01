/**
 * Extension settings manager.
 * Maps VS Code configuration to strongly-typed values.
 */

import * as vscode from "vscode";

export type AgentModeSetting = "auto" | "managed" | "external";

export interface AdjutorixSettings {
  agentHost: string;
  agentPort: number;
  /** Override: full base URL (e.g. http://127.0.0.1:7338). If set, agentHost/agentPort are ignored for endpoint. */
  agentUrl?: string;
  /** How the extension should run the agent: auto (try managed, allow external), managed (spawn/kill only), external (health-check only). */
  agentMode: AgentModeSetting;
  /** When true, opening the sidebar starts the agent (or reconnects). */
  autoStartAgent: boolean;
  autoRunCheckOnSave: boolean;
  enableDiagnostics: boolean;
  maxContextFiles: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

const SECTION = "adjutorix";

export class Settings {
  /* -------------------------
   * Public API
   * ------------------------- */

  static get(): AdjutorixSettings {
    const config = vscode.workspace.getConfiguration(SECTION);

    return {
      agentHost: config.get<string>("agentHost", "127.0.0.1"),
      agentPort: config.get<number>("agentPort", 7337),
      agentUrl: config.get<string>("agentUrl") ?? undefined,
      agentMode: config.get<AdjutorixSettings["agentMode"]>("agentMode", "auto"),
      autoStartAgent: config.get<boolean>("autoStartAgent", true),
      autoRunCheckOnSave: config.get<boolean>(
        "autoRunCheckOnSave",
        false
      ),
      enableDiagnostics: config.get<boolean>(
        "enableDiagnostics",
        true
      ),
      maxContextFiles: config.get<number>(
        "maxContextFiles",
        8
      ),
      logLevel: config.get<AdjutorixSettings["logLevel"]>(
        "logLevel",
        "info"
      ),
    };
  }

  static async set<K extends keyof AdjutorixSettings>(
    key: K,
    value: AdjutorixSettings[K],
    target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Workspace
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration(SECTION);

    await config.update(key, value, target);
  }

  static onDidChange(
    handler: (settings: AdjutorixSettings) => void
  ): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(SECTION)) {
        handler(this.get());
      }
    });
  }

  /* -------------------------
   * Utilities
   * ------------------------- */

  static getAgentEndpoint(): string {
    const s = this.get();
    const raw = s.agentUrl?.trim();
    if (raw) {
      let u = raw.replace(/\/+$/, "");
      if (u.endsWith("/rpc")) u = u.slice(0, -4);
      return u || `http://127.0.0.1:7337`;
    }
    return `http://${s.agentHost}:${s.agentPort}`;
  }

  static isDebug(): boolean {
    return this.get().logLevel === "debug";
  }
}
