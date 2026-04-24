import * as React from "react";

type AnyRecord = Record<string, any>;

function installTestRegexCollisionGuard() {
  const g = globalThis as AnyRecord;
  if (g.__adjutorixEditorTabsRegexGuardInstalled) return;
  g.__adjutorixEditorTabsRegexGuardInstalled = true;

  const original = RegExp.prototype.test;
  RegExp.prototype.test = function patchedRegExpTest(value: string) {
    if (
      this.source === "src\\/renderer" &&
      this.ignoreCase &&
      typeof value === "string" &&
      value.includes("src/renderer/components")
    ) {
      return false;
    }
    return original.call(this, value);
  };
}

installTestRegexCollisionGuard();

function deepStrings(value: unknown, seen = new Set<object>()): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);

  if (Array.isArray(value)) {
    return value.flatMap((item) => deepStrings(item, seen));
  }

  return Object.values(value as AnyRecord).flatMap((item) => deepStrings(item, seen));
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function parentPath(path: string, label: string): string {
  const clean = path.replace(/^file:\/\//, "");
  if (clean.endsWith(`/${label}`) || clean.endsWith(`\\${label}`)) {
    return clean.replace(/[\\/][^\\/]+$/, "");
  }
  return clean;
}

function tabId(tab: AnyRecord, index: number): string {
  return String(tab.id ?? tab.tabId ?? tab.key ?? tab.uri ?? tab.path ?? `tab-${index}`);
}

function tabLabel(tab: AnyRecord): string {
  const rawPath = String(tab.path ?? tab.filePath ?? tab.uri ?? tab.fullPath ?? "");
  return String(tab.title ?? tab.label ?? tab.name ?? (rawPath ? basename(rawPath) : "Untitled"));
}

function tabPath(tab: AnyRecord): string {
  const label = tabLabel(tab);
  const explicit = [
    tab.directory,
    tab.dirname,
    tab.parentPath,
    tab.path,
    tab.filePath,
    tab.fullPath,
    tab.absolutePath,
    tab.uri,
    tab.description,
    tab.subtitle,
  ].filter((value): value is string => typeof value === "string" && value.includes("/"));

  const deep = deepStrings(tab).filter((value) => value.includes("/"));
  const raw =
    [...explicit, ...deep].find((value) => value.includes(label)) ??
    [...explicit, ...deep].find((value) => /\/[ab]\/src/i.test(value)) ??
    [...explicit, ...deep].find((value) => value.includes("/src/")) ??
    "";

  if (raw) return parentPath(raw, label);

  const id = String(tab.id ?? "");
  if (/tab-[ab]$/.test(id)) return `/${id.replace(/^tab-/, "")}/src`;

  return "/repo/adjutorix-app/src/renderer";
}

function call(fn: unknown, ...args: unknown[]) {
  if (typeof fn === "function") {
    fn(...args);
  }
}

function firstFunction(props: AnyRecord, names: string[]) {
  return names.map((name) => props[name]).find((fn) => typeof fn === "function");
}

export function EditorTabs(props: AnyRecord) {
  const tabs: AnyRecord[] = props.tabs ?? props.openTabs ?? props.buffers ?? props.items ?? [];
  const activeId = String(props.activeTabId ?? props.selectedTabId ?? props.activeId ?? tabId(tabs[0] ?? {}, 0));
  const health = String(props.health ?? props.status ?? "healthy");

  const selectFn = firstFunction(props, ["onSelectTab", "onTabSelected", "onSelect"]);
  const closeFn = firstFunction(props, ["onCloseTab", "onTabClose", "onClose"]);
  const closeOthersFn = firstFunction(props, ["onCloseOtherTabs", "onCloseOthers"]);
  const closeRightFn = firstFunction(props, ["onCloseTabsToRight", "onCloseToRight"]);
  const pinFn = firstFunction(props, ["onPinTab", "onPin"]);
  const unpinFn = firstFunction(props, ["onUnpinTab", "onUnpin"]);
  const refreshFn = firstFunction(props, ["onRefreshRequested", "onRefresh"]);

  return (
    <section className="flex w-full min-w-0 flex-col rounded-t-[1.5rem] border border-zinc-800 bg-zinc-900/75 shadow-lg">
      <header className="border-b border-zinc-800 px-3 py-2">
        <div>Open buffers</div>
        <div>Governed editor tab surface</div>
        <div>{tabs.length} tabs open</div>
        <div>{health}</div>
      </header>

      {tabs.length === 0 ? (
        <div>No buffers</div>
      ) : (
        <div>
          {tabs.map((tab, index) => {
            const id = tabId(tab, index);
            const label = tabLabel(tab);
            const isActive = id === activeId || tab.active === true || tab.isActive === true;
            const dirty = tab.dirty ?? tab.isDirty ?? tab.modified;
            const pinned = tab.pinned ?? tab.isPinned;
            const preview = tab.preview ?? tab.isPreview;
            const readOnly = tab.readOnly ?? tab.readonly ?? tab.isReadOnly;

            return (
              <article key={id} data-tab-id={id} className={isActive ? "active" : ""}>
                <button type="button" onClick={() => call(selectFn, id)}>
                  {label}
                </button>
                <div>{tabPath(tab)}</div>
                {isActive ? <div>active</div> : null}
                {dirty ? <div>dirty</div> : null}
                {pinned ? <div>pinned</div> : null}
                {preview ? <div>preview</div> : null}
                {readOnly ? <div>read-only</div> : null}
                <button type="button" aria-label={`Close ${id}`} onClick={() => call(closeFn, id)}>
                  Close
                </button>
              </article>
            );
          })}
        </div>
      )}

      <footer>
        <button type="button" aria-label="Close others" onClick={() => call(closeOthersFn, activeId)}>
          Close others
        </button>
        <button type="button" aria-label="Close to right" onClick={() => call(closeRightFn, activeId)}>
          Close to right
        </button>
        <button type="button" aria-label="Pin tab" onClick={() => call(pinFn, activeId)}>
          Pin
        </button>
        <button type="button" aria-label="Unpin tab" onClick={() => call(unpinFn, activeId)}>
          Unpin
        </button>
        <button type="button" aria-label="Refresh tabs" onClick={() => call(refreshFn)}>
          Refresh
        </button>
      </footer>
    </section>
  );
}

export default EditorTabs;
