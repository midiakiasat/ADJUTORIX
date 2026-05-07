import React from "react";

function basename(path: unknown): string {
  return String(path ?? "").replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
}


type AnyRecord = Record<string, any>;
export type OutlinePanelProps = AnyRecord;
export type OutlineSymbol = AnyRecord;

type NormalizedSymbol = {
  id: string;
  name: string;
  kind: string;
  detail: string;
  path: string;
  range: string;
  diagnostics: number;
  children: NormalizedSymbol[];
  issues: number;
  raw: AnyRecord;
};

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as AnyRecord) : {};
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return "";
}

function toArray(value: unknown): AnyRecord[] {
  const wrap = (item: unknown, index: number): AnyRecord =>
    item && typeof item === "object" && !Array.isArray(item)
      ? (item as AnyRecord)
      : { id: String(index), value: item };

  if (Array.isArray(value)) return value.map(wrap);
  if (value instanceof Set) return Array.from(value).map(wrap);
  if (value && typeof value === "object") {
    return Object.entries(value as AnyRecord).map(([id, entry]) => ({ id, ...asRecord(entry), value: entry }));
  }
  return [];
}

function invoke(props: AnyRecord, names: string[], ...args: unknown[]): void {
  for (const name of names) {
    if (typeof props[name] === "function") {
      props[name](...args);
      return;
    }
  }
}

function normalizeRange(node: AnyRecord): string {
  return firstString(
    node.range,
    node.location,
    node.line,
    node.startLine && node.endLine ? `${node.startLine}-${node.endLine}` : "",
    node.range?.startLine && node.range?.endLine ? `${node.range.startLine}-${node.range.endLine}` : "",
    node.selectionRange?.startLine && node.selectionRange?.endLine ? `${node.selectionRange.startLine}-${node.selectionRange.endLine}` : "",
  );
}


function diagnosticCount(node: Record<string, unknown>): number {
  const numeric = (...values: unknown[]): number | null => {
    for (const value of values) {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
    }
    return null;
  };

  const issues = asRecord(node.diagnostics ?? node.diagnostic ?? node.issues);
  const explicit = numeric(
    issues.total,
    issues.count,
    node.diagnosticCount,
    node.diagnosticsCount,
    node.issueCount,
    node.issuesCount,
  );
  if (explicit !== null) return explicit;

  return (
    (numeric(issues.warningCount, issues.warnings, node.warningCount, node.warnings) ?? 0) +
    (numeric(issues.errorCount, issues.errors, node.errorCount, node.errors) ?? 0)
  );
}

function warningCount(node: NormalizedSymbol): number {
  const issues = asRecord(node.raw.diagnostics);
  return typeof issues.warningCount === "number" ? issues.warningCount : 0;
}

function errorCount(node: NormalizedSymbol): number {
  const issues = asRecord(node.raw.diagnostics);
  return typeof issues.errorCount === "number" ? issues.errorCount : 0;
}

function normalizeSymbol(node: AnyRecord, indexPath: string): NormalizedSymbol {
  const children = [
    ...toArray(node.children),
    ...toArray(node.nodes),
    ...toArray(node.symbols),
    ...toArray(node.items),
    ...toArray(node.entries),
  ].map((child, index) => normalizeSymbol(child, `${indexPath}.${index}`));

  const name = firstString(node.name, node.label, node.symbol, node.title, node.id, `symbol-${indexPath}`);
  const path = firstString(node.path, node.filePath, node.uri, node.sourcePath, node.canonicalPath);

  return {
    id: firstString(node.id, node.symbolId, `${name}-${indexPath}`),
    name,
    kind: firstString(node.kind, node.type, node.symbolKind, "symbol"),
    detail: firstString(node.detail, node.description, node.signature, node.containerName),
    path,
    range: normalizeRange(node),
    diagnostics: diagnosticCount(node),
    issues: diagnosticCount(node),
    children,
    raw: node,
  };
}

function collectNodes(props: AnyRecord): NormalizedSymbol[] {
  return toArray(
    props.nodes ??
      props.symbols ??
      props.outlineSymbols ??
      props.items ??
      props.entries ??
      props.outline?.nodes ??
      props.outline?.symbols ??
      props.file?.symbols,
  ).map((node, index) => normalizeSymbol(node, String(index)));
}

function matches(node: NormalizedSymbol, query: string, diagnosticsOnly: boolean): boolean {
  const q = query.trim().toLowerCase();
  const selfMatches =
    !q ||
    node.name.toLowerCase().includes(q) ||
    node.kind.toLowerCase().includes(q) ||
    node.detail.toLowerCase().includes(q) ||
    node.path.toLowerCase().includes(q);
  const diagnosticMatches = !diagnosticsOnly || node.issues > 0;
  const childMatches = node.children.some((child) => matches(child, query, diagnosticsOnly));
  return (selfMatches && diagnosticMatches) || childMatches;
}

function countSymbols(nodes: NormalizedSymbol[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countSymbols(node.children), 0);
}

function countDiagnostics(nodes: NormalizedSymbol[]): number {
  return nodes.reduce((sum, node) => sum + (node.issues > 0 ? 1 : 0) + countDiagnostics(node.children), 0);
}

function countWarnings(nodes: NormalizedSymbol[]): number {
  return nodes.reduce((sum, node) => sum + warningCount(node) + countWarnings(node.children), 0);
}

function countErrors(nodes: NormalizedSymbol[]): number {
  return nodes.reduce((sum, node) => sum + errorCount(node) + countErrors(node.children), 0);
}

function stat(label: string, value: string | number) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-3">
      <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">{label}</div>
      <div className="mt-1 text-sm font-semibold text-zinc-100">{value}</div>
    </div>
  );
}

function SymbolRow({ node, depth, props }: { node: NormalizedSymbol; depth: number; props: AnyRecord }) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-3" style={{ marginLeft: depth * 16 }}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="text-left text-sm font-semibold text-zinc-100"
          onClick={() => invoke(props, ["onSelectSymbol", "onSymbolSelected", "onSelect", "onSymbolSelectionRequested"], node.id)}
        >
          {node.name}
        </button>
        <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-zinc-300">{node.kind}</span>
        {node.issues > 0 ? <span className="rounded-full border border-amber-700 px-2 py-0.5 text-[10px] text-amber-300">issues {node.diagnostics}</span> : null}
      </div>

      <div className="mt-2 flex flex-wrap gap-3 text-xs text-zinc-500">
        {node.detail ? <span>{node.detail}</span> : null}
        {node.range ? <span>{node.range}</span> : null}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => invoke(props, ["onNavigateToSymbol", "onNavigate", "onOpenSymbol"], node.id)}>Navigate</button>
        <button type="button" onClick={() => invoke(props, ["onRevealInEditor", "onRevealSymbol", "onReveal", "onRevealRequested"], node.id)}>Reveal</button>
        {node.children.length ? <button type="button" onClick={() => invoke(props, ["onExpandSymbol", "onExpand", "onExpandRequested"], node.raw)}>Expand</button> : null}
        {node.children.length ? <button type="button" onClick={() => invoke(props, ["onCollapseSymbol", "onCollapse", "onCollapseRequested"], node.raw)}>Collapse</button> : null}
      </div>

      {node.children.length ? (
        <div className="mt-3 space-y-2">
          {node.children.map((child) => (
            <SymbolRow key={child.id} node={child} depth={depth + 1} props={props} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function OutlinePanel(props: OutlinePanelProps) {
  const nodes = collectNodes(props);
  const query = firstString(props.query, props.filterQuery, props.searchQuery);
  const diagnosticsOnly = Boolean(props.showOnlyDiagnostics ?? props.diagnosticsOnly);
  const visibleRoots = nodes.filter((node) => matches(node, query, diagnosticsOnly));

  const filePath = firstString(props.filePath, props.path, props.activePath, props.file?.path, props.document?.path, "No file selected");
  const fileName = firstString(props.fileName, props.file?.name, props.document?.name, "selected file", basename(filePath));
  const language = firstString(props.language, props.file?.language, props.document?.language, "unknown");
  const languageLabel = language.toLowerCase() === "typescript" ? "ts" : language;
  const health = firstString(props.health, props.healthStatus, props.status, props.degraded ? "degraded" : "healthy");

  return (
    <section className="flex h-full min-h-0 flex-col rounded-[2rem] border border-zinc-800 bg-zinc-900/70 text-zinc-100">
      <header className="border-b border-zinc-800 p-5">
        <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Symbols</div>
        <h2 className="mt-1 text-lg font-semibold">Outline</h2>
        <p className="mt-2 text-sm text-zinc-400">Governed symbol and structure surface</p>

        <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {stat("File", fileName)}
          {stat("Path", filePath)}
          {stat("Language", languageLabel)}
          {stat("Health", health)}
          {stat("Total", countSymbols(nodes))}
          {stat("Visible", countSymbols(visibleRoots))}
          {stat("Filtered", query ? "yes" : "no")}
          {stat("Diagnostics", countDiagnostics(nodes))}
          {stat("Warnings", countWarnings(nodes))}
          {stat("Errors", countErrors(nodes))}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <input
            className="min-w-[16rem] rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm outline-none"
            placeholder="Filter outline"
            value={query}
            onChange={(event) => invoke(props, ["onQueryChange", "onFilterQueryChange", "onSearchQueryChange"], event.target.value)}
          />
          <button type="button" onClick={() => invoke(props, ["onRefresh", "onRefreshRequested", "onReload"])}>Refresh</button>
        </div>
      </header>

      <main className="min-h-0 flex-1 space-y-3 overflow-auto p-5">
        {props.loading ? <div className="rounded-2xl border border-zinc-800 p-4 text-sm text-zinc-300">Loading symbol graph</div> : null}

        {!props.loading && nodes.length === 0 ? (
          <div className="rounded-2xl border border-zinc-800 p-4 text-sm text-zinc-300">No symbols are available for the selected file</div>
        ) : null}

        {!props.loading && nodes.length > 0 && visibleRoots.length === 0 ? (
          <div className="rounded-2xl border border-zinc-800 p-4 text-sm text-zinc-300">No symbols match the current outline filter</div>
        ) : null}

        {visibleRoots.map((node) => (
          <SymbolRow key={node.id} node={node} depth={0} props={props} />
        ))}
      </main>
    </section>
  );
}

export default OutlinePanel;
