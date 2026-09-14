import type { GraphEdge, GraphNode } from './graphTypes.ts';

export interface GraphPoint {
  node: GraphNode;
  x: number;
  y: number;
}

// Stable component rings avoid a continuously running simulation.
export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[]): GraphPoint[] {
  const neighbors = new Map(nodes.map((node) => [node.key, new Set<string>()]));
  for (const edge of edges) {
    if (neighbors.has(edge.source) && neighbors.has(edge.target)) {
      neighbors.get(edge.source)!.add(edge.target);
      neighbors.get(edge.target)!.add(edge.source);
    }
  }
  const ordered = [...nodes].sort(
    (a, b) => neighbors.get(b.key)!.size - neighbors.get(a.key)!.size || a.key.localeCompare(b.key),
  );
  const byPath = new Map(nodes.map((node) => [node.key, node]));
  const visited = new Set<string>();
  const components: GraphPoint[][] = [];
  for (const root of ordered) {
    if (visited.has(root.key)) {
      continue;
    }
    const queue = [root.key];
    visited.add(root.key);
    const layers: string[][] = [[root.key]];
    const depths = new Map([[root.key, 0]]);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const path = queue[cursor];
      const depth = depths.get(path)! + 1;
      for (const neighbor of neighbors.get(path)!) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          depths.set(neighbor, depth);
          (layers[depth] ??= []).push(neighbor);
          queue.push(neighbor);
        }
      }
    }
    let radius = 0;
    const points = layers.flatMap((layer, depth) => {
      radius = depth ? Math.max(radius + 160, layer.length * 24) : 0;
      return layer.map((path, index) => {
        const angle = (index / layer.length) * Math.PI * 2 - Math.PI / 2;
        return {
          node: byPath.get(path)!,
          x: Math.cos(angle) * radius,
          y: Math.sin(angle) * radius,
        };
      });
    });
    components.push(points);
  }
  const columns = Math.max(1, Math.ceil(Math.sqrt(components.length)));
  const result: GraphPoint[] = [];
  let top = 0;
  for (let start = 0; start < components.length; start += columns) {
    let left = 0;
    let rowHeight = 0;
    for (const points of components.slice(start, start + columns)) {
      let extent = 0;
      for (const point of points) {
        extent = Math.max(extent, Math.abs(point.x), Math.abs(point.y));
      }
      const size = extent * 2 + 220;
      for (const point of points) {
        result.push({
          ...point,
          ...savedPosition(point, left + size / 2, top + size / 2),
        });
      }
      left += size;
      rowHeight = Math.max(rowHeight, size);
    }
    top += rowHeight;
  }
  return result;
}

export function graphNeighbors(path: string | null, edges: GraphEdge[]): Set<string> {
  const result = new Set<string>();
  if (path) {
    result.add(path);
    for (const edge of edges) {
      if (edge.source === path && edge.target) {
        result.add(edge.target);
      }
      if (edge.target === path) {
        result.add(edge.source);
      }
    }
  }
  return result;
}

function savedPosition(point: GraphPoint, x: number, y: number) {
  return { x: point.node.x ?? point.x + x, y: point.node.y ?? point.y + y };
}
