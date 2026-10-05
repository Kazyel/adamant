import type { GraphNode, GraphSnapshot } from './graphTypes.ts';

function indexNodes(nodes: GraphNode[]) {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const byPath = new Map(nodes.map((node) => [node.path, node]));
  const byId = new Map<string, GraphNode | null>();
  for (const node of nodes) {
    if (node.id) {
      byId.set(node.id, byId.has(node.id) ? null : node);
    }
  }
  return { byKey, byPath, byId };
}

function previousNode(
  node: GraphNode,
  current: ReturnType<typeof indexNodes>,
  nextIds: Map<string, GraphNode | null>,
) {
  const atKey = current.byKey.get(node.key);
  if (atKey && (atKey.id === node.id || (atKey.id === null && atKey.path === node.path))) {
    return atKey;
  }
  if (node.id && nextIds.get(node.id)) {
    const atId = current.byId.get(node.id);
    if (atId) {
      return atId;
    }
  }
  const atPath = current.byPath.get(node.path);
  return atPath?.id === null ? atPath : undefined;
}

function refreshNode(node: GraphNode, previous: GraphNode): GraphNode {
  return previous.path === node.path &&
    previous.kind === node.kind &&
    previous.tags.length === node.tags.length &&
    previous.tags.every((tag, index) => tag === node.tags[index]) &&
    previous.id === node.id &&
    previous.identity === node.identity &&
    previous.problem === node.problem
    ? previous
    : { ...node, key: previous.key, x: previous.x, y: previous.y };
}

function refreshEdges(
  current: GraphSnapshot,
  next: GraphSnapshot,
  nodes: GraphNode[],
  keys: Map<string, string>,
) {
  const retained = new Set(nodes.map((node) => node.key));
  const edges = current.edges.filter(
    (edge) => retained.has(edge.source) && retained.has(edge.target),
  );
  // A restored file can recover its saved connections while the stored revision is unchanged.
  if (current.revision === next.revision) {
    const currentKeys = new Set(current.nodes.map((node) => node.key));
    const edgeIds = new Set(edges.map((edge) => edge.id));
    for (const edge of next.edges) {
      const source = keys.get(edge.source);
      const target = keys.get(edge.target);
      if (
        source &&
        target &&
        !edgeIds.has(edge.id) &&
        (!currentKeys.has(source) || !currentKeys.has(target))
      ) {
        edges.push({ ...edge, source, target });
        edgeIds.add(edge.id);
      }
    }
  }
  return edges.length === current.edges.length &&
    edges.every((edge, index) => edge === current.edges[index])
    ? current.edges
    : edges;
}

/** Refresh derived inventory without accepting another writer's manual graph or revision. */
export function refreshGraph(current: GraphSnapshot, next: GraphSnapshot): GraphSnapshot {
  const currentIndex = indexNodes(current.nodes);
  const nextIds = indexNodes(next.nodes).byId;

  const sameRevision = current.revision === next.revision;
  const keys = new Map<string, string>();
  const used = new Set<string>();
  const reserved = new Set(currentIndex.byKey.keys());
  const nodes: GraphNode[] = [];
  for (const node of next.nodes) {
    let previous = previousNode(node, currentIndex, nextIds);
    if (previous && used.has(previous.key)) {
      previous = undefined;
    }
    if (previous) {
      keys.set(node.key, previous.key);
      used.add(previous.key);
      nodes.push(sameRevision ? refreshNode(node, previous) : previous);
    } else if (sameRevision) {
      let key = node.key;
      let suffix = 1;
      while (reserved.has(key)) {
        key = `${node.key}#${suffix++}`;
      }
      reserved.add(key);
      used.add(key);
      keys.set(node.key, key);
      nodes.push({ ...node, key });
    }
  }

  if (!next.complete) {
    for (const node of current.nodes) {
      if (!used.has(node.key)) {
        nodes.push(node);
      }
    }
  }
  // Reference-index progress must not recalculate an unchanged file layout.
  const unchanged =
    nodes.length === current.nodes.length &&
    nodes.every((node, index) => node === current.nodes[index]);
  return {
    ...current,
    nodes: unchanged ? current.nodes : nodes,
    edges: refreshEdges(current, next, nodes, keys),
    indexing: next.indexing,
    generation: next.generation,
    complete: next.complete,
    references: {
      ...next.references,
      edges: next.references.edges.flatMap((edge) => {
        const source = keys.get(edge.source);
        const target = keys.get(edge.target);
        return source && target ? [{ source, target }] : [];
      }),
    },
  };
}
