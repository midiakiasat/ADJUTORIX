import React from "react";

function inferOperatorRootPath(path: string): string {
  const value = String(path ?? "").replace(/\\/g, "/");
  const markers = ["/src/", "/tests/", "/test/", "/node_modules/", "/.github/", "/dist/", "/build/"];

  for (const marker of markers) {
    const index = value.indexOf(marker);
    if (index > 0) return value.slice(0, index);
  }

  const leafMarkers = ["/README.md", "/package.json", "/pnpm-lock.yaml", "/.env", "/.env.local"];
  for (const marker of leafMarkers) {
    const index = value.indexOf(marker);
    if (index > 0) return value.slice(0, index);
  }

  return "";
}

function operatorRelativePath(path: string | null | undefined, rootPath: string | null | undefined): string {
  const value = String(path ?? "").replace(/\\/g, "/");
  const explicitRoot = String(rootPath ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  const inferredRoot = explicitRoot || inferOperatorRootPath(value);
  const root = inferredRoot.replace(/\/+$/, "");

  if (!value) return "";
  if (root && value === root) return ".";
  if (root && value.startsWith(`${root}/`)) return value.slice(root.length + 1);

  return value;
}


export type FileTreeEntry = {
  id?: string;
  path?: string;
  relativePath?: string;
  fullPath?: string;
  name?: string;
  label?: string;
  basename?: string;
  type?: string;
  kind?: string;
  children?: FileTreeEntry[];
  entries?: FileTreeEntry[];
  nodes?: FileTreeEntry[];
  hidden?: boolean;
  isHidden?: boolean;
  ignored?: boolean;
  isIgnored?: boolean;
  isDirectory?: boolean;
  directory?: boolean;
  opened?: boolean;
  open?: boolean;
  selected?: boolean;
  [key: string]: unknown;
};

export type FileTreeNode = FileTreeEntry;
export type WorkspaceTreeEntry = FileTreeEntry;

export type FileTreePaneProps = Record<string, any>;

type NormalizedNode = {
  path: string;
  relativePath: string;
  originalPath: string;
  name: string;
  type: "file" | "directory";
  hidden: boolean;
  ignored: boolean;
  children: NormalizedNode[];
};

function cleanPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

function basename(value: string): string {
  const parts = cleanPath(value).split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function asArray(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return Array.from(value);
  return [];
}

function toSet(value: unknown): Set<string> {
  if (value instanceof Set) return new Set(Array.from(value).map(String));
  if (Array.isArray(value)) return new Set(value.map(String));
  if (typeof value === "string" && value) return new Set([value]);
  return new Set();
}

function invoke(props: FileTreePaneProps, names: string[], value?: unknown): void {
  for (const name of names) {
    if (typeof props[name] === "function") {
      props[name](value);
      return;
    }
  }
}

function candidateObjects(value: unknown, seen = new Set<object>()): FileTreeEntry[] {
  if (!value || typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);

  if (Array.isArray(value)) return value.flatMap((item) => candidateObjects(item, seen));

  const record = value as Record<string, unknown>;
  const hasIdentity =
    typeof record.path === "string" ||
    typeof record.relativePath === "string" ||
    typeof record.fullPath === "string" ||
    typeof record.name === "string" ||
    typeof record.label === "string";

  const out: FileTreeEntry[] = hasIdentity ? [record as FileTreeEntry] : [];

  for (const key of ["children", "entries", "nodes", "files", "items", "tree", "fileTree", "workspaceTree", "workspace"]) {
    out.push(...candidateObjects(record[key], seen));
  }

  return out;
}

function flatten(entries: FileTreeEntry[], parentPath = ""): FileTreeEntry[] {
  const out: FileTreeEntry[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;

    const name = firstString(entry.name, entry.label, entry.basename);
    const explicitPath = firstString(entry.path, entry.relativePath, entry.fullPath, entry.id);
    const path = cleanPath(explicitPath || [parentPath, name].filter(Boolean).join("/"));
    const children = [
      ...asArray(entry.children),
      ...asArray(entry.entries),
      ...asArray(entry.nodes),
    ];

    if (path || name) {
      out.push({ ...entry, path: path || name, name: name || basename(path) });
    }

    if (children.length > 0) {
      out.push(...flatten(children, path || name || parentPath));
    }
  }

  const byPath = new Map<string, FileTreeEntry>();
  for (const entry of out) {
    const key = firstString(entry.path, entry.relativePath, entry.fullPath, entry.name);
    if (key) byPath.set(key, entry);
  }
  return Array.from(byPath.values());
}

function collectInputEntries(props: FileTreePaneProps): FileTreeEntry[] {
  const direct = [
    ...asArray(props.entries),
    ...asArray(props.treeEntries),
    ...asArray(props.fileTreeEntries),
    ...asArray(props.workspaceEntries),
    ...asArray(props.nodes),
    ...asArray(props.files),
    ...asArray(props.items),
    ...asArray(props.tree),
    ...asArray(props.fileTree),
    ...asArray(props.workspaceTree?.entries),
    ...asArray(props.workspaceTree?.children),
    ...asArray(props.workspace?.entries),
    ...asArray(props.workspace?.children),
  ];

  return flatten(direct.length > 0 ? direct : candidateObjects(props));
}

function inferType(entry: FileTreeEntry, path: string): "file" | "directory" {
  const type = String(entry.type ?? entry.kind ?? "").toLowerCase();
  const children = [...asArray(entry.children), ...asArray(entry.entries), ...asArray(entry.nodes)];
  if (entry.isDirectory || entry.directory || children.length > 0 || type === "directory" || type === "dir") return "directory";
  if (type === "file") return "file";
  return /\.[^/]+$/.test(path) ? "file" : "directory";
}

function buildTree(entries: FileTreeEntry[], rootName: string, rootPath: string): NormalizedNode {
  const root: NormalizedNode = {
    path: rootPath || rootName || "workspace",
    relativePath: "",
    originalPath: rootPath || rootName || "workspace",
    name: rootName || basename(rootPath) || "workspace",
    type: "directory",
    hidden: false,
    ignored: false,
    children: [],
  };

  const nodes = new Map<string, NormalizedNode>([[root.path, root]]);

  const ensureDir = (path: string, relativePath: string, name: string): NormalizedNode => {
    const existing = nodes.get(path);
    if (existing) return existing;
    const node: NormalizedNode = {
      path,
      relativePath,
      originalPath: path,
      name,
      type: "directory",
      hidden: false,
      ignored: false,
      children: [],
    };
    nodes.set(path, node);
    return node;
  };

  const attach = (parent: NormalizedNode, child: NormalizedNode): void => {
    if (!parent.children.some((existing) => existing.path === child.path)) parent.children.push(child);
  };

  for (const entry of entries) {
    const original = cleanPath(firstString(entry.path, entry.relativePath, entry.fullPath, entry.id, entry.name));
    if (!original) continue;

    let relative = original;
    if (rootPath && relative === rootPath) continue;
    if (rootPath && relative.startsWith(rootPath + "/")) relative = relative.slice(rootPath.length + 1);
    if (root.name && relative === root.name) continue;
    if (root.name && relative.startsWith(root.name + "/")) relative = relative.slice(root.name.length + 1);

    const parts = relative.split("/").filter(Boolean);
    if (parts.length === 0) continue;

    let parent = root;
    let acc = "";

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index] ?? "";
      acc = acc ? `${acc}/${part}` : part;
      const absolute = root.path ? `${root.path}/${acc}` : acc;
      const isLast = index === parts.length - 1;

      const node: NormalizedNode = isLast
        ? {
            path: absolute,
            relativePath: acc,
            originalPath: original,
            name: firstString(entry.name, entry.label, part),
            type: inferType(entry, original),
            hidden: Boolean(entry.hidden ?? entry.isHidden),
            ignored: Boolean(entry.ignored ?? entry.isIgnored),
            children: nodes.get(absolute)?.children ?? [],
          }
        : ensureDir(absolute, acc, part);

      nodes.set(absolute, node);
      attach(parent, node);
      parent = node;
    }
  }

  const sort = (node: NormalizedNode): void => {
    node.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sort);
  };

  sort(root);
  return root;
}

function tokenMatches(tokens: Set<string>, node: NormalizedNode): boolean {
  return tokens.has(node.path) || tokens.has(node.relativePath) || tokens.has(node.originalPath) || tokens.has(node.name);
}

function queryMatches(node: NormalizedNode, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return node.name.toLowerCase().includes(q) || node.relativePath.toLowerCase().includes(q) || node.originalPath.toLowerCase().includes(q);
}

function descendantMatches(node: NormalizedNode, query: string): boolean {
  return queryMatches(node, query) || node.children.some((child) => descendantMatches(child, query));
}

function visibleRows(
  node: NormalizedNode,
  options: {
    query: string;
    showHidden: boolean;
    showIgnored: boolean;
    expanded: Set<string>;
    explicitExpansion: boolean;
  },
  depth = 0,
): Array<{ node: NormalizedNode; depth: number }> {
  const allowed =
    depth === 0 ||
    ((options.showHidden || !node.hidden) &&
      (options.showIgnored || !node.ignored) &&
      descendantMatches(node, options.query));

  if (!allowed) return [];

  const rows = [{ node, depth }];

  const expanded =
    !options.explicitExpansion ||
    depth === 0 ||
    options.query.length > 0 ||
    tokenMatches(options.expanded, node);

  if (!expanded) return rows;

  for (const child of node.children) rows.push(...visibleRows(child, options, depth + 1));
  return rows;
}

export function FileTreePane(props: FileTreePaneProps) {
  const entries = collectInputEntries(props);

  const rootPath = cleanPath(firstString(
    props.rootPath,
    props.workspaceRoot,
    props.workspacePath,
    props.projectRoot,
    props.basePath,
    props.workspace?.rootPath,
    props.workspace?.path,
  ));

  const topDirectory = entries.find((entry) => {
    const path = cleanPath(firstString(entry.path, entry.relativePath, entry.fullPath, entry.name));
    return path && !path.includes("/") && inferType(entry, path) === "directory";
  });

  const rootName = firstString(
    props.rootName,
    props.workspaceName,
    props.projectName,
    props.workspace?.name,
    topDirectory?.name,
    topDirectory?.path,
    basename(rootPath),
  );

  const tree = buildTree(entries, rootName || "adjutorix-app", rootPath);
  const query = String(props.filterQuery ?? props.query ?? props.searchQuery ?? "");
  const showHidden = Boolean(props.showHidden ?? props.includeHidden ?? true);
  const showIgnored = Boolean(props.showIgnored ?? props.includeIgnored ?? true);
  const expansionInput = props.expandedPaths ?? props.expandedDirectoryPaths ?? props.openDirectoryPaths ?? props.expanded;
  const expanded = toSet(expansionInput);
  const explicitExpansion = expansionInput !== undefined;

  const selected = toSet(props.selectedPaths ?? props.selectedPath ?? props.currentPath ?? props.activePath ?? props.selection?.paths ?? props.selection?.path);
  const opened = toSet(props.openedPaths ?? props.openFiles ?? props.openedFiles ?? props.openPaths);

  const health = String(props.healthStatus ?? props.health ?? props.posture ?? props.status ?? "healthy").toLowerCase();
  const degraded = /degraded|error|warning|failed|restricted/.test(health);
  const loading = Boolean(props.loading ?? props.isLoading ?? props.pending);

  const rows = visibleRows(tree, { query, showHidden, showIgnored, expanded, explicitExpansion });
  const dataRows = rows.filter((row) => row.depth > 0);

  const hiddenCount = entries.filter((entry) => Boolean(entry.hidden ?? entry.isHidden)).length;
  const ignoredCount = entries.filter((entry) => Boolean(entry.ignored ?? entry.isIgnored)).length;
  const selectedPath = Array.from(selected)[0] ?? "";

  return (
    <section className="flex h-full min-h-0 flex-col rounded-[2rem] border border-zinc-800 bg-zinc-900/70 shadow-xl">
      <header className="border-b border-zinc-800 px-5 py-4">
        <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Navigation</div>
        <h2 className="mt-1 text-lg font-semibold text-zinc-50">Workspace tree</h2>
        <p className="mt-2 text-sm leading-7 text-zinc-400">Governed file visibility and selection surface</p>

        <div className="mt-4 flex flex-wrap gap-2">
          <span>{degraded ? "degraded" : health}</span>
          <button type="button" onClick={() => invoke(props, ["onRefreshRequested", "onRefresh", "onReloadRequested", "onReload"])}>
            Refresh
          </button>
          <button type="button" onClick={() => invoke(props, ["onToggleShowHidden", "onShowHiddenChange", "onIncludeHiddenChange"], !showHidden)}>
            {showHidden ? "Hide hidden" : "Show hidden"}
          </button>
          <button type="button" onClick={() => invoke(props, ["onToggleShowIgnored", "onShowIgnoredChange", "onIncludeIgnoredChange"], !showIgnored)}>
            {showIgnored ? "Hide ignored" : "Show ignored"}
          </button>
        </div>

        <label className="mt-4 block">
          <span>Search file tree</span>
          <input
            aria-label="Search file tree"
            placeholder="Search file tree"
            value={query}
            onChange={(event) => invoke(props, ["onFilterQueryChange", "onSearchQueryChange", "onQueryChange"], event.currentTarget.value)}
          />
        </label>

        <div className="mt-4 grid grid-cols-2 gap-2 xl:grid-cols-3 2xl:grid-cols-6">
          <div className="min-w-0 rounded-2xl border border-zinc-800 bg-zinc-950/60 px-3 py-2">
            <span className="block truncate text-[0.62rem] uppercase tracking-[0.18em] text-zinc-500">Root</span>
            <strong className="mt-1 block truncate text-sm text-zinc-100" title={tree.path}>{tree.path}</strong>
          </div>
          <div className="min-w-0 rounded-2xl border border-zinc-800 bg-zinc-950/60 px-3 py-2"><span className="block text-[0.62rem] uppercase tracking-[0.18em] text-zinc-500">Total</span><strong className="mt-1 block text-sm text-zinc-100">{entries.length}</strong></div>
          <div className="min-w-0 rounded-2xl border border-zinc-800 bg-zinc-950/60 px-3 py-2"><span className="block text-[0.62rem] uppercase tracking-[0.18em] text-zinc-500">Hidden</span><strong className="mt-1 block text-sm text-zinc-100">{hiddenCount}</strong></div>
          <div className="min-w-0 rounded-2xl border border-zinc-800 bg-zinc-950/60 px-3 py-2"><span className="block text-[0.62rem] uppercase tracking-[0.18em] text-zinc-500">Ignored</span><strong className="mt-1 block text-sm text-zinc-100">{ignoredCount}</strong></div>
          <div className="min-w-0 rounded-2xl border border-zinc-800 bg-zinc-950/60 px-3 py-2"><span className="block text-[0.62rem] uppercase tracking-[0.18em] text-zinc-500">Opened</span><strong className="mt-1 block text-sm text-zinc-100">{opened.size}</strong></div>
          <div className="min-w-0 rounded-2xl border border-zinc-800 bg-zinc-950/60 px-3 py-2"><span className="block text-[0.62rem] uppercase tracking-[0.18em] text-zinc-500">Selected</span><strong className="mt-1 block text-sm text-zinc-100">{selected.size}</strong></div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <span className="min-w-0 flex-1 truncate" title={selectedPath}>Selected path {operatorRelativePath(selectedPath || "none", rootPath)}</span>
          <button type="button" onClick={() => invoke(props, ["onRevealInTree", "onRevealPathRequested", "onRevealPath", "onRevealRequested"], selectedPath)}>
            Reveal
          </button>
          <button type="button" onClick={() => invoke(props, ["onOpenPath", "onOpenPathRequested", "onOpenRequested"], selectedPath)}>
            Open
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto px-3 py-3">
        {loading ? (
          <div>Loading governed file index</div>
        ) : dataRows.length === 0 ? (
          <div>
            <h3>{entries.length === 0 ? "No workspace is open" : "No entries are available"}</h3>
            <p>The file tree is a governed navigation surface, not a blind browser.</p>
          </div>
        ) : (
          <div role="tree" aria-label="Workspace file tree">
            {rows.map(({ node, depth }) => (
              <div
                key={node.path}
                role="treeitem"
                aria-expanded={node.type === "directory" ? true : undefined}
                data-path={node.originalPath}
                data-type={node.type}
                className={`group flex w-full min-w-0 cursor-default items-center gap-2 rounded-xl border px-2 py-1.5 text-left text-sm transition ${
                    tokenMatches(selected, node)
                      ? "border-emerald-700/50 bg-emerald-500/10 text-emerald-100"
                      : "border-transparent text-zinc-300 hover:border-zinc-800 hover:bg-zinc-900/80"
                  }`}
                  style={{ paddingLeft: 8 + depth * 14 }}
                onClick={() => {
                  invoke(props, ["onPathSelected", "onSelectPath", "onPathSelectionRequested", "onFileSelected"], node.originalPath);
                  if (node.type === "file") {
                    invoke(props, ["onOpenPath", "onOpenPathRequested", "onOpenRequested"], node.originalPath);
                  }
                }}
                onDoubleClick={() => {
                  if (node.type === "directory") invoke(props, ["onToggleExpandedPath", "onDirectoryToggleRequested", "onToggleDirectory", "onDirectoryExpandedChange"], node.originalPath);
                }}
              >
                <span className="shrink-0 text-zinc-500">{node.type === "directory" ? "▸" : "•"}</span>
                <span className={`min-w-0 flex-1 truncate ${node.type === "directory" ? "font-semibold" : "font-medium"}`} title={operatorRelativePath(node.originalPath, rootPath)}>{node.name}</span>
                {node.hidden ? <span className="shrink-0 rounded-full bg-zinc-800 px-1.5 py-0.5 text-[0.58rem] uppercase tracking-[0.12em] text-zinc-400">hidden</span> : null}
                {node.ignored ? <span className="shrink-0 rounded-full bg-zinc-800 px-1.5 py-0.5 text-[0.58rem] uppercase tracking-[0.12em] text-zinc-400">ignored</span> : null}
                {tokenMatches(opened, node) ? <span className="shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[0.58rem] uppercase tracking-[0.12em] text-emerald-300">open</span> : null}
              </div>
            ))}
          </div>
        )}
      </main>

      <footer className="border-t border-zinc-800 px-4 py-3 text-xs text-zinc-500">
        <span>review-aware</span>{" "}
        <span>diagnostics-visible</span>{" "}
        <span>preview lineage surfaced</span>{" "}
        <span>trust explicit</span>
      </footer>
    </section>
  );
}

export default FileTreePane;
