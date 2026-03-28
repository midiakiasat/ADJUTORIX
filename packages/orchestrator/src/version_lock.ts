export interface VersionLockEntry {
  readonly component: string;
  readonly version: string;
}

export function assertVersionLock(entries: readonly VersionLockEntry[]): void {
  const seen = new Set<string>();

  for (const entry of entries) {
    if (entry.component.trim().length === 0) {
      throw new Error("version lock component must be non-empty");
    }
    if (entry.version.trim().length === 0) {
      throw new Error(`version lock version must be non-empty for ${entry.component}`);
    }
    if (seen.has(entry.component)) {
      throw new Error(`duplicate version lock entry for ${entry.component}`);
    }
    seen.add(entry.component);
  }
}
