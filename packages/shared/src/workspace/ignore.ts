export interface WorkspaceIgnoreRule {
  readonly pattern: string;
  readonly reason?: string;
}

export interface WorkspaceIgnoreSet {
  readonly rules: readonly WorkspaceIgnoreRule[];
}

export function assertWorkspaceIgnoreRule(value: WorkspaceIgnoreRule): void {
  if (value.pattern.trim().length === 0) {
    throw new Error("workspaceIgnoreRule.pattern must be non-empty");
  }
  if (value.reason !== undefined && value.reason.trim().length === 0) {
    throw new Error("workspaceIgnoreRule.reason must be non-empty when present");
  }
}

export function matchesSimpleIgnoreRule(path: string, rule: WorkspaceIgnoreRule): boolean {
  const pattern = rule.pattern;
  if (pattern === path) {
    return true;
  }
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  if (pattern.startsWith("*.")) {
    return path.endsWith(pattern.slice(1));
  }
  return path.includes(pattern);
}

export function shouldIgnoreWorkspacePath(
  path: string,
  ignoreSet: WorkspaceIgnoreSet
): boolean {
  return ignoreSet.rules.some((rule) => matchesSimpleIgnoreRule(path, rule));
}
