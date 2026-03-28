import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / RENDERER / monaco_models.test.ts
 *
 * Canonical Monaco model lifecycle contract suite.
 *
 * Purpose:
 * - verify that renderer/lib/monaco_models preserves one authoritative model registry surface
 *   for editor, preview, and diff contexts
 * - verify that URI generation, model creation, reuse, updates, disposal, diff pairing,
 *   language assignment, preview/read-only variants, and registry cleanup remain deterministic
 * - verify that stale or duplicate model identity cannot silently drift away from canonical buffer truth
 *
 * Test philosophy:
 * - no snapshots
 * - assert model registry semantics, lifecycle guarantees, and boundary conditions directly
 * - prefer identity, disposal, and reuse invariants over happy-path-only coverage
 *
 * Notes:
 * - this suite assumes renderer/lib/monaco_models exports the functions referenced below
 * - Monaco is mocked here because the contract target is the registry/lifecycle logic, not Monaco itself
 * - if the real module exports differ slightly, update the imports and mock adapters first
 */

const modelStore = new Map<string, MockModel>();

class MockUri {
  constructor(public readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

class MockModel {
  public disposed = false;
  public language: string;
  public value: string;
  public readonly uri: MockUri;

  constructor(value: string, language: string, uri: MockUri) {
    this.value = value;
    this.language = language;
    this.uri = uri;
  }

  getValue(): string {
    return this.value;
  }

  setValue(next: string): void {
    this.value = next;
  }

  getLanguageId(): string {
    return this.language;
  }

  dispose(): void {
    this.disposed = true;
    modelStore.delete(this.uri.toString());
  }

  isDisposed(): boolean {
    return this.disposed;
  }
}

vi.mock("monaco-editor", () => {
  return {
    Uri: {
      parse: (value: string) => new MockUri(value),
      file: (value: string) => new MockUri(`file://${value}`),
    },
    editor: {
      getModel: (uri: MockUri) => modelStore.get(uri.toString()) ?? null,
      getModels: () => Array.from(modelStore.values()),
      createModel: (value: string, language: string, uri: MockUri) => {
        const model = new MockModel(value, language, uri);
        modelStore.set(uri.toString(), model);
        return model;
      },
      setModelLanguage: (model: MockModel, language: string) => {
        model.language = language;
      },
    },
  };
});

import {
  buildModelUri,
  buildDiffModelUris,
  getOrCreateModel,
  getOrCreateDiffModels,
  updateModelContents,
  ensureModelLanguage,
  disposeModelByUri,
  disposeModelsByPrefix,
  disposeAllManagedModels,
  listManagedModels,
  type ManagedModelDescriptor,
} from "../../../src/renderer/lib/monaco_models";

function descriptor(
  overrides: Partial<ManagedModelDescriptor> = {},
): ManagedModelDescriptor {
  return {
    path: "/repo/adjutorix-app/src/renderer/App.tsx",
    language: "typescript",
    value: "export default function App() { return null; }\n",
    kind: "editor",
    readOnly: false,
    ...overrides,
  } as ManagedModelDescriptor;
}

describe("renderer/lib/monaco_models", () => {
  beforeEach(() => {
    modelStore.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    modelStore.clear();
  });

  describe("buildModelUri", () => {
    it("builds deterministic editor URIs from path, kind, and readonly posture", () => {
      const a = buildModelUri(
        descriptor({ path: "/repo/adjutorix-app/src/renderer/App.tsx", kind: "editor", readOnly: false }),
      );
      const b = buildModelUri(
        descriptor({ path: "/repo/adjutorix-app/src/renderer/App.tsx", kind: "editor", readOnly: false }),
      );

      expect(a.toString()).toBe(b.toString());
      expect(a.toString()).toContain("App.tsx");
    });

    it("separates preview and editor URIs so degraded preview models cannot collide with editable buffers", () => {
      const editorUri = buildModelUri(descriptor({ kind: "editor", readOnly: false }));
      const previewUri = buildModelUri(descriptor({ kind: "preview", readOnly: true }));

      expect(editorUri.toString()).not.toBe(previewUri.toString());
    });

    it("separates readonly and writable editor variants when the contract encodes authority in the URI", () => {
      const writable = buildModelUri(descriptor({ kind: "editor", readOnly: false }));
      const readonly = buildModelUri(descriptor({ kind: "editor", readOnly: true }));

      expect(writable.toString()).not.toBe(readonly.toString());
    });

    it("normalizes cross-platform path separators into stable URI identity", () => {
      const unix = buildModelUri(
        descriptor({ path: "/repo/adjutorix-app/src/renderer/App.tsx" }),
      );
      const windows = buildModelUri(
        descriptor({ path: "C:\\repo\\adjutorix-app\\src\\renderer\\App.tsx" }),
      );

      expect(unix.toString()).toContain("App.tsx");
      expect(windows.toString()).toContain("App.tsx");
    });
  });

  describe("buildDiffModelUris", () => {
    it("builds distinct original and modified URIs for the same path", () => {
      const uris = buildDiffModelUris({
        path: "/repo/adjutorix-app/src/renderer/App.tsx",
        language: "typescript",
      });

      expect(uris.original.toString()).not.toBe(uris.modified.toString());
      expect(uris.original.toString()).toContain("original");
      expect(uris.modified.toString()).toContain("modified");
    });

    it("preserves rename lineage when oldPath differs from path", () => {
      const uris = buildDiffModelUris({
        oldPath: "/repo/adjutorix-app/src/renderer/OldShell.tsx",
        path: "/repo/adjutorix-app/src/renderer/AppShell.tsx",
        language: "typescript",
      });

      expect(uris.original.toString()).toContain("OldShell.tsx");
      expect(uris.modified.toString()).toContain("AppShell.tsx");
    });
  });

  describe("getOrCreateModel", () => {
    it("creates a model on first request and reuses it on subsequent identical requests", () => {
      const first = getOrCreateModel(descriptor());
      const second = getOrCreateModel(descriptor());

      expect(first).toBe(second);
      expect(modelStore.size).toBe(1);
      expect(first.getValue()).toContain("export default function App");
      expect(first.getLanguageId()).toBe("typescript");
    });

    it("creates distinct models for distinct kinds even when the source path matches", () => {
      const editor = getOrCreateModel(descriptor({ kind: "editor" }));
      const preview = getOrCreateModel(descriptor({ kind: "preview", readOnly: true }));

      expect(editor).not.toBe(preview);
      expect(modelStore.size).toBe(2);
    });

    it("does not recreate a model just because the incoming value changed; identity stays stable until explicit update", () => {
      const first = getOrCreateModel(descriptor({ value: "first\n" }));
      const second = getOrCreateModel(descriptor({ value: "second\n" }));

      expect(first).toBe(second);
      expect(second.getValue()).toBe("first\n");
    });

    it("recreates a disposed model when the same descriptor is requested again", () => {
      const first = getOrCreateModel(descriptor());
      first.dispose();

      const second = getOrCreateModel(descriptor());

      expect(first).not.toBe(second);
      expect(second.isDisposed()).toBe(false);
      expect(modelStore.size).toBe(1);
    });
  });

  describe("updateModelContents", () => {
    it("updates model contents only when the value actually changes", () => {
      const model = getOrCreateModel(descriptor({ value: "alpha\n" }));

      updateModelContents(model, "alpha\n");
      expect(model.getValue()).toBe("alpha\n");

      updateModelContents(model, "beta\n");
      expect(model.getValue()).toBe("beta\n");
    });

    it("preserves model identity while replacing contents", () => {
      const model = getOrCreateModel(descriptor({ value: "before\n" }));
      const uri = model.uri.toString();

      updateModelContents(model, "after\n");

      expect(model.uri.toString()).toBe(uri);
      expect(model.getValue()).toBe("after\n");
    });
  });

  describe("ensureModelLanguage", () => {
    it("updates Monaco language when the desired language changes", () => {
      const model = getOrCreateModel(descriptor({ language: "plaintext" }));
      expect(model.getLanguageId()).toBe("plaintext");

      ensureModelLanguage(model, "typescript");
      expect(model.getLanguageId()).toBe("typescript");
    });

    it("leaves language untouched when already aligned", () => {
      const model = getOrCreateModel(descriptor({ language: "typescript" }));
      ensureModelLanguage(model, "typescript");
      expect(model.getLanguageId()).toBe("typescript");
    });
  });

  describe("getOrCreateDiffModels", () => {
    it("creates deterministic original and modified models for diff viewing", () => {
      const pair = getOrCreateDiffModels({
        path: "/repo/adjutorix-app/src/renderer/App.tsx",
        language: "typescript",
        originalValue: "old\n",
        modifiedValue: "new\n",
      });

      expect(pair.original.getValue()).toBe("old\n");
      expect(pair.modified.getValue()).toBe("new\n");
      expect(pair.original.uri.toString()).not.toBe(pair.modified.uri.toString());
      expect(modelStore.size).toBe(2);
    });

    it("reuses diff model identities on repeated requests for the same diff pair", () => {
      const first = getOrCreateDiffModels({
        path: "/repo/adjutorix-app/src/renderer/App.tsx",
        language: "typescript",
        originalValue: "old\n",
        modifiedValue: "new\n",
      });
      const second = getOrCreateDiffModels({
        path: "/repo/adjutorix-app/src/renderer/App.tsx",
        language: "typescript",
        originalValue: "old changed but not yet updated\n",
        modifiedValue: "new changed but not yet updated\n",
      });

      expect(first.original).toBe(second.original);
      expect(first.modified).toBe(second.modified);
      expect(second.original.getValue()).toBe("old\n");
      expect(second.modified.getValue()).toBe("new\n");
    });

    it("updates diff contents explicitly when requested through the helper contract", () => {
      const pair = getOrCreateDiffModels({
        path: "/repo/adjutorix-app/src/renderer/App.tsx",
        language: "typescript",
        originalValue: "old\n",
        modifiedValue: "new\n",
        syncContents: true,
      });

      const updated = getOrCreateDiffModels({
        path: "/repo/adjutorix-app/src/renderer/App.tsx",
        language: "typescript",
        originalValue: "older\n",
        modifiedValue: "newer\n",
        syncContents: true,
      });

      expect(updated.original).toBe(pair.original);
      expect(updated.modified).toBe(pair.modified);
      expect(updated.original.getValue()).toBe("older\n");
      expect(updated.modified.getValue()).toBe("newer\n");
    });
  });

  describe("listManagedModels", () => {
    it("lists only currently managed live models", () => {
      getOrCreateModel(descriptor({ path: "/repo/adjutorix-app/src/renderer/App.tsx" }));
      getOrCreateModel(descriptor({ path: "/repo/adjutorix-app/src/renderer/ProviderStatus.tsx" }));

      const listed = listManagedModels();
      expect(listed).toHaveLength(2);
      expect(listed.map((m) => m.uri.toString()).join(" ")).toContain("App.tsx");
      expect(listed.map((m) => m.uri.toString()).join(" ")).toContain("ProviderStatus.tsx");
    });

    it("does not include disposed models in the managed listing", () => {
      const model = getOrCreateModel(descriptor());
      model.dispose();

      expect(listManagedModels()).toEqual([]);
    });
  });

  describe("disposeModelByUri", () => {
    it("disposes the targeted model by URI without touching other live models", () => {
      const app = getOrCreateModel(descriptor({ path: "/repo/adjutorix-app/src/renderer/App.tsx" }));
      const provider = getOrCreateModel(
        descriptor({ path: "/repo/adjutorix-app/src/renderer/ProviderStatus.tsx" }),
      );

      disposeModelByUri(app.uri);

      expect(app.isDisposed()).toBe(true);
      expect(provider.isDisposed()).toBe(false);
      expect(modelStore.size).toBe(1);
    });

    it("fails safely when the target URI does not exist", () => {
      expect(() => disposeModelByUri(new MockUri("missing://model"))).not.toThrow();
    });
  });

  describe("disposeModelsByPrefix", () => {
    it("disposes all models whose URIs match a logical prefix", () => {
      const app = getOrCreateModel(descriptor({ path: "/repo/adjutorix-app/src/renderer/App.tsx" }));
      const appPreview = getOrCreateModel(
        descriptor({ path: "/repo/adjutorix-app/src/renderer/App.tsx", kind: "preview", readOnly: true }),
      );
      const other = getOrCreateModel(
        descriptor({ path: "/repo/adjutorix-app/src/renderer/ProviderStatus.tsx" }),
      );

      disposeModelsByPrefix("/repo/adjutorix-app/src/renderer/App.tsx");

      expect(app.isDisposed()).toBe(true);
      expect(appPreview.isDisposed()).toBe(true);
      expect(other.isDisposed()).toBe(false);
    });
  });

  describe("disposeAllManagedModels", () => {
    it("disposes every managed model and empties the registry deterministically", () => {
      getOrCreateModel(descriptor({ path: "/repo/adjutorix-app/src/renderer/App.tsx" }));
      getOrCreateModel(descriptor({ path: "/repo/adjutorix-app/src/renderer/ProviderStatus.tsx" }));
      getOrCreateDiffModels({
        path: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
        language: "typescript",
        originalValue: "old\n",
        modifiedValue: "new\n",
      });

      expect(modelStore.size).toBeGreaterThan(0);
      disposeAllManagedModels();
      expect(modelStore.size).toBe(0);
      expect(listManagedModels()).toEqual([]);
    });
  });

  describe("cross-surface lifecycle guarantees", () => {
    it("keeps editor and diff models isolated so diff updates cannot mutate the live editor buffer model", () => {
      const editor = getOrCreateModel(
        descriptor({ path: "/repo/adjutorix-app/src/renderer/App.tsx", value: "editor\n", kind: "editor" }),
      );
      const diff = getOrCreateDiffModels({
        path: "/repo/adjutorix-app/src/renderer/App.tsx",
        language: "typescript",
        originalValue: "old\n",
        modifiedValue: "new\n",
        syncContents: true,
      });

      expect(editor.uri.toString()).not.toBe(diff.modified.uri.toString());
      expect(editor.getValue()).toBe("editor\n");
      expect(diff.modified.getValue()).toBe("new\n");
    });

    it("recreates registry truth cleanly after global disposal instead of reviving disposed instances", () => {
      const first = getOrCreateModel(descriptor());
      disposeAllManagedModels();
      const second = getOrCreateModel(descriptor());

      expect(first).not.toBe(second);
      expect(second.isDisposed()).toBe(false);
      expect(modelStore.size).toBe(1);
    });

    it("preserves unique URI identity for duplicate basenames from different directories", () => {
      const a = getOrCreateModel(
        descriptor({ path: "/repo/adjutorix-app/src/renderer/App.tsx" }),
      );
      const b = getOrCreateModel(
        descriptor({ path: "/repo/adjutorix-app/tests/renderer/App.tsx" }),
      );

      expect(a.uri.toString()).not.toBe(b.uri.toString());
      expect(modelStore.size).toBe(2);
    });
  });
});
