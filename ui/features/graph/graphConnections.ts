import type { GraphEdge, GraphSnapshot } from './graphTypes.ts';

export interface GraphConnection extends GraphEdge {
  manual: boolean;
  markdown: 'none' | 'forward' | 'backward' | 'both';
}

export function removeManualConnection(
  snapshot: GraphSnapshot,
  connection: Pick<GraphEdge, 'source' | 'target'>,
): GraphSnapshot {
  return {
    ...snapshot,
    edges: snapshot.edges.filter(
      (edge) =>
        !(
          (edge.source === connection.source && edge.target === connection.target) ||
          (edge.source === connection.target && edge.target === connection.source)
        ),
    ),
  };
}

/** One displayed connection per unordered pair; Markdown keeps its original direction. */
export function graphConnections(snapshot: GraphSnapshot): GraphConnection[] {
  const connections = new Map<string, GraphConnection>();
  const nodes = new Set(snapshot.nodes.map((node) => node.key));
  function add(edge: Pick<GraphEdge, 'source' | 'target'>, manual: boolean) {
    if (edge.source === edge.target || !nodes.has(edge.source) || !nodes.has(edge.target)) {
      return;
    }
    const [source, target] = [edge.source, edge.target].sort();
    const id = JSON.stringify([source, target]);
    const connection: GraphConnection = connections.get(id) ?? {
      id,
      source,
      target,
      manual: false,
      markdown: 'none',
    };
    if (manual) {
      connection.manual = true;
    } else {
      const direction = source === edge.source ? 'forward' : 'backward';
      connection.markdown =
        connection.markdown === 'none' || connection.markdown === direction ? direction : 'both';
    }
    connections.set(id, connection);
  }
  for (const edge of snapshot.edges) {
    add(edge, true);
  }
  for (const edge of snapshot.references.edges) {
    add(edge, false);
  }
  return [...connections.values()];
}

export function connectionOrigins(connection: GraphConnection, selected: string): string {
  const origins = connection.manual ? ['Manual'] : [];
  if (connection.markdown === 'both') {
    origins.push('Link and backlink');
  } else if (connection.markdown !== 'none') {
    const outgoing = (selected === connection.source) === (connection.markdown === 'forward');
    origins.push(outgoing ? 'Link in this note' : 'Backlink');
  }
  return origins.join(' · ');
}
