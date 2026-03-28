export type WorkspaceFileClass =
  | "source"
  | "test"
  | "config"
  | "asset"
  | "generated"
  | "vendor"
  | "documentation"
  | "unknown";

export interface WorkspaceClassification {
  readonly path: string;
  readonly className: WorkspaceFileClass;
  readonly confidence: number;
}

export function classifyWorkspacePath(path: string): WorkspaceFileClass {
  if (/(\.test\.|\.spec\.)/u.test(path) || path.startsWith("tests/")) {
    return "test";
  }
  if (/^configs\//u.test(path) || /(^|\/)(package\.json|tsconfig.*\.json|pyproject\.toml)$/u.test(path)) {
    return "config";
  }
  if (/^docs\//u.test(path) || /README\.md$/u.test(path)) {
    return "documentation";
  }
  if (/\.(png|jpg|jpeg|gif|svg|woff2|icns)$/u.test(path)) {
    return "asset";
  }
  if (/(^|\/)(dist|build|coverage|\.turbo|node_modules)\//u.test(path)) {
    return "generated";
  }
  if (/^vendor\//u.test(path)) {
    return "vendor";
  }
  if (/\.(ts|tsx|js|jsx|py|sh|json|yaml|yml|toml|css)$/u.test(path)) {
    return "source";
  }
  return "unknown";
}

export function buildWorkspaceClassification(path: string): WorkspaceClassification {
  return {
    path,
    className: classifyWorkspacePath(path),
    confidence: 1
  };
}
