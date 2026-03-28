import { topologicallySortDependencies, type DependencyGraph } from "./dependency_graph.js";

export interface ShutdownAction {
  readonly service: string;
  readonly order: number;
}

export function buildShutdownPlan(graph: DependencyGraph): ShutdownAction[] {
  const startupOrder = topologicallySortDependencies(graph);
  return startupOrder
    .reverse()
    .map((service, index) => ({
      service,
      order: index + 1
    }));
}
