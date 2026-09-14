import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutGraph, graphNeighbors } from './graphLayout.ts';
import { graphRecord, type GraphNode, type GraphSnapshot } from './graphTypes.ts';

function node(key: string, kind: GraphNode['kind'] = 'markdown'): GraphNode {
  return {
    key,
    path: `content/${key}`,
    kind,
    id: null,
    identity: `file:${key}`,
    problem: null,
    x: null,
    y: null,
  };
}

void test('layout includes isolated files, cycles and saved positions without merging duplicate identities', () => {
  const nodes = [
    node('a.md'),
    node('b.pdf', 'pdf'),
    node('c.docx', 'docx'),
    { ...node('alone.md'), x: -40, y: 75 },
  ];
  const edges = [
    { id: 'ab', source: 'a.md', target: 'b.pdf' },
    { id: 'bc', source: 'b.pdf', target: 'c.docx' },
    { id: 'ca', source: 'c.docx', target: 'a.md' },
  ];
  const points = layoutGraph(nodes, edges);
  assert.equal(points.length, 4);
  assert.equal(new Set(points.map((point) => `${point.x},${point.y}`)).size, 4);
  assert.deepEqual(
    points.find((point) => point.node.key === 'alone.md'),
    { node: nodes[3], x: -40, y: 75 },
  );
  assert.deepEqual(layoutGraph([...nodes].reverse(), edges), points);
  assert.deepEqual(graphNeighbors('a.md', edges), new Set(['a.md', 'b.pdf', 'c.docx']));
  assert.deepEqual(layoutGraph([], []), []);
  const duplicates = [
    { ...node('first.md'), id: 'shared' },
    { ...node('second.md'), id: 'shared' },
  ];
  assert.equal(layoutGraph(duplicates, []).length, 2);
});

void test('graph JSON contains portable file references and positions, not document contents or runtime identities', () => {
  const snapshot: GraphSnapshot = {
    nodes: [node('a.md'), node('b.pdf', 'pdf')],
    edges: [{ id: 'edge', source: 'a.md', target: 'b.pdf' }],
    revision: 5,
    generation: 9,
    complete: true,
    indexing: { state: 'ready', scannedEntries: 2, indexedDocuments: 2, message: null },
  };
  assert.deepEqual(graphRecord(snapshot), {
    version: 1,
    nodes: snapshot.nodes.map((item) => ({
      key: item.key,
      path: item.path,
      id: null,
      x: null,
      y: null,
    })),
    edges: snapshot.edges,
  });
  const thousand = Array.from({ length: 1000 }, (_, index) => node(`${index}.md`));
  assert.equal(
    layoutGraph(thousand, []).filter(
      (point) => Number.isFinite(point.x) && Number.isFinite(point.y),
    ).length,
    1000,
  );
});
