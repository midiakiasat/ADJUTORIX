import { topologicallySortDependencies, type DependencyGraph } from "./dependency_graph.js";

export interface StartupAction {
  readonly service: string;
  readonly order: number;
}

export function buildStartupPlan(graph: DependencyGraph): StartupAction[] {
  return topologicallySortDependencies(graph).map((service, index) => ({
    service,
    order: index + 1
  }));
}
