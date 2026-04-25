/*
 * ADJUTORIX APP — RENDERER / LIB / large_file_guard.ts
 *
 * Canonical large-file admission, degradation, and safety boundary.
 *
 * Purpose:
 * - provide deterministic renderer-side policy and helper logic for classifying files that are
 *   too large, too dense, too binary-like, or too operationally expensive for normal UI flows
 * - centralize the decision boundary used by editor hydration, diff preview, search/indexing,
 *   diagnostics surfacing, symbol extraction, and content preview
 * - prevent feature-specific ad hoc heuristics from diverging and silently treating dangerous
 *   files as ordinary text
 *
 * Architectural role:
 * - pure policy / evaluation module
 * - no filesystem I/O, no Electron APIs, no mutable global state, no hidden caching
 * - accepts caller-supplied metadata and optional sampled bytes/text statistics
 * - returns explicit decisions and degradation plans that higher-level services can enforce
 *
 * Hard invariants:
 * - identical inputs produce identical outputs
 * - every deny/degrade outcome carries explicit reasons
 * - policy does not perform side effects or implicit logging
 * - binary-likelihood, size pressure, and operational capability are evaluated separately
 * - callers can explain every resulting policy decision to the operator
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type LargeFileCapability =
  | "open-editor"
  | "full-read"
  | "preview-read"
  | "index-content"
  | "search-content"
  | "extract-symbols"
  | "diff-content"
  | "diagnostics-content"
  | "stream-content";

export type LargeFileDecision = "allow" | "degrade" | "deny";

export type LargeFileKind =
  | "text"
  | "binary"
  | "archive"
  | "media"
  | "document"
  | "dataset"
  | "unknown";

export type LargeFileReasonCode =
  | "size-soft-limit"
  | "size-hard-limit"
  | "binary-likely"
  | "null-byte-detected"
  | "high-line-count"
  | "high-average-line-length"
  | "oversized-for-diff"
  | "oversized-for-editor"
  | "oversized-for-index"
  | "oversized-for-symbols"
  | "oversized-for-diagnostics"
  | "extension-binary-known"
  | "mime-binary-known"
  | "streaming-required"
  | "path-excluded"
  | "compressed-or-packed"
  | "sample-truncated"
  | "unknown-risk";

export interface LargeFileReason {
  code: LargeFileReasonCode;
  message: string;
  severity: "info" | "warn" | "error";
}

export interface LargeFileThresholds {
  softTextBytes: number;
  hardTextBytes: number;
  editorBytes: number;
  diffBytes: number;
  indexBytes: number;
  symbolBytes: number;
  diagnosticsBytes: number;
  lineCountSoftLimit: number;
  averageLineLengthSoftLimit: number;
  binarySuspicionRatio: number;
  previewBytes: number;
  streamingBytes: number;
}

export interface LargeFileSampleStats {
  sampledBytes: number;
  sampledTextLength?: number;
  nullByteCount?: number;
  nonPrintableCount?: number;
  lineCount?: number;
  longestLineLength?: number;
  averageLineLength?: number;
  utf8DecodingFailed?: boolean;
  sampleTruncated?: boolean;
}

export interface LargeFileInput {
  path: string;
  sizeBytes: number;
  extension?: string | null;
  mimeType?: string | null;
  kindHint?: LargeFileKind | null;
  sample?: LargeFileSampleStats | null;
  excludedFromIndexing?: boolean;
}

export interface LargeFileCapabilityVerdict {
  capability: LargeFileCapability;
  decision: LargeFileDecision;
  reasons: LargeFileReason[];
  recommendedReadBytes?: number;
}

export interface LargeFileAssessment {
  identity: {
    path: string;
    normalizedExtension: string;
    mimeType: string | null;
    sizeBytes: number;
    sizeLabel: string;
  };
  inferredKind: LargeFileKind;
  binaryLikelihood: number;
  overallDecision: LargeFileDecision;
  reasons: LargeFileReason[];
  capabilities: Record<LargeFileCapability, LargeFileCapabilityVerdict>;
  operatorFlags: {
    binaryLikely: boolean;
    streamingRecommended: boolean;
    previewOnly: boolean;
    indexSuppressed: boolean;
  };
}

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

export const LARGE_FILE_GUARD_VERSION = "1.1.0";

export const DEFAULT_LARGE_FILE_THRESHOLDS: Readonly<LargeFileThresholds> = Object.freeze({
  softTextBytes: 512 * 1024,
  hardTextBytes: 5 * 1024 * 1024,
  editorBytes: 2 * 1024 * 1024,
  diffBytes: 1 * 1024 * 1024,
  indexBytes: 2 * 1024 * 1024,
  symbolBytes: 768 * 1024,
  diagnosticsBytes: 768 * 1024,
  lineCountSoftLimit: 25_000,
  averageLineLengthSoftLimit: 1_200,
  binarySuspicionRatio: 0.18,
  previewBytes: 64 * 1024,
  streamingBytes: 2 * 1024 * 1024,
});

export const LARGE_FILE_CAPABILITIES: readonly LargeFileCapability[] = Object.freeze([
  "open-editor",
  "full-read",
  "preview-read",
  "index-content",
  "search-content",
  "extract-symbols",
  "diff-content",
  "diagnostics-content",
  "stream-content",
]);

const KNOWN_BINARY_EXTENSIONS = new Set<string>([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff",
  ".mp3", ".wav", ".ogg", ".flac", ".mp4", ".mov", ".mkv", ".avi",
  ".zip", ".gz", ".bz2", ".xz", ".7z", ".rar", ".tar", ".jar", ".war",
  ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx",
  ".sqlite", ".db", ".so", ".dll", ".dylib", ".exe", ".bin", ".class",
  ".wasm", ".ttf", ".otf", ".woff", ".woff2", ".psd", ".ai", ".sketch",
  ".parquet", ".feather", ".avro", ".orc",
]);

const KNOWN_ARCHIVE_EXTENSIONS = new Set<string>([".zip", ".gz", ".bz2", ".xz", ".7z", ".rar", ".tar", ".jar", ".war"]);
const KNOWN_MEDIA_EXTENSIONS = new Set<string>([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff", ".mp3", ".wav", ".ogg", ".flac", ".mp4", ".mov", ".mkv", ".avi"]);
const KNOWN_DOCUMENT_EXTENSIONS = new Set<string>([".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"]);
const KNOWN_DATASET_EXTENSIONS = new Set<string>([".parquet", ".feather", ".avro", ".orc"]);

const BINARY_MIME_PREFIXES = [
  "image/",
  "audio/",
  "video/",
  "font/",
  "application/octet-stream",
  "application/zip",
  "application/gzip",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/pdf",
  "application/vnd",
] as const;

export const LARGE_FILE_KNOWN_BINARY_EXTENSIONS: readonly string[] = Object.freeze([...KNOWN_BINARY_EXTENSIONS].sort());
export const LARGE_FILE_KNOWN_ARCHIVE_EXTENSIONS: readonly string[] = Object.freeze([...KNOWN_ARCHIVE_EXTENSIONS].sort());
export const LARGE_FILE_KNOWN_MEDIA_EXTENSIONS: readonly string[] = Object.freeze([...KNOWN_MEDIA_EXTENSIONS].sort());
export const LARGE_FILE_KNOWN_DOCUMENT_EXTENSIONS: readonly string[] = Object.freeze([...KNOWN_DOCUMENT_EXTENSIONS].sort());
export const LARGE_FILE_KNOWN_DATASET_EXTENSIONS: readonly string[] = Object.freeze([...KNOWN_DATASET_EXTENSIONS].sort());
export const LARGE_FILE_BINARY_MIME_PREFIXES: readonly string[] = Object.freeze([...BINARY_MIME_PREFIXES]);

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function normalizeExtension(extension?: string | null, path?: string): string {
  const raw = extension?.trim() || path?.trim().match(/(\.[^./\\]+)$/)?.[1] || "";
  return raw ? raw.toLowerCase() : "";
}

function normalizeMime(mimeType?: string | null): string | null {
  const value = mimeType?.trim().toLowerCase();
  return value || null;
}

function bytesToLabel(bytes: number): string {
  const abs = Math.abs(bytes);
  if (abs < 1024) return `${bytes} B`;
  if (abs < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (abs < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function createReason(
  code: LargeFileReasonCode,
  message: string,
  severity: LargeFileReason["severity"],
): LargeFileReason {
  return { code, message, severity };
}

function uniqueReasons(reasons: LargeFileReason[]): LargeFileReason[] {
  const seen = new Set<string>();
  const out: LargeFileReason[] = [];

  for (const item of reasons) {
    const key = `${item.code}::${item.message}::${item.severity}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }

  return out;
}

function mergeDecision(a: LargeFileDecision, b: LargeFileDecision): LargeFileDecision {
  if (a === "deny" || b === "deny") return "deny";
  if (a === "degrade" || b === "degrade") return "degrade";
  return "allow";
}

function inferKind(extension: string, mimeType: string | null, hint?: LargeFileKind | null): LargeFileKind {
  if (hint && hint !== "unknown") return hint;
  if (KNOWN_ARCHIVE_EXTENSIONS.has(extension)) return "archive";
  if (KNOWN_MEDIA_EXTENSIONS.has(extension)) return "media";
  if (KNOWN_DOCUMENT_EXTENSIONS.has(extension)) return "document";
  if (KNOWN_DATASET_EXTENSIONS.has(extension)) return "dataset";
  if (KNOWN_BINARY_EXTENSIONS.has(extension)) return "binary";

  if (mimeType) {
    if (mimeType.startsWith("text/")) return "text";
    if (mimeType.startsWith("image/") || mimeType.startsWith("audio/") || mimeType.startsWith("video/")) return "media";
    if (mimeType === "application/pdf") return "document";
    if (
      mimeType.includes("json") ||
      mimeType.includes("xml") ||
      mimeType.includes("javascript") ||
      mimeType.includes("typescript") ||
      mimeType.includes("yaml") ||
      mimeType.includes("toml")
    ) {
      return "text";
    }
    if (BINARY_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix))) return "binary";
  }

  return "unknown";
}

function computeBinaryLikelihood(
  input: LargeFileInput,
  extension: string,
  mimeType: string | null,
): number {
  let score = 0;

  if (KNOWN_BINARY_EXTENSIONS.has(extension)) score = Math.max(score, 0.85);
  if (mimeType && BINARY_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix))) {
    score = Math.max(score, 0.75);
  }
  if (KNOWN_ARCHIVE_EXTENSIONS.has(extension)) score = Math.max(score, 0.9);

  const sample = input.sample;
  if (sample) {
    if ((sample.nullByteCount ?? 0) > 0) score = Math.max(score, 0.98);
    if (sample.utf8DecodingFailed) score = Math.max(score, 0.92);

    const sampledBytes = Math.max(sample.sampledBytes, 1);
    const suspicious = (sample.nonPrintableCount ?? 0) + (sample.nullByteCount ?? 0) * 4;
    const ratio = suspicious / sampledBytes;
    score = Math.max(score, Math.min(1, ratio));
  }

  return Math.max(0, Math.min(1, score));
}

function buildBaseReasons(
  input: LargeFileInput,
  thresholds: LargeFileThresholds,
  extension: string,
  mimeType: string | null,
  binaryLikelihood: number,
): LargeFileReason[] {
  const reasons: LargeFileReason[] = [];

  if (input.excludedFromIndexing) {
    reasons.push(createReason("path-excluded", "Path is explicitly excluded from indexing policy.", "info"));
  }

  if (input.sizeBytes >= thresholds.hardTextBytes) {
    reasons.push(
      createReason(
        "size-hard-limit",
        `File size ${bytesToLabel(input.sizeBytes)} exceeds hard text limit ${bytesToLabel(thresholds.hardTextBytes)}.`,
        "error",
      ),
    );
  } else if (input.sizeBytes >= thresholds.softTextBytes) {
    reasons.push(
      createReason(
        "size-soft-limit",
        `File size ${bytesToLabel(input.sizeBytes)} exceeds soft text limit ${bytesToLabel(thresholds.softTextBytes)}.`,
        "warn",
      ),
    );
  }

  if (input.sizeBytes >= thresholds.streamingBytes) {
    reasons.push(
      createReason(
        "streaming-required",
        `File size ${bytesToLabel(input.sizeBytes)} recommends streaming or sampled access.`,
        "warn",
      ),
    );
  }

  if (KNOWN_BINARY_EXTENSIONS.has(extension)) {
    reasons.push(createReason("extension-binary-known", `Extension ${extension} is classified as binary-oriented.`, "warn"));
  }

  if (mimeType && BINARY_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix))) {
    reasons.push(createReason("mime-binary-known", `MIME type ${mimeType} is classified as binary-oriented.`, "warn"));
  }

  if (KNOWN_ARCHIVE_EXTENSIONS.has(extension)) {
    reasons.push(createReason("compressed-or-packed", `Extension ${extension} indicates compressed or packed content.`, "warn"));
  }

  const sample = input.sample;
  if (sample) {
    if ((sample.nullByteCount ?? 0) > 0) {
      reasons.push(createReason("null-byte-detected", "Sample contains null bytes, strongly indicating binary content.", "error"));
    }

    if ((sample.lineCount ?? 0) >= thresholds.lineCountSoftLimit) {
      reasons.push(
        createReason(
          "high-line-count",
          `Sampled line count ${sample.lineCount} exceeds soft limit ${thresholds.lineCountSoftLimit}.`,
          "warn",
        ),
      );
    }

    if ((sample.averageLineLength ?? 0) >= thresholds.averageLineLengthSoftLimit) {
      reasons.push(
        createReason(
          "high-average-line-length",
          `Average line length ${Math.round(sample.averageLineLength ?? 0)} exceeds soft limit ${thresholds.averageLineLengthSoftLimit}.`,
          "warn",
        ),
      );
    }

    if (sample.sampleTruncated) {
      reasons.push(createReason("sample-truncated", "Classification sample was truncated; residual uncertainty remains.", "info"));
    }
  }

  if (binaryLikelihood >= thresholds.binarySuspicionRatio) {
    reasons.push(
      createReason(
        "binary-likely",
        `Binary likelihood ${(binaryLikelihood * 100).toFixed(1)}% exceeds suspicion threshold ${(thresholds.binarySuspicionRatio * 100).toFixed(1)}%.`,
        binaryLikelihood >= 0.85 ? "error" : "warn",
      ),
    );
  }

  if (reasons.length === 0) {
    reasons.push(createReason("unknown-risk", "No large-file risk signals detected beyond baseline policy inspection.", "info"));
  }

  return uniqueReasons(reasons);
}

function capabilityVerdict(
  capability: LargeFileCapability,
  input: LargeFileInput,
  inferredKind: LargeFileKind,
  binaryLikelihood: number,
  thresholds: LargeFileThresholds,
  baseReasons: LargeFileReason[],
): LargeFileCapabilityVerdict {
  const reasons: LargeFileReason[] = [];
  let decision: LargeFileDecision = "allow";
  let recommendedReadBytes: number | undefined;

  const clearlyBinary = inferredKind === "binary" || inferredKind === "archive" || binaryLikelihood >= 0.85;
  const maybeBinary = clearlyBinary || binaryLikelihood >= thresholds.binarySuspicionRatio;

  const denyTextOperationForBinary = (message: string): void => {
    reasons.push(createReason("binary-likely", message, "error"));
    decision = "deny";
  };

  switch (capability) {
    case "full-read": {
      if (input.sizeBytes >= thresholds.hardTextBytes) {
        reasons.push(createReason("size-hard-limit", `Full read denied beyond ${bytesToLabel(thresholds.hardTextBytes)}.`, "error"));
        decision = "deny";
      } else if (input.sizeBytes >= thresholds.softTextBytes) {
        reasons.push(createReason("size-soft-limit", `Full read degraded beyond ${bytesToLabel(thresholds.softTextBytes)}.`, "warn"));
        decision = mergeDecision(decision, "degrade");
      }

      if (clearlyBinary) {
        denyTextOperationForBinary("Full text read denied for binary-like content.");
      }
      break;
    }

    case "preview-read": {
      if (input.sizeBytes >= thresholds.previewBytes) {
        reasons.push(createReason("streaming-required", `Preview should be sampled to ${bytesToLabel(thresholds.previewBytes)} or less.`, "warn"));
        decision = mergeDecision(decision, "degrade");
        recommendedReadBytes = thresholds.previewBytes;
      }

      if (clearlyBinary) {
        reasons.push(createReason("binary-likely", "Preview must be metadata-only for binary-like content.", "warn"));
        decision = mergeDecision(decision, "degrade");
        recommendedReadBytes = 0;
      }
      break;
    }

    case "open-editor": {
      if (input.sizeBytes >= thresholds.editorBytes) {
        reasons.push(createReason("oversized-for-editor", `Editor hydration degrades beyond ${bytesToLabel(thresholds.editorBytes)}.`, "warn"));
        decision = mergeDecision(decision, "degrade");
      }

      if (input.sizeBytes >= thresholds.hardTextBytes) {
        reasons.push(createReason("size-hard-limit", "Editor open denied for files beyond hard text limit.", "error"));
        decision = "deny";
      }

      if (clearlyBinary) {
        denyTextOperationForBinary("Editor open denied for binary-like content.");
      }
      break;
    }

    case "index-content": {
      if (input.excludedFromIndexing) {
        reasons.push(createReason("path-excluded", "Indexing denied because path is excluded by policy.", "info"));
        decision = "deny";
      }

      if (input.sizeBytes >= thresholds.indexBytes) {
        reasons.push(createReason("oversized-for-index", `Content indexing degrades or denies beyond ${bytesToLabel(thresholds.indexBytes)}.`, "warn"));
        decision = mergeDecision(decision, input.sizeBytes >= thresholds.hardTextBytes ? "deny" : "degrade");
      }

      if (maybeBinary) {
        denyTextOperationForBinary("Content indexing denied for binary-like content.");
      }
      break;
    }

    case "search-content": {
      if (input.sizeBytes >= thresholds.indexBytes) {
        reasons.push(createReason("oversized-for-index", `Search-content indexing degrades beyond ${bytesToLabel(thresholds.indexBytes)}.`, "warn"));
        decision = mergeDecision(decision, "degrade");
      }

      if (maybeBinary) {
        denyTextOperationForBinary("Search-content indexing denied for binary-like content.");
      }
      break;
    }

    case "extract-symbols": {
      if (input.sizeBytes >= thresholds.symbolBytes) {
        reasons.push(createReason("oversized-for-symbols", `Symbol extraction degrades beyond ${bytesToLabel(thresholds.symbolBytes)}.`, "warn"));
        decision = mergeDecision(decision, "degrade");
      }

      if (maybeBinary) {
        denyTextOperationForBinary("Symbol extraction denied for binary-like content.");
      }
      break;
    }

    case "diff-content": {
      if (input.sizeBytes >= thresholds.diffBytes) {
        reasons.push(createReason("oversized-for-diff", `Diff rendering degrades beyond ${bytesToLabel(thresholds.diffBytes)}.`, "warn"));
        decision = mergeDecision(decision, "degrade");
        recommendedReadBytes = thresholds.previewBytes;
      }

      if (input.sizeBytes >= thresholds.hardTextBytes) {
        reasons.push(createReason("size-hard-limit", "Full diff denied for files beyond hard text limit.", "error"));
        decision = "deny";
      }

      if (clearlyBinary) {
        denyTextOperationForBinary("Text diff denied for binary-like content.");
      }
      break;
    }

    case "diagnostics-content": {
      if (input.sizeBytes >= thresholds.diagnosticsBytes) {
        reasons.push(createReason("oversized-for-diagnostics", `Content-bound diagnostics degrade beyond ${bytesToLabel(thresholds.diagnosticsBytes)}.`, "warn"));
        decision = mergeDecision(decision, "degrade");
      }

      if (maybeBinary) {
        denyTextOperationForBinary("Content-bound diagnostics denied for binary-like content.");
      }
      break;
    }

    case "stream-content": {
      if (input.sizeBytes >= thresholds.streamingBytes) {
        reasons.push(createReason("streaming-required", "Streaming is the preferred access mode for this file size.", "info"));
      }

      if (clearlyBinary) {
        reasons.push(createReason("binary-likely", "Streaming should remain opaque or metadata-oriented for binary-like content.", "warn"));
        decision = mergeDecision(decision, "degrade");
      }
      break;
    }
  }

  return {
    capability,
    decision,
    reasons: uniqueReasons([...reasons, ...baseReasons.filter((item) => item.severity !== "info" || reasons.length === 0)]),
    recommendedReadBytes,
  };
}

// -----------------------------------------------------------------------------
// PUBLIC API
// -----------------------------------------------------------------------------

export function assessLargeFile(
  input: LargeFileInput,
  thresholds: LargeFileThresholds = DEFAULT_LARGE_FILE_THRESHOLDS,
): LargeFileAssessment {
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes < 0) {
    throw new Error(`Invalid sizeBytes for large-file assessment: ${input.sizeBytes}`);
  }

  const normalizedExtension = normalizeExtension(input.extension, input.path);
  const mimeType = normalizeMime(input.mimeType);
  const inferredKind = inferKind(normalizedExtension, mimeType, input.kindHint);
  const binaryLikelihood = computeBinaryLikelihood(input, normalizedExtension, mimeType);
  const reasons = buildBaseReasons(input, thresholds, normalizedExtension, mimeType, binaryLikelihood);

  const capabilityEntries: Array<[LargeFileCapability, LargeFileCapabilityVerdict]> = LARGE_FILE_CAPABILITIES.map((capability) => [
    capability,
    capabilityVerdict(capability, input, inferredKind, binaryLikelihood, thresholds, reasons),
  ]);

  const capabilities = Object.fromEntries(capabilityEntries) as Record<LargeFileCapability, LargeFileCapabilityVerdict>;

  let overallDecision: LargeFileDecision = "allow";
  for (const verdict of Object.values(capabilities)) {
    overallDecision = mergeDecision(overallDecision, verdict.decision);
  }

  const previewOnly =
    capabilities["preview-read"].decision !== "deny" &&
    capabilities["full-read"].decision !== "allow" &&
    capabilities["open-editor"].decision !== "allow";

  return {
    identity: {
      path: input.path,
      normalizedExtension,
      mimeType,
      sizeBytes: input.sizeBytes,
      sizeLabel: bytesToLabel(input.sizeBytes),
    },
    inferredKind,
    binaryLikelihood,
    overallDecision,
    reasons,
    capabilities,
    operatorFlags: {
      binaryLikely: binaryLikelihood >= thresholds.binarySuspicionRatio,
      streamingRecommended: input.sizeBytes >= thresholds.streamingBytes,
      previewOnly,
      indexSuppressed: capabilities["index-content"].decision === "deny",
    },
  };
}

export function isLargeFileDeniedFor(
  input: LargeFileInput,
  capability: LargeFileCapability,
  thresholds: LargeFileThresholds = DEFAULT_LARGE_FILE_THRESHOLDS,
): boolean {
  return assessLargeFile(input, thresholds).capabilities[capability].decision === "deny";
}

export function isLargeFileDegradedFor(
  input: LargeFileInput,
  capability: LargeFileCapability,
  thresholds: LargeFileThresholds = DEFAULT_LARGE_FILE_THRESHOLDS,
): boolean {
  return assessLargeFile(input, thresholds).capabilities[capability].decision === "degrade";
}

export function getLargeFilePreviewBudget(
  input: LargeFileInput,
  thresholds: LargeFileThresholds = DEFAULT_LARGE_FILE_THRESHOLDS,
): number {
  const assessment = assessLargeFile(input, thresholds);
  return assessment.capabilities["preview-read"].recommendedReadBytes ?? thresholds.previewBytes;
}

export function shouldTreatAsBinaryLike(
  input: LargeFileInput,
  thresholds: LargeFileThresholds = DEFAULT_LARGE_FILE_THRESHOLDS,
): boolean {
  return assessLargeFile(input, thresholds).operatorFlags.binaryLikely;
}

export function summarizeLargeFileAssessment(assessment: LargeFileAssessment): string {
  const dominantReasons = assessment.reasons
    .filter((reasonItem) => reasonItem.severity !== "info")
    .slice(0, 3)
    .map((reasonItem) => reasonItem.message);

  const reasonSummary = dominantReasons.length > 0 ? dominantReasons.join(" ") : "No exceptional pressure detected.";

  return [
    `File ${assessment.identity.path} (${assessment.identity.sizeLabel}) is classified as ${assessment.inferredKind}.`,
    `Overall decision: ${assessment.overallDecision}.`,
    reasonSummary,
  ].join(" ");
}

export function buildLargeFileDisplayModel(
  input: LargeFileInput,
  thresholds: LargeFileThresholds = DEFAULT_LARGE_FILE_THRESHOLDS,
): {
  title: string;
  subtitle: string;
  badges: string[];
  warnings: string[];
} {
  const assessment = assessLargeFile(input, thresholds);

  const badges = [
    assessment.identity.sizeLabel,
    assessment.inferredKind,
    assessment.overallDecision,
    assessment.operatorFlags.binaryLikely ? "binary-like" : "text-like",
    assessment.operatorFlags.previewOnly ? "preview-only" : "interactive",
  ];

  const warnings = assessment.reasons
    .filter((reasonItem) => reasonItem.severity === "warn" || reasonItem.severity === "error")
    .map((reasonItem) => reasonItem.message);

  return {
    title: input.path,
    subtitle: summarizeLargeFileAssessment(assessment),
    badges,
    warnings,
  };
}

// -----------------------------------------------------------------------------
// TEST-ORIENTED PURE UTILITIES
// -----------------------------------------------------------------------------

export function __private__binarySuspicionRatio(sample: LargeFileSampleStats | null | undefined): number {
  if (!sample || sample.sampledBytes <= 0) return 0;
  const suspicious = (sample.nonPrintableCount ?? 0) + (sample.nullByteCount ?? 0) * 4;
  return suspicious / sample.sampledBytes;
}

export function __private__inferKindForTesting(
  extension: string,
  mimeType: string | null,
  hint?: LargeFileKind | null,
): LargeFileKind {
  return inferKind(extension.toLowerCase(), mimeType ? mimeType.toLowerCase() : null, hint);
}

export function __private__bytesToLabel(bytes: number): string {
  return bytesToLabel(bytes);
}

export function __private__normalizeExtension(extension?: string | null, path?: string): string {
  return normalizeExtension(extension, path);
}

export function __private__normalizeMime(mimeType?: string | null): string | null {
  return normalizeMime(mimeType);
}


// -----------------------------------------------------------------------------
// COMPATIBILITY SURFACE
// -----------------------------------------------------------------------------

export interface LargeFilePolicy {
  editorAllowBytes: number;
  editorDegradeBytes: number;
  diffAllowBytes: number;
  diffDegradeBytes: number;
  previewBytes: number;
  denyBinaryLike: boolean;
  binaryExtensions: string[];
  binaryMimePrefixes: string[];
  binaryMimeExact: string[];
}

export interface LargeFileProbe {
  path?: string | null;
  sizeBytes: number;
  mimeType?: string | null;
  purpose: "editor" | "diff";
}

export interface LargeFileCompatDecision {
  enabled: boolean;
  decision: LargeFileDecision;
  reason: string | null;
  previewBytes: number | null;
}

export const DEFAULT_LARGE_FILE_POLICY: Readonly<LargeFilePolicy> = Object.freeze({
  editorAllowBytes: 256 * 1024,
  editorDegradeBytes: 1024 * 1024,
  diffAllowBytes: 128 * 1024,
  diffDegradeBytes: 512 * 1024,
  previewBytes: DEFAULT_LARGE_FILE_THRESHOLDS.previewBytes,
  denyBinaryLike: true,
  binaryExtensions: [...LARGE_FILE_KNOWN_BINARY_EXTENSIONS],
  binaryMimePrefixes: [...LARGE_FILE_BINARY_MIME_PREFIXES].filter((item) => item.endsWith("/")),
  binaryMimeExact: [...LARGE_FILE_BINARY_MIME_PREFIXES].filter((item) => !item.endsWith("/")),
});

function compatNormalizePath(path?: string | null): string | null {
  const value = path?.trim();
  return value ? value.replace(/\\/g, "/") : null;
}

function compatNormalizeMime(mimeType?: string | null): string | null {
  const value = mimeType?.trim().toLowerCase();
  return value ? value : null;
}

export function isBinaryLikePath(path?: string | null, policy: LargeFilePolicy = DEFAULT_LARGE_FILE_POLICY): boolean {
  const normalized = compatNormalizePath(path);
  if (!normalized) return false;
  const match = normalized.match(/(\.[^./\\]+)$/);
  const ext = match?.[1]?.toLowerCase() ?? "";
  if (!ext) return false;
  return policy.binaryExtensions.map((item) => item.toLowerCase()).includes(ext);
}

export function isBinaryLikeMime(mimeType?: string | null, policy: LargeFilePolicy = DEFAULT_LARGE_FILE_POLICY): boolean {
  const normalized = compatNormalizeMime(mimeType);
  if (!normalized) return false;

  const exact = new Set(policy.binaryMimeExact.map((item) => item.toLowerCase()));
  if (exact.has(normalized)) return true;

  return policy.binaryMimePrefixes.some((prefix) => normalized.startsWith(prefix.toLowerCase()));
}

function compatDecision(
  decision: LargeFileDecision,
  reason: string | null,
  previewBytes?: number,
): LargeFileCompatDecision {
  return {
    enabled: decision !== "allow",
    decision,
    reason,
    previewBytes: decision === "allow" ? null : (previewBytes ?? null),
  };
}

export function classifyLargeFileDecision(
  probe: LargeFileProbe,
  policy: LargeFilePolicy = DEFAULT_LARGE_FILE_POLICY,
): LargeFileCompatDecision {
  const sizeBytes = Number.isFinite(probe.sizeBytes) ? probe.sizeBytes : -1;
  const purpose = probe.purpose === "diff" ? "diff" : "editor";

  if (sizeBytes < 0) {
    return compatDecision("deny", "File size is invalid or unavailable; edit authority is denied safely.", policy.previewBytes);
  }

  const binaryLike =
    isBinaryLikePath(probe.path ?? null, policy) ||
    isBinaryLikeMime(probe.mimeType ?? null, policy);

  if (policy.denyBinaryLike && binaryLike) {
    return compatDecision("deny", "Content appears binary-like and is denied for text operations.", policy.previewBytes);
  }

  const allowBytes = purpose === "diff" ? policy.diffAllowBytes : policy.editorAllowBytes;
  const degradeBytes = purpose === "diff" ? policy.diffDegradeBytes : policy.editorDegradeBytes;

  if (sizeBytes < allowBytes) {
    return compatDecision("allow", null);
  }

  if (sizeBytes < degradeBytes) {
    return compatDecision(
      "degrade",
      "Large file exceeds the normal interactive threshold; preview mode is required.",
      policy.previewBytes,
    );
  }

  return compatDecision(
    "deny",
    "Large file exceeds the maximum safe threshold for this surface.",
    policy.previewBytes,
  );
}

export function buildLargeFileDecision(
  probe: LargeFileProbe,
  policy: LargeFilePolicy = DEFAULT_LARGE_FILE_POLICY,
): LargeFileCompatDecision {
  return classifyLargeFileDecision(
    {
      path: probe.path ?? null,
      sizeBytes: probe.sizeBytes,
      mimeType: probe.mimeType ?? null,
      purpose: probe.purpose,
    },
    {
      editorAllowBytes: policy.editorAllowBytes,
      editorDegradeBytes: policy.editorDegradeBytes,
      diffAllowBytes: policy.diffAllowBytes,
      diffDegradeBytes: policy.diffDegradeBytes,
      previewBytes: policy.previewBytes,
      denyBinaryLike: policy.denyBinaryLike,
      binaryExtensions: [...policy.binaryExtensions],
      binaryMimePrefixes: [...policy.binaryMimePrefixes],
      binaryMimeExact: [...policy.binaryMimeExact],
    },
  );
}

export function shouldAllowFullEditor(decision: LargeFileCompatDecision): boolean {
  return decision.decision === "allow";
}

export function shouldAllowDiffEditor(decision: LargeFileCompatDecision): boolean {
  return decision.decision === "allow";
}

