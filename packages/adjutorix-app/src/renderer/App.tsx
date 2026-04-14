// @ts-nocheck
import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef
} from "react";

type AnyRecord = Record<string, unknown>;
type LoadContext = "boot" | "restore" | "open" | "manual";
type LoadOutcome = "attached" | "empty" | "error";

function asRecord(value: unknown): AnyRecord | null {
  return value !== null && typeof value === "object" ? (value as AnyRecord) : null;
}

function isFn<T extends (...args: any[]) => any = (...args: any[]) => any>(value: unknown): value is T {
  return typeof value === "function";
}

function unwrapEnvelope(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  if (record.ok === true && "data" in record) return record.data;
  return value;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values));
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function looksLikeFilePath(path: string): boolean {
  const base = basename(path);
  return /\.[A-Za-z0-9]{1,12}$/i.test(base) || base.includes(".");
}

function looksLikeDirPath(path: string): boolean {
  return !looksLikeFilePath(path);
}

function compactRecord(input: AnyRecord): AnyRecord {
  const out: AnyRecord = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim().length === 0) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

function currentBridge(): AnyRecord {
  const g = globalThis as AnyRecord;
  const runtime =
    asRecord(g.__adjutorixRendererRuntime) ??
    asRecord(g.adjutorixRuntime) ??
    asRecord(asRecord(g.__adjutorixRendererRuntime)?.runtime) ??
    asRecord(asRecord(g.adjutorixRuntime)?.runtime);

  return (
    asRecord(g.adjutorix) ??
    asRecord(runtime?.bridge) ??
    asRecord(runtime?.api) ??
    {}
  );
}

function deepMergeRecords(...inputs: unknown[]): AnyRecord {
  let out: AnyRecord = {};

  const visit = (value: unknown) => {
    const unwrapped = unwrapEnvelope(value);
    const record = asRecord(unwrapped);
    if (!record) return;

    out = { ...out, ...record };

    for (const nested of Object.values(record)) {
      if (Array.isArray(nested)) {
        for (const item of nested) visit(item);
      } else {
        visit(nested);
      }
    }
  };

  for (const input of inputs) visit(input);
  return out;
}

function collectFilePaths(...inputs: unknown[]): string[] {
  const found = new Set<string>();

  const visit = (value: unknown) => {
    const unwrapped = unwrapEnvelope(value);

    if (typeof unwrapped === "string") {
      if (looksLikeFilePath(unwrapped)) found.add(unwrapped);
      return;
    }

    if (Array.isArray(unwrapped)) {
      for (const item of unwrapped) visit(item);
      return;
    }

    const record = asRecord(unwrapped);
    if (!record) return;

    for (const nested of Object.values(record)) visit(nested);
  };

  for (const input of inputs) visit(input);
  return Array.from(found);
}

function deriveLargePreview(...inputs: unknown[]): AnyRecord | null {
  const suspiciousText =
    /(large|too[ -]?large|oversiz|preview|read[ -]?only|degraded|guard|truncat|limit|exceed)/i;

  const toNumber = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };

  const firstNumber = (...values: unknown[]): number | null => {
    for (const value of values) {
      const parsed = toNumber(value);
      if (parsed != null) return parsed;
    }
    return null;
  };

  const seen = new Set<unknown>();
  const records: AnyRecord[] = [];

  const visit = (value: unknown): void => {
    if (value == null || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    const record = asRecord(unwrapEnvelope(value)) ?? asRecord(value);
    if (!record) return;
    records.push(record);

    for (const nested of Object.values(record)) {
      visit(nested);
    }
  };

  for (const input of inputs) visit(input);

  const normalize = (record: AnyRecord): AnyRecord | null => {
    const workspace = asRecord(record.workspace) ?? {};
    const nested =
      asRecord(record.largePreview) ??
      asRecord(record.large_file_preview) ??
      asRecord(record.largeFilePreview) ??
      asRecord(record.largeFile) ??
      asRecord(record.filePreview) ??
      asRecord(record.previewPayload) ??
      asRecord(record.preview) ??
      asRecord(workspace.largePreview) ??
      asRecord(workspace.large_file_preview) ??
      asRecord(workspace.largeFilePreview) ??
      asRecord(workspace.largeFile) ??
      asRecord(workspace.filePreview) ??
      asRecord(workspace.previewPayload);

    const source = nested ?? record;

    const path = firstString(
      source.path,
      source.selectedPath,
      source.filePath,
      source.targetPath,
      source.previewPath,
      record.path,
      record.selectedPath,
      record.filePath,
      workspace.path,
      workspace.selectedPath,
    );

    const selectedPath = firstString(
      source.selectedPath,
      source.path,
      record.selectedPath,
      record.path,
      workspace.selectedPath,
      workspace.path,
      path,
    );

    const previewText = firstString(
      source.preview,
      source.previewText,
      source.text,
      source.content,
      source.snippet,
      source.value,
      source.body,
      source.message,
      record.preview,
      record.previewText,
      record.text,
      record.content,
      record.snippet,
      record.message,
      workspace.preview,
      workspace.previewText,
      workspace.text,
      workspace.content,
      workspace.snippet,
      workspace.message,
    );

    const reason = firstString(
      source.reason,
      source.guardReason,
      source.guardMode,
      source.previewMode,
      source.status,
      source.mode,
      source.kind,
      source.type,
      source.code,
      source.message,
      record.reason,
      record.guardReason,
      record.guardMode,
      record.previewMode,
      record.status,
      record.mode,
      record.kind,
      record.type,
      record.code,
      record.message,
      workspace.reason,
      workspace.guardReason,
      workspace.guardMode,
      workspace.previewMode,
      workspace.status,
      workspace.mode,
      workspace.kind,
      workspace.type,
      workspace.code,
      workspace.message,
    );

    const workspaceId = firstString(
      source.workspaceId,
      source.diagnosticsWorkspaceId,
      record.workspaceId,
      record.diagnosticsWorkspaceId,
      workspace.workspaceId,
      workspace.diagnosticsWorkspaceId,
    );

    const diagnosticsWorkspaceId = firstString(
      source.diagnosticsWorkspaceId,
      source.workspaceId,
      record.diagnosticsWorkspaceId,
      record.workspaceId,
      workspace.diagnosticsWorkspaceId,
      workspace.workspaceId,
    );

    const textSignal = suspiciousText.test(
      [
        reason,
        previewText,
        firstString(source.mode, record.mode, workspace.mode),
        firstString(source.status, record.status, workspace.status),
        firstString(source.code, record.code, workspace.code),
      ]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .join(" "),
    );

    const boolSignal = [
      source.previewOnly,
      source.readOnly,
      source.readonly,
      source.degraded,
      source.oversized,
      source.oversize,
      source.tooLarge,
      source.isTooLarge,
      source.large,
      source.largeFile,
      source.isLargeFile,
      source.fileTooLarge,
      source.guard,
      source.truncated,
      record.previewOnly,
      record.readOnly,
      record.readonly,
      record.degraded,
      record.oversized,
      record.oversize,
      record.tooLarge,
      record.isTooLarge,
      record.large,
      record.largeFile,
      record.isLargeFile,
      record.fileTooLarge,
      record.guard,
      record.truncated,
      workspace.previewOnly,
      workspace.readOnly,
      workspace.readonly,
      workspace.degraded,
      workspace.oversized,
      workspace.oversize,
      workspace.tooLarge,
      workspace.isTooLarge,
      workspace.large,
      workspace.largeFile,
      workspace.isLargeFile,
      workspace.fileTooLarge,
      workspace.guard,
      workspace.truncated,
    ].some((value) => value === true);

    const size = firstNumber(
      source.size,
      source.bytes,
      source.byteLength,
      source.sizeBytes,
      source.fileSize,
      source.fileSizeBytes,
      record.size,
      record.bytes,
      record.byteLength,
      record.sizeBytes,
      record.fileSize,
      record.fileSizeBytes,
      workspace.size,
      workspace.bytes,
      workspace.byteLength,
      workspace.sizeBytes,
      workspace.fileSize,
      workspace.fileSizeBytes,
    );

    const limit = firstNumber(
      source.limit,
      source.maxBytes,
      source.byteLimit,
      source.previewLimit,
      source.maxPreviewBytes,
      source.sizeLimit,
      record.limit,
      record.maxBytes,
      record.byteLimit,
      record.previewLimit,
      record.maxPreviewBytes,
      record.sizeLimit,
      workspace.limit,
      workspace.maxBytes,
      workspace.byteLimit,
      workspace.previewLimit,
      workspace.maxPreviewBytes,
      workspace.sizeLimit,
    );

    const sizeSignal =
      (size != null && limit != null && size > limit) ||
      (size != null && firstString(reason, previewText) != null && size > 1024 * 1024);

    const guardSignal =
      nested != null ||
      boolSignal ||
      textSignal ||
      sizeSignal;

    if (!guardSignal) return null;

    return compactRecord({
      path: path ?? selectedPath ?? "Large file preview",
      selectedPath: selectedPath ?? path ?? "Large file preview",
      workspaceId,
      diagnosticsWorkspaceId,
      preview: previewText,
      reason,
      previewOnly:
        source.previewOnly === true ||
        record.previewOnly === true ||
        workspace.previewOnly === true
          ? true
          : undefined,
      readOnly:
        source.readOnly === true ||
        source.readonly === true ||
        record.readOnly === true ||
        record.readonly === true ||
        workspace.readOnly === true ||
        workspace.readonly === true
          ? true
          : undefined,
      degraded:
        source.degraded === true ||
        record.degraded === true ||
        workspace.degraded === true ||
        sizeSignal
          ? true
          : undefined,
      large:
        source.large === true ||
        source.largeFile === true ||
        source.isLargeFile === true ||
        source.tooLarge === true ||
        source.isTooLarge === true ||
        record.large === true ||
        record.largeFile === true ||
        record.isLargeFile === true ||
        record.tooLarge === true ||
        record.isTooLarge === true ||
        workspace.large === true ||
        workspace.largeFile === true ||
        workspace.isLargeFile === true ||
        workspace.tooLarge === true ||
        workspace.isTooLarge === true ||
        sizeSignal
          ? true
          : undefined,
    });
  };

  for (const record of records) {
    const normalized = normalize(record);
    if (normalized) return normalized;
  }

  return null;
}

function deriveDiagnosticsSummary(...inputs: unknown[]): AnyRecord | null {
  const merged = deepMergeRecords(...inputs);

  return (
    asRecord(merged.summary) ??
    asRecord(asRecord(merged.diagnostics)?.summary) ??
    null
  );
}

function deriveWorkspaceSeed(...inputs: unknown[]): AnyRecord {
  const merged = deepMergeRecords(...inputs);
  const session = asRecord(merged.session);

  const genericPath = firstString(
    merged.path,
    merged.root,
    merged.rootPath,
    merged.workspaceRoot,
    merged.workspacePath,
    merged.repoPath,
    merged.directory,
    merged.location,
    session?.rootPath,
  );

  const inferredRootPath =
    genericPath && looksLikeDirPath(genericPath) ? genericPath : null;

  const inferredSelectedPath = firstString(
    merged.selectedPath,
    merged.filePath,
    merged.targetPath,
    merged.previewPath,
    session?.selectedPath,
  ) ?? (genericPath && looksLikeFilePath(genericPath) ? genericPath : null);

  const openedPaths = uniq([
    ...collectFilePaths(merged.openedPaths),
    ...collectFilePaths(session?.openedPaths),
    ...collectFilePaths(merged.files),
    ...collectFilePaths(merged.items),
    ...(inferredSelectedPath ? [inferredSelectedPath] : []),
  ]);

  const expandedPaths = uniq([
    ...toStringArray(merged.expandedPaths),
    ...toStringArray(session?.expandedPaths),
  ]).filter(looksLikeDirPath);

  return compactRecord({
    restored: merged.restored === true ? true : undefined,
    attached: merged.attached === true ? true : undefined,
    sessionId: firstString(merged.sessionId, session?.sessionId) ?? undefined,
    workspaceId: firstString(merged.workspaceId, session?.workspaceId) ?? undefined,
    rootPath:
      firstString(
        merged.rootPath,
        merged.workspaceRoot,
        merged.workspacePath,
        merged.repoPath,
        merged.directory,
        session?.rootPath,
        inferredRootPath,
      ) ?? undefined,
    trustLevel: firstString(merged.trustLevel, session?.trustLevel) ?? undefined,
    selectedPath: inferredSelectedPath ?? undefined,
    openedPaths: openedPaths.length > 0 ? openedPaths : undefined,
    expandedPaths: expandedPaths.length > 0 ? expandedPaths : undefined,
    verifyId: firstString(merged.verifyId, session?.verifyId) ?? undefined,
    ledgerId: firstString(merged.ledgerId, session?.ledgerId) ?? undefined,
    patchId: firstString(merged.patchId, session?.patchId) ?? undefined,
    diagnosticsWorkspaceId:
      firstString(
        merged.diagnosticsWorkspaceId,
        session?.diagnosticsWorkspaceId,
        merged.workspaceId,
        session?.workspaceId,
      ) ?? undefined,
  });
}

function hasMeaningfulSeed(seed: AnyRecord, preview: AnyRecord | null, paths: string[]): boolean {
  return Boolean(
    seed.attached === true ||
    seed.restored === true ||
    seed.rootPath ||
    seed.workspaceId ||
    seed.selectedPath ||
    seed.verifyId ||
    seed.ledgerId ||
    seed.patchId ||
    seed.diagnosticsWorkspaceId ||
    (Array.isArray(seed.openedPaths) && seed.openedPaths.length > 0) ||
    (Array.isArray(seed.expandedPaths) && seed.expandedPaths.length > 0) ||
    preview ||
    paths.length > 0
  );
}

function isExplicitCancel(value: unknown): boolean {
  const record = asRecord(unwrapEnvelope(value)) ?? asRecord(value);
  if (!record) return false;

  if (record.cancelled === true || record.canceled === true) {
    return true;
  }

  const status =
    typeof record.status === "string" ? record.status.trim().toLowerCase() : "";
  const disposition =
    typeof record.disposition === "string" ? record.disposition.trim().toLowerCase() : "";
  const reason =
    typeof record.reason === "string" ? record.reason.trim().toLowerCase() : "";
  const code =
    typeof record.code === "string" ? record.code.trim().toUpperCase() : "";

  return (
    status === "cancelled" ||
    status === "canceled" ||
    disposition === "cancelled" ||
    disposition === "canceled" ||
    reason === "cancelled" ||
    reason === "canceled" ||
    code === "CANCELLED" ||
    code === "CANCELED" ||
    code === "USER_CANCELLED" ||
    code === "USER_CANCELED"
  );
}

function normalizeUnsubscribe(value: unknown): (() => void) | null {
  if (isFn(value)) return value;
  const record = asRecord(value);
  if (record && isFn(record.unsubscribe)) return () => record.unsubscribe();
  return null;
}

function describeLoadError(context: LoadContext, error: unknown): string {
  const message =
    error instanceof Error ? error.message :
    typeof error === "string" ? error :
    "unknown error";

  if (context === "restore") return `Workspace restore failed: ${message}`;
  if (context === "open") return `Workspace open failed: ${message}`;
  return `Workspace load failed: ${message}`;
}

export default function App(): React.JSX.Element {
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [paths, setPaths] = useState<string[]>([]);
  const [diagnosticsSummary, setDiagnosticsSummary] = useState<AnyRecord | null>(null);
  const [largePreview, setLargePreview] = useState<AnyRecord | null>(null);
  const largePreviewRef = useRef<AnyRecord | null>(null);
  const manualOpenRef = useRef(false);
  const manualOpenSyncRef = useRef(false);
  const applyWorkspaceStateRef = useRef<((...inputs: unknown[]) => Promise<LoadOutcome>) | null>(null);

  useEffect(() => {
    largePreviewRef.current = largePreview;
  }, [largePreview]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [workspaceIdentity, setWorkspaceIdentity] = useState<string | null>(null);

  const fileButtons = useMemo(() => {
    const byLabel = new Map<string, string>();
    const candidates = uniq([
      ...paths,
      ...collectFilePaths(largePreview),
      ...(selectedPath ? [selectedPath] : []),
    ]).filter(looksLikeFilePath);

    for (const path of candidates) {
      const label = basename(path);
      if (!byLabel.has(label) || path === selectedPath) {
        byLabel.set(label, path);
      }
    }

    return Array.from(byLabel.entries()).map(([label, path]) => ({ label, path }));
  }, [largePreview, paths, selectedPath]);

  const subscribeStreams = useCallback(() => {
    const bridge = currentBridge();
    const workspaceApi = asRecord(bridge.workspace);
    const diagnosticsApi = asRecord(bridge.diagnostics);
    const cleanups: Array<() => void> = [];

    if (isFn(workspaceApi?.subscribe)) {
      const unsub = normalizeUnsubscribe(
        workspaceApi.subscribe((signal: unknown) => {
          if (!manualOpenRef.current) return;
          if (manualOpenSyncRef.current) return;

          manualOpenSyncRef.current = true;

          void (async () => {
            try {
              const signalSeed = deriveWorkspaceSeed(signal);
              const signalPreview = deriveLargePreview(signal);

              const loadArg = compactRecord({
                attached: true,
                rootPath: firstString(
                  signalSeed.rootPath,
                  signalPreview?.workspacePath,
                  signalPreview?.rootPath,
                ),
                path: firstString(
                  signalSeed.rootPath,
                  signalPreview?.workspacePath,
                  signalPreview?.rootPath,
                ),
                workspacePath: firstString(
                  signalSeed.rootPath,
                  signalPreview?.workspacePath,
                  signalPreview?.rootPath,
                ),
                directory: firstString(
                  signalSeed.rootPath,
                  signalPreview?.workspacePath,
                  signalPreview?.rootPath,
                ),
                folderPath: firstString(
                  signalSeed.rootPath,
                  signalPreview?.workspacePath,
                  signalPreview?.rootPath,
                ),
                selectedPath: firstString(
                  signalSeed.selectedPath,
                  signalPreview?.selectedPath,
                  signalPreview?.path,
                ),
                workspaceId: firstString(
                  signalSeed.workspaceId,
                  signalSeed.diagnosticsWorkspaceId,
                  signalPreview?.workspaceId,
                  signalPreview?.diagnosticsWorkspaceId,
                ),
                diagnosticsWorkspaceId: firstString(
                  signalSeed.diagnosticsWorkspaceId,
                  signalSeed.workspaceId,
                  signalPreview?.diagnosticsWorkspaceId,
                  signalPreview?.workspaceId,
                ),
              });

              const loaded =
                isFn(workspaceApi?.load)
                  ? await workspaceApi.load(
                      Object.keys(loadArg).length > 0 ? loadArg : { attached: true },
                    )
                  : signal;

              const outcome =
                applyWorkspaceStateRef.current
                  ? await applyWorkspaceStateRef.current(loadArg, loaded, signal, signalPreview)
                  : "empty";

              if (outcome === "attached") {
                manualOpenRef.current = false;
              }
            } catch {
              // authority stream reconciliation is best-effort
            } finally {
              manualOpenSyncRef.current = false;
            }
          })();
        }),
      );
      if (unsub) cleanups.push(unsub);
    }

    if (isFn(diagnosticsApi?.subscribe)) {
      const unsub = normalizeUnsubscribe(diagnosticsApi.subscribe(() => undefined));
      if (unsub) cleanups.push(unsub);
    }

    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, []);

  const hydrateGovernedSurfaces = useCallback(async (seed: AnyRecord) => {
    const bridge = currentBridge();

    const diagnosticsApi = asRecord(bridge.diagnostics);
    const verifyApi = asRecord(bridge.verify);
    const ledgerApi = asRecord(bridge.ledger);
    const patchApi = asRecord(bridge.patch);
    const shellApi = asRecord(bridge.shell);
    const agentApi = asRecord(bridge.agent);

    if (isFn(diagnosticsApi?.load)) {
      const diagnosticsArg = compactRecord({
        workspaceId: firstString(seed.diagnosticsWorkspaceId, seed.workspaceId) ?? undefined,
      });
      const diagnostics = await diagnosticsApi.load(
        Object.keys(diagnosticsArg).length > 0 ? diagnosticsArg : {},
      );
      setDiagnosticsSummary(deriveDiagnosticsSummary(diagnostics));
    } else {
      setDiagnosticsSummary(null);
    }

    if (seed.verifyId && isFn(verifyApi?.load)) {
      await verifyApi.load({ verifyId: seed.verifyId });
    }

    if (seed.ledgerId && isFn(ledgerApi?.load)) {
      await ledgerApi.load({ ledgerId: seed.ledgerId });
    }

    if (seed.patchId && isFn(patchApi?.load)) {
      await patchApi.load({ patchId: seed.patchId });
    }

    if (isFn(shellApi?.status)) {
      await shellApi.status();
    }

    if (isFn(agentApi?.connect)) {
      await agentApi.connect();
    }
  }, []);

  const applyWorkspaceState = useCallback(async (...inputs: unknown[]) => {
    const seed = deriveWorkspaceSeed(...inputs);
    const directPreview = deriveLargePreview(...inputs);

    const rememberedPreviewRecord =
      asRecord(unwrapEnvelope(largePreviewRef.current)) ??
      asRecord(largePreviewRef.current) ??
      null;

    const rememberedPreview =
      deriveLargePreview(rememberedPreviewRecord) ??
      rememberedPreviewRecord;

    const harvestedPaths = uniq([
      ...collectFilePaths(...inputs),
      ...toStringArray(seed.openedPaths),
      ...(seed.selectedPath ? [String(seed.selectedPath)] : []),
    ]).filter(looksLikeFilePath);

    const selectedPath =
      typeof seed.selectedPath === "string" ? seed.selectedPath : null;

    const rememberedPreviewPath = firstString(
      rememberedPreview?.path,
      rememberedPreview?.selectedPath,
    );

    const previewPathMatchesSelection =
      typeof rememberedPreviewPath === "string" &&
      (
        rememberedPreviewPath === selectedPath ||
        harvestedPaths.includes(rememberedPreviewPath) ||
        (typeof seed.rootPath === "string" &&
          rememberedPreviewPath.startsWith(String(seed.rootPath)))
      );

    const serializedInputs = inputs
      .map((input) => {
        try {
          return JSON.stringify(unwrapEnvelope(input) ?? input);
        } catch {
          return "";
        }
      })
      .join(" ")
      .toLowerCase();

    const rawGuardSignal =
      /large|preview|read-?only|guard|oversiz|truncat|degrad/.test(serializedInputs);

    const stickyPreview =
      directPreview ??
      (previewPathMatchesSelection
        ? compactRecord({
            path: firstString(
              rememberedPreview?.path,
              rememberedPreview?.selectedPath,
              selectedPath,
              "Large file preview",
            ),
            selectedPath: firstString(
              rememberedPreview?.selectedPath,
              rememberedPreview?.path,
              selectedPath,
              "Large file preview",
            ),
            preview: firstString(
              rememberedPreview?.preview,
              rememberedPreview?.text,
              rememberedPreview?.content,
              rememberedPreview?.snippet,
            ),
            reason: firstString(
              rememberedPreview?.reason,
              rememberedPreview?.message,
              "Large file preview",
            ),
            workspaceId: firstString(
              seed.workspaceId,
              seed.diagnosticsWorkspaceId,
              rememberedPreview?.workspaceId,
              rememberedPreview?.diagnosticsWorkspaceId,
            ),
            diagnosticsWorkspaceId: firstString(
              seed.diagnosticsWorkspaceId,
              seed.workspaceId,
              rememberedPreview?.diagnosticsWorkspaceId,
              rememberedPreview?.workspaceId,
            ),
            previewOnly: true,
            readOnly: true,
            degraded: true,
          })
        : null) ??
      (rawGuardSignal && selectedPath
        ? compactRecord({
            path: firstString(selectedPath, "Large file preview"),
            selectedPath: firstString(selectedPath, "Large file preview"),
            preview: firstString(
              rememberedPreview?.preview,
              rememberedPreview?.text,
              rememberedPreview?.content,
              rememberedPreview?.snippet,
            ),
            reason: firstString(
              directPreview?.reason,
              rememberedPreview?.reason,
              "Large file preview",
            ),
            workspaceId: firstString(
              seed.workspaceId,
              seed.diagnosticsWorkspaceId,
              rememberedPreview?.workspaceId,
              rememberedPreview?.diagnosticsWorkspaceId,
            ),
            diagnosticsWorkspaceId: firstString(
              seed.diagnosticsWorkspaceId,
              seed.workspaceId,
              rememberedPreview?.diagnosticsWorkspaceId,
              rememberedPreview?.workspaceId,
            ),
            previewOnly: true,
            readOnly: true,
            degraded: true,
          })
        : null);

    const normalizedSelectedPath =
      seed.rootPath &&
      selectedPath &&
      !String(selectedPath).startsWith(String(seed.rootPath))
        ? null
        : selectedPath;

    const meaningful = hasMeaningfulSeed(seed, stickyPreview, harvestedPaths);

    setRootPath(typeof seed.rootPath === "string" ? seed.rootPath : null);
    setSelectedPath(normalizedSelectedPath);
    setPaths(harvestedPaths);
    setLargePreview(stickyPreview);

    if (!meaningful) {
      setDiagnosticsSummary(null);
      return "empty" as const;
    }

    const governedSeed =
      stickyPreview == null
        ? seed
        : compactRecord({
            ...seed,
            attached: true,
            workspaceId: firstString(
              seed.workspaceId,
              seed.diagnosticsWorkspaceId,
              stickyPreview.workspaceId,
              stickyPreview.diagnosticsWorkspaceId,
            ),
            diagnosticsWorkspaceId: firstString(
              seed.diagnosticsWorkspaceId,
              seed.workspaceId,
              stickyPreview.diagnosticsWorkspaceId,
              stickyPreview.workspaceId,
            ),
            selectedPath: firstString(
              seed.selectedPath,
              stickyPreview.selectedPath,
              stickyPreview.path,
            ),
          });

    await hydrateGovernedSurfaces(governedSeed);
    setErrorMessage(null);
    return "attached" as const;
  }, [hydrateGovernedSurfaces]);
  useEffect(() => {
    applyWorkspaceStateRef.current = applyWorkspaceState;
  }, [applyWorkspaceState]);

  const loadWorkspace = useCallback(async (
    context: LoadContext,
    seedInputs: unknown[],
    explicitArg?: AnyRecord,
  ): Promise<LoadOutcome> => {
    const bridge = currentBridge();
    const workspaceApi = asRecord(bridge.workspace);

    const seed = deriveWorkspaceSeed(explicitArg, ...seedInputs);
    const preview = deriveLargePreview(explicitArg, ...seedInputs);
    const harvestedPaths = collectFilePaths(explicitArg, ...seedInputs);
    const arg =
      explicitArg ??
      (hasMeaningfulSeed(seed, preview, harvestedPaths) ? seed : {});

    if (!isFn(workspaceApi?.load)) {
      try {
        const resolvedWorkspaceIdentity = firstString(
          seed.workspaceId,
          seed.diagnosticsWorkspaceId,
          preview?.workspaceId,
          preview?.diagnosticsWorkspaceId,
        );
        setWorkspaceIdentity(resolvedWorkspaceIdentity ?? null);
        return await applyWorkspaceState(arg, preview, ...seedInputs);
      } catch (error) {
        setWorkspaceIdentity(null);
        setErrorMessage(describeLoadError(context, error));
        return "error";
      }
    }

    try {
      const loaded = await workspaceApi.load(arg);
      const loadedSeed = deriveWorkspaceSeed(arg, loaded, ...seedInputs);
      const loadedPreview = deriveLargePreview(arg, loaded, preview, ...seedInputs);
      const resolvedWorkspaceIdentity = firstString(
        loadedSeed.workspaceId,
        loadedSeed.diagnosticsWorkspaceId,
        seed.workspaceId,
        seed.diagnosticsWorkspaceId,
        loadedPreview?.workspaceId,
        loadedPreview?.diagnosticsWorkspaceId,
        preview?.workspaceId,
        preview?.diagnosticsWorkspaceId,
      );
      setWorkspaceIdentity(resolvedWorkspaceIdentity ?? null);
      return await applyWorkspaceState(arg, loaded, preview, ...seedInputs);
    } catch (error) {
      setWorkspaceIdentity(null);
      setRootPath(null);
      setSelectedPath(null);
      setPaths([]);
      setLargePreview(null);
      setDiagnosticsSummary(null);
      setErrorMessage(describeLoadError(context, error));
      return "error";
    }
  }, [applyWorkspaceState]);

  const boot = useCallback(async () => {
    if (manualOpenRef.current) return;

    const bridge = currentBridge();
    const sessionApi = asRecord(bridge.session);
    const runtimeApi = asRecord(bridge.runtime);

    if (isFn(sessionApi?.restore)) {
      const restored = await sessionApi.restore();
      if (manualOpenRef.current) return;

      if (restored && !isExplicitCancel(restored)) {
        const outcome = await loadWorkspace("restore", [restored]);
        if (outcome === "attached" || outcome === "error") return;
      }
    }

    if (manualOpenRef.current) return;

    if (isFn(runtimeApi?.snapshot)) {
      const runtimeSnapshot = await runtimeApi.snapshot();
      if (manualOpenRef.current) return;

      const runtimeSeed = deriveWorkspaceSeed(runtimeSnapshot);
      const runtimePreview = deriveLargePreview(runtimeSnapshot);
      const runtimePaths = collectFilePaths(runtimeSnapshot);

      if (hasMeaningfulSeed(runtimeSeed, runtimePreview, runtimePaths)) {
        const outcome = await loadWorkspace("boot", [runtimeSnapshot]);
        if (outcome === "attached" || outcome === "error") return;
      }
    }

    if (manualOpenRef.current) return;
    await loadWorkspace("boot", [{}], {});
  }, [loadWorkspace]);

  const openWorkspace = useCallback(async () => {
    const initialBridge = currentBridge();
    const initialWorkspaceApi = asRecord(initialBridge.workspace);
    if (!isFn(initialWorkspaceApi?.open)) return;

    manualOpenRef.current = true;

    try {
      const opened = await initialWorkspaceApi.open();
      const openedRecord = asRecord(unwrapEnvelope(opened)) ?? asRecord(opened);

      const explicitlyCancelled =
        openedRecord?.cancelled === true ||
        openedRecord?.canceled === true ||
        openedRecord?.aborted === true ||
        openedRecord?.dismissed === true;

      if (explicitlyCancelled) return;

      await Promise.resolve();

      const refreshedBridge = currentBridge();
      const refreshedWorkspaceApi = asRecord(refreshedBridge.workspace);
      const loadFn =
        isFn(refreshedWorkspaceApi?.load)
          ? refreshedWorkspaceApi.load.bind(refreshedWorkspaceApi)
          : isFn(initialWorkspaceApi?.load)
            ? initialWorkspaceApi.load.bind(initialWorkspaceApi)
            : null;

      const openedRoot = firstString(
        typeof opened === "string" ? opened : null,
        openedRecord?.rootPath,
        openedRecord?.workspacePath,
        openedRecord?.directory,
        openedRecord?.folderPath,
        openedRecord?.path,
      );

      const openedSelectedPath = firstString(
        openedRecord?.selectedPath,
        openedRecord?.path,
      );

      const openedWorkspaceId = firstString(
        openedRecord?.workspaceId,
        openedRecord?.diagnosticsWorkspaceId,
      );

      const openedDiagnosticsWorkspaceId = firstString(
        openedRecord?.diagnosticsWorkspaceId,
        openedRecord?.workspaceId,
      );

      const openedSnapshot = compactRecord({
        attached: true,
        rootPath: openedRoot,
        path: openedRoot,
        workspacePath: openedRoot,
        directory: openedRoot,
        folderPath: openedRoot,
        selectedPath: openedSelectedPath,
        workspaceId: openedWorkspaceId,
        diagnosticsWorkspaceId: openedDiagnosticsWorkspaceId,
      });

      const loaded = loadFn ? await loadFn(openedSnapshot) : undefined;

      const seed = deriveWorkspaceSeed(openedSnapshot, loaded, opened);
      const preview = deriveLargePreview(openedSnapshot, loaded, opened) ?? null;

      const rootPath = firstString(
        seed.rootPath,
        openedSnapshot.rootPath,
        openedRoot,
      );

      const selectedPath = firstString(
        seed.selectedPath,
        preview?.selectedPath,
        preview?.path,
        openedSnapshot.selectedPath,
      );

      const workspaceId = firstString(
        seed.workspaceId,
        seed.diagnosticsWorkspaceId,
        openedSnapshot.workspaceId,
        openedSnapshot.diagnosticsWorkspaceId,
        preview?.workspaceId,
        preview?.diagnosticsWorkspaceId,
      );

      const diagnosticsWorkspaceId = firstString(
        seed.diagnosticsWorkspaceId,
        seed.workspaceId,
        openedSnapshot.diagnosticsWorkspaceId,
        openedSnapshot.workspaceId,
        preview?.diagnosticsWorkspaceId,
        preview?.workspaceId,
      );

      const harvestedPaths = uniq([
        ...collectFilePaths(openedSnapshot, loaded, opened, preview),
        ...toStringArray(seed.openedPaths),
        ...(selectedPath ? [selectedPath] : []),
      ]).filter(looksLikeFilePath);

      const normalizedSelectedPath =
        rootPath &&
        selectedPath &&
        !String(selectedPath).startsWith(String(rootPath))
          ? null
          : selectedPath;

      const normalizedPreview =
        preview == null
          ? null
          : compactRecord({
              ...preview,
              path: firstString(
                preview.path,
                preview.selectedPath,
                normalizedSelectedPath,
                "Large file preview",
              ),
              selectedPath: firstString(
                preview.selectedPath,
                preview.path,
                normalizedSelectedPath,
                "Large file preview",
              ),
              workspaceId: firstString(
                preview.workspaceId,
                preview.diagnosticsWorkspaceId,
                workspaceId,
                diagnosticsWorkspaceId,
              ),
              diagnosticsWorkspaceId: firstString(
                preview.diagnosticsWorkspaceId,
                preview.workspaceId,
                diagnosticsWorkspaceId,
                workspaceId,
              ),
            });

      const governedSeed = compactRecord({
        ...seed,
        attached: true,
        rootPath,
        selectedPath: normalizedSelectedPath,
        workspaceId,
        diagnosticsWorkspaceId,
      });

      if (!hasMeaningfulSeed(governedSeed, normalizedPreview, harvestedPaths)) {
        throw new Error("workspace open returned no attached workspace");
      }

      setWorkspaceIdentity(firstString(workspaceId, diagnosticsWorkspaceId) ?? null);
      setRootPath(typeof rootPath === "string" ? rootPath : null);
      setSelectedPath(normalizedSelectedPath);
      setPaths(harvestedPaths);
      setLargePreview(normalizedPreview);
      await hydrateGovernedSurfaces(governedSeed);
      setErrorMessage(null);
    } catch (error) {
      setWorkspaceIdentity(null);
      setRootPath(null);
      setSelectedPath(null);
      setPaths([]);
      setLargePreview(null);
      setDiagnosticsSummary(null);
      setErrorMessage(describeLoadError("open", error));
    }
  }, [hydrateGovernedSurfaces]);

  const selectFile = useCallback(async (path: string) => {
    setSelectedPath(path);

    const bridge = currentBridge();
    const workspaceApi = asRecord(bridge.workspace);

    const previewRecord = asRecord(unwrapEnvelope(largePreview)) ?? asRecord(largePreview) ?? {};
    const previewWorkspace = asRecord(previewRecord.workspace) ?? {};

    const resolvedWorkspaceIdentity = firstString(
      workspaceIdentity,
      previewRecord.workspaceId,
      previewRecord.diagnosticsWorkspaceId,
      previewWorkspace.workspaceId,
      previewWorkspace.diagnosticsWorkspaceId,
    );

    const selectionArg = compactRecord({
      path,
      workspaceId: resolvedWorkspaceIdentity,
    });

    const stickyPreview = deriveLargePreview(largePreview) ?? compactRecord({
      path,
      selectedPath: path,
      workspaceId: resolvedWorkspaceIdentity,
      diagnosticsWorkspaceId: resolvedWorkspaceIdentity,
      previewOnly: true,
      readOnly: true,
      degraded: true,
      reason: "Large file preview",
    });

    try {
      const result =
        isFn(workspaceApi?.selectPath)
          ? await workspaceApi.selectPath(selectionArg)
          : isFn(workspaceApi?.reveal)
            ? await workspaceApi.reveal(selectionArg)
            : undefined;

      const nextSeed = deriveWorkspaceSeed(result, selectionArg, stickyPreview);
      const nextPreview = deriveLargePreview(result, stickyPreview) ?? stickyPreview;
      const nextPaths = uniq([
        ...paths,
        path,
        ...collectFilePaths(result),
        ...toStringArray(nextSeed.openedPaths),
      ]).filter(looksLikeFilePath);

      const nextRootPath =
        typeof nextSeed.rootPath === "string"
          ? nextSeed.rootPath
          : rootPath;

      const nextSelectedPath =
        nextRootPath &&
        typeof nextSeed.selectedPath === "string" &&
        !String(nextSeed.selectedPath).startsWith(String(nextRootPath))
          ? path
          : firstString(nextSeed.selectedPath, path) ?? path;

      const nextIdentity = firstString(
        nextSeed.workspaceId,
        nextSeed.diagnosticsWorkspaceId,
        nextPreview?.workspaceId,
        nextPreview?.diagnosticsWorkspaceId,
        resolvedWorkspaceIdentity,
      );

      setWorkspaceIdentity(nextIdentity ?? null);
      setRootPath(nextRootPath);
      setSelectedPath(nextSelectedPath);
      setPaths(nextPaths);
      setLargePreview(nextPreview);
      setErrorMessage(null);
    } catch {
      setLargePreview(stickyPreview);
    }
  }, [largePreview, paths, rootPath, workspaceIdentity]);

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(() => subscribeStreams(), [subscribeStreams]);

  return (
    <div className="adjutorix-app">
      <header className="app-header">
        <div>
          <h1>ADJUTORIX</h1>
          <p>Deterministic operator workspace for governed patching, replay, verification, and authority-aware execution.</p>
        </div>
        <div className="app-header-meta">
          <button type="button" onClick={openWorkspace}>
            Open Command Surface
          </button>
          <button type="button">Provider Online</button>
        </div>
      </header>

      <main className="app-main">
        <section className="app-panel">
          <h2>Workspace Command Surface</h2>

          {errorMessage ? (
            <p>{errorMessage}</p>
          ) : rootPath ? (
            <p>Attached workspace: {rootPath}</p>
          ) : (
            <p>No workspace attached.</p>
          )}

          {selectedPath ? <p>Selected path: {selectedPath}</p> : null}

          {fileButtons.length > 0 ? (
            <section>
              <h2>Open Files</h2>
              <ul>
                {fileButtons.map(({ label, path }) => (
                  <li key={label}>
                    <button type="button" onClick={() => void selectFile(path)}>
                      {label}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {diagnosticsSummary ? (
            <p>
              Diagnostics — error: {Number(diagnosticsSummary.error ?? 0)}, warn: {Number(diagnosticsSummary.warn ?? 0)}, info: {Number(diagnosticsSummary.info ?? 0)}, hint: {Number(diagnosticsSummary.hint ?? 0)}
            </p>
          ) : null}

          {largePreview ? (
            <section>
              <h2>Large File Guard</h2>
              <p>Preview only / degraded editor state is active.</p>
              <p>{selectedPath ?? firstString(largePreview.path, largePreview.selectedPath, "Large file preview")}</p>
            </section>
          ) : null}
        </section>
      </main>
    </div>
  );
}
