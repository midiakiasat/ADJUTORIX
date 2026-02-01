# ADJUTORIX VS Code Extension

**VS Code–only.** Local AI coding agent with governance, diff control, and offline execution.

Adjutorix does **not** run in Cursor or other hosts. If installed there, it will show a single warning and refuse to activate (no commands, no view).

---

## Build and package

From the extension package directory:

```bash
cd packages/adjutorix-vscode
npm install
npm run build
npm run vsix
```

The VSIX is created as `./adjutorix-vscode-0.1.1.vsix` in that directory.

**Verify the VSIX includes the Activity Bar icon** (required for the container to show):

```bash
vsce ls
```

You must see `extension/media/icon.svg`. If it’s missing, the Activity Bar entry can fail; the `package.json` `files` array includes `media/**` for this.

If `vsce package` fails with a secret-scan error (e.g. `Expected concurrency to be an integer`), the “Files included” output is still accurate—the packaging list is correct. Retry or try a different Node/vsce version; the VSIX is only written if the full run succeeds.

---

## Install into VS Code

Use the **VS Code** CLI (not Cursor’s):

```bash
/Applications/Visual\ Studio\ Code.app/Contents/Resources/app/bin/code \
  --install-extension "$(pwd)/adjutorix-vscode-0.1.1.vsix" --force
```

Or with a quoted path (avoids space issues in some shells):

```bash
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --install-extension "$(pwd)/adjutorix-vscode-0.1.1.vsix" --force
```

Then in VS Code: **Developer: Reload Window**.

---

## Uninstall from Cursor (recommended)

If you previously installed the extension into Cursor, remove it so it doesn’t appear there:

```bash
/Applications/Cursor.app/Contents/Resources/app/bin/code \
  --uninstall-extension adjutorix.adjutorix-vscode
```

---

## Verify (VS Code only)

**Binary “done” test:**

1. **Activity Bar** shows the **ADJUTORIX** icon. Click it → sidebar shows the webview (Connected/Disconnected + Check / Fix / Verify / Deploy).
2. If the container is hidden: run **Adjutorix: Show Sidebar** from the Command Palette (View: Open View… → “Adjutorix” also works).
3. **View → Output** → **Adjutorix**: `[guard] ok host: ...`, `activate()`, and action logs when you click buttons.
4. Run **Adjutorix: Smoke Test** → “Adjutorix smoke OK” and `smoke()` in Output.
5. Agent must be running (`./tools/dev/run_agent.sh`) for status to show **Connected**; if the agent is down, the UI still renders and shows **Disconnected**.

---

## Configuration

- **adjutorix.agentHost** (default: `127.0.0.1`)
- **adjutorix.agentPort** (default: `7337`) — must match `./tools/dev/run_agent.sh`
- **adjutorix.autoStartAgent** (default: `true`)
- **adjutorix.logLevel** (default: `info`)

Token is read from `~/.adjutorix/token` (created by the agent on first run). Never logged.
