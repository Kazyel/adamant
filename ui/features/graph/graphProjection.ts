import {
  matchesDocumentFilters,
  type DocumentFiltersState,
} from '../navigation/documentFilters.ts';
import type { GraphConnection } from './graphConnections.ts';
import type { GraphNode } from './graphTypes.ts';

export interface LocalGraph {
  root: string | null;
  depth: 1 | 2;
}

function localNeighborhood(nodes: GraphNode[], connections: GraphConnection[], local: LocalGraph) {
  const neighborhood = new Set<string>();
  const root = nodes.find((node) => node.key === local.root && node.identity);
  if (!root) {
    return neighborhood;
  }
  neighborhood.add(root.key);
  let frontier = new Set([root.key]);
  for (let depth = 0; depth < local.depth; depth++) {
    const next = new Set<string>();
    for (const edge of connections) {
      if (frontier.has(edge.source) && !neighborhood.has(edge.target)) {
        next.add(edge.target);
      }
      if (frontier.has(edge.target) && !neighborhood.has(edge.source)) {
        next.add(edge.source);
      }
    }
    for (const key of next) {
      neighborhood.add(key);
    }
    frontier = next;
  }
  return neighborhood;
}

/** Traverse the complete graph before applying display filters, including backlinks. */
export function projectGraph(
  nodes: GraphNode[],
  connections: GraphConnection[],
  filters: DocumentFiltersState,
  query: string,
  local: LocalGraph | null,
) {
  const neighborhood = local ? localNeighborhood(nodes, connections, local) : null;
  const search = query.trim().toLocaleLowerCase();
  const visible = nodes.filter(
    (node) =>
      (!neighborhood || neighborhood.has(node.key)) &&
      matchesDocumentFilters(node, filters) &&
      (!search || node.path.toLocaleLowerCase().includes(search)),
  );
  const keys = new Set(visible.map((node) => node.key));
  return {
    nodes: visible,
    keys,
    connections: connections.filter((edge) => keys.has(edge.source) && keys.has(edge.target)),
  };
}
