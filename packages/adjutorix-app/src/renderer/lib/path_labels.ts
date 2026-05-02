/*
 * ADJUTORIX APP — RENDERER / LIB / path_labels.ts
 *
 * Canonical path normalization, labeling, abbreviation, disambiguation, and display-model boundary.
 *
 * Purpose:
 * - provide one deterministic renderer-side source of truth for converting raw filesystem-like paths
 *   into operator-facing labels used by tabs, trees, diagnostics, search results, diffs, ledger rows,
 *   patch review surfaces, breadcrumbs, and status bars
 * - centralize path normalization, basename extraction, workspace-relative shortening,
 *   collision-aware disambiguation, truncation, breadcrumb generation, and group labeling
 * - prevent each feature surface from inventing its own unstable path rendering rules
 *
 * Architectural role:
 * - pure path-display policy module
 * - no filesystem I/O, no path existence checks, no global mutable caches, no platform probing
 * - accepts caller-supplied raw paths plus optional workspace/context metadata
 * - returns explicit, reproducible display labels and label models that higher-level UI can render
 *
 * Hard invariants:
 * - identical inputs produce identical normalized paths and labels
 * - workspace-relative shortening never destroys uniqueness without an explicit disambiguation step
 * - basename, dirname, breadcrumb, and compact label outputs are mutually consistent
 * - separator normalization is deterministic and independent of UI surface
 * - no hidden state, no heuristic randomness, no implicit environment dependence
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type PathSeparatorStyle = "slash" | "backslash";
export type PathLabelStrategy =
  | "basename"
  | "workspace-relative"
  | "smart-compact"
  | "full"
  | "breadcrumb"
  | "disambiguated";

export interface PathLabelContext {
  workspaceRoots?: string[];
  preferredSeparator?: PathSeparatorStyle;
  homePath?: string | null;
  maxLabelLength?: number;
  disambiguationDepth?: number;
}

export interface PathParts {
  original: string;
  normalized: string;
  root: string;
  segments: string[];
  basename: string;
  dirname: string;
  extension: string;
  isAbsolute: boolean;
  isWindowsDrivePath: boolean;
  isUncPath: boolean;
}

export interface PathLabelModel {
  original: string;
  normalized: string;
  basename: string;
  dirname: string;
  workspaceRelative: string | null;
  compact: string;
  full: string;
  breadcrumb: string[];
  display: string;
  tooltip: string;
  strategy: PathLabelStrategy;
  disambiguator?: string | null;
}

export interface PathCollisionGroup {
  basename: string;
  normalizedPaths: string[];
  labels: Record<string, string>;
}

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

export const PATH_LABELS_VERSION = "1.0.0";

const DEFAULT_CONTEXT: Readonly<Required<Omit<PathLabelContext, "workspaceRoots" | "homePath">> & Pick<PathLabelContext, "workspaceRoots" | "homePath">> = Object.freeze({
  workspaceRoots: [],
  preferredSeparator: "slash",
  homePath: null,
  maxLabelLength: 48,
  disambiguationDepth: 2,
});

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function withContext(context?: PathLabelContext): Required<Omit<PathLabelContext, "workspaceRoots" | "homePath">> & Pick<PathLabelContext, "workspaceRoots" | "homePath"> {
  return {
    workspaceRoots: context?.workspaceRoots?.slice() ?? DEFAULT_CONTEXT.workspaceRoots ?? [],
    preferredSeparator: context?.preferredSeparator ?? DEFAULT_CONTEXT.preferredSeparator,
    homePath: context?.homePath ?? DEFAULT_CONTEXT.homePath,
    maxLabelLength: context?.maxLabelLength ?? DEFAULT_CONTEXT.maxLabelLength,
    disambiguationDepth: context?.disambiguationDepth ?? DEFAULT_CONTEXT.disambiguationDepth,
  };
}

function toSlash(path: string): string {
  return path.replace(/\\/g, "/");
}

function collapseSlashes(path: string): string {
  if (path.startsWith("//")) {
    const body = path.slice(2).replace(/\/+/g, "/");
    return `//${body}`;
  }
  return path.replace(/\/+/g, "/");
}

function trimTrailingSlash(path: string): string {
  if (path === "/") return "/";
  if (/^[A-Za-z]:\/$/.test(path)) return path;
  if (path.startsWith("//") && path.split("/").filter(Boolean).length <= 2) return path;
  return path.replace(/\/+$/, "");
}

function normalizeRawPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  let slashified = toSlash(trimmed);

  if (slashified.startsWith("file://")) {
    slashified = slashified.replace(/^file:\/\//, "");
    if (!slashified.startsWith("/") && !/^[A-Za-z]:\//.test(slashified)) {
      slashified = `/${slashified}`;
    }
  }

  slashified = collapseSlashes(slashified);
  slashified = trimTrailingSlash(slashified);

  return slashified;
}

function preferredSeparator(path: string, style: PathSeparatorStyle): string {
  return style === "backslash" ? path.replace(/\//g, "\\") : path;
}

function splitRoot(normalized: string): { root: string; rest: string; isAbsolute: boolean; isWindowsDrivePath: boolean; isUncPath: boolean } {
  if (!normalized) {
    return { root: "", rest: "", isAbsolute: false, isWindowsDrivePath: false, isUncPath: false };
  }

  if (normalized.startsWith("//")) {
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length >= 2) {
      const root = `//${parts[0]}/${parts[1]}`;
      const rest = normalized.slice(root.length).replace(/^\//, "");
      return { root, rest, isAbsolute: true, isWindowsDrivePath: false, isUncPath: true };
    }
  }

  const drive = normalized.match(/^([A-Za-z]:)(\/.*)?$/);
  if (drive) {
    return {
      root: drive[1] + "/",
      rest: (drive[2] ?? "").replace(/^\//, ""),
      isAbsolute: true,
      isWindowsDrivePath: true,
      isUncPath: false,
    };
  }

  if (normalized.startsWith("/")) {
    return {
      root: "/",
      rest: normalized.slice(1),
      isAbsolute: true,
      isWindowsDrivePath: false,
      isUncPath: false,
    };
  }

  return {
    root: "",
    rest: normalized,
    isAbsolute: false,
    isWindowsDrivePath: false,
    isUncPath: false,
  };
}

function ellipsizeMiddle(value: string, maxLength: number): string {
  if (maxLength < 5 || value.length <= maxLength) return value;
  const budget = maxLength - 1;
  const left = Math.ceil(budget / 2);
  const right = Math.floor(budget / 2);
  return `${value.slice(0, left)}…${value.slice(value.length - right)}`;
}

function joinSegments(root: string, segments: string[]): string {
  const body = segments.join("/");
  if (!root) return body;
  if (!body) return root;
  if (root === "/") return `/${body}`;
  if (root.endsWith("/")) return `${root}${body}`;
  return `${root}/${body}`;
}

function longestCommonPrefixSegmentCount(paths: string[][]): number {
  if (paths.length === 0) return 0;
  const minLen = Math.min(...paths.map((parts) => parts.length));
  let count = 0;
  for (let i = 0; i < minLen; i += 1) {
    const token = paths[0]![i]!;
    if (paths.every((parts) => parts[i] === token)) count += 1;
    else break;
  }
  return count;
}

function pickWorkspaceRoot(normalizedPath: string, roots: string[]): string | null {
  const sorted = roots
    .map(normalizeRawPath)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  for (const root of sorted) {
    if (normalizedPath === root) return root;
    if (normalizedPath.startsWith(`${root}/`)) return root;
  }
  return null;
}

function computeWorkspaceRelative(normalizedPath: string, context: ReturnType<typeof withContext>): string | null {
  const root = pickWorkspaceRoot(normalizedPath, context.workspaceRoots ?? []);
  if (!root) return null;
  if (normalizedPath === root) return ".";
  return normalizedPath.slice(root.length + 1);
}

function computeCompactLabel(parts: PathParts, context: ReturnType<typeof withContext>): string {
  if (!parts.normalized) return "";

  const relative = computeWorkspaceRelative(parts.normalized, context);
  const preferredBase = relative ?? parts.normalized;
  if (preferredBase.length <= context.maxLabelLength) return preferredSeparator(preferredBase, context.preferredSeparator);

  if (parts.segments.length <= 2) {
    return preferredSeparator(ellipsizeMiddle(preferredBase, context.maxLabelLength), context.preferredSeparator);
  }

  const first = parts.segments[0] ?? "";
  const last = parts.basename;
  const middle = parts.segments.length > 2 ? "…" : "";
  const joined = [first, middle, last].filter(Boolean).join("/");
  return preferredSeparator(ellipsizeMiddle(joined, context.maxLabelLength), context.preferredSeparator);
}

function computeBreadcrumb(parts: PathParts): string[] {
  if (!parts.normalized) return [];
  const out: string[] = [];
  if (parts.root) out.push(parts.root);
  for (const segment of parts.segments) out.push(segment);
  return out;
}

function computeDisambiguator(parts: PathParts, depth: number): string | null {
  if (parts.segments.length <= 1) return null;
  const parentSegments = parts.segments.slice(0, -1);
  const slice = parentSegments.slice(Math.max(0, parentSegments.length - depth));
  return slice.length > 0 ? slice.join("/") : null;
}

// -----------------------------------------------------------------------------
// PUBLIC API
// -----------------------------------------------------------------------------

export function parsePathParts(rawPath: string): PathParts {
  const normalized = normalizeRawPath(rawPath);
  const rootInfo = splitRoot(normalized);
  const segments = rootInfo.rest.split("/").filter(Boolean);
  const basename = segments[segments.length - 1] ?? (rootInfo.root || "");
  const dirnameSegments = segments.slice(0, -1);
  const dirname = joinSegments(rootInfo.root, dirnameSegments);
  const extensionMatch = basename.match(/(\.[^.]+)$/);
  const extension = extensionMatch?.[1]?.toLowerCase() ?? "";

  return {
    original: rawPath,
    normalized,
    root: rootInfo.root,
    segments,
    basename,
    dirname,
    extension,
    isAbsolute: rootInfo.isAbsolute,
    isWindowsDrivePath: rootInfo.isWindowsDrivePath,
    isUncPath: rootInfo.isUncPath,
  };
}

export function getBasename(rawPath: string): string {
  return parsePathParts(rawPath).basename;
}

export function getDirname(rawPath: string): string {
  return parsePathParts(rawPath).dirname;
}

export function getExtension(rawPath: string): string {
  return parsePathParts(rawPath).extension;
}

export function normalizeDisplayPath(rawPath: string, preferred: PathSeparatorStyle = "slash"): string {
  return preferredSeparator(parsePathParts(rawPath).normalized, preferred);
}

export function buildPathLabelModel(
  rawPath: string,
  strategy: PathLabelStrategy = "smart-compact",
  context?: PathLabelContext,
): PathLabelModel {
  const resolved = withContext(context);
  const parts = parsePathParts(rawPath);
  const workspaceRelative = computeWorkspaceRelative(parts.normalized, resolved);
  const compact = computeCompactLabel(parts, resolved);
  const full = preferredSeparator(parts.normalized, resolved.preferredSeparator);
  const breadcrumb = computeBreadcrumb(parts).map((part) => preferredSeparator(part, resolved.preferredSeparator));
  const disambiguator = computeDisambiguator(parts, resolved.disambiguationDepth);

  let display: string;
  switch (strategy) {
    case "basename":
      display = parts.basename;
      break;
    case "workspace-relative":
      display = workspaceRelative ? preferredSeparator(workspaceRelative, resolved.preferredSeparator) : full;
      break;
    case "full":
      display = full;
      break;
    case "breadcrumb":
      display = breadcrumb.join(resolved.preferredSeparator === "backslash" ? " \\ " : " / ");
      break;
    case "disambiguated":
      display = disambiguator ? `${parts.basename} — ${preferredSeparator(disambiguator, resolved.preferredSeparator)}` : parts.basename;
      break;
    case "smart-compact":
    default:
      display = compact;
      break;
  }

  const homePath = resolved.homePath ? normalizeRawPath(resolved.homePath) : null;
  const tooltipBase = homePath && parts.normalized.startsWith(homePath)
    ? `~${parts.normalized.slice(homePath.length) || "/"}`
    : parts.normalized;

  return {
    original: rawPath,
    normalized: parts.normalized,
    basename: parts.basename,
    dirname: parts.dirname,
    workspaceRelative,
    compact,
    full,
    breadcrumb,
    display,
    tooltip: preferredSeparator(tooltipBase, resolved.preferredSeparator),
    strategy,
    disambiguator,
  };
}

export function disambiguatePathLabelGroups(
  rawPaths: string[],
  context?: PathLabelContext,
): PathCollisionGroup[] {
  const resolved = withContext(context);
  const parsed = rawPaths.map((path) => parsePathParts(path));
  const byBasename = new Map<string, PathParts[]>();

  for (const item of parsed) {
    const key = item.basename || item.normalized;
    const existing = byBasename.get(key);
    if (existing) existing.push(item);
    else byBasename.set(key, [item]);
  }

  const groups: PathCollisionGroup[] = [];

  for (const [basename, items] of [...byBasename.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const normalizedPaths = items.map((item) => item.normalized).sort((a, b) => a.localeCompare(b));

    if (items.length === 1) {
      groups.push({
        basename,
        normalizedPaths,
        labels: { [items[0]!.normalized]: items[0]!.basename },
      });
      continue;
    }

    const parentSegments = items.map((item) => item.segments.slice(0, -1));
    const commonPrefix = longestCommonPrefixSegmentCount(parentSegments);
    const labels: Record<string, string> = {};

    for (const item of items) {
      const uniqueTail = item.segments.slice(commonPrefix, -1);
      const scopedTail = uniqueTail.length > 0
        ? uniqueTail.join("/")
        : (computeDisambiguator(item, resolved.disambiguationDepth) ?? item.dirname ?? item.root ?? ".");

      const label = scopedTail && scopedTail !== "."
        ? `${item.basename} — ${preferredSeparator(scopedTail, resolved.preferredSeparator)}`
        : item.basename;

      labels[item.normalized] = label;
    }

    groups.push({ basename, normalizedPaths, labels });
  }

  return groups;
}

export function labelPathSet(
  rawPaths: string[],
  context?: PathLabelContext,
): Record<string, PathLabelModel> {
  const resolved = withContext(context);
  const groups = disambiguatePathLabels(rawPaths, resolved);
  const disambiguatedMap = new Map<string, string>();

  for (const group of groups) {
    for (const [normalized, label] of Object.entries(group.labels)) {
      disambiguatedMap.set(normalized, label);
    }
  }

  const out: Record<string, PathLabelModel> = {};

  for (const rawPath of rawPaths) {
    const model = buildPathLabelModel(rawPath, "smart-compact", resolved);
    const disambiguated = disambiguatedMap.get(model.normalized);

    out[rawPath] = {
      ...model,
      display: disambiguated && disambiguated !== model.basename ? disambiguated : model.display,
      strategy: disambiguated && disambiguated !== model.basename ? "disambiguated" : model.strategy,
    };
  }

  return out;
}

export function buildBreadcrumbLabel(
  rawPath: string,
  context?: PathLabelContext,
): string {
  const resolved = withContext(context);
  const model = buildPathLabelModel(rawPath, "breadcrumb", resolved);
  return model.display;
}

export function summarizePathGroup(rawPaths: string[], context?: PathLabelContext): {
  count: number;
  commonPrefix: string;
  labels: string[];
} {
  const resolved = withContext(context);
  const parsed = rawPaths.map(parsePathParts);
  const allSegments = parsed.map((item) => [item.root, ...item.segments].filter(Boolean));
  const prefixCount = longestCommonPrefixSegmentCount(allSegments);
  const commonPrefix = allSegments.length > 0
    ? preferredSeparator(allSegments[0]!.slice(0, prefixCount).join("/"), resolved.preferredSeparator)
    : "";

  const labels = Object.values(labelPathSet(rawPaths, resolved))
    .map((model) => model.display)
    .sort((a, b) => a.localeCompare(b));

  return {
    count: rawPaths.length,
    commonPrefix,
    labels,
  };
}

// -----------------------------------------------------------------------------
// TEST-ORIENTED PURE UTILITIES
// -----------------------------------------------------------------------------

export function __private__normalizeRawPath(rawPath: string): string {
  return normalizeRawPath(rawPath);
}

export function __private__splitRoot(normalized: string): ReturnType<typeof splitRoot> {
  return splitRoot(normalized);
}

export function __private__ellipsizeMiddle(value: string, maxLength: number): string {
  return ellipsizeMiddle(value, maxLength);
}

export function __private__computeWorkspaceRelative(
  normalizedPath: string,
  context?: PathLabelContext,
): string | null {
  return computeWorkspaceRelative(normalizedPath, withContext(context));
}


// -----------------------------------------------------------------------------
// ADJUTORIX_TEST_COMPAT_PATH_LABEL_EXPORTS
// -----------------------------------------------------------------------------

export interface ShortPathLabelContext {
  workspaceRoot?: string | null;
  workspaceRoots?: string[];
  allPaths?: string[];
  maxLabelLength?: number;
}

function pathLabelWorkspaceRoot(context?: ShortPathLabelContext): string | null {
  if (context?.workspaceRoot) return normalizeRawPath(context.workspaceRoot);
  const first = context?.workspaceRoots?.find((root) => root.trim().length > 0);
  return first ? normalizeRawPath(first) : null;
}

function pathLabelSegments(rawPath: string, workspaceRoot?: string | null): string[] {
  const normalized = normalizeRawPath(rawPath);
  const root = workspaceRoot ? normalizeRawPath(workspaceRoot) : null;
  const label = root ? relativePathLabel(normalized, root) : normalized;
  if (!label || label === ".") return [];
  return label.replace(/^\/+/, "").split("/").filter(Boolean);
}

export function normalizePathForLabeling(path: string): string {
  return normalizeRawPath(path);
}

export function basenameLabel(path: string): string {
  const normalized = normalizeRawPath(path);
  if (!normalized) return "";

  const parts = splitRoot(normalized);
  if (!parts.rest) return parts.root || normalized;

  const segments = parts.rest.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? parts.root ?? normalized;
}

export function dirnameLabel(path: string): string {
  const normalized = normalizeRawPath(path);
  if (!normalized) return "";

  const parts = splitRoot(normalized);
  if (!parts.rest) return parts.root || normalized;

  const segments = parts.rest.split("/").filter(Boolean);
  if (segments.length <= 1) return parts.root || ".";

  return joinSegments(parts.root, segments.slice(0, -1));
}

export function relativePathLabel(path: string, workspaceRoot?: string | null): string {
  const normalized = normalizeRawPath(path);
  const root = workspaceRoot ? normalizeRawPath(workspaceRoot) : "";

  if (!root) return normalized;
  if (normalized === root) return ".";

  const boundary = root.endsWith("/") ? root : `${root}/`;
  if (normalized.startsWith(boundary)) return normalized.slice(boundary.length);

  return normalized;
}

export function breadcrumbLabel(path: string, workspaceRoot?: string | null): string {
  const label = workspaceRoot ? relativePathLabel(path, workspaceRoot) : normalizeRawPath(path);
  if (label === ".") return ".";

  const segments = label.replace(/^\/+/, "").split("/").filter(Boolean);
  return segments.join(" / ") || label || basenameLabel(path);
}

export function commonPathPrefix(paths: string[]): string {
  const normalized = paths.map(normalizeRawPath).filter(Boolean);
  if (normalized.length === 0) return "";

  const split = normalized.map((path) => {
    const parts = splitRoot(path);
    return {
      root: parts.root,
      absolute: parts.isAbsolute,
      segments: parts.rest.split("/").filter(Boolean),
    };
  });

  const firstRoot = split[0]?.root ?? "";
  const sameRoot = split.every((entry) => entry.root === firstRoot);

  if (!sameRoot) {
    return split.every((entry) => entry.absolute) ? "/" : "";
  }

  const minLength = Math.min(...split.map((entry) => entry.segments.length));
  let count = 0;

  for (let index = 0; index < minLength; index += 1) {
    const token = split[0]!.segments[index];
    if (split.every((entry) => entry.segments[index] === token)) count += 1;
    else break;
  }

  return joinSegments(firstRoot, split[0]!.segments.slice(0, count));
}

export function disambiguatePathLabels(
  paths: string[],
  context: ShortPathLabelContext = {},
): Record<string, string> {
  const workspaceRoot = pathLabelWorkspaceRoot(context);
  const result: Record<string, string> = {};
  const groups = new Map<string, string[]>();

  for (const path of paths) {
    const base = basenameLabel(path);
    const bucket = groups.get(base) ?? [];
    bucket.push(path);
    groups.set(base, bucket);
  }

  for (const [base, group] of groups.entries()) {
    if (group.length === 1) {
      result[group[0]!] = base;
      continue;
    }

    const segmentSets = group.map((path) => {
      const segments = pathLabelSegments(path, workspaceRoot);
      return segments.length > 0 ? segments : [basenameLabel(path)];
    });

    const maxDepth = Math.max(...segmentSets.map((segments) => segments.length));
    let labels = group.map(() => base);

    for (let depth = 1; depth <= maxDepth; depth += 1) {
      const candidate = segmentSets.map((segments) => segments.slice(-depth).join("/"));
      if (new Set(candidate).size === candidate.length) {
        labels = candidate;
        break;
      }
    }

    if (new Set(labels).size !== labels.length) {
      labels = group.map((path) => relativePathLabel(path, workspaceRoot) || normalizeRawPath(path));
    }

    group.forEach((path, index) => {
      result[path] = labels[index] || basenameLabel(path);
    });
  }

  return result;
}

export function shortPathLabel(path: string, context: ShortPathLabelContext = {}): string {
  if (context.allPaths && context.allPaths.length > 0) {
    const labels = disambiguatePathLabels(context.allPaths, context);
    return labels[path] ?? basenameLabel(path);
  }

  return basenameLabel(path);
}
