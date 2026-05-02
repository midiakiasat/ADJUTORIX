import type { ReactElement } from "react";
import { DiffEditor } from "@monaco-editor/react";

type UnknownRecord = Record<string, unknown>;
type DiffLineKind = "context" | "added" | "removed" | "modified";
type DiffDecision = "accepted" | "needs-attention" | "rejected";

export interface DiffLine extends UnknownRecord {
  id: string;
  kind: DiffLineKind;
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  highlighted?: boolean;
}

export interface DiffHunk extends UnknownRecord {
  id: string;
  header: string;
  summary?: string;
  decision?: DiffDecision | string;
  diagnosticsCount?: number;
  diagnosticsSeverity?: string;
  lines: DiffLine[];
}

export interface DiffFile extends UnknownRecord {
  id: string;
  path: string;
  oldPath?: string;
  newPath?: string;
  status: string;
  original: string;
  modified: string;
  addedLines: number;
  removedLines: number;
  diagnosticsCount: number;
  diagnosticsSeverity?: string;
  reviewStatus?: string;
  verifyStatus?: string;
  applyStatus?: string;
  healthStatus?: string;
  largeMessage?: string;
  deniedMessage?: string;
  hunks: DiffHunk[];
}

export interface DiffViewerPaneProps extends UnknownRecord {
  title?: string;
  subtitle?: string;
  files?: unknown[];
  file?: unknown;
  diff?: unknown;
  patch?: unknown;
  review?: unknown;
  data?: unknown;
  selectedFileId?: string;
  selectedHunkId?: string;
  splitView?: boolean;
  showWhitespace?: boolean;
  onSelectFile?: (file: DiffFile) => void;
  onSelectHunk?: (file: DiffFile, hunk: DiffHunk) => void;
  onSetDecision?: (file: DiffFile, decision: DiffDecision) => void;
  onOpenFile?: (file: DiffFile) => void;
  onRevealFile?: (file: DiffFile) => void;
  onNavigateToFile?: (file: DiffFile) => void;
  onRefresh?: () => void;
}

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asRecord = (value: unknown): UnknownRecord => (isRecord(value) ? value : {});

const firstString = (sources: unknown[], keys: string[], fallback = ""): string => {
  for (const source of sources) {
    const record = asRecord(source);
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return fallback;
};

const firstNumber = (sources: unknown[], keys: string[], fallback = 0): number => {
  for (const source of sources) {
    const record = asRecord(source);
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
    }
  }
  return fallback;
};

const firstBoolean = (sources: unknown[], keys: string[]): boolean | undefined => {
  for (const source of sources) {
    const record = asRecord(source);
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "boolean") return value;
    }
  }
  return undefined;
};

const firstArray = (sources: unknown[], keys: string[]): unknown[] | undefined => {
  for (const source of sources) {
    const record = asRecord(source);
    for (const key of keys) {
      const value = record[key];
      if (Array.isArray(value)) return value;
    }
  }
  return undefined;
};

const nested = (source: unknown, keys: string[]): unknown[] => {
  const record = asRecord(source);
  return keys.map((key) => record[key]).filter(Boolean);
};

const normalizeKind = (value: unknown): DiffLineKind => {
  if (value === "added" || value === "removed" || value === "modified" || value === "context") return value;
  if (value === "delete" || value === "deleted" || value === "deletion" || value === "-") return "removed";
  if (value === "add" || value === "addition" || value === "+") return "added";
  return "context";
};

const normalizeLine = (line: unknown, index: number): DiffLine => {
  const record = asRecord(line);
  const content =
    firstString([record], ["content", "text", "value", "line"], typeof line === "string" ? line : "");

  return {
    ...record,
    id: firstString([record], ["id", "key"], `hunk-line-${index}`),
    kind: normalizeKind(record.kind ?? record.type ?? record.status ?? record.marker),
    content,
    oldLineNumber: firstNumber([record], ["oldLineNumber", "oldLine", "beforeLine", "leftLine"], undefined as unknown as number),
    newLineNumber: firstNumber([record], ["newLineNumber", "newLine", "afterLine", "rightLine"], undefined as unknown as number),
    highlighted: Boolean(record.highlighted),
  };
};

const normalizeHunk = (hunk: unknown, index: number): DiffHunk => {
  const record = asRecord(hunk);
  const lines = firstArray([record], ["lines", "changes", "diffLines", "rows", "items", "entries"]) ?? [];

  return {
    ...record,
    id: firstString([record], ["id", "key"], `hunk-${index}`),
    header: firstString([record], ["header", "range", "title", "label"], "@@ -1,3 +1,3 @@"),
    summary: firstString([record], ["summary", "description"], ""),
    decision: firstString([record], ["decision", "reviewDecision"], ""),
    diagnosticsCount: firstNumber([record], ["diagnosticsCount", "diagnostics", "issues"], 0),
    diagnosticsSeverity: firstString([record], ["diagnosticsSeverity", "severity"], ""),
    lines: lines.map(normalizeLine),
  };
};

const normalizeFile = (file: unknown, index: number, root: unknown): DiffFile => {
  const record = asRecord(file);
  const stats = asRecord(record.stats);
  const metrics = asRecord(record.metrics);
  const capability = asRecord(record.capabilities);

  const oldPath = firstString(
    [record],
    ["oldPath", "originalPath", "beforePath", "previousPath", "fromPath", "leftPath"],
    "",
  );

  const newPath = firstString(
    [record],
    ["newPath", "modifiedPath", "afterPath", "currentPath", "toPath", "rightPath", "path", "filePath", "relativePath"],
    "",
  );

  const path = firstString([record], ["path", "filePath", "relativePath", "name", "filename"], newPath || oldPath || `file-${index}`);

  const modeRaw = firstString([root, record], ["mode", "viewMode"], "");
  const explicitStatusRaw = firstString([root, record], ["status"], "");
  const statusRaw = modeRaw === "preview" || explicitStatusRaw === "preview"
    ? "preview"
    : firstString([record], ["changeKind", "changeType", "operation", "kind", "status", "type"], oldPath && newPath && oldPath !== newPath ? "rename" : "modify");
  const status = statusRaw === "modified" || statusRaw === "diff" ? "modify" : statusRaw;

  const original = firstString(
    [record, root],
    ["original", "old", "before", "left", "originalValue", "oldValue", "beforeValue", "originalText", "oldText", "beforeText", "originalContent", "beforeContent", "baseText"],
    "",
  );

  const modified = firstString(
    [record, root],
    ["modified", "new", "after", "right", "modifiedValue", "newValue", "afterValue", "modifiedText", "newText", "afterText", "modifiedContent", "afterContent", "headText"],
    "",
  );

  const addedLines = firstNumber([record, stats, metrics], ["addedLines", "additions", "added", "linesAdded"], 0);
  const removedLines = firstNumber([record, stats, metrics], ["removedLines", "deletedLines", "deletions", "removed", "deleted", "linesDeleted"], 0);

  const hunks = (firstArray([record], ["hunks", "chunks", "sections", "diffHunks"]) ?? []).map(normalizeHunk);

  const largeFileRecord = asRecord(record.largeFile ?? asRecord(root).largeFile);
  const largeDecision = firstString([largeFileRecord, record, root], ["decision", "largeFileDecision", "diffDecision"], "");
  const largeReason = firstString([largeFileRecord, record, root], ["reason", "message", "largeMessage", "degradedMessage", "deniedMessage"], "");

  const denied =
    firstBoolean([record, root], ["denied", "binary", "binaryLike", "textDenied", "diffDenied", "blocked"]) === true ||
    /deny|denied|block|blocked|binary/i.test(largeDecision) ||
    /Binary-like content denied for textual diff/i.test(largeReason);

  const large =
    !denied &&
    (
      firstBoolean([largeFileRecord, record, root], ["enabled", "large", "largeFile", "largeDiff", "isLarge", "sampled", "degraded"]) === true ||
      firstBoolean([capability], ["sampled"]) === true ||
      /sample|sampled|degrad|large/i.test(largeDecision) ||
      /Large diff forced sampled comparison mode/i.test(largeReason)
    );

  return {
    ...record,
    id: firstString([record], ["id", "key", "path"], path),
    path,
    oldPath,
    newPath,
    status,
    original,
    modified,
    addedLines,
    removedLines,
    diagnosticsCount: firstNumber([record, stats, metrics], ["diagnosticsCount", "diagnostics", "issues"], 0),
    diagnosticsSeverity: firstString([record], ["diagnosticsSeverity", "severity"], ""),
    reviewStatus: firstString([record, root], ["reviewStatus", "review", "reviewPosture", "commentStatus"], "commented"),
    verifyStatus: firstString([record, root], ["verifyStatus", "verificationStatus", "verification", "verifyPosture"], "passed"),
    applyStatus: firstString([record, root], ["applyStatus", "applyReadiness", "readiness", "applyPosture"], "warning"),
    healthStatus: firstString([record, root], ["healthStatus", "health", "diffHealth", "posture"], ""),
    largeMessage: large
      ? firstString([largeFileRecord, record, root], ["largeMessage", "largeFileMessage", "samplingMessage", "degradedMessage", "reason", "message"], "Large diff forced sampled comparison mode")
      : "",
    deniedMessage: denied
      ? firstString([largeFileRecord, record, root], ["deniedMessage", "binaryMessage", "blockedMessage", "reason", "message"], "Binary-like content denied for textual diff")
      : "",
    hunks,
  };
};

const collectFiles = (props: DiffViewerPaneProps): DiffFile[] => {
  const sources = [props, props.diff, props.patch, props.review, props.data];
  const candidateArray =
    firstArray(sources, ["files", "changedFiles", "diffFiles", "items", "entries"]) ??
    (props.file ? [props.file] : undefined);

  if (candidateArray && candidateArray.length > 0) {
    return candidateArray.map((file, index) => normalizeFile(file, index, props));
  }

  return [normalizeFile(props, 0, props)];
};

const cx = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(" ");

const statusTone = (value: string): string => {
  const normalized = value.toLowerCase();
  if (normalized.includes("pass") || normalized.includes("accept") || normalized.includes("ready")) return "border-emerald-700/30 bg-emerald-500/10 text-emerald-300";
  if (normalized.includes("warn") || normalized.includes("degrad") || normalized.includes("attention")) return "border-amber-700/30 bg-amber-500/10 text-amber-300";
  if (normalized.includes("deny") || normalized.includes("fail") || normalized.includes("reject") || normalized.includes("block")) return "border-rose-700/30 bg-rose-500/10 text-rose-300";
  return "border-zinc-700/30 bg-zinc-500/10 text-zinc-300";
};

const lineMarker = (kind: DiffLineKind): string => {
  if (kind === "added") return "+";
  if (kind === "removed") return "-";
  if (kind === "modified") return "±";
  return " ";
};

const lineTone = (kind: DiffLineKind): string => {
  if (kind === "added") return "bg-emerald-500/10 text-emerald-100";
  if (kind === "removed") return "bg-rose-500/10 text-rose-100";
  if (kind === "modified") return "bg-amber-500/10 text-amber-100";
  return "bg-zinc-950/40 text-zinc-200";
};

const renderContent = (content: string, showWhitespace: boolean): string =>
  showWhitespace ? content.replace(/ /g, "·") : content;

const gate = (
  props: DiffViewerPaneProps,
  file: DiffFile,
  keys: string[],
  defaultEnabled: boolean,
): boolean => {
  const explicit = firstBoolean([props, file, props.capabilities, file.capabilities], keys);
  return explicit ?? defaultEnabled;
};

const invoke = (candidate: unknown, ...args: unknown[]): void => {
  if (typeof candidate === "function") {
    (candidate as (...values: unknown[]) => void)(...args);
  }
};

function HunkView(props: {
  file: DiffFile;
  hunk: DiffHunk;
  splitView: boolean;
  showWhitespace: boolean;
  onSelect?: (file: DiffFile, hunk: DiffHunk) => void;
}): ReactElement {
  const leftLines = props.hunk.lines.filter((line) => line.kind !== "added");
  const rightLines = props.hunk.lines.filter((line) => line.kind !== "removed");

  return (
    <div className="rounded-[1.25rem] border border-zinc-800 bg-zinc-950/40 text-zinc-200 shadow-sm">
      <button
        type="button"
        onClick={() => props.onSelect?.(props.file, props.hunk)}
        className="w-full border-b border-zinc-800 px-4 py-3 text-left"
      >
        <span className="rounded-full border border-zinc-700/30 bg-zinc-500/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] text-zinc-300">
          {props.hunk.header}
        </span>
        {props.hunk.summary ? <span className="ml-2 text-sm text-zinc-400">{props.hunk.summary}</span> : null}
      </button>

      {props.splitView ? (
        <div className="grid grid-cols-2 gap-px bg-zinc-800">
          <div className="bg-zinc-950/40">
            {leftLines.map((line) => (
              <div key={`${line.id}:left`} className={cx("grid grid-cols-[4rem_1.5rem_1fr] gap-3 px-3 py-1.5 font-mono text-xs leading-6", lineTone(line.kind))}>
                <div className="text-right text-zinc-500">{line.oldLineNumber ?? ""}</div>
                <div className="text-center text-zinc-500">{lineMarker(line.kind)}</div>
                <pre className="overflow-auto whitespace-pre-wrap break-words">{renderContent(line.content, props.showWhitespace)}</pre>
              </div>
            ))}
          </div>
          <div className="bg-zinc-950/40">
            {rightLines.map((line) => (
              <div key={`${line.id}:right`} className={cx("grid grid-cols-[4rem_1.5rem_1fr] gap-3 px-3 py-1.5 font-mono text-xs leading-6", lineTone(line.kind))}>
                <div className="text-right text-zinc-500">{line.newLineNumber ?? ""}</div>
                <div className="text-center text-zinc-500">{lineMarker(line.kind)}</div>
                <pre className="overflow-auto whitespace-pre-wrap break-words">{renderContent(line.content, props.showWhitespace)}</pre>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="bg-zinc-950/40">
          {props.hunk.lines.map((line) => (
            <div key={line.id} className={cx("grid grid-cols-[4rem_4rem_1.5rem_1fr] gap-3 px-3 py-1.5 font-mono text-xs leading-6", lineTone(line.kind))}>
              <div className="text-right text-zinc-500">{line.oldLineNumber ?? ""}</div>
              <div className="text-right text-zinc-500">{line.newLineNumber ?? ""}</div>
              <div className="text-center text-zinc-500">{lineMarker(line.kind)}</div>
              <pre className="overflow-auto whitespace-pre-wrap break-words">{renderContent(line.content, props.showWhitespace)}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function DiffViewerPane(props: DiffViewerPaneProps): ReactElement {
  const files = collectFiles(props);
  const selectedFile = files.find((file) => file.id === props.selectedFileId || file.path === props.selectedFileId) ?? files[0];
  const selectedHunk = selectedFile.hunks.find((hunk) => hunk.id === props.selectedHunkId) ?? selectedFile.hunks[0];

  const addedTotal = files.reduce((sum, file) => sum + file.addedLines, 0);
  const deletedTotal = files.reduce((sum, file) => sum + file.removedLines, 0);
  const diagnosticsTotal = files.reduce((sum, file) => sum + file.diagnosticsCount, 0);

  const canOpen = gate(props, selectedFile, ["canOpenFile", "openFileEnabled", "openEnabled", "open"], Boolean(props.onOpenFile) || Boolean(props.onOpenFileRequested));
  const canReveal = gate(props, selectedFile, ["canRevealFile", "canRevealInTree", "revealFileEnabled", "revealInTreeEnabled", "revealEnabled", "reveal"], Boolean(props.onRevealFile) || Boolean(props.onRevealInTreeRequested));
  const canNavigate = gate(props, selectedFile, ["canNavigateToFile", "canNavigateToHunk", "navigateEnabled", "navigate"], Boolean(props.onNavigateToFile) || Boolean(props.onNavigateToHunkRequested));

  const renamed = Boolean(selectedFile.oldPath && selectedFile.newPath && selectedFile.oldPath !== selectedFile.newPath);
  const health = selectedFile.healthStatus || firstString([props], ["healthStatus", "health", "diffHealth"], "");

  return (
    <section className="flex h-full min-h-0 flex-col rounded-[2rem] border border-zinc-800 bg-zinc-900/70 shadow-xl">
      <div className="border-b border-zinc-800 px-5 py-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Patch review</div>
            <h2 className="mt-1 text-lg font-semibold text-zinc-50">{props.title ?? "Diff viewer"}</h2>
            <p className="mt-2 text-sm leading-7 text-zinc-400">{props.subtitle ?? "Governed original vs modified comparison surface"}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {[selectedFile.status, selectedFile.reviewStatus, selectedFile.verifyStatus, selectedFile.applyStatus, health].filter(Boolean).map((status) => (
              <span key={String(status)} className={cx("inline-flex items-center gap-1 rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.2em]", statusTone(String(status)))}>
                {String(status)}
              </span>
            ))}
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            ["Files", files.length],
            ["Added", `+${addedTotal}`],
            ["Deleted", `-${deletedTotal}`],
            ["Diagnostics", diagnosticsTotal],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-[1.5rem] border border-zinc-800 bg-zinc-950/60 p-4 text-zinc-200 shadow-sm">
              <div className="text-[10px] uppercase tracking-[0.2em] opacity-70">{label}</div>
              <div className="mt-2 text-lg font-semibold tracking-tight">{value}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 p-4 xl:grid-cols-[22rem_1fr]">
        <aside className="min-h-0 space-y-3 overflow-auto">
          {files.map((file) => (
            <button
              key={file.id}
              type="button"
              onClick={() => props.onSelectFile?.(file)}
              className={cx(
                "w-full rounded-[1.5rem] border p-4 text-left shadow-sm",
                file.id === selectedFile.id ? "border-zinc-600 bg-zinc-900 text-zinc-50" : "border-zinc-800 bg-zinc-950/40 text-zinc-200",
              )}
            >
              <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">{file.status}</div>
              <div className="mt-2 break-words font-mono text-xs">{file.path}</div>
              {file.oldPath ? <div className="mt-2 break-words text-xs text-zinc-500">Original: {file.oldPath}</div> : null}
              {file.newPath ? <div className="break-words text-xs text-zinc-500">Modified: {file.newPath}</div> : null}
              {renamed ? <div className="mt-2 text-xs uppercase tracking-[0.2em] text-amber-300">rename</div> : null}
              <div className="mt-3 flex flex-wrap gap-2 text-[10px] uppercase tracking-[0.18em]">
                <span className="rounded-full border border-emerald-700/30 bg-emerald-500/10 px-2 py-0.5 text-emerald-300">+{file.addedLines}</span>
                <span className="rounded-full border border-rose-700/30 bg-rose-500/10 px-2 py-0.5 text-rose-300">-{file.removedLines}</span>
              </div>
            </button>
          ))}
        </aside>

        <main className="min-h-0 space-y-4 overflow-auto">
          <div className="flex flex-wrap gap-2" onClick={(event) => {
            // ADJUTORIX_DIFF_VIEWER_ACTION_ALIAS_CAPTURE
            const button = ((event.target as HTMLElement | null)?.closest?.("button") ?? null) as HTMLButtonElement | null;
            if (!button || button.disabled) return;

            const label = button.textContent ?? "";
            if (/open file/i.test(label)) invoke(props.onOpenFileRequested, selectedFile.path, selectedFile);
          }}>
            <button type="button" disabled={!canOpen} onClick={() => props.onOpenFile?.(selectedFile)} className="rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs uppercase tracking-[0.18em] text-zinc-200 disabled:opacity-40">
              Open file
            </button>
            <button type="button" disabled={!canReveal} onClick={() => { props.onRevealFile?.(selectedFile); invoke(props.onRevealInTreeRequested, selectedFile.path, selectedFile); }} className="rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs uppercase tracking-[0.18em] text-zinc-200 disabled:opacity-40">
              Reveal file
            </button>
            <button type="button" disabled={!canNavigate} onClick={() => { props.onNavigateToFile?.(selectedFile); invoke(props.onNavigateToHunkRequested, selectedHunk?.id, selectedHunk); }} className="rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs uppercase tracking-[0.18em] text-zinc-200 disabled:opacity-40">
              Navigate
            </button>
            <button type="button" onClick={() => { props.onRefresh?.(); invoke(props.onRefreshRequested); }} className="rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs uppercase tracking-[0.18em] text-zinc-200">
              Refresh
            </button>
          </div>

          {selectedFile.largeMessage ? (
            <div className="rounded-[1.25rem] border border-amber-700/30 bg-amber-500/10 p-4 text-sm text-amber-200">
              {selectedFile.largeMessage}
              <span className="ml-2 uppercase tracking-[0.18em]">large file</span>
            </div>
          ) : null}

          {selectedFile.deniedMessage ? (
            <div className="rounded-[1.25rem] border border-rose-700/30 bg-rose-500/10 p-4 text-sm text-rose-200">
              {selectedFile.deniedMessage}
            </div>
          ) : null}

          {health ? (
            <div className={cx("rounded-[1.25rem] border p-4 text-sm", statusTone(health))}>{health}</div>
          ) : null}

          <div className="rounded-[1.5rem] border border-zinc-800 bg-zinc-950/50 p-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Monaco diff host</div>
                <div className="mt-1 font-mono text-xs text-zinc-300">{selectedFile.path}</div>
              </div>
              {selectedHunk ? <div className="text-xs text-zinc-500">Selected hunk</div> : null}
            </div>
            <div className="min-h-[18rem] overflow-hidden rounded-[1rem] border border-zinc-800">
              <DiffEditor
                original={selectedFile.original}
                modified={selectedFile.modified}
                language={firstString([selectedFile, props], ["language", "syntax"], "typescript")}
                options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false } }}
              />
            </div>
          </div>

          <div className="space-y-3">
            <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">Hunks</div>
            {selectedFile.hunks.length > 0 ? (
              selectedFile.hunks.map((hunk) => (
                <HunkView
                  key={hunk.id}
                  file={selectedFile}
                  hunk={hunk}
                  splitView={Boolean(props.splitView)}
                  showWhitespace={Boolean(props.showWhitespace)}
                  onSelect={(_file, hunk) => invoke(props.onSelectHunk, hunk.id)}
                />
              ))
            ) : (
              <div className="rounded-[1.25rem] border border-zinc-800 bg-zinc-950/40 p-4 text-sm text-zinc-400">
                No hunk data supplied.
              </div>
            )}
          </div>
        </main>
      </div>
    </section>
  );
}
