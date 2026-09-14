import { graphRecord, type GraphRecord, type GraphSnapshot } from './graphTypes.ts';

export interface GraphHistory {
  past: GraphRecord[];
  future: GraphRecord[];
}

export function rememberGraph(history: GraphHistory, before: GraphSnapshot, after: GraphSnapshot) {
  const record = graphRecord(before);
  if (JSON.stringify(record) === JSON.stringify(graphRecord(after))) {
    return history;
  }
  return { past: [...history.past.slice(-99), record], future: [] };
}

export function travelGraph(
  history: GraphHistory,
  current: GraphSnapshot,
  direction: 'undo' | 'redo',
): { history: GraphHistory; snapshot: GraphSnapshot } | null {
  const source = direction === 'undo' ? history.past : history.future;
  const target = source.at(-1);
  if (!target) {
    return null;
  }
  const positions = new Map(target.nodes.map((node) => [node.key, node]));
  return {
    history:
      direction === 'undo'
        ? { past: source.slice(0, -1), future: [...history.future, graphRecord(current)] }
        : { past: [...history.past, graphRecord(current)], future: source.slice(0, -1) },
    snapshot: {
      ...current,
      nodes: current.nodes.map((node) => {
        const position = positions.get(node.key);
        return position ? { ...node, x: position.x, y: position.y } : node;
      }),
      edges: target.edges,
    },
  };
}
