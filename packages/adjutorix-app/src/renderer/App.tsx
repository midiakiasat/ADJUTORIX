import React, { useEffect, useMemo, useReducer } from "react";

type PanelKey =
  | "workspace"
  | "editor"
  | "diagnostics"
  | "ledger"
  | "verify"
  | "terminal"
  | "governance"
  | "activity";

interface WorkspaceFile {
  readonly path: string;
  readonly status: "clean" | "modified" | "governed" | "generated";
  readonly language: string;
}

interface TimelineEntry {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly state: "ready" | "running" | "blocked" | "complete";
}

interface AppState {
  readonly activePanel: PanelKey;
  readonly commandPaletteOpen: boolean;
  readonly providerOnline: boolean;
  readonly selectedFile: string;
  readonly files: readonly WorkspaceFile[];
  readonly timeline: readonly TimelineEntry[];
  readonly notifications: readonly string[];
}

type AppAction =
  | { readonly type: "set-panel"; readonly panel: PanelKey }
  | { readonly type: "toggle-command-palette" }
  | { readonly type: "select-file"; readonly path: string }
  | { readonly type: "toggle-provider" }
  | { readonly type: "push-notification"; readonly message: string }
  | { readonly type: "dismiss-notification"; readonly index: number };

const INITIAL_FILES: readonly WorkspaceFile[] = [
  { path: "packages/adjutorix-agent/adjutorix_agent/core/state_machine.py", status: "modified", language: "python" },
  { path: "packages/shared/src/rpc/protocol.ts", status: "clean", language: "typescript" },
  { path: "packages/adjutorix-app/src/main/ipc/verify_ipc.ts", status: "governed", language: "typescript" },
  { path: "configs/policy/verify_policy.yaml", status: "generated", language: "yaml" }
];

const INITIAL_TIMELINE: readonly TimelineEntry[] = [
  {
    id: "workspace-scan",
    title: "Workspace scan",
    detail: "Index and trust boundary synchronized with the active repository root.",
    state: "complete"
  },
  {
    id: "governance-audit",
    title: "Governance audit",
    detail: "Governed surfaces and deny reasons resolved before mutation surfaces open.",
    state: "running"
  },
  {
    id: "patch-review",
    title: "Patch review",
    detail: "Patch artifact normalization and rollback plan inspection pending final operator action.",
    state: "ready"
  },
  {
    id: "verify",
    title: "Verification",
    detail: "Verify pipeline blocked until patch basis and snapshot head match the active transaction.",
    state: "blocked"
  }
];

const INITIAL_STATE: AppState = {
  activePanel: "workspace",
  commandPaletteOpen: false,
  providerOnline: true,
  selectedFile: INITIAL_FILES[0]?.path ?? "",
  files: INITIAL_FILES,
  timeline: INITIAL_TIMELINE,
  notifications: [
    "Repository connected to governed execution surface.",
    "Verification gate is armed for mutation-capable workflows."
  ]
};

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "set-panel":
      return { ...state, activePanel: action.panel };
    case "toggle-command-palette":
      return { ...state, commandPaletteOpen: !state.commandPaletteOpen };
    case "select-file":
      return { ...state, selectedFile: action.path, activePanel: "editor" };
    case "toggle-provider":
      return { ...state, providerOnline: !state.providerOnline };
    case "push-notification":
      return { ...state, notifications: [...state.notifications, action.message] };
    case "dismiss-notification":
      return {
        ...state,
        notifications: state.notifications.filter((_, index) => index !== action.index)
      };
    default:
      return state;
  }
}

function statusTone(status: WorkspaceFile["status"]): string {
  switch (status) {
    case "clean":
      return "Clean";
    case "modified":
      return "Modified";
    case "governed":
      return "Governed";
    case "generated":
      return "Generated";
  }
}

function timelineTone(state: TimelineEntry["state"]): string {
  switch (state) {
    case "complete":
      return "Complete";
    case "running":
      return "Running";
    case "ready":
      return "Ready";
    case "blocked":
      return "Blocked";
  }
}

function renderPanel(state: AppState): React.ReactNode {
  switch (state.activePanel) {
    case "workspace":
      return (
        <section className="app-panel">
          <h2>Workspace Command Surface</h2>
          <p>
            Active repository content is synchronized with transaction-aware navigation, governed target
            inspection, and mutation boundary visibility.
          </p>
          <ul className="app-list">
            {state.files.map((file) => (
              <li key={file.path}>
                <strong>{file.path}</strong>
                <span> — {statusTone(file.status)} — {file.language}</span>
              </li>
            ))}
          </ul>
        </section>
      );
    case "editor":
      return (
        <section className="app-panel">
          <h2>Editor Focus</h2>
          <p><strong>{state.selectedFile}</strong></p>
          <p>
            Editor session is prepared for deterministic buffer management, large-file guard enforcement,
            diagnostics correlation, and patch review adjacency.
          </p>
          <pre className="app-code">
{`// canonical focus: ${state.selectedFile}
export const editorIntent = {
  readonly: false,
  governed: true,
  verifyGate: "armed",
  transactionMode: "explicit"
};`}
          </pre>
        </section>
      );
    case "diagnostics":
      return (
        <section className="app-panel">
          <h2>Diagnostics Correlation</h2>
          <p>
            Diagnostic streams are normalized into repository-relative coordinates with problem linking,
            parser stability, and command-output trace alignment.
          </p>
          <ul className="app-list">
            <li>TypeScript compile drift: none detected in active buffer selection.</li>
            <li>Policy conflict scan: mutation surfaces remain gated.</li>
            <li>Renderer isolation audit: main-process authority boundary preserved.</li>
          </ul>
        </section>
      );
    case "ledger":
      return (
        <section className="app-panel">
          <h2>Ledger View</h2>
          <p>
            Transaction state, artifact lineage, replay edges, and state-head continuity are exposed as a
            first-class operator surface.
          </p>
          <ul className="app-list">
            {state.timeline.map((entry) => (
              <li key={entry.id}>
                <strong>{entry.title}</strong>
                <span> — {timelineTone(entry.state)} — {entry.detail}</span>
              </li>
            ))}
          </ul>
        </section>
      );
    case "verify":
      return (
        <section className="app-panel">
          <h2>Verify Gate</h2>
          <p>
            Verification remains blocked until patch basis, snapshot identity, and governed mutation intent
            satisfy the runtime policy envelope.
          </p>
          <pre className="app-code">
{`verify.summary = {
  ok: false,
  blockedBy: ["snapshot_head_mismatch", "pending_patch_review"],
  nextAction: "resolve review and rerun verify"
};`}
          </pre>
        </section>
      );
    case "terminal":
      return (
        <section className="app-panel">
          <h2>Terminal Control</h2>
          <p>
            Shell execution is constrained by command policy, environment fingerprinting, governed target
            denial rules, and explicit operator intent.
          </p>
          <pre className="app-code">
{`$ bash ./scripts/verify/run.sh
policy=allow
authority=main-process
mutation=none
verify=ready`}
          </pre>
        </section>
      );
    case "governance":
      return (
        <section className="app-panel">
          <h2>Governance Surface</h2>
          <p>
            Deny reasons, governed targets, confirmation rules, and command guards are elevated into a
            single operator-visible decision plane.
          </p>
          <ul className="app-list">
            <li>Governed targets loaded from policy surface.</li>
            <li>Secrets guard active for outbound and persisted payloads.</li>
            <li>Mutation boundary requires explicit apply confirmation.</li>
          </ul>
        </section>
      );
    case "activity":
      return (
        <section className="app-panel">
          <h2>Runtime Activity</h2>
          <p>
            Session activity is presented as a concise operational feed, prioritizing causality, transaction
            identity, and verification readiness over chat-style noise.
          </p>
          <ul className="app-list">
            {state.notifications.map((notification, index) => (
              <li key={`${notification}-${index}`}>{notification}</li>
            ))}
          </ul>
        </section>
      );
    default:
      return null;
  }
}

export default function App(): React.JSX.Element {
  const [state, dispatch] = useReducer(appReducer, INITIAL_STATE);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        dispatch({ type: "toggle-command-palette" });
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        dispatch({ type: "toggle-provider" });
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const selectedFile = useMemo(
    () => state.files.find((file) => file.path === state.selectedFile) ?? state.files[0],
    [state.files, state.selectedFile]
  );

  return (
    <div className="adjutorix-app">
      <header className="app-header">
        <div>
          <h1>ADJUTORIX</h1>
          <p>Deterministic operator workspace for governed patching, replay, verification, and authority-aware execution.</p>
        </div>
        <div className="app-header-meta">
          <button type="button" onClick={() => dispatch({ type: "toggle-command-palette" })}>
            {state.commandPaletteOpen ? "Close Command Surface" : "Open Command Surface"}
          </button>
          <button type="button" onClick={() => dispatch({ type: "toggle-provider" })}>
            Provider {state.providerOnline ? "Online" : "Offline"}
          </button>
        </div>
      </header>

      <div className="app-body">
        <aside className="app-sidebar">
          <nav className="app-nav" aria-label="Primary">
            {([
              "workspace",
              "editor",
              "diagnostics",
              "ledger",
              "verify",
              "terminal",
              "governance",
              "activity"
            ] as const).map((panel) => (
              <button
                key={panel}
                type="button"
                className={panel === state.activePanel ? "is-active" : ""}
                onClick={() => dispatch({ type: "set-panel", panel })}
              >
                {panel}
              </button>
            ))}
          </nav>

          <section className="app-sidebar-section">
            <h2>Open Files</h2>
            <ul className="app-list">
              {state.files.map((file) => (
                <li key={file.path}>
                  <button type="button" onClick={() => dispatch({ type: "select-file", path: file.path })}>
                    {file.path}
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="app-sidebar-section">
            <h2>Selected Artifact</h2>
            <p>{selectedFile?.path ?? "No file selected"}</p>
            <p>{selectedFile ? `${selectedFile.language} · ${statusTone(selectedFile.status)}` : "Unavailable"}</p>
          </section>
        </aside>

        <main className="app-main">
          {state.commandPaletteOpen ? (
            <section className="app-command-surface">
              <h2>Command Surface</h2>
              <p>Invoke auditable workflows across workspace scan, ledger replay, patch review, and verify gate operations.</p>
              <ul className="app-list">
                <li>workspace:scan</li>
                <li>ledger:replay</li>
                <li>patch:preview</li>
                <li>verify:run</li>
                <li>governance:audit</li>
              </ul>
            </section>
          ) : null}

          {renderPanel(state)}
        </main>
      </div>
    </div>
  );
}
