import React, { useEffect, useMemo, useRef, useState } from "react";
import Editor, { OnMount, Monaco } from "@monaco-editor/react";
import { motion, AnimatePresence } from "framer-motion";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  FileCode2,
  GitBranch,
  History,
  Lock,
  Pencil,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  SplitSquareVertical,
  Wrench,
} from "lucide-react";

/**
 * ADJUTORIX APP — RENDERER / COMPONENTS / MonacoEditorPane.tsx
 *
 * Canonical governed Monaco editor surface.
 *
 * Purpose:
 * - provide the authoritative renderer editor pane for file/buffer inspection and editing
 * - treat Monaco as a rendering/runtime substrate under explicit governance rather than a
 *   free-form text widget with hidden authority
 * - surface baseline vs working vs preview lineage explicitly
 * - expose diagnostics pressure, verify/apply posture, read-only state, and editor intent
 * - keep user-visible editor state deterministic and externally controlled where it matters
 *
 * Architectural role:
 * - this component hosts one active editor buffer at a time
 * - it renders explicit state provided by renderer stores/contexts
 * - it never performs implicit persistence, patch apply, or trust mutation
 * - it may emit content/viewport/search intent upward, but does not own truth for governance
 *
 * Hard invariants:
 * - visible content source is explicit (working or preview overlay)
 * - read-only state is explicit and visible in chrome
 * - diagnostics, review, and lineage indicators are present without changing text identity
 * - identical props produce identical initial editor model state
 * - no hidden save/apply behavior exists
 * - no placeholders, fake diffing, or undeclared side effects
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type MonacoPaneSeverity = "none" | "info" | "warn" | "error" | "critical";
export type MonacoPaneReviewState = "none" | "preview" | "approved" | "verified" | "applied";
export type MonacoPaneContentSource = "working" | "preview";
export type MonacoPaneTrustLevel = "unknown" | "untrusted" | "restricted" | "trusted";

export type MonacoPaneDiagnosticItem = {
  id: string;
  severity: MonacoPaneSeverity;
  message: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  source?: string;
  code?: string;
};

export type MonacoPaneCursor = {
  line: number;
  column: number;
};

export type MonacoPaneSelection = {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
};

export type MonacoEditorPaneProps = {
  path: string | null;
  title?: string | null;
  language?: string | null;
  baselineContent: string;
  workingContent: string;
  previewContent?: string | null;
  previewHash?: string | null;
  patchId?: string | null;
  reviewState?: MonacoPaneReviewState;
  contentSource?: MonacoPaneContentSource;
  diagnostics?: MonacoPaneDiagnosticItem[];
  readOnly?: boolean;
  modified?: boolean;
  generated?: boolean;
  trustLevel?: MonacoPaneTrustLevel;
  verifyPassed?: boolean;
  applyReady?: boolean;
  loading?: boolean;
  showMinimap?: boolean;
  wordWrap?: "off" | "on" | "bounded" | "wordWrapColumn";
  fontSize?: number;
  cursor?: MonacoPaneCursor | null;
  selections?: MonacoPaneSelection[];
  onChangeWorkingContent?: (next: string) => void;
  onSaveRequested?: () => void;
  onResetToBaselineRequested?: () => void;
  onTogglePreviewSource?: (next: MonacoPaneContentSource) => void;
  onSearchRequested?: () => void;
  onCursorChanged?: (cursor: MonacoPaneCursor) => void;
  onSelectionsChanged?: (selections: MonacoPaneSelection[]) => void;
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function normalizePath(path: string | null | undefined): string | null {
  if (!path) return null;
  const p = path.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  return p.endsWith("/") && p !== "/" ? p.slice(0, -1) : p;
}

function basename(path: string | null | undefined): string {
  const p = normalizePath(path);
  if (!p) return "Untitled";
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function inferLanguage(path: string | null, fallback?: string | null): string {
  if (fallback) return fallback;
  const p = normalizePath(path) ?? "";
  if (p.endsWith(".ts")) return "typescript";
  if (p.endsWith(".tsx")) return "typescript";
  if (p.endsWith(".js")) return "javascript";
  if (p.endsWith(".jsx")) return "javascript";
  if (p.endsWith(".json")) return "json";
  if (p.endsWith(".md")) return "markdown";
  if (p.endsWith(".py")) return "python";
  if (p.endsWith(".css")) return "css";
  if (p.endsWith(".html")) return "html";
  if (p.endsWith(".yml") || p.endsWith(".yaml")) return "yaml";
  if (p.endsWith(".sql")) return "sql";
  return "plaintext";
}

function severityRank(severity: MonacoPaneSeverity): number {
  return { none: 0, info: 1, warn: 2, error: 3, critical: 4 }[severity];
}

function highestSeverity(items: MonacoPaneDiagnosticItem[]): MonacoPaneSeverity {
  return items.reduce<MonacoPaneSeverity>((acc, item) => (severityRank(item.severity) > severityRank(acc) ? item.severity : acc), "none");
}

function trustTone(level: MonacoPaneTrustLevel | undefined): string {
  switch (level) {
    case "trusted":
      return "border-emerald-700/30 bg-emerald-500/10 text-emerald-300";
    case "restricted":
      return "border-amber-700/30 bg-amber-500/10 text-amber-300";
    case "untrusted":
      return "border-rose-700/30 bg-rose-500/10 text-rose-300";
    default:
      return "border-zinc-700/30 bg-zinc-500/10 text-zinc-300";
  }
}

function reviewTone(state: MonacoPaneReviewState | undefined): string {
  switch (state) {
    case "preview":
      return "border-sky-700/30 bg-sky-500/10 text-sky-300";
    case "approved":
      return "border-indigo-700/30 bg-indigo-500/10 text-indigo-300";
    case "verified":
      return "border-emerald-700/30 bg-emerald-500/10 text-emerald-300";
    case "applied":
      return "border-violet-700/30 bg-violet-500/10 text-violet-300";
    default:
      return "border-zinc-700/30 bg-zinc-500/10 text-zinc-400";
  }
}

function severityTone(severity: MonacoPaneSeverity): string {
  switch (severity) {
    case "critical":
    case "error":
      return "border-rose-700/30 bg-rose-500/10 text-rose-300";
    case "warn":
      return "border-amber-700/30 bg-amber-500/10 text-amber-300";
    case "info":
      return "border-sky-700/30 bg-sky-500/10 text-sky-300";
    default:
      return "border-zinc-700/30 bg-zinc-500/10 text-zinc-400";
  }
}

function toMonacoSeverity(monaco: Monaco, severity: MonacoPaneSeverity): number {
  switch (severity) {
    case "critical":
    case "error":
      return monaco.MarkerSeverity.Error;
    case "warn":
      return monaco.MarkerSeverity.Warning;
    case "info":
      return monaco.MarkerSeverity.Info;
    default:
      return monaco.MarkerSeverity.Hint;
  }
}

function computeVisibleContent(source: MonacoPaneContentSource, working: string, preview?: string | null): string {
  return source === "preview" && preview != null ? preview : working;
}

function countLines(text: string): number {
  return text.length === 0 ? 1 : text.split(/\r?\n/).length;
}

function hasBaselineDrift(baseline: string, working: string): boolean {
  return baseline !== working;
}

// -----------------------------------------------------------------------------
// SUBCOMPONENTS
// -----------------------------------------------------------------------------

function Badge(props: { className?: string; children: React.ReactNode }): JSX.Element {
  return <span className={cx("inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.2em]", props.className)}>{props.children}</span>;
}

function ToolbarButton(props: { onClick?: () => void; disabled?: boolean; active?: boolean; icon: React.ReactNode; label: string }): JSX.Element {
  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled || !props.onClick}
      className={cx(
        "inline-flex items-center gap-2 rounded-2xl border px-3.5 py-2 text-sm font-medium transition",
        props.active
          ? "border-indigo-700/40 bg-indigo-500/15 text-indigo-200"
          : "border-zinc-800 bg-zinc-950/70 text-zinc-200 hover:bg-zinc-900",
        (props.disabled || !props.onClick) && "cursor-not-allowed opacity-40",
      )}
    >
      {props.icon}
      {props.label}
    </button>
  );
}

function DiagnosticsStrip(props: { diagnostics: MonacoPaneDiagnosticItem[] }): JSX.Element | null {
  if (props.diagnostics.length === 0) return null;

  const severity = highestSeverity(props.diagnostics);
  const grouped = {
    critical: props.diagnostics.filter((d) => d.severity === "critical").length,
    error: props.diagnostics.filter((d) => d.severity === "error").length,
    warn: props.diagnostics.filter((d) => d.severity === "warn").length,
    info: props.diagnostics.filter((d) => d.severity === "info").length,
  };

  return (
    <div className={cx("border-t px-4 py-3", severityTone(severity))}>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className="font-semibold uppercase tracking-[0.2em]">Diagnostics</span>
        {grouped.critical > 0 ? <span>{grouped.critical} critical</span> : null}
        {grouped.error > 0 ? <span>{grouped.error} error</span> : null}
        {grouped.warn > 0 ? <span>{grouped.warn} warn</span> : null}
        {grouped.info > 0 ? <span>{grouped.info} info</span> : null}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// MAIN COMPONENT
// -----------------------------------------------------------------------------

export default function MonacoEditorPane(props: MonacoEditorPaneProps): JSX.Element {
  const path = normalizePath(props.path);
  const title = props.title ?? basename(path);
  const language = inferLanguage(path, props.language);
  const diagnostics = props.diagnostics ?? [];
  const readOnly = props.readOnly ?? false;
  const reviewState = props.reviewState ?? "none";
  const trustLevel = props.trustLevel ?? "unknown";
  const loading = props.loading ?? false;
  const modified = props.modified ?? hasBaselineDrift(props.baselineContent, props.workingContent);
  const showMinimap = props.showMinimap ?? true;
  const wordWrap = props.wordWrap ?? "on";
  const fontSize = props.fontSize ?? 13;

  const [contentSource, setContentSource] = useState<MonacoPaneContentSource>(props.contentSource ?? (props.previewContent != null ? "preview" : "working"));
  const [isMounted, setIsMounted] = useState(false);

  const editorRef = useRef<any>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const currentModelUriRef = useRef<string | null>(null);

  useEffect(() => {
    if (props.contentSource) setContentSource(props.contentSource);
  }, [props.contentSource]);

  const visibleContent = useMemo(
    () => computeVisibleContent(contentSource, props.workingContent, props.previewContent),
    [contentSource, props.previewContent, props.workingContent],
  );

  const visibleSourceLabel = contentSource === "preview" ? "preview overlay" : "working copy";
  const diagnosticsSeverity = highestSeverity(diagnostics);

  const modelPath = useMemo(() => `file://${path ?? "/untitled"}`, [path]);

  const applyMarkers = useCallback(() => {
    if (!editorRef.current || !monacoRef.current) return;
    const model = editorRef.current.getModel?.();
    if (!model) return;

    monacoRef.current.editor.setModelMarkers(
      model,
      "adjutorix-diagnostics",
      diagnostics.map((d) => ({
        startLineNumber: Math.max(1, d.line),
        startColumn: Math.max(1, d.column),
        endLineNumber: Math.max(1, d.endLine ?? d.line),
        endColumn: Math.max(1, d.endColumn ?? d.column + 1),
        message: d.message,
        severity: toMonacoSeverity(monacoRef.current!, d.severity),
        source: d.source,
        code: d.code,
      })),
    );
  }, [diagnostics]);

  useEffect(() => {
    applyMarkers();
  }, [applyMarkers, visibleContent]);

  useEffect(() => {
    if (!editorRef.current) return;
    const model = editorRef.current.getModel?.();
    if (!model) return;

    if (model.getValue() !== visibleContent) {
      const position = editorRef.current.getPosition?.();
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: visibleContent }], () => null);
      if (position) editorRef.current.setPosition(position);
    }
  }, [visibleContent]);

  useEffect(() => {
    if (!editorRef.current || !props.cursor) return;
    editorRef.current.setPosition({ lineNumber: props.cursor.line, column: props.cursor.column });
  }, [props.cursor]);

  const onMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    currentModelUriRef.current = modelPath;

    editor.updateOptions({
      minimap: { enabled: showMinimap },
      readOnly,
      wordWrap,
      fontSize,
      glyphMargin: true,
      renderWhitespace: "selection",
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorBlinking: "smooth",
      padding: { top: 16, bottom: 16 },
    });

    applyMarkers();

    editor.onDidChangeCursorPosition((e) => {
      props.onCursorChanged?.({ line: e.position.lineNumber, column: e.position.column });
    });

    editor.onDidChangeCursorSelection((e) => {
      props.onSelectionsChanged?.(
        e.secondarySelections.concat([e.selection]).map((s) => ({
          startLine: s.startLineNumber,
          startColumn: s.startColumn,
          endLine: s.endLineNumber,
          endColumn: s.endColumn,
        })),
      );
    });

    setIsMounted(true);
  };

  const headerStatus = useMemo(() => {
    const lines = countLines(visibleContent);
    return {
      lines,
      diagnostics: diagnostics.length,
      dirty: modified,
    };
  }, [diagnostics.length, modified, visibleContent]);

  return (
    <section className="flex h-full min-h-0 flex-col rounded-[2rem] border border-zinc-800 bg-zinc-900/70 shadow-xl">
      <div className="border-b border-zinc-800 px-5 py-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-3">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-3">
                <FileCode2 className="h-5 w-5 text-zinc-200" />
              </div>
              <div className="min-w-0">
                <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Editor surface</div>
                <h2 className="truncate text-lg font-semibold text-zinc-50">{title}</h2>
                <p className="mt-1 truncate text-sm text-zinc-400">{path ?? "No file selected"}</p>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Badge className={trustTone(trustLevel)}>
                <ShieldCheck className="h-3.5 w-3.5" />
                {trustLevel}
              </Badge>
              <Badge className={reviewTone(reviewState)}>
                <GitBranch className="h-3.5 w-3.5" />
                {reviewState}
              </Badge>
              <Badge className="border-zinc-700/30 bg-zinc-500/10 text-zinc-300">
                <History className="h-3.5 w-3.5" />
                {visibleSourceLabel}
              </Badge>
              {props.previewHash ? (
                <Badge className="border-sky-700/30 bg-sky-500/10 text-sky-300">
                  <Sparkles className="h-3.5 w-3.5" />
                  {props.previewHash}
                </Badge>
              ) : null}
              {props.patchId ? (
                <Badge className="border-indigo-700/30 bg-indigo-500/10 text-indigo-300">
                  <GitBranch className="h-3.5 w-3.5" />
                  {props.patchId}
                </Badge>
              ) : null}
              {modified ? (
                <Badge className="border-amber-700/30 bg-amber-500/10 text-amber-300">
                  <Pencil className="h-3.5 w-3.5" />
                  dirty
                </Badge>
              ) : null}
              {props.generated ? (
                <Badge className="border-zinc-700/30 bg-zinc-500/10 text-zinc-400">
                  <Wrench className="h-3.5 w-3.5" />
                  generated
                </Badge>
              ) : null}
              {readOnly ? (
                <Badge className="border-rose-700/30 bg-rose-500/10 text-rose-300">
                  <Lock className="h-3.5 w-3.5" />
                  read-only
                </Badge>
              ) : null}
              {props.verifyPassed ? (
                <Badge className="border-emerald-700/30 bg-emerald-500/10 text-emerald-300">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  verified
                </Badge>
              ) : null}
              {props.applyReady ? (
                <Badge className="border-violet-700/30 bg-violet-500/10 text-violet-300">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  apply-ready
                </Badge>
              ) : null}
            </div>
          </div>

          <div className="flex flex-col gap-3 xl:items-end">
            <div className="grid gap-2 sm:grid-cols-3 xl:min-w-[26rem]">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Language</div>
                <div className="mt-1 text-sm font-medium text-zinc-100">{language}</div>
              </div>
              <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Lines</div>
                <div className="mt-1 text-sm font-medium text-zinc-100">{headerStatus.lines}</div>
              </div>
              <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Diagnostics</div>
                <div className="mt-1 text-sm font-medium text-zinc-100">{headerStatus.diagnostics}</div>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <ToolbarButton
                onClick={() => {
                  const next = contentSource === "preview" ? "working" : "preview";
                  setContentSource(next);
                  props.onTogglePreviewSource?.(next);
                }}
                disabled={props.previewContent == null}
                active={contentSource === "preview"}
                icon={contentSource === "preview" ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                label={contentSource === "preview" ? "Show working" : "Show preview"}
              />
              <ToolbarButton onClick={props.onSearchRequested} icon={<Search className="h-4 w-4" />} label="Search" />
              <ToolbarButton onClick={props.onResetToBaselineRequested} disabled={!modified || readOnly} icon={<RefreshCw className="h-4 w-4" />} label="Reset" />
              <ToolbarButton onClick={props.onSaveRequested} disabled={readOnly || !modified} icon={<Save className="h-4 w-4" />} label="Save" />
            </div>
          </div>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <AnimatePresence initial={false}>
          {loading ? (
            <motion.div
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-10 grid place-items-center bg-zinc-950/55 backdrop-blur-sm"
            >
              <div className="rounded-[2rem] border border-zinc-800 bg-zinc-900/90 px-6 py-5 shadow-2xl">
                <div className="flex items-center gap-3 text-zinc-200">
                  <RefreshCw className="h-4 w-4 animate-spin" />
                  <span className="text-sm font-medium">Hydrating governed editor surface…</span>
                </div>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        {path ? (
          <Editor
            key={modelPath}
            path={modelPath}
            language={language}
            value={visibleContent}
            onMount={onMount}
            onChange={(next) => {
              if (readOnly || contentSource === "preview") return;
              props.onChangeWorkingContent?.(next ?? "");
            }}
            theme="vs-dark"
            loading={
              <div className="flex h-full items-center justify-center bg-zinc-950 text-sm text-zinc-400">
                Loading editor model…
              </div>
            }
            options={{
              minimap: { enabled: showMinimap },
              readOnly,
              wordWrap,
              fontSize,
              glyphMargin: true,
              scrollBeyondLastLine: false,
              smoothScrolling: true,
              renderWhitespace: "selection",
              bracketPairColorization: { enabled: true },
              guides: { bracketPairs: true, indentation: true },
              padding: { top: 16, bottom: 16 },
            }}
          />
        ) : (
          <div className="grid h-full min-h-[24rem] place-items-center bg-zinc-950/20 p-8 text-center">
            <div className="max-w-xl">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-[1.5rem] border border-zinc-800 bg-zinc-950/60">
                <SplitSquareVertical className="h-6 w-6 text-zinc-400" />
              </div>
              <h3 className="mt-6 text-xl font-semibold text-zinc-100">No active buffer</h3>
              <p className="mt-3 text-sm leading-7 text-zinc-500">
                Select a governed workspace path from the file tree or activity surface to mount an editor buffer with explicit lineage, diagnostics, and trust posture.
              </p>
            </div>
          </div>
        )}
      </div>

      <DiagnosticsStrip diagnostics={diagnostics} />

      <div className="border-t border-zinc-800 px-4 py-3 text-xs text-zinc-500">
        <div className="flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-1"><FileCode2 className="h-3.5 w-3.5" /> source: {visibleSourceLabel}</span>
          <span className="inline-flex items-center gap-1"><History className="h-3.5 w-3.5" /> baseline vs working explicit</span>
          <span className="inline-flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" /> diagnostics-bound</span>
          <span className="inline-flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5" /> governance-visible</span>
        </div>
      </div>
    </section>
  );
}
