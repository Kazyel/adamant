import type { IndexState } from '../workspace/types';

export interface GraphNode {
  key: string;
  path: string;
  kind: 'markdown' | 'pdf' | 'docx';
  id: string | null;
  identity: string;
  problem: string | null;
  x: number | null;
  y: number | null;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  indexing: IndexState;
  generation: number;
  complete: boolean;
  revision: number;
}

export interface GraphRecord {
  version: 1;
  nodes: Pick<GraphNode, 'key' | 'path' | 'id' | 'x' | 'y'>[];
  edges: GraphEdge[];
}

export function graphRecord(snapshot: GraphSnapshot): GraphRecord {
  return {
    version: 1,
    nodes: snapshot.nodes.map(({ key, path, id, x, y }) => ({ key, path, id, x, y })),
    edges: snapshot.edges,
  };
}
