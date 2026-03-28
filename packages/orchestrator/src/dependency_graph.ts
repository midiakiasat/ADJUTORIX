export interface DependencyNode {
  readonly id: string;
  readonly dependsOn: readonly string[];
}

export interface DependencyGraph {
  readonly nodes: readonly DependencyNode[];
}

export function topologicallySortDependencies(graph: DependencyGraph): string[] {
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: string[] = [];

  function visit(id: string): void {
    if (visited.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      throw new Error(`dependency cycle detected at ${id}`);
    }
    const node = nodeMap.get(id);
    if (!node) {
      throw new Error(`unknown dependency node ${id}`);
    }
    visiting.add(id);
    for (const dependency of node.dependsOn) {
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(id);
  }

  for (const node of graph.nodes) {
    visit(node.id);
  }

  return ordered;
}
