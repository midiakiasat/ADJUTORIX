export type DiagnosticSeverity = "fatal" | "error" | "warning" | "info";

export type DiagnosticRange = {
  start: { line: number; column: number };
  end: { line: number; column: number };
};

export type CanonicalDiagnostic = {
  id: string;
  severity: DiagnosticSeverity;
  producer: string;
  sourceLabel: string | null;
  source: string | null;
  category: string | null;
  code: string | null;
  message: string;
  filePath: string | null;
  range: DiagnosticRange | null;
  startLine: number | null;
  startColumn: number | null;
  endLine: number | null;
  endColumn: number | null;
  relatedPaths: string[];
  tags: string[];
  verifyId: string | null;
  patchId: string | null;
  jobId: string | null;
  raw: unknown;
};

export type DiagnosticSummary = {
  total: number;
  fatalCount: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  bySeverity: Record<DiagnosticSeverity, number>;
  byProducer: Record<string, number>;
  byCategory: Record<string, number>;
  byFile: Record<string, number>;
};

function text(value: unknown): string {
  if (value == null) return "";
  return String(value).trim();
}

function lower(value: unknown): string {
  return text(value).toLowerCase();
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function pathOrNull(value: unknown): string | null {
  const out = text(value).replaceAll("\\", "/");
  return out ? out : null;
}

function arrayOfText(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  const out = text(value);
  return out ? [out] : [];
}

function messageFrom(raw: any): string {
  const value =
    raw?.message ??
    raw?.messageText ??
    raw?.detail ??
    raw?.description ??
    raw?.text ??
    raw?.reason;

  if (typeof value === "object" && value != null) {
    return text(value.messageText ?? value.message ?? JSON.stringify(value));
  }

  return text(value);
}

function producerFrom(raw: any): string {
  const candidate = lower(raw?.producer ?? raw?.tool ?? raw?.engine ?? raw?.kind ?? raw?.source);

  if (candidate.includes("typescript") || candidate === "tsc" || candidate === "tsserver") return "typescript";
  if (candidate.includes("eslint") || candidate.includes("lint")) return "eslint";
  if (candidate.includes("verify")) return "verify";
  if (candidate.includes("replay")) return "replay";
  if (candidate.includes("vitest") || candidate.includes("test")) return "test";

  return candidate || "unknown";
}

function sourceLabelFrom(raw: any, producer: string): string | null {
  const direct = text(raw?.sourceLabel ?? raw?.source);
  if (direct) return direct;

  if (producer === "typescript") return text(raw?.tool) || "tsc";
  if (producer === "eslint") return text(raw?.tool) || "eslint";
  return text(raw?.tool) || null;
}

function severityFrom(raw: any, producer: string): DiagnosticSeverity {
  const value = raw?.severity ?? raw?.level ?? raw?.category ?? raw?.type;
  const valueText = lower(value);

  if (["fatal", "panic", "critical", "blocker"].includes(valueText)) return "fatal";
  if (["error", "err", "failure", "failed"].includes(valueText)) return "error";
  if (["warning", "warn"].includes(valueText)) return "warning";
  if (["info", "information", "message", "notice", "suggestion", "hint"].includes(valueText)) return "info";

  const numeric = numberOrNull(value);

  if (producer === "typescript") {
    if (numeric === 1) return "error";
    if (numeric === 0) return "warning";
    if (numeric === 2 || numeric === 3) return "info";
  }

  if (producer === "eslint") {
    if (numeric === 2) return "error";
    if (numeric === 1) return "warning";
    if (numeric === 0) return "info";
  }

  if (numeric != null) {
    if (numeric >= 3) return "fatal";
    if (numeric === 2) return "error";
    if (numeric === 1) return "warning";
  }

  return "info";
}

function codeFrom(raw: any, producer: string): string | null {
  const value = raw?.code ?? raw?.ruleId ?? raw?.rule ?? raw?.name;

  if (value == null || value === "") return null;

  if (producer === "typescript" && /^\d+$/.test(String(value))) return `TS${value}`;

  return String(value);
}

function categoryFrom(raw: any, producer: string): string | null {
  const direct = lower(raw?.categoryName ?? raw?.diagnosticCategory ?? raw?.type);

  if (direct && !/^\d+$/.test(direct)) return direct;

  if (producer === "typescript") return "compile";
  if (producer === "eslint") return "lint";
  if (producer === "verify" || producer === "replay") return "verification";

  const fallback = lower(raw?.category);
  if (fallback && !/^\d+$/.test(fallback)) return fallback;

  return null;
}

function filePathFrom(raw: any): string | null {
  return pathOrNull(
    raw?.filePath ??
      raw?.file ??
      raw?.filename ??
      raw?.path ??
      raw?.uri ??
      raw?.location?.file ??
      raw?.loc?.file
  );
}

function lineFrom(raw: any): number | null {
  return numberOrNull(
    raw?.startLine ??
      raw?.line ??
      raw?.start?.line ??
      raw?.location?.line ??
      raw?.location?.start?.line ??
      raw?.loc?.line ??
      raw?.loc?.start?.line
  );
}

function columnFrom(raw: any): number | null {
  return numberOrNull(
    raw?.startColumn ??
      raw?.column ??
      raw?.start?.column ??
      raw?.start?.character ??
      raw?.location?.column ??
      raw?.location?.start?.column ??
      raw?.loc?.column ??
      raw?.loc?.start?.column
  );
}

function endLineFrom(raw: any, startLine: number | null): number | null {
  return numberOrNull(
    raw?.endLine ??
      raw?.end?.line ??
      raw?.location?.endLine ??
      raw?.location?.end?.line ??
      raw?.loc?.end?.line
  ) ?? startLine;
}

function endColumnFrom(raw: any, startColumn: number | null): number | null {
  return numberOrNull(
    raw?.endColumn ??
      raw?.end?.column ??
      raw?.end?.character ??
      raw?.location?.endColumn ??
      raw?.location?.end?.column ??
      raw?.loc?.end?.column
  ) ?? startColumn;
}

function rangeFrom(raw: any): {
  range: DiagnosticRange | null;
  startLine: number | null;
  startColumn: number | null;
  endLine: number | null;
  endColumn: number | null;
} {
  const startLine = lineFrom(raw);
  const startColumn = columnFrom(raw);
  const endLine = endLineFrom(raw, startLine);
  const endColumn = endColumnFrom(raw, startColumn);

  if (startLine == null || startColumn == null) {
    return {
      range: null,
      startLine: null,
      startColumn: null,
      endLine: null,
      endColumn: null,
    };
  }

  return {
    range: {
      start: { line: startLine, column: startColumn },
      end: {
        line: endLine ?? startLine,
        column: endColumn ?? startColumn,
      },
    },
    startLine,
    startColumn,
    endLine: endLine ?? startLine,
    endColumn: endColumn ?? startColumn,
  };
}

export function parseDiagnostic(raw: unknown): CanonicalDiagnostic {
  if (!raw || typeof raw !== "object") {
    throw new Error("Diagnostic payload must be an object");
  }

  const item = raw as any;
  const message = messageFrom(item);

  if (!message) {
    throw new Error("Diagnostic payload is missing message");
  }

  const producer = producerFrom(item);
  const severity = severityFrom(item, producer);
  const rangeParts = rangeFrom(item);

  const parsed: CanonicalDiagnostic = {
    id: "",
    severity,
    producer,
    sourceLabel: sourceLabelFrom(item, producer),
    source: sourceLabelFrom(item, producer),
    category: categoryFrom(item, producer),
    code: codeFrom(item, producer),
    message,
    filePath: filePathFrom(item),
    range: rangeParts.range,
    startLine: rangeParts.startLine,
    startColumn: rangeParts.startColumn,
    endLine: rangeParts.endLine,
    endColumn: rangeParts.endColumn,
    relatedPaths: [
      ...arrayOfText(item.relatedPaths),
      ...arrayOfText(item.relatedFiles),
      ...arrayOfText(item.references),
      ...arrayOfText(item.lineage),
    ],
    tags: arrayOfText(item.tags),
    verifyId: text(item.verifyId ?? item.verificationId ?? item.verify_id) || null,
    patchId: text(item.patchId ?? item.patch_id) || null,
    jobId: text(item.jobId ?? item.job_id ?? item.runId ?? item.run_id) || null,
    raw,
  };

  parsed.id = fingerprintDiagnostic(parsed);
  return parsed;
}

export function parseDiagnostics(rawDiagnostics: unknown): CanonicalDiagnostic[] {
  if (!Array.isArray(rawDiagnostics)) return [];
  return rawDiagnostics.map((raw) => parseDiagnostic(raw));
}

export function fingerprintDiagnostic(diagnostic: CanonicalDiagnostic): string {
  return [
    diagnostic.producer,
    diagnostic.code ?? "",
    diagnostic.filePath ?? "",
    diagnostic.startLine ?? "",
    diagnostic.startColumn ?? "",
    diagnostic.message,
  ]
    .map((part) => String(part).toLowerCase())
    .join("|");
}

const severityRank: Record<DiagnosticSeverity, number> = {
  fatal: 0,
  error: 1,
  warning: 2,
  info: 3,
};

export function diagnosticSortKey(diagnostic: CanonicalDiagnostic): string {
  return [
    String(severityRank[diagnostic.severity] ?? 9).padStart(2, "0"),
    diagnostic.filePath ?? "",
    String(diagnostic.startLine ?? 0).padStart(8, "0"),
    String(diagnostic.startColumn ?? 0).padStart(8, "0"),
    diagnostic.message,
  ].join("|");
}

export function summarizeDiagnostics(diagnostics: CanonicalDiagnostic[]): DiagnosticSummary {
  const summary: DiagnosticSummary = {
    total: diagnostics.length,
    fatalCount: 0,
    errorCount: 0,
    warningCount: 0,
    infoCount: 0,
    bySeverity: {
      fatal: 0,
      error: 0,
      warning: 0,
      info: 0,
    },
    byProducer: {},
    byCategory: {},
    byFile: {},
  };

  for (const diagnostic of diagnostics) {
    summary.bySeverity[diagnostic.severity] += 1;

    if (diagnostic.severity === "fatal") summary.fatalCount += 1;
    if (diagnostic.severity === "error") summary.errorCount += 1;
    if (diagnostic.severity === "warning") summary.warningCount += 1;
    if (diagnostic.severity === "info") summary.infoCount += 1;

    summary.byProducer[diagnostic.producer] = (summary.byProducer[diagnostic.producer] ?? 0) + 1;

    const categoryKey = diagnostic.category ?? "uncategorized";
    summary.byCategory[categoryKey] = (summary.byCategory[categoryKey] ?? 0) + 1;

    if (diagnostic.filePath) {
      summary.byFile[diagnostic.filePath] = (summary.byFile[diagnostic.filePath] ?? 0) + 1;
    }
  }

  return summary;
}

export default {
  parseDiagnostic,
  parseDiagnostics,
  fingerprintDiagnostic,
  diagnosticSortKey,
  summarizeDiagnostics,
};
