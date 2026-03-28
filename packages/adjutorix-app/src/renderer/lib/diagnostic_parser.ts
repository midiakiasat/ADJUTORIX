/*
 * ADJUTORIX APP — RENDERER / LIB / diagnostic_parser.ts
 *
 * Canonical diagnostic normalization, parsing, classification, deduplication, and indexing boundary.
 *
 * Purpose:
 * - normalize heterogeneous diagnostic payloads emitted by shell tools, language servers,
 *   verify runs, agent-side analyzers, TypeScript/ESLint style reporters, and structured runtime checks
 * - centralize severity mapping, source attribution, file/range normalization, stable identity generation,
 *   deduplication, grouping, summary construction, and render-ready filtering helpers
 * - prevent renderer state from depending on producer-specific diagnostic schemas
 *
 * Architectural role:
 * - pure parsing / normalization module
 * - no filesystem I/O, no Electron APIs, no global mutable state, no hidden caching
 * - accepts caller-supplied raw payloads or text blobs and returns explicit normalized structures
 * - suitable for renderer state, diagnostics panels, patch review evidence, verify summaries,
 *   and ledger/job attachments
 *
 * Hard invariants:
 * - identical inputs produce identical normalized outputs
 * - every normalized diagnostic has explicit provenance and severity
 * - file/range normalization does not silently drop known coordinates
 * - deduplication is deterministic and explainable
 * - no producer-specific shape leaks past this boundary unless preserved under raw metadata
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type DiagnosticSeverity = "info" | "warning" | "error" | "fatal";
export type DiagnosticProducerKind =
  | "typescript"
  | "eslint"
  | "shell"
  | "verify"
  | "agent"
  | "runtime"
  | "index"
  | "custom"
  | "unknown";

export type DiagnosticCategory =
  | "syntax"
  | "type"
  | "lint"
  | "runtime"
  | "build"
  | "verification"
  | "indexing"
  | "policy"
  | "unknown";

export interface DiagnosticPosition {
  line: number;
  column: number;
}

export interface DiagnosticRange {
  start: DiagnosticPosition;
  end: DiagnosticPosition;
}

export interface NormalizedDiagnostic {
  id: string;
  fingerprint: string;
  severity: DiagnosticSeverity;
  category: DiagnosticCategory;
  producer: DiagnosticProducerKind;
  sourceLabel: string;
  message: string;
  code?: string | null;
  filePath?: string | null;
  range?: DiagnosticRange | null;
  relatedPaths?: string[];
  tags?: string[];
  jobId?: string | null;
  verifyId?: string | null;
  patchId?: string | null;
  createdAtMs?: number | null;
  raw?: unknown;
}

export interface DiagnosticSummary {
  total: number;
  fatalCount: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  byProducer: Record<string, number>;
  byCategory: Record<string, number>;
  byFile: Record<string, number>;
}

export interface DiagnosticParseResult {
  diagnostics: NormalizedDiagnostic[];
  summary: DiagnosticSummary;
  rejected: DiagnosticReject[];
}

export interface DiagnosticReject {
  reason: string;
  raw: unknown;
}

export interface DiagnosticParseOptions {
  defaultProducer?: DiagnosticProducerKind;
  defaultCategory?: DiagnosticCategory;
  sourceLabel?: string;
  jobId?: string | null;
  verifyId?: string | null;
  patchId?: string | null;
  createdAtMs?: number | null;
  cwd?: string | null;
  dedupe?: boolean;
}

export interface DiagnosticCollectionFilters {
  severities?: DiagnosticSeverity[];
  producers?: DiagnosticProducerKind[];
  categories?: DiagnosticCategory[];
  filePath?: string | null;
  query?: string;
}

export interface DiagnosticProducerHint {
  producer: DiagnosticProducerKind;
  confidence: number;
}

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

export const DIAGNOSTIC_PARSER_VERSION = "1.0.0";

const SEVERITY_RANK: Record<DiagnosticSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
  fatal: 3,
};

const KNOWN_WARNING_WORDS = ["warn", "warning"] as const;
const KNOWN_ERROR_WORDS = ["error", "err", "failed", "failure"] as const;
const KNOWN_FATAL_WORDS = ["fatal", "panic", "crash"] as const;

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalizePath(path: string | null | undefined, cwd?: string | null): string | null {
  const raw = path?.trim();
  if (!raw) return null;

  const slashified = raw.replace(/\\/g, "/");
  if (slashified.startsWith("file://")) {
    return slashified.replace(/^file:\/\//, "");
  }
  if (cwd && !slashified.startsWith("/") && !/^[A-Za-z]:\//.test(slashified)) {
    return `${cwd.replace(/\\/g, "/").replace(/\/+$/, "")}/${slashified.replace(/^\/+/, "")}`;
  }
  return slashified;
}

function normalizePosition(line: unknown, column: unknown): DiagnosticPosition | null {
  const l = asFiniteNumber(line);
  const c = asFiniteNumber(column);
  if (l === null || c === null) return null;
  return {
    line: Math.max(1, Math.floor(l)),
    column: Math.max(1, Math.floor(c)),
  };
}

function normalizeRange(raw: unknown): DiagnosticRange | null {
  if (!isRecord(raw)) return null;

  const startRecord = isRecord(raw.start) ? raw.start : raw;
  const endRecord = isRecord(raw.end) ? raw.end : raw;

  const start = normalizePosition(
    startRecord.line ?? startRecord.startLine ?? startRecord.row,
    startRecord.column ?? startRecord.startColumn ?? startRecord.col,
  );

  const end = normalizePosition(
    endRecord.line ?? endRecord.endLine ?? endRecord.row,
    endRecord.column ?? endRecord.endColumn ?? endRecord.col,
  );

  if (!start) return null;
  return {
    start,
    end: end ?? start,
  };
}

function normalizeSeverity(value: unknown): DiagnosticSeverity | null {
  const raw = asString(value)?.toLowerCase();
  if (!raw) return null;
  if (KNOWN_FATAL_WORDS.some((word) => raw.includes(word))) return "fatal";
  if (KNOWN_ERROR_WORDS.some((word) => raw.includes(word))) return "error";
  if (KNOWN_WARNING_WORDS.some((word) => raw.includes(word))) return "warning";
  if (raw.includes("info") || raw.includes("hint") || raw.includes("note")) return "info";
  return null;
}

function severityFromNumeric(value: unknown): DiagnosticSeverity | null {
  const n = asFiniteNumber(value);
  if (n === null) return null;
  if (n >= 4) return "fatal";
  if (n >= 3) return "error";
  if (n >= 2) return "warning";
  return "info";
}

function normalizeCategory(value: unknown, message?: string | null, producer?: DiagnosticProducerKind): DiagnosticCategory {
  const raw = asString(value)?.toLowerCase();
  const msg = (message ?? "").toLowerCase();

  if (raw) {
    if (raw.includes("syntax")) return "syntax";
    if (raw.includes("type")) return "type";
    if (raw.includes("lint")) return "lint";
    if (raw.includes("runtime")) return "runtime";
    if (raw.includes("build")) return "build";
    if (raw.includes("verify")) return "verification";
    if (raw.includes("index")) return "indexing";
    if (raw.includes("policy")) return "policy";
  }

  if (producer === "eslint") return "lint";
  if (producer === "typescript") return msg.includes("type") ? "type" : "syntax";
  if (producer === "verify") return "verification";
  if (producer === "index") return "indexing";
  if (producer === "runtime") return "runtime";
  if (producer === "shell") return "build";

  if (msg.includes("syntax")) return "syntax";
  if (msg.includes("type ") || msg.includes("assignable") || msg.includes("property")) return "type";
  if (msg.includes("lint")) return "lint";
  if (msg.includes("runtime")) return "runtime";
  if (msg.includes("verify") || msg.includes("verification")) return "verification";

  return "unknown";
}

function detectProducerFromText(text: string): DiagnosticProducerHint {
  const t = text.toLowerCase();
  if (t.includes("eslint")) return { producer: "eslint", confidence: 0.95 };
  if (t.includes("ts") || t.includes("typescript") || /\bts\d{4}\b/i.test(text)) return { producer: "typescript", confidence: 0.9 };
  if (t.includes("verify") || t.includes("verification")) return { producer: "verify", confidence: 0.85 };
  if (t.includes("diagnostic") || t.includes("runtime")) return { producer: "runtime", confidence: 0.7 };
  return { producer: "unknown", confidence: 0.1 };
}

function inferProducer(raw: unknown, fallback: DiagnosticProducerKind = "unknown"): DiagnosticProducerKind {
  if (isRecord(raw)) {
    const explicit =
      normalizeProducer(raw.producer) ??
      normalizeProducer(raw.source) ??
      normalizeProducer(raw.engine) ??
      normalizeProducer(raw.tool) ??
      normalizeProducer(raw.owner);

    if (explicit) return explicit;

    const textBlob = [
      asString(raw.message),
      asString(raw.msg),
      asString(raw.text),
      asString(raw.code),
      asString(raw.ruleId),
    ]
      .filter(Boolean)
      .join(" ");

    if (textBlob) return detectProducerFromText(textBlob).producer;
  }

  if (typeof raw === "string") return detectProducerFromText(raw).producer;
  return fallback;
}

function normalizeProducer(value: unknown): DiagnosticProducerKind | null {
  const raw = asString(value)?.toLowerCase();
  if (!raw) return null;
  if (raw.includes("typescript") || /^ts$/.test(raw) || /^tsc$/.test(raw)) return "typescript";
  if (raw.includes("eslint")) return "eslint";
  if (raw.includes("shell") || raw.includes("stderr") || raw.includes("stdout")) return "shell";
  if (raw.includes("verify")) return "verify";
  if (raw.includes("agent")) return "agent";
  if (raw.includes("runtime")) return "runtime";
  if (raw.includes("index")) return "index";
  if (raw.includes("custom")) return "custom";
  return "unknown";
}

function coalesceMessage(raw: Record<string, unknown>): string | null {
  return (
    asString(raw.message) ??
    asString(raw.msg) ??
    asString(raw.text) ??
    asString(raw.description) ??
    asString(raw.title) ??
    null
  );
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `d${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function buildFingerprint(input: {
  severity: DiagnosticSeverity;
  producer: DiagnosticProducerKind;
  category: DiagnosticCategory;
  filePath?: string | null;
  code?: string | null;
  message: string;
  range?: DiagnosticRange | null;
}): string {
  return stableHash(
    [
      input.severity,
      input.producer,
      input.category,
      input.filePath ?? "",
      input.code ?? "",
      input.message.trim(),
      input.range?.start.line ?? "",
      input.range?.start.column ?? "",
      input.range?.end.line ?? "",
      input.range?.end.column ?? "",
    ].join("|"),
  );
}

function buildSourceLabel(producer: DiagnosticProducerKind, raw: Record<string, unknown>, fallback?: string): string {
  return (
    asString(raw.sourceLabel) ??
    asString(raw.source) ??
    asString(raw.owner) ??
    asString(raw.tool) ??
    fallback ??
    producer
  );
}

function parseStructuredDiagnostic(raw: Record<string, unknown>, options: DiagnosticParseOptions): NormalizedDiagnostic | null {
  const message = coalesceMessage(raw);
  if (!message) return null;

  const producer = inferProducer(raw, options.defaultProducer ?? "unknown");
  const severity =
    normalizeSeverity(raw.severity) ??
    normalizeSeverity(raw.level) ??
    severityFromNumeric(raw.severity) ??
    severityFromNumeric(raw.level) ??
    "error";

  const range =
    normalizeRange(raw.range) ??
    normalizeRange({
      start: {
        line: raw.line ?? raw.startLine ?? raw.row,
        column: raw.column ?? raw.startColumn ?? raw.col,
      },
      end: {
        line: raw.endLine ?? raw.line ?? raw.startLine ?? raw.row,
        column: raw.endColumn ?? raw.column ?? raw.startColumn ?? raw.col,
      },
    });

  const filePath = normalizePath(
    asString(raw.filePath) ?? asString(raw.file) ?? asString(raw.path) ?? asString(raw.filename),
    options.cwd,
  );

  const code = asString(raw.code) ?? asString(raw.ruleId) ?? asString(raw.rule) ?? null;
  const category = normalizeCategory(raw.category, message, producer) || options.defaultCategory || "unknown";

  const tags: string[] = [];
  if (typeof raw.tags === "string") tags.push(raw.tags);
  if (Array.isArray(raw.tags)) {
    for (const tag of raw.tags) {
      const normalized = asString(tag);
      if (normalized) tags.push(normalized);
    }
  }

  const relatedPaths = Array.isArray(raw.relatedPaths)
    ? raw.relatedPaths.map((item) => normalizePath(asString(item), options.cwd)).filter((item): item is string => Boolean(item))
    : [];

  const fingerprint = buildFingerprint({
    severity,
    producer,
    category,
    filePath,
    code,
    message,
    range,
  });

  return {
    id: fingerprint,
    fingerprint,
    severity,
    category,
    producer,
    sourceLabel: buildSourceLabel(producer, raw, options.sourceLabel),
    message,
    code,
    filePath,
    range,
    relatedPaths,
    tags,
    jobId: asString(raw.jobId) ?? options.jobId ?? null,
    verifyId: asString(raw.verifyId) ?? options.verifyId ?? null,
    patchId: asString(raw.patchId) ?? options.patchId ?? null,
    createdAtMs: asFiniteNumber(raw.createdAtMs) ?? options.createdAtMs ?? null,
    raw,
  };
}

function parseTextLineDiagnostic(line: string, options: DiagnosticParseOptions): NormalizedDiagnostic | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const patterns: RegExp[] = [
    /^(?<file>.+?):(?<line>\d+):(?<column>\d+):\s*(?<severity>warning|warn|error|fatal|info)\s*[:\-]?\s*(?<message>.+?)(?:\s+\((?<code>[^)]+)\))?$/i,
    /^(?<file>.+?)\((?<line>\d+),(?<column>\d+)\):\s*(?<severity>warning|error|fatal|info)\s*(?<code>TS\d+)?\s*:?\s*(?<message>.+)$/i,
    /^(?<severity>warning|warn|error|fatal|info)\s*[:\-]\s*(?<message>.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (!match?.groups) continue;

    const producer = inferProducer(trimmed, options.defaultProducer ?? "unknown");
    const message = match.groups.message?.trim();
    if (!message) continue;

    const filePath = normalizePath(match.groups.file ?? null, options.cwd);
    const severity = normalizeSeverity(match.groups.severity) ?? "error";
    const range = match.groups.line
      ? {
          start: {
            line: Math.max(1, Number(match.groups.line)),
            column: Math.max(1, Number(match.groups.column ?? 1)),
          },
          end: {
            line: Math.max(1, Number(match.groups.line)),
            column: Math.max(1, Number(match.groups.column ?? 1)),
          },
        }
      : null;

    const code = match.groups.code?.trim() ?? null;
    const category = normalizeCategory(null, message, producer);
    const fingerprint = buildFingerprint({ severity, producer, category, filePath, code, message, range });

    return {
      id: fingerprint,
      fingerprint,
      severity,
      category,
      producer,
      sourceLabel: options.sourceLabel ?? producer,
      message,
      code,
      filePath,
      range,
      relatedPaths: [],
      tags: [],
      jobId: options.jobId ?? null,
      verifyId: options.verifyId ?? null,
      patchId: options.patchId ?? null,
      createdAtMs: options.createdAtMs ?? null,
      raw: line,
    };
  }

  return null;
}

function dedupeDiagnostics(items: NormalizedDiagnostic[]): NormalizedDiagnostic[] {
  const map = new Map<string, NormalizedDiagnostic>();

  for (const item of items) {
    const existing = map.get(item.fingerprint);
    if (!existing) {
      map.set(item.fingerprint, item);
      continue;
    }

    const winner = choosePreferredDiagnostic(existing, item);
    map.set(item.fingerprint, winner);
  }

  return [...map.values()].sort(compareDiagnostics);
}

function choosePreferredDiagnostic(a: NormalizedDiagnostic, b: NormalizedDiagnostic): NormalizedDiagnostic {
  const score = (item: NormalizedDiagnostic): number => {
    let n = SEVERITY_RANK[item.severity] * 100;
    if (item.filePath) n += 10;
    if (item.range) n += 6;
    if (item.code) n += 4;
    if (item.relatedPaths.length > 0) n += 2;
    return n;
  };

  return score(b) > score(a) ? b : a;
}

function compareDiagnostics(a: NormalizedDiagnostic, b: NormalizedDiagnostic): number {
  const fileA = a.filePath ?? "";
  const fileB = b.filePath ?? "";
  if (fileA !== fileB) return fileA.localeCompare(fileB);

  const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (sev !== 0) return sev;

  const lineA = a.range?.start.line ?? 0;
  const lineB = b.range?.start.line ?? 0;
  if (lineA !== lineB) return lineA - lineB;

  const colA = a.range?.start.column ?? 0;
  const colB = b.range?.start.column ?? 0;
  if (colA !== colB) return colA - colB;

  return a.message.localeCompare(b.message);
}

function summarizeDiagnostics(items: NormalizedDiagnostic[]): DiagnosticSummary {
  const summary: DiagnosticSummary = {
    total: items.length,
    fatalCount: 0,
    errorCount: 0,
    warningCount: 0,
    infoCount: 0,
    byProducer: {},
    byCategory: {},
    byFile: {},
  };

  for (const item of items) {
    if (item.severity === "fatal") summary.fatalCount += 1;
    else if (item.severity === "error") summary.errorCount += 1;
    else if (item.severity === "warning") summary.warningCount += 1;
    else summary.infoCount += 1;

    summary.byProducer[item.producer] = (summary.byProducer[item.producer] ?? 0) + 1;
    summary.byCategory[item.category] = (summary.byCategory[item.category] ?? 0) + 1;
    if (item.filePath) {
      summary.byFile[item.filePath] = (summary.byFile[item.filePath] ?? 0) + 1;
    }
  }

  return summary;
}

// -----------------------------------------------------------------------------
// PUBLIC API
// -----------------------------------------------------------------------------

export function parseDiagnostics(raw: unknown, options: DiagnosticParseOptions = {}): DiagnosticParseResult {
  const diagnostics: NormalizedDiagnostic[] = [];
  const rejected: DiagnosticReject[] = [];

  const consume = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) consume(item);
      return;
    }

    if (typeof value === "string") {
      const lines = value.split(/\r?\n/);
      for (const line of lines) {
        const parsed = parseTextLineDiagnostic(line, options);
        if (parsed) diagnostics.push(parsed);
      }
      return;
    }

    if (isRecord(value)) {
      if (Array.isArray(value.diagnostics)) {
        consume(value.diagnostics);
        return;
      }
      if (Array.isArray(value.errors)) {
        consume(value.errors);
        return;
      }
      if (Array.isArray(value.messages)) {
        consume(value.messages);
        return;
      }

      const parsed = parseStructuredDiagnostic(value, options);
      if (parsed) {
        diagnostics.push(parsed);
      } else {
        rejected.push({ reason: "Structured diagnostic did not contain a parseable message.", raw: value });
      }
      return;
    }

    rejected.push({ reason: "Unsupported diagnostic payload shape.", raw: value });
  };

  consume(raw);

  const normalized = options.dedupe === false ? diagnostics.sort(compareDiagnostics) : dedupeDiagnostics(diagnostics);
  return {
    diagnostics: normalized,
    summary: summarizeDiagnostics(normalized),
    rejected,
  };
}

export function filterDiagnostics(
  diagnostics: NormalizedDiagnostic[],
  filters: DiagnosticCollectionFilters,
): NormalizedDiagnostic[] {
  const query = filters.query?.trim().toLowerCase();
  const severitySet = filters.severities ? new Set(filters.severities) : null;
  const producerSet = filters.producers ? new Set(filters.producers) : null;
  const categorySet = filters.categories ? new Set(filters.categories) : null;
  const filePath = filters.filePath ? normalizePath(filters.filePath) : null;

  return diagnostics.filter((item) => {
    if (severitySet && !severitySet.has(item.severity)) return false;
    if (producerSet && !producerSet.has(item.producer)) return false;
    if (categorySet && !categorySet.has(item.category)) return false;
    if (filePath && normalizePath(item.filePath) !== filePath) return false;

    if (query) {
      const haystack = [
        item.message,
        item.code ?? "",
        item.filePath ?? "",
        item.sourceLabel,
        item.producer,
        item.category,
        ...item.tags,
      ]
        .join(" ")
        .toLowerCase();

      if (!haystack.includes(query)) return false;
    }

    return true;
  });
}

export function groupDiagnosticsByFile(diagnostics: NormalizedDiagnostic[]): Record<string, NormalizedDiagnostic[]> {
  const result: Record<string, NormalizedDiagnostic[]> = {};
  for (const item of diagnostics) {
    const key = item.filePath ?? "__unbound__";
    if (!result[key]) result[key] = [];
    result[key].push(item);
  }

  for (const key of Object.keys(result)) {
    result[key].sort(compareDiagnostics);
  }

  return result;
}

export function getMostSevereDiagnostic(diagnostics: NormalizedDiagnostic[]): NormalizedDiagnostic | null {
  if (diagnostics.length === 0) return null;
  return [...diagnostics].sort(compareDiagnostics)[0] ?? null;
}

export function formatDiagnosticLocation(diagnostic: NormalizedDiagnostic): string {
  if (!diagnostic.filePath) return "unbound";
  if (!diagnostic.range) return diagnostic.filePath;
  return `${diagnostic.filePath}:${diagnostic.range.start.line}:${diagnostic.range.start.column}`;
}

export function buildDiagnosticDisplayModel(diagnostic: NormalizedDiagnostic): {
  title: string;
  subtitle: string;
  badges: string[];
} {
  const badges = [diagnostic.severity, diagnostic.producer, diagnostic.category];
  if (diagnostic.code) badges.push(diagnostic.code);
  if (diagnostic.filePath) badges.push(formatDiagnosticLocation(diagnostic));

  return {
    title: diagnostic.message,
    subtitle: `${diagnostic.sourceLabel}${diagnostic.filePath ? ` • ${formatDiagnosticLocation(diagnostic)}` : ""}`,
    badges,
  };
}

// -----------------------------------------------------------------------------
// TEST-ORIENTED PURE UTILITIES
// -----------------------------------------------------------------------------

export function __private__stableHash(value: string): string {
  return stableHash(value);
}

export function __private__normalizeSeverity(value: unknown): DiagnosticSeverity | null {
  return normalizeSeverity(value) ?? severityFromNumeric(value);
}

export function __private__normalizeProducer(value: unknown): DiagnosticProducerKind | null {
  return normalizeProducer(value);
}

export function __private__normalizePath(path: string | null | undefined, cwd?: string | null): string | null {
  return normalizePath(path, cwd);
}

export function __private__normalizeRange(raw: unknown): DiagnosticRange | null {
  return normalizeRange(raw);
}
